/**
 * SQLite-backed message storage.
 *
 * Replaces the previous "single JSON blob per channel" MMKV layout. That
 * shape forced a full read-modify-write of every channel's entire history
 * on every received message, capped at 1000 messages per channel just to
 * keep the latency tolerable, and was racy under concurrent saves (two
 * messages arriving at once both parsed the same blob, both appended,
 * the second's write clobbered the first — a real source of silent
 * receiver-side message loss).
 *
 * The new schema stores one row per message. INSERT OR REPLACE keyed on
 * (space_id, channel_id, message_id) makes saves O(1) and atomic. WAL
 * journal mode makes concurrent writes safe. The 1000-cap is gone —
 * channels keep history indefinitely. Pagination is a real indexed query
 * against (space_id, channel_id, created_date DESC).
 *
 * Initialization is lazy: the database is opened on the first call to
 * `getDb()`, then a one-shot migration pulls any existing
 * `messages:<spaceId>:<channelId>` blobs out of MMKV and INSERTs their
 * contents. The migration is idempotent — per-channel transactions plus
 * INSERT OR REPLACE mean a mid-flight crash just gets retried on the
 * next launch without data loss or duplication.
 */

import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { storage } from '../offline/storage';
import type {
  GetMessagesParams,
  GetMessagesResult,
  Message,
} from '@quilibrium/quorum-shared';
import { logger } from '@quilibrium/quorum-shared';

const DB_NAME = 'quorum-messages.db';
const MIGRATION_FLAG_KEY = 'messages-sqlite-migration:v1';
const MMKV_MESSAGES_PREFIX = 'messages:';

// Must match the secureStorage module's key + accessibility so we read
// the same hex-encoded Ed448 private key that the app stored at
// onboarding. Duplicated rather than imported to avoid a cycle and to
// keep this module's dependency surface minimal.
const ED448_PRIVATE_KEY_STORE_KEY = 'quorum.privateKey';
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// HKDF info string. Bump the version suffix if we ever need to rotate
// the cipher key derivation (e.g. switch hash, change length); the DB
// would need to be re-encrypted at that point.
const CIPHER_KEY_HKDF_INFO = new TextEncoder().encode('quorum-sqlite-v1');

// Row layout in the messages table. Payload is the full JSON-serialized
// Message — keeps the schema flat and avoids needing a migration every
// time the shared Message type gains a field. The dedicated columns are
// the ones we sort/filter by.
interface MessageRow {
  payload: string;
  created_date: number;
}

let dbInstance: SQLite.SQLiteDatabase | null = null;

/**
 * Sync check used by StorageProvider to decide whether to render the
 * one-time migration modal BEFORE actually triggering the migration.
 * The modal blocks the user from leaving the app while the sync
 * MMKV→SQLite copy is running (which can take a noticeable second or
 * two for power users with thousands of cached messages).
 *
 * Returns true only when: (a) the migration flag isn't set yet, AND
 * (b) MMKV actually contains `messages:*` blobs to migrate. A fresh
 * install (no MMKV blobs) returns false — no modal needed.
 */
export function isMigrationPending(): boolean {
  if (storage.getString(MIGRATION_FLAG_KEY) === 'done') return false;
  const keys = storage.getAllKeys();
  for (const k of keys) {
    if (k.startsWith(MMKV_MESSAGES_PREFIX)) return true;
  }
  return false;
}

/**
 * Sentinel thrown when getDb() is called before the Ed448 identity key
 * exists in SecureStore. Callers (storage adapter methods) catch and
 * return empty results — the only legitimate pre-key caller is the
 * StorageProvider's eager init(), which is meant to be a no-op in that
 * state. By the time the user has a session that can produce or consume
 * messages, the Ed448 key is guaranteed to exist.
 */
class NoIdentityKeyError extends Error {
  constructor() {
    super('No Ed448 identity key available; SQLite messages DB cannot be opened yet');
    this.name = 'NoIdentityKeyError';
  }
}

