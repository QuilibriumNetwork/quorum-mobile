import { logger, type Message } from '@quilibrium/quorum-shared';
import { createMMKV, type MMKV } from 'react-native-mmkv';
import { truncateAddress } from '@/utils/formatAddress';

/**
 * The DM reveal ledger: "this device's user has DELIBERATELY messaged this
 * partner at least once."
 *
 * This is the product's DM privacy rule made storable: you do not see
 * someone's name/pfp unless they deliberately messaged you, and consent
 * belongs to the RELATIONSHIP, not the session — once given, any new
 * device/session of the partner may be answered immediately.
 *
 * Set ONLY by deliberate sends (a chat/embed send, or the initiating side of
 * a new conversation). Never by receipts, typing, or any automatic frame.
 * Consulted by every identity emission: the broadcast sweep, the
 * reveal-on-reply trigger, and the inbound-new-session auto-announce.
 *
 * FAILS CLOSED: a storage error reads as "not revealed". Deliberately the
 * opposite of the send-gates (which fail open, because their risk is a
 * harmless duplicate push; ours is a privacy leak).
 *
 * Per-device by design. A device that never sent a message here treats the
 * partner as unrevealed until its own first deliberate send — worst case a
 * friend waits for one reply from THIS device, never a leak.
 */

let store: MMKV | null = null;
function getStore(): MMKV {
  if (!store) store = createMMKV({ id: 'quorum-dm-reveal-ledger' });
  return store;
}

/**
 * An empty string is never a real address, and treating it as one would let
 * two unrelated bad calls (e.g. an address read before auth finished
 * resolving) collide on the exact same ledger key. Reject it at every entry
 * point rather than assuming callers only ever pass a real address —
 * Tasks 5-7 route caller-supplied strings through these functions, and the
 * one thing this module cannot afford is discovering that assumption was
 * wrong from a leak instead of a refusal.
 */
function isUsableIdentifier(value: string): boolean {
  return value.length > 0;
}

/**
 * INVARIANT: key(self, partner) must be injective — two different (self,
 * partner) pairs must never produce the same stored key, or a reveal
 * recorded for one pair would silently read back as `true` for an unrelated
 * pair. That is a fail-OPEN path in the one module whose entire purpose is
 * to fail CLOSED.
 *
 * A hand-rolled `${self}:${partner}` template is NOT injective over
 * arbitrary strings: self="A", partner="B:C" and self="A:B", partner="C"
 * both produce "A:B:C". Real addresses are base58 multihashes, which exclude
 * ':', so this was not exploitable today — but nothing enforced that, and an
 * unenforced assumption about caller input is exactly the class of bug this
 * module exists to close off, not repeat.
 *
 * JSON-array encoding is injective for arbitrary strings by construction: an
 * unescaped '"' always closes a JSON string, and JSON.stringify on an array
 * joins elements with a literal ',' outside any string's quotes, so the
 * boundary between self and partner can never be ambiguous. This is proved
 * by the JSON grammar, not by scanning input for a forbidden character — a
 * validator has to enumerate every dangerous character and stays only as
 * safe as that enumeration; this has none to enumerate.
 */
const key = (self: string, partner: string) => JSON.stringify([self, partner]);

// The structural prefix of every key(self, <anything>) — safe for
// `startsWith` because JSON.stringify(self) is unique to that exact string
// (same injectivity argument as above), so this prefix cannot be produced by
// any other self and cannot turn a scoped sweep into a broader one.
const selfPrefix = (self: string) => `[${JSON.stringify(self)},`;

// In-memory memo so a hot path (broadcast sweep, list render) never re-reads
// MMKV for the same pair in one session. Positive AND negative memos are safe
// here because recordReveal updates both layers.
const memo = new Map<string, boolean>();

export function hasRevealedTo(selfAddress: string, partnerAddress: string): boolean {
  if (!isUsableIdentifier(selfAddress) || !isUsableIdentifier(partnerAddress)) return false;
  const k = key(selfAddress, partnerAddress);
  const m = memo.get(k);
  if (m !== undefined) return m;
  try {
    const v = getStore().getString(k) != null;
    memo.set(k, v);
    return v;
  } catch {
    return false; // fail CLOSED — never memoized, so recovery re-reads
  }
}

