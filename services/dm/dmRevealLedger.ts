import { createMMKV, type MMKV } from 'react-native-mmkv';

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

const key = (self: string, partner: string) => `${self}:${partner}`;

// In-memory memo so a hot path (broadcast sweep, list render) never re-reads
// MMKV for the same pair in one session. Positive AND negative memos are safe
// here because recordReveal updates both layers.
const memo = new Map<string, boolean>();

export function hasRevealedTo(selfAddress: string, partnerAddress: string): boolean {
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
  const k = key(selfAddress, partnerAddress);
  try {
    getStore().set(k, JSON.stringify({ at: now }));
    memo.set(k, true);
  } catch {
    // Storage failed: memo only. The reveal re-derives from message history
    // next launch (the reply that set it IS the history).
    memo.set(k, true);
  }
}

export function clearReveal(selfAddress: string, partnerAddress?: string): void {
  try {
    const s = getStore();
    if (partnerAddress) {
      s.remove(key(selfAddress, partnerAddress));
      memo.delete(key(selfAddress, partnerAddress));
      return;
    }
    const prefix = `${selfAddress}:`;
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

/** Pure: does this page of a DM's history contain a message we authored? */
export function messagesContainSelfAuthored(
  messages: readonly { content?: { senderId?: string } }[],
  selfAddress: string,
): boolean {
  return messages.some((m) => m?.content?.senderId === selfAddress);
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
  }) => Promise<{ messages: { content?: { senderId?: string } }[] }>,
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
