/**
 * Reset App Data must not brick the messages database.
 *
 * The bug this pins: the SQLCipher key is derived from the Ed448 identity
 * and memoized for the process lifetime. "Reset App Data" wipes the disk
 * but never restarts the process, so the key of the DELETED identity used
 * to survive into the re-onboarding flow. The first database touch after
 * that created a fresh file encrypted under the dead identity, and the
 * next cold start — deriving correctly from the NEW identity — could no
 * longer open it. The "refuse to wipe canonical history" guard then made
 * the state permanent: every message surface dead, no in-app recovery.
 *
 * Two things have to be modelled for that to be reproducible at all:
 *
 *   1. SQLCipher's key enforcement. Plain SQLite ignores `PRAGMA key`, so
 *      a stock in-memory database can never reproduce a wrong-key open.
 *      The mock below stamps the key on file creation and throws the real
 *      "file is not a database" on a mismatch.
 *   2. State that outlives a process restart. Disk, keychain and MMKV all
 *      survive a cold start; module-level caches do not. The fakes live on
 *      `globalThis` so `jest.resetModules()` reproduces exactly that split
 *      — which is the whole point, since the damage is only visible on the
 *      launch AFTER the launch that caused it.
 */

const IDENTITY_A = 'aa'.repeat(32);
const IDENTITY_B = 'bb'.repeat(32);
const DB_NAME = 'quorum-messages.db';
const MIGRATION_FLAG_KEY = 'messages-sqlite-migration:v1';

jest.mock('expo-sqlite', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite');
  const g = globalThis as any;
  // The "filesystem". Survives jest.resetModules() the way a real DB file
  // survives a process restart.
  g.__disk ??= new Map<string, { key: string | null; db: any }>();

  const openDatabaseSync = (name: string) => {
    if (!g.__disk.has(name)) {
      g.__disk.set(name, { key: null, db: new DatabaseSync(':memory:') });
    }
    const file = g.__disk.get(name)!;
    let attemptedKey: string | null = null;
    let unlocked = false;

    // SQLCipher validates the key on the first real statement after
    // PRAGMA key, not on the PRAGMA itself. On a brand-new file that
    // first statement stamps the header instead of failing — which is
    // precisely why a stale key silently produces a valid-looking file.
    const unlock = () => {
      if (unlocked) return;
      if (file.key === null) file.key = attemptedKey;
      else if (file.key !== attemptedKey) throw new Error('file is not a database');
      unlocked = true;
    };

    return {
      execSync: (sql: string) => {
        const keyed = /PRAGMA\s+key\s*=\s*"x'([0-9a-f]+)'"/i.exec(sql);
        if (keyed) {
          attemptedKey = keyed[1];
          return;
        }
        // journal_mode etc. carry no meaning for this test.
        if (/^\s*PRAGMA/i.test(sql)) return;
        unlock();
        return file.db.exec(sql);
      },
      runSync: (sql: string, params: unknown[] = []) => {
        unlock();
        return file.db.prepare(sql).run(...params);
      },
      getFirstSync: (sql: string, params: unknown[] = []) => {
        unlock();
        return file.db.prepare(sql).get(...params) ?? null;
      },
      getAllSync: (sql: string, params: unknown[] = []) => {
        unlock();
        return file.db.prepare(sql).all(...params);
      },
      prepareSync: (sql: string) => {
        unlock();
        const stmt = file.db.prepare(sql);
        return {
          executeSync: (...params: unknown[]) => stmt.run(...params),
          finalizeSync: () => {},
        };
      },
      withTransactionSync: (fn: () => void) => fn(),
      // Closing a HANDLE must not destroy the FILE — that distinction is
      // load-bearing here, since the fix closes the connection on wipe.
      closeSync: () => {},
    };
  };

  return {
    openDatabaseSync,
    deleteDatabaseSync: (name: string) => {
      (globalThis as any).__disk.delete(name);
    },
  };
});

