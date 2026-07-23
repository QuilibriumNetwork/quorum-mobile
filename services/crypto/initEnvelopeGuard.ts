/**
 * Staleness guard for Double Ratchet init envelopes — port of desktop's
 * quorum-desktop/src/utils/initEnvelopeGuard.ts (mechanism 3 of its solved
 * DM master report, shipped 2026-07-17).
 *
 * An init envelope replaces the receiver's session for its conversation,
 * unconditionally. The server redelivers any frame whose ack-by-delete
 * failed (502s observed live), so stale init envelopes act as mines: on a
 * reconnect they are replayed and each one silently replaces the CURRENT
 * healthy session with a resurrected zombie the sender no longer holds.
 * Confirmed live on mobile 2026-07-23: both of a desktop peer's sessions
 * toward this device were forked, killing all DM receipts (master report
 * §7b), with months of stale init envelopes replaying every connect.
 *
 * Rules (pure, unit-tested, same as desktop):
 * 1. No existing timestamps for the conversation → not stale (first init).
 * 2. Envelope timestamp EXACTLY equals a known timestamp → stale. Desktop
 *    keys its session rows by the envelope's own timestamp; mobile rows
 *    carry local Date.now, so the exact-match rule is fed by the separate
 *    installed-init record below instead.
 * 3. Envelope older than the newest known timestamp by more than the
 *    tolerance → stale. The tolerance absorbs clock-domain skew (rows
 *    updated by sends/receives carry local Date.now; envelope timestamps
 *    are server-assigned) without weakening the guard — observed zombies
 *    are hours to weeks older, far beyond any plausible skew.
 *
 * A genuine session reset always produces an envelope NEWER than every
 * row it replaces, so legitimate re-inits pass rules 2 and 3 untouched.
 */

import type { MMKV } from 'react-native-mmkv';

// Desktop uses 120s. Mobile needs a much wider window: state rows are
// re-stamped with local Date.now() on every save, and the receive drain can
// delay an envelope by several minutes (catch-up refloods; dev throttling) —
// observed live 2026-07-23: a legitimately fresh ack-as-init envelope surfaced
// ~2 minutes after send and was falsely refused under the 120s tolerance.
// The zombies this guard exists for are DAYS to WEEKS old, so 30 minutes
// keeps the full protection margin while absorbing worst-case drain latency.
export const INIT_ENVELOPE_STALENESS_TOLERANCE_MS = 30 * 60 * 1000;

export function isStaleInitEnvelope(
  envelopeTimestamp: number,
  existingTimestamps: number[],
  toleranceMs: number = INIT_ENVELOPE_STALENESS_TOLERANCE_MS
): boolean {
  if (existingTimestamps.length === 0) return false;
  if (existingTimestamps.includes(envelopeTimestamp)) return true;
  const newest = Math.max(...existingTimestamps);
  return envelopeTimestamp < newest - toleranceMs;
}

// ---------------------------------------------------------------------------
// Record of installed init-envelope timestamps, per conversation.
//
// Mobile's EncryptionState rows are stamped with local Date.now() (and are
// re-stamped on every ratchet advance), so rule 2's exact-match redelivery
// detection cannot key off them the way desktop's rows (stamped with the
// envelope timestamp) allow. This small MMKV record keeps the last few
// installed init-envelope timestamps per conversation so a redelivered
// envelope is recognized as stale even inside the skew tolerance window.
// Lazy-initialized so importing the pure function above doesn't touch MMKV
// (keeps it unit-testable under jest without a native module).
// ---------------------------------------------------------------------------

const MAX_RECORDED_INIT_TS = 20;

let storage: MMKV | null = null;
function getStorage(): MMKV {
  if (!storage) {
    // Lazy require: a static `import { createMMKV }` pulls in the native
    // nitro-modules chain, which breaks any jest suite that (transitively)
    // imports this module for the pure isStaleInitEnvelope function.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createMMKV } = require('react-native-mmkv') as typeof import('react-native-mmkv');
    storage = createMMKV({ id: 'quorum-init-envelope-guard' });
  }
  return storage;
}

const key = (conversationId: string) => `installed/${conversationId}`;

export function getInstalledInitEnvelopeTs(conversationId: string): number[] {
  const raw = getStorage().getString(key(conversationId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

export function recordInstalledInitEnvelopeTs(conversationId: string, timestamp: number): void {
  const list = getInstalledInitEnvelopeTs(conversationId);
  if (list.includes(timestamp)) return;
  list.push(timestamp);
  list.sort((a, b) => a - b);
  getStorage().set(key(conversationId), JSON.stringify(list.slice(-MAX_RECORDED_INIT_TS)));
}