/**
 * Cached cipher key. Populated by `ensureCipherKeyAsync()` (via init()
 * during StorageProvider mount) and consumed by every subsequent open
 * — both sync and async. The sync fallback is there for a hypothetical
 * race where some message read fires before init resolves, but in
 * practice the cache is hot well before any user-triggered code path
 * touches messagesDb.
 *
 * Why bother with both? `SecureStore.getItem` (sync) has device-
 * specific edge cases — iOS keychain access via the sync bridge has
 * been observed to return null or throw under conditions where the
 * async equivalent works (cold start, background-then-foreground,
 * accessibility-level interactions). Doing the *real* derivation
 * async during init (when these edge cases are absent) and then
 * memoizing avoids paying that lottery on every save.
 */
let cipherKeyHexCache: string | null = null;

function deriveCipherKeyHexFromHex(hexPrivate: string): string {
  const ikm = hexToBytes(hexPrivate);
  // No salt — we want the derivation to be deterministic from the IKM
  // alone so the same Ed448 key always produces the same cipher key
  // across re-derives. SQLCipher uses 32-byte (256-bit) AES keys by
  // default.
  const key = hkdf(sha256, ikm, undefined, CIPHER_KEY_HKDF_INFO, 32);
  return bytesToHex(key);
}

/**
 * Async derivation path. Preferred — uses SecureStore.getItemAsync,
 * which is the more reliable iOS path. Called from init() during the
 * StorageProvider mount so the cache is warm before any user action.
 *
 * If SecureStore loses the Ed448 key but the user still has their
 * mnemonic, keyService.ensurePrivateKey re-derives it on next launch
 * and the same HKDF output reconstitutes the same cipher key — so the
 * database survives a Keystore desync as long as the mnemonic does.
 */
async function ensureCipherKeyAsync(): Promise<string> {
  if (cipherKeyHexCache) return cipherKeyHexCache;
  const hexPrivate = await SecureStore.getItemAsync(ED448_PRIVATE_KEY_STORE_KEY, SECURE_OPTIONS);
  if (!hexPrivate) throw new NoIdentityKeyError();
  cipherKeyHexCache = deriveCipherKeyHexFromHex(hexPrivate);
  return cipherKeyHexCache;
}

/**
 * Sync derivation fallback. Used only by the rare-race sync code path
 * (useMessages' initialData seed firing before init's async derivation
 * has had a chance to run). On iOS especially, SecureStore.getItem can
 * return null or throw transiently — we treat both as "key not
 * available right now, try again later" rather than data-destroying
 * errors. Returns null instead of throwing so the caller can degrade
 * gracefully to an empty page that re-paints on the next render once
 * the async cache populates.
 */
function tryGetCipherKeySync(): string | null {
  if (cipherKeyHexCache) return cipherKeyHexCache;
  try {
    const hexPrivate = SecureStore.getItem(ED448_PRIVATE_KEY_STORE_KEY, SECURE_OPTIONS);
    if (!hexPrivate) return null;
    cipherKeyHexCache = deriveCipherKeyHexFromHex(hexPrivate);
    return cipherKeyHexCache;
  } catch (e) {
    // iOS keychain sync access can throw under specific conditions —
    // see comment on cipherKeyHexCache above. Don't propagate; let
    // the caller return empty and try again next render.
    logger.warn('[messagesDb] sync SecureStore read failed (will retry async):', e instanceof Error ? e.message : e);
    return null;
  }
}