jest.mock('expo-secure-store', () => {
  const g = globalThis as any;
  // The keychain: a real key-value store, because clearAllSecureStorage()
  // is exercised below and actually deletes from it. Survives a cold start.
  g.__keychain ??= { store: new Map<string, string>(), reads: 0, gate: null };
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
    getItem: (k: string) => {
      g.__keychain.reads += 1;
      return g.__keychain.store.get(k) ?? null;
    },
    getItemAsync: async (k: string) => {
      g.__keychain.reads += 1;
      // Read the value at CALL time, then optionally block. That models a
      // keychain read issued while the old identity was still stored and
      // resolving only after it has been deleted — the interleaving the
      // epoch guard exists for. Android Keystore reads are 650-900ms, so
      // this window is wide in practice, not theoretical.
      const value = g.__keychain.store.get(k) ?? null;
      if (g.__keychain.gate) await g.__keychain.gate;
      return value;
    },
    setItemAsync: async (k: string, v: string) => void g.__keychain.store.set(k, v),
    deleteItemAsync: async (k: string) => void g.__keychain.store.delete(k),
  };
});

jest.mock('../services/offline/storage', () => {
  const g = globalThis as any;
  g.__mmkv ??= new Map<string, string>();
  return {
    storage: {
      getString: (k: string) => g.__mmkv.get(k),
      set: (k: string, v: string) => void g.__mmkv.set(k, v),
      remove: (k: string) => void g.__mmkv.delete(k),
      delete: (k: string) => void g.__mmkv.delete(k),
      getAllKeys: () => [...g.__mmkv.keys()],
    },
  };
});

type MessagesDb = typeof import('../services/storage/messagesDb');

/** The key messagesDb and secureStorage both read the Ed448 identity from. */
const ED448_KEY = 'quorum.privateKey';

const disk = () => (globalThis as any).__disk as Map<string, { key: string | null }>;
const keychain = () =>
  (globalThis as any).__keychain as {
    store: Map<string, string>;
    reads: number;
    gate: Promise<void> | null;
  };
const mmkv = () => (globalThis as any).__mmkv as Map<string, string>;
const setIdentity = (hex: string) => keychain().store.set(ED448_KEY, hex);

/** Re-require the module with a clean module registry: a cold start. */
function coldStart(): MessagesDb {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../services/storage/messagesDb') as MessagesDb;
}

beforeEach(() => {
  (globalThis as any).__disk = new Map();
  (globalThis as any).__keychain = { store: new Map(), reads: 0, gate: null };
  (globalThis as any).__mmkv = new Map();
  setIdentity(IDENTITY_A);
});

describe('Reset App Data → re-onboard → cold start', () => {
  it('does not leave the database encrypted under the wiped identity', async () => {
    // Session 1: user A has been using the app, so the database exists and
    // the migration flag is armed.
    let db = coldStart();
    expect(await db.ensureDb()).toBeTruthy();
    expect(mmkv().get(MIGRATION_FLAG_KEY)).toBe('done');
    const keyUnderA = disk().get(DB_NAME)!.key;

    // Reset App Data. Disk is wiped; the process keeps running, which is
    // the entire premise of the bug.
    db.clearAllMessages();
    mmkv().clear();
    expect(disk().has(DB_NAME)).toBe(false);

    // User onboards a different account.
    setIdentity(IDENTITY_B);

    // Anything touching messages during the rest of this session — an
    // arriving DM, a space backfill, a useMessages read — recreates the
    // file. It must be keyed to B, not to the account just deleted.
    expect(await db.ensureDb()).toBeTruthy();
    const keyAfterReset = disk().get(DB_NAME)!.key;
    expect(keyAfterReset).not.toBe(keyUnderA);

    // The launch after the launch that caused the damage. This is where a
    // stale key surfaced as "Refusing to wipe" and stayed forever.
    db = coldStart();
    await expect(db.ensureDb()).resolves.toBeTruthy();
  });

  it('survives a reset with no re-onboard in between', async () => {
    let db = coldStart();
    expect(await db.ensureDb()).toBeTruthy();

    db.clearAllMessages();
    mmkv().clear();
    // Same identity re-onboarded (user resets and signs back in as
    // themselves). The derived key is identical, so this passes with or
    // without the fix — it is here to catch a "fix" that breaks the
    // ordinary path.
    expect(await db.ensureDb()).toBeTruthy();

    db = coldStart();
    await expect(db.ensureDb()).resolves.toBeTruthy();
  });
});

