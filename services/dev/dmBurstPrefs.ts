/**
 * dmBurstPrefs — persisted prefix counter for the dev-only DM test burst
 * tool (T2 of the transport-debugging tool suite).
 *
 * Mirrors the MMKV pattern in services/theme/skinPrefs.ts. Each burst run
 * sends `"<prefix> 1"` … `"<prefix> N"`; this store remembers the last prefix
 * used so the next run defaults to the following one and two rounds never
 * collide on the same prefix. The actual next-prefix logic lives in the
 * dependency-free ./dmBurstPrefix so it stays unit-testable without a native
 * module in the loop. Prefixes are 1-3 letters/digits (e.g. "A", "AA", "R2").
 */

import { createMMKV } from 'react-native-mmkv';
import { isValidBurstPrefix, nextBurstPrefix } from './dmBurstPrefix';

export const dmBurstPrefsStore = createMMKV({ id: 'quorum-dev-dm-burst-prefs' });

const K_LAST_LETTER = 'lastLetter';

/** Suggested next burst-test prefix, persisted across runs/app restarts. */
export function getSuggestedBurstPrefix(): string {
  return nextBurstPrefix(dmBurstPrefsStore.getString(K_LAST_LETTER));
}

/** Persists `prefix` as the most recently used burst-test prefix. No-ops on
 *  anything that isn't a valid 1-3 char letter/digit prefix (defensive;
 *  callers validate too). */
export function markBurstPrefixUsed(prefix: string): void {
  if (!isValidBurstPrefix(prefix)) return;
  dmBurstPrefsStore.set(K_LAST_LETTER, prefix.trim().toUpperCase());
}