export function recordReveal(selfAddress: string, partnerAddress: string, now: number): void {
  // A malformed identifier can never be a real relationship — refuse the
  // write rather than store a record under a key nothing legitimate can
  // ever look up by its real address.
  if (!isUsableIdentifier(selfAddress) || !isUsableIdentifier(partnerAddress)) return;
  const k = key(selfAddress, partnerAddress);
  try {
    getStore().set(k, JSON.stringify({ at: now }));
    memo.set(k, true);
  } catch (e) {
    // Storage failed: memo only. The reveal re-derives from message history
    // next launch (the reply that set it IS the history).
    memo.set(k, true);
    // A systematic MMKV failure would otherwise degrade every device to
    // bootstrap-only reveals (re-deriving from history on every launch) with
    // no signal that anything is wrong. Truncated: a raw full address is
    // identity-bearing, and debug logs get pasted into issues and chats.
    logger.warn(
      `[DMRevealLedger] write failed for ${truncateAddress(partnerAddress)} — reveal stays memo-only this session`,
      e instanceof Error ? e.message : e,
    );
  }
}

export function clearReveal(selfAddress: string, partnerAddress?: string): void {
  // A malformed self can hold no legitimate record (recordReveal already
  // refuses to write one under it), so refuse outright rather than compute a
  // prefix sweep from it. Over-clearing would be safe for privacy but not
  // for correctness — it would destroy real consent records for a self that
  // never actually held any degenerate ones — and a flat refusal is simpler
  // to reason about than trusting the prefix math to stay narrow for every
  // possible malformed input, now and after future edits.
  if (!isUsableIdentifier(selfAddress)) return;
  try {
    const s = getStore();
    if (partnerAddress) {
      s.remove(key(selfAddress, partnerAddress));
      memo.delete(key(selfAddress, partnerAddress));
      return;
    }
    const prefix = selfPrefix(selfAddress);
    for (const k of s.getAllKeys()) {
      if (k.startsWith(prefix)) s.remove(k);
    }
    for (const k of Array.from(memo.keys())) {
      if (k.startsWith(prefix)) memo.delete(k);
    }
  } catch {
    memo.clear();
  }
}

/**
 * Pure: does this page of a DM's history contain a message we authored?
 *
 * ⚠️ `content.senderId` IS NOT EVIDENCE AND IS NOT READ HERE. It is plaintext
 * the sending client writes, and the receive path persists it verbatim, so a
 * stranger can store a row on this device whose payload names US as the author.
 * While this function read that field, one such message flipped the ledger and
 * the next profile sweep handed the attacker the victim's real name. MEASURED
 * on desktop 2026-08-20 against the production relay; mobile carried the
 * identical scan.
 *
 * The only field consulted is `authenticatedSenderId`, stamped at persist time
 * from what the crypto layer authenticated and never taken off the wire (see
 * `Message.authenticatedSenderId` in quorum-shared, and the two stamps in
 * WebSocketContext, both written AFTER the spread of the wire message so a
 * forged payload value cannot survive).
 *
 * ⚠️ ABSENT MEANS UNKNOWN, NOT SAFE. Rows written before the marker existed
 * carry nothing and cannot prove authorship. Fail-safe by design: the cost is a
 * partner waiting for one more deliberate send from this device, which is the
 * per-device posture this module already documents above.
 */
export function messagesContainSelfAuthored(
  // `Partial<Message>` rather than `{ authenticatedSenderId?: string }`: an
  // all-optional type sharing NO property names with `Message` trips
  // TypeScript's weak-type detection, so a real `Message[]` out of storage
  // would not be assignable. Sharing the names keeps both that and the bare
  // `{ authenticatedSenderId }` objects the tests pass working.
  messages: readonly Partial<Message>[],
  selfAddress: string,
): boolean {
  if (!isUsableIdentifier(selfAddress) || !Array.isArray(messages)) return false;
  return messages.some((m) => m?.authenticatedSenderId === selfAddress);
}

/** How much history the one-time bootstrap scans. One page, newest-first: a
 *  real relationship has a self-authored message in its recent window; an
 *  inbound-only stranger row has none at any depth. */
const BOOTSTRAP_SCAN_LIMIT = 200;

/**
 * Ledger check with one-time derivation from local history, for
 * conversations that predate the ledger. DM messages are stored under
 * (spaceId = partner, channelId = partner). Negative results are never
 * persisted — a later reply flips the answer through recordReveal.
 */
export async function ensureRevealBootstrap(
  selfAddress: string,
  partnerAddress: string,
  getMessages: (p: {
    spaceId: string;
    channelId: string;
    limit?: number;
  }) => Promise<{ messages: Partial<Message>[] }>,
): Promise<boolean> {
  if (hasRevealedTo(selfAddress, partnerAddress)) return true;
  try {
    const { messages } = await getMessages({
      spaceId: partnerAddress,
      channelId: partnerAddress,
      limit: BOOTSTRAP_SCAN_LIMIT,
    });
    if (messagesContainSelfAuthored(messages, selfAddress)) {
      recordReveal(selfAddress, partnerAddress, Date.now());
      return true;
    }
    return false;
  } catch {
    return false; // fail CLOSED
  }
}
