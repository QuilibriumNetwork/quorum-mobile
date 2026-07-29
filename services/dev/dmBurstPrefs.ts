/**
 * dmBurstPrefs — persisted letter-prefix counter for the dev-only DM test
 * burst tool (T2 of the transport-debugging tool suite).
 *
 * Mirrors the MMKV pattern in services/theme/skinPrefs.ts. Each burst run
 * sends `"<letter> 1"` … `"<letter> N"`; this store remembers the last letter
 * used so the next run defaults to the following one and two rounds never
 * collide on the same prefix. The actual next-letter logic lives in the
 * dependency-free ./dmBurstPrefix so it stays unit-testable without a native
 * module in the loop.
 */

import { createMMKV } from 'react-native-mmkv';
import { isValidBurstPrefix, nextBurstPrefix } from './dmBurstPrefix';

export const dmBurstPrefsStore = createMMKV({ id: 'quorum-dev-dm-burst-prefs' });

const K_LAST_LETTER = 'lastLetter';

/** Suggested next burst-test letter, persisted across runs/app restarts. */
export function getSuggestedBurstPrefix(): string {
  return nextBurstPrefix(dmBurstPrefsStore.getString(K_LAST_LETTER));
}

/** Persists `letter` as the most recently used burst-test prefix. No-ops on
 *  anything that isn't a single A-Z letter (defensive; callers validate too). */
export function markBurstPrefixUsed(letter: string): void {
  if (!isValidBurstPrefix(letter)) return;
  dmBurstPrefsStore.set(K_LAST_LETTER, letter.trim().toUpperCase());
}