function openAndInit(cipherKeyHex: string): SQLite.SQLiteDatabase {
  const db = SQLite.openDatabaseSync(DB_NAME);
  // PRAGMA key MUST be the very first statement on the connection.
  // Using SQLCipher's `x'...'` raw-key form so it uses our HKDF output
  // bytes directly instead of running PBKDF2 on top.
  db.execSync(`PRAGMA key = "x'${cipherKeyHex}'";`);
  // Probe the connection to confirm the key actually decrypts the file.
  // On a fresh DB this initializes the header with our key; on an
  // existing DB this throws if the key is wrong. The wrong-key case
  // bubbles to getDb() which deletes the file and retries cleanly.
  try {
    db.execSync('SELECT count(*) FROM sqlite_master;');
  } catch (e) {
    try { db.closeSync(); } catch {}
    throw new Error(`SQLCipher key probe failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // WAL gives us concurrent readers + safer writes than the default rollback
  // journal. journal_mode is persistent across connections so this is set
  // once and stays in the file.
  db.execSync('PRAGMA journal_mode = WAL;');
  db.execSync(`
    CREATE TABLE IF NOT EXISTS messages (
      space_id      TEXT    NOT NULL,
      channel_id    TEXT    NOT NULL,
      message_id    TEXT    NOT NULL,
      created_date  INTEGER NOT NULL,
      modified_date INTEGER NOT NULL,
      payload       TEXT    NOT NULL,
      PRIMARY KEY (space_id, channel_id, message_id)
    );
  `);
  // The composite index covers cursor pagination: ORDER BY created_date DESC
  // with optional WHERE created_date < ? filter, partitioned by channel.
  db.execSync(`
    CREATE INDEX IF NOT EXISTS idx_messages_channel_created
      ON messages (space_id, channel_id, created_date DESC);
  `);
  // Cross-channel delete-by-id (admin remove without knowing the channel).
  db.execSync(`
    CREATE INDEX IF NOT EXISTS idx_messages_message_id
      ON messages (message_id);
  `);
  // Empty-channel hub-log replay flag (see messageRecovery.ts). Co-located
  // with the messages so a DB wipe re-arms recovery automatically.
  db.execSync(`
    CREATE TABLE IF NOT EXISTS space_recovery (
      space_id      TEXT    PRIMARY KEY,
      attempted_at  INTEGER NOT NULL
    );
  `);
  return db;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('Invalid hex string');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

/**
 * Best-effort coercion of an unknown value to a unix-millis number.
 * Used during migration to keep rows whose `createdDate` was somehow
 * stored as a non-number (string, ISO string, missing). The order of
 * a single message is less valuable than its content; falling back to
 * `Date.now()` preserves the row at the cost of misplaced ordering.
 */
function coerceTimestamp(value: unknown, fallback: number = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Lazy initializer. First call opens the database, applies the
 * SQLCipher key, ensures schema, and runs the MMKV → SQLite migration.
 * Subsequent calls return the cached instance.
 *
 * Throws NoIdentityKeyError if the Ed448 key isn't in SecureStore yet
 * (pre-onboarding). Callers should treat that as "no messages
 * available" and short-circuit; the only legitimate caller in that
 * state is StorageProvider's eager init(), which catches and ignores.
 *
 * If we successfully derive a cipher key but the SQLCipher probe
 * fails — meaning the file was encrypted with a DIFFERENT key (the
 * user re-onboarded under a new identity without clearAllMessages
 * having had a chance to wipe the file) — we delete the file and
 * recurse to recreate it cleanly under the new key. This is safe
 * because there's no scenario where keeping a file encrypted under an
 * inaccessible key is useful: by definition no future code path can
 * read it.
 */
/**
 * Async open path. Used by `init()` (called from StorageProvider on
 * mount) so SecureStore is consulted via the more reliable async
 * keychain bridge. After this resolves once, `cipherKeyHexCache` is
 * populated and all subsequent calls — including the sync ones — hit
 * the cache and never touch SecureStore again.
 */
export async function ensureDb(): Promise<SQLite.SQLiteDatabase | null> {
  if (dbInstance) return dbInstance;
  let cipherKey: string;
  try {
    cipherKey = await ensureCipherKeyAsync();
  } catch (e) {
    if (e instanceof NoIdentityKeyError) return null;
    throw e;
  }
  return openWithCipherKey(cipherKey);
}

/**
 * Sync open path. Used by `useMessages.initialData` to render cached
 * messages on the first paint without waiting on a microtask. If the
 * cipher key cache hasn't been populated yet (init still in flight, or
 * sync SecureStore unavailable on this device right now), returns null
 * gracefully — the caller treats that as "no cached data this frame"
 * and the next render after ensureDb resolves will succeed.
 */
function getDbSync(): SQLite.SQLiteDatabase | null {
  if (dbInstance) return dbInstance;
  const cipherKey = tryGetCipherKeySync();
  if (!cipherKey) return null;
  try {
    return openWithCipherKey(cipherKey);
  } catch (e) {
    logger.warn('[messagesDb] sync open failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Shared open implementation. Given a cipher key, opens the file,
 * applies the key, runs the wrong-key-recovery dance (only when the
 * migration flag is unset, per the data-loss guard we added earlier),
 * sets schema, and runs the MMKV migration.
 */
function openWithCipherKey(cipherKey: string): SQLite.SQLiteDatabase {
  if (dbInstance) return dbInstance;
  let db: SQLite.SQLiteDatabase;
  try {
    db = openAndInit(cipherKey);
  } catch (e) {
    // Open failed. There are two reasons we want to handle differently:
    //
    //   A. We've never successfully completed a MMKV→SQLite migration on
    //      this device. The file is either nonexistent, freshly-created
    //      empty, or left over from a half-finished migration attempt
    //      that didn't reach the "set flag = 'done'" step. None of those
    //      states hold canonical user data — the MMKV blobs are still
    //      the source of truth. Safe to wipe and retry; the next call
    //      will re-migrate from MMKV.
    //
    //   B. Migration was previously marked 'done', meaning we already
    //      moved everything out of MMKV into THIS file. Wiping it here
    //      would destroy real user data with no way to recover. A probe
    //      failure in this state is almost certainly an identity-key
    //      change or a build-config change — neither is a reason to
    //      silently nuke history. Surface the error loudly and stop.
    if (storage.getString(MIGRATION_FLAG_KEY) === 'done') {
      throw new Error(
        `[messagesDb] cannot open SQLite messages DB with derived cipher key, ` +
        `and the migration flag is set so the file is presumed to hold ` +
        `canonical history. Refusing to wipe. Underlying: ` +
        `${e instanceof Error ? e.message : String(e)}`
      );
    }

    logger.warn('[messagesDb] open failed during pre-migration state; resetting db file:', e instanceof Error ? e.message : e);
    try { SQLite.deleteDatabaseSync(DB_NAME); } catch {}
    storage.remove(MIGRATION_FLAG_KEY);
    db = openAndInit(cipherKey);
  }
  dbInstance = db;
  try {
    runMmkvMigration(db);
  } catch (err) {
    logger.warn('[messagesDb] migration failed (will retry next launch):', err);
  }
  return db;
}

/**
 * Open the DB defensively — returns null instead of throwing for any
 * non-fatal reason (no identity key yet, sync SecureStore failed,
 * file open transient error). Used by read paths so a stray query
 * never crashes the surface; the worst case is an empty page that
 * re-renders correctly on the next attempt.
 */
function tryGetDb(): SQLite.SQLiteDatabase | null {
  return getDbSync();
}

/**
 * One-shot migration of every `messages:<spaceId>:<channelId>` blob in
 * MMKV into the SQLite messages table. Per-channel transactions plus
 * INSERT OR REPLACE keep it crash-safe: an interruption mid-channel
 * just gets the channel re-migrated on the next launch (rows already
 * present are simply overwritten with identical data, no duplication).
 *
 * MMKV blobs are deleted *only after* the transaction commits, so we
 * never lose data on a crash. The migration flag is recorded only after
 * the full sweep completes, so a partial migration of N channels means
 * the remaining (N+1, N+2, ...) get picked up next launch.
 */
function runMmkvMigration(db: SQLite.SQLiteDatabase): void {
  if (storage.getString(MIGRATION_FLAG_KEY) === 'done') return;

  const allKeys = storage.getAllKeys();
  const messageKeys = allKeys.filter((k) => k.startsWith(MMKV_MESSAGES_PREFIX));
  if (messageKeys.length === 0) {
    storage.set(MIGRATION_FLAG_KEY, 'done');
    return;
  }

  const startedAt = Date.now();
  let totalMessages = 0;
  let migratedKeys = 0;

  for (const key of messageKeys) {
    // Key shape: `messages:<spaceId>:<channelId>`. Addresses don't contain
    // colons, but split with limit=3 anyway in case a future key format
    // ever uses a colon-bearing channelId.
    const rest = key.slice(MMKV_MESSAGES_PREFIX.length);
    const sepIdx = rest.indexOf(':');
    if (sepIdx <= 0) {
      logger.warn('[messagesDb] migration: bad key shape, skipping:', key);
      continue;
    }
    const spaceId = rest.slice(0, sepIdx);
    const channelId = rest.slice(sepIdx + 1);

    const data = storage.getString(key);
    if (!data) continue;

    let messages: Message[];
    try {
      messages = JSON.parse(data) as Message[];
    } catch (e) {
      logger.warn('[messagesDb] migration: malformed JSON, skipping:', key, e);
      continue;
    }

    if (!Array.isArray(messages) || messages.length === 0) continue;

    // One transaction per channel keeps each batch atomic. A crash
    // between channels is fine; a crash mid-channel rolls the
    // transaction back so we re-migrate this channel cleanly next time.
    db.withTransactionSync(() => {
      const stmt = db.prepareSync(
        `INSERT OR REPLACE INTO messages
           (space_id, channel_id, message_id, created_date, modified_date, payload)
         VALUES (?, ?, ?, ?, ?, ?);`
      );
      try {
        for (const m of messages) {
          // Defensively use the channel-key-derived ids over the message's
          // own fields. In practice they're equal, but if any historical
          // bug ever wrote a message under a mismatched key we'd rather
          // preserve the key-derived grouping than orphan rows.
          const sid = spaceId;
          const cid = channelId;
          const mid = m.messageId;
          if (!mid) continue;
          // Tolerate broken timestamps rather than dropping the row.
          // Some legacy paths may have serialized createdDate as a
          // string or as a JSON-ified Date (ISO string). Coerce when
          // possible, fall back to Date.now() — losing the precise
          // ordering of one message is strictly better than losing
          // its content.
          const created = coerceTimestamp(m.createdDate);
          const modified = coerceTimestamp(m.modifiedDate, created);
          stmt.executeSync([sid, cid, mid, created, modified, JSON.stringify(m)]);
          totalMessages++;
        }
      } finally {
        stmt.finalizeSync();
      }
    });

    migratedKeys++;
  }

  // MMKV blobs are intentionally left in place. The earlier design
  // deleted them after a successful per-channel commit, which made
  // any post-migration SQLite mishap unrecoverable (we'd nuked the
  // source). Now they sit as forever-cold backup. The 1000-message
  // per-channel cap from the original storage keeps the total disk
  // cost bounded (~50 MB worst case for a heavy user), well below
  // the threshold at which we'd care. If a future cleanup pass wants
  // to reclaim that space after enough successful launches, it can
  // do so opt-in — but never as part of the migration itself.
  storage.set(MIGRATION_FLAG_KEY, 'done');
  logger.debug(
    `[messagesDb] MMKV→SQLite migration done: ${migratedKeys}/${messageKeys.length} channels, ${totalMessages} messages, ${Date.now() - startedAt}ms`
  );
}

// ---------- Public API ----------

/**
 * Synchronous read used by useMessages' initialData seed. Returns an
 * empty result if the DB isn't openable right now (e.g. sync
 * SecureStore unavailable on this iOS device this instant). The
 * re-render after init()'s async path resolves will then have a hot
 * cache and the next sync call will succeed.
 */
export function getMessagesSync(params: GetMessagesParams): GetMessagesResult {
  const { spaceId, channelId, cursor, limit = 50 } = params;
  const db = getDbSync();
  if (!db) return { messages: [], nextCursor: null, prevCursor: null };
  let rows: MessageRow[];
  if (cursor !== undefined && cursor !== null) {
    rows = db.getAllSync<MessageRow>(
      `SELECT payload, created_date FROM messages
       WHERE space_id = ? AND channel_id = ? AND created_date < ?
       ORDER BY created_date DESC LIMIT ?;`,
      [spaceId, channelId, cursor, limit]
    );
  } else {
    rows = db.getAllSync<MessageRow>(
      `SELECT payload, created_date FROM messages
       WHERE space_id = ? AND channel_id = ?
       ORDER BY created_date DESC LIMIT ?;`,
      [spaceId, channelId, limit]
    );
  }
  return rowsToResult(db, rows, spaceId, channelId, cursor);
}

export async function getMessages(params: GetMessagesParams): Promise<GetMessagesResult> {
  // Ensure the DB is open via the async key-derivation path before
  // delegating to the sync read. After init() runs once, this is a
  // no-op cache hit.
  await ensureDb();
  return getMessagesSync(params);
}

export async function getMessage(params: {
  spaceId: string;
  channelId: string;
  messageId: string;
}): Promise<Message | undefined> {
  const db = await ensureDb();
  if (!db) return undefined;
  const row = db.getFirstSync<{ payload: string }>(
    `SELECT payload FROM messages
     WHERE space_id = ? AND channel_id = ? AND message_id = ?
     LIMIT 1;`,
    [params.spaceId, params.channelId, params.messageId]
  );
  if (!row) return undefined;
  try {
    return JSON.parse(row.payload) as Message;
  } catch {
    return undefined;
  }
}

export async function saveMessage(message: Message): Promise<void> {
  // Use the async path so we never lose a message just because sync
  // SecureStore happened to fail. ensureDb populates the cipher key
  // cache on first call (via getItemAsync, the reliable iOS path) and
  // is a memoized no-op thereafter.
  const db = await ensureDb();
  if (!db) {
    // Truly no identity key (pre-onboarding or post-signout). Nothing
    // durable to do; the caller is almost always a stale receive
    // handler from a previous session. Silently drop.
    return;
  }

  // Reaction-preservation rule: wire-format messages don't carry reactions
  // (those arrive as separate control messages and fold into the target
  // via WebSocketContext). A replay/backfill of the original would erase
  // them on a blind replace, so when the incoming copy has no reactions
  // and the existing row does, keep the existing ones.
  const existing = db.getFirstSync<{ payload: string }>(
    `SELECT payload FROM messages
     WHERE space_id = ? AND channel_id = ? AND message_id = ?
     LIMIT 1;`,
    [message.spaceId, message.channelId, message.messageId]
  );

  let toSave = message;
  const incomingHasReactions = Array.isArray(message.reactions) && message.reactions.length > 0;
  if (existing && !incomingHasReactions) {
    try {
      const prev = JSON.parse(existing.payload) as Message;
      if (Array.isArray(prev.reactions) && prev.reactions.length > 0) {
        toSave = { ...message, reactions: prev.reactions };
      }
    } catch {
      // Fall through to plain replace if the existing row is unparseable.
    }
  }

  db.runSync(
    `INSERT OR REPLACE INTO messages
       (space_id, channel_id, message_id, created_date, modified_date, payload)
     VALUES (?, ?, ?, ?, ?, ?);`,
    [
      toSave.spaceId,
      toSave.channelId,
      toSave.messageId,
      toSave.createdDate,
      toSave.modifiedDate ?? toSave.createdDate,
      JSON.stringify(toSave),
    ]
  );
}

export async function deleteMessage(messageId: string): Promise<void> {
  const db = await ensureDb();
  if (!db) return;
  db.runSync(`DELETE FROM messages WHERE message_id = ?;`, [messageId]);
}

/**
 * DM delivery receipt: stamp deliveredAt on a single sent message. Patches
 * the JSON payload (deliveredAt is not a dedicated column). No-op if the row
 * is gone or already delivered.
 */
export async function updateMessageDeliveredAt(messageId: string, deliveredAt: number): Promise<void> {
  const db = await ensureDb();
  if (!db) return;
  const row = db.getFirstSync<{ payload: string }>(
    `SELECT payload FROM messages WHERE message_id = ? LIMIT 1;`,
    [messageId]
  );
  if (!row) return;
  let msg: Message;
  try { msg = JSON.parse(row.payload) as Message; } catch { return; }
  if (msg.deliveredAt) return;
  msg.deliveredAt = deliveredAt;
  db.runSync(`UPDATE messages SET payload = ? WHERE message_id = ?;`, [JSON.stringify(msg), messageId]);
}

/**
 * DM read receipt: stamp readAt (and deliveredAt if missing) on all OWN
 * messages in a conversation up to a high-water timestamp. DM spaceId and
 * channelId are both the partner address.
 */
export async function updateMessagesReadAt(
  conversationAddress: string,
  selfAddress: string,
  upToTimestamp: number,
  readAt: number
): Promise<void> {
  const db = await ensureDb();
  if (!db) return;
  const rows = db.getAllSync<{ message_id: string; payload: string }>(
    `SELECT message_id, payload FROM messages
     WHERE space_id = ? AND channel_id = ? AND created_date <= ?;`,
    [conversationAddress, conversationAddress, upToTimestamp]
  );
  for (const row of rows) {
    let msg: Message;
    try { msg = JSON.parse(row.payload) as Message; } catch { continue; }
    if (msg.content?.senderId !== selfAddress || msg.readAt) continue;
    msg.readAt = readAt;
    if (!msg.deliveredAt) msg.deliveredAt = readAt;
    db.runSync(`UPDATE messages SET payload = ? WHERE message_id = ?;`, [JSON.stringify(msg), row.message_id]);
  }
}

/**
 * Per-space "we already asked the server to replay the full hub log"
 * flag. Synchronous because the open-empty-channel detector in
 * useMessages needs to short-circuit without waiting on a microtask.
 *
 * Returns false (i.e. "recovery should run") if the DB isn't open yet
 * (pre-onboarding) — recovery would no-op anyway in that state since
 * there's no hub key to sign with.
 */
export function hasAttemptedRecovery(spaceId: string): boolean {
  const db = tryGetDb();
  if (!db) return false;
  const row = db.getFirstSync<{ space_id: string }>(
    `SELECT space_id FROM space_recovery WHERE space_id = ? LIMIT 1;`,
    [spaceId]
  );
  return row !== null && row !== undefined;
}

export function markRecoveryAttempted(spaceId: string): void {
  const db = tryGetDb();
  if (!db) return;
  db.runSync(
    `INSERT OR REPLACE INTO space_recovery (space_id, attempted_at)
     VALUES (?, ?);`,
    [spaceId, Date.now()]
  );
}

/**
 * Wipe the messages database. Used by sign-out so a re-onboard doesn't
 * inherit the previous identity's history.
 *
 * We delete the FILE, not just the rows. The next identity will derive
 * a different SQLCipher key, and a file encrypted under the prior key
 * would be unreadable to it anyway — keeping it around would just
 * force the wrong-key recovery path on the first open. Also resets the
 * MMKV→SQLite migration flag so any stray legacy blobs get migrated
 * cleanly into the fresh, newly-encrypted file.
 */
export function clearAllMessages(): void {
  if (dbInstance) {
    try { dbInstance.closeSync(); } catch { /* noop */ }
    dbInstance = null;
  }
  try {
    SQLite.deleteDatabaseSync(DB_NAME);
  } catch {
    // File didn't exist or already deleted — fine.
  }
  storage.remove(MIGRATION_FLAG_KEY);
}

// ---------- Helpers ----------

function rowsToResult(
  db: SQLite.SQLiteDatabase,
  rows: MessageRow[],
  spaceId: string,
  channelId: string,
  cursor: number | null | undefined
): GetMessagesResult {
  if (rows.length === 0) {
    return { messages: [], nextCursor: null, prevCursor: null };
  }

  const messages: Message[] = [];
  for (const r of rows) {
    try {
      messages.push(JSON.parse(r.payload) as Message);
    } catch {
      // Skip unparseable rows rather than failing the whole page.
    }
  }

  // Rows came back newest-first; reverse to chronological (oldest-first)
  // for the UI, matching the previous adapter's behavior.
  messages.reverse();

  // prevCursor is the created_date of the *oldest* message in this slice —
  // the next "load older" page asks for messages with created_date < this.
  // Only emit it if there's actually anything older in the table.
  const oldestInSlice = rows[rows.length - 1].created_date;
  const olderExists = db.getFirstSync<{ c: number }>(
    `SELECT 1 AS c FROM messages
     WHERE space_id = ? AND channel_id = ? AND created_date < ?
     LIMIT 1;`,
    [spaceId, channelId, oldestInSlice]
  );
  const prevCursor = olderExists ? oldestInSlice : null;

  // nextCursor matches the previous adapter's semantic: timestamp of the
  // first row newer than the cursor's anchor, used by callers that want
  // to know whether there's anything more recent than what they have.
  // Only meaningful when we paged with an explicit cursor.
  let nextCursor: number | null = null;
  if (cursor !== undefined && cursor !== null) {
    const newer = db.getFirstSync<{ created_date: number }>(
      `SELECT created_date FROM messages
       WHERE space_id = ? AND channel_id = ? AND created_date >= ?
       ORDER BY created_date ASC LIMIT 1;`,
      [spaceId, channelId, cursor]
    );
    nextCursor = newer?.created_date ?? null;
  }

  return { messages, nextCursor, prevCursor };
}