describe('a wipe that lands mid-derivation', () => {
  // The narrow door into the same brick. Nothing marks the session
  // unauthenticated until the wipe finishes, so the socket keeps delivering
  // messages throughout it, and a keychain read issued microseconds before
  // the wipe resolves microseconds after — holding the identity that was
  // just deleted.
  it('refuses to cache an identity the wipe overtook', async () => {
    const db = coldStart();

    let release!: () => void;
    keychain().gate = new Promise<void>((r) => {
      release = r;
    });

    // A message arrives: derivation starts and reads identity A.
    const inFlight = db.ensureDb();
    // Reset App Data lands while that read is still outstanding.
    db.clearAllMessages();
    mmkv().clear();
    // The keychain read now resolves, still carrying A.
    release();

    // It must be discarded, not cached and not used to create a file.
    await expect(inFlight).resolves.toBeNull();
    expect(disk().has(DB_NAME)).toBe(false);

    // And the next open, after re-onboarding, uses the new identity.
    setIdentity(IDENTITY_B);
    keychain().gate = null;
    expect(await db.ensureDb()).toBeTruthy();
    const keyB = disk().get(DB_NAME)!.key;

    const cold = coldStart();
    await expect(cold.ensureDb()).resolves.toBeTruthy();
    expect(disk().get(DB_NAME)!.key).toBe(keyB);
  });

  it('creates no database at all once the identity is gone', async () => {
    // Pins the PRECONDITION that signOut()'s ordering relies on, not the
    // ordering itself — this passes on the unfixed code too, and that is the
    // point: it is the property that must keep holding for deleting the keys
    // first to be worth anything. The ordering is asserted directly in
    // __tests__/signOutTeardownOrder.test.tsx.
    const db = coldStart();
    keychain().store.clear();

    await expect(db.ensureDb()).resolves.toBeNull();
    expect(disk().has(DB_NAME)).toBe(false);
  });
});

describe('clearAllSecureStorage drops the derived key too', () => {
  // Defence in depth: the cipher key must not outlive its identity even if
  // some future caller wipes secure storage without going through
  // clearAllMessages().
  it('leaves no key behind that could encrypt the next identity database', async () => {
    const db = coldStart();
    expect(await db.ensureDb()).toBeTruthy();
    const keyUnderA = disk().get(DB_NAME)!.key;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const secureStorage = require('../services/onboarding/secureStorage');
    await secureStorage.clearAllSecureStorage();
    expect(keychain().store.get(ED448_KEY)).toBeUndefined();

    // Re-onboard, then let something touch the database. The cached key from
    // A must be gone, so this has to land under B.
    setIdentity(IDENTITY_B);
    (globalThis as any).__disk.delete(DB_NAME);
    expect(await db.ensureDb()).toBeTruthy();
    expect(disk().get(DB_NAME)!.key).not.toBe(keyUnderA);
  });
});

describe('the cache still does its job', () => {
  // Control arm. Deleting the memoization entirely would make every test
  // above pass while reintroducing the 650-900ms Keystore read per save
  // that the cache exists to avoid.
  it('derives the cipher key from the keychain only once per session', async () => {
    const db = coldStart();
    await db.ensureDb();
    const readsAfterFirstOpen = keychain().reads;
    expect(readsAfterFirstOpen).toBe(1);

    await db.ensureDb();
    db.getMessagesSync({ spaceId: 'QmSpace', channelId: 'QmChannel' });
    db.isMigrationPending();

    expect(keychain().reads).toBe(readsAfterFirstOpen);
  });

  it('keeps the database readable across a Keystore desync', async () => {
    // A desync loses the stored key but the mnemonic re-derives the same
    // one, so the same HKDF output must still open the same file. The fix
    // must not turn "key temporarily unavailable" into "wipe the data".
    let db = coldStart();
    await db.ensureDb();
    const original = disk().get(DB_NAME)!.key;

    db = coldStart();
    await expect(db.ensureDb()).resolves.toBeTruthy();
    expect(disk().get(DB_NAME)!.key).toBe(original);
  });
});
