/**
 * Bounded-retry tracker for undecryptable DM / device-inbox envelopes.
 *
 * Background: mobile never deletes an inbox envelope that fails to decrypt, so
 * a failed envelope replays on every connect forever — a monotonically growing
 * "hoard". When the hoard includes large init envelopes, the native
 * batchProcessMessages call hangs and freezes the whole receive drain until
 * restart.
 *
 * This tracker bounds the retry: an envelope that keeps failing is eventually
 * skipped from the native batch so it can neither re-freeze it nor grow the
 * hoard, WHILE still giving genuinely-transient failures several chances to
 * recover across reconnects. It is the middle ground between mobile's current
 * infinite retry (hoards) and desktop's delete-on-first-failure (black-holes
 * transient failures).
 *
 * Scope: DM / device-inbox envelopes only. Channel (hub-log) entries are NOT
 * tracked here — skipping one would gap the contiguous hub-log cursor advance.
 * See [[2026-07-23-bounded-retry-inbox-poison-skiplist]].
 */

import { createMMKV } from 'react-native-mmkv';

const storage = createMMKV({ id: 'quorum-inbox-attempts' });

/** Give up feeding an envelope to the decryptor after this many failed attempts. */
const MAX_DECRYPT_ATTEMPTS = 5;
/** An envelope still failing this long after it was sent is treated as dead. */
const MAX_ENVELOPE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const key = (inboxAddress: string, timestamp: number) => `${inboxAddress}/${timestamp}`;

export function getInboxAttempts(inboxAddress: string, timestamp: number): number {
  return storage.getNumber(key(inboxAddress, timestamp)) ?? 0;
}

/** Record one more failed decrypt attempt; returns the new count. */
export function recordInboxAttempt(inboxAddress: string, timestamp: number): number {
  const next = getInboxAttempts(inboxAddress, timestamp) + 1;
  storage.set(key(inboxAddress, timestamp), next);
  return next;
}

/**
 * Clear tracking on a successful decrypt. Keeps the tracker from becoming a
 * second hoard (only currently-failing envelopes ever hold a key) and resets a
 * transient failure that later recovered so it can never accrue toward the cap.
 */
export function clearInboxAttempt(inboxAddress: string, timestamp: number): void {
  storage.remove(key(inboxAddress, timestamp));
}

/**
 * Whether this envelope should be skipped from the native batch.
 *
 * SAFETY RULE: a never-attempted envelope is NEVER poison, regardless of age —
 * it always gets its first try. This protects a legitimate old DM waiting for a
 * user who was offline for a while: it arrives old but is still tried, decrypts,
 * and is delivered. The age cap only applies once we have already attempted the
 * envelope and seen it fail at least once.
 */
export function isInboxEnvelopePoisoned(inboxAddress: string, timestamp: number): boolean {
  const attempts = getInboxAttempts(inboxAddress, timestamp);
  if (attempts >= MAX_DECRYPT_ATTEMPTS) return true;
  if (attempts >= 1 && Date.now() - timestamp > MAX_ENVELOPE_AGE_MS) return true;
  return false;
}
