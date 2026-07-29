/**
 * Pure next-letter suggestion logic for the dev-only DM test burst tool (T2).
 * Split out from dmBurstPrefs.ts (which wraps this with MMKV persistence) so
 * it can be unit-tested without touching a native module — importing
 * react-native-mmkv triggers its native constructor at module load time,
 * which isn't available under jest.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Given the last-used letter (or null/undefined/unrecognized for "never
 * used"), returns the next unused single letter, cycling A → Z → A.
 */
export function nextBurstPrefix(lastUsed: string | null | undefined): string {
  const upper = lastUsed?.trim().toUpperCase() ?? '';
  // Guard the length: String.indexOf matches substrings, so a stray
  // multi-char value (e.g. "AB") would otherwise match ALPHABET at index 0
  // instead of falling through to the "unrecognized" case.
  const idx = upper.length === 1 ? ALPHABET.indexOf(upper) : -1;
  if (idx === -1) return ALPHABET[0];
  return ALPHABET[(idx + 1) % ALPHABET.length];
}

/** True for a single A-Z letter (case-insensitive). */
export function isValidBurstPrefix(letter: string): boolean {
  const upper = letter.trim().toUpperCase();
  return upper.length === 1 && ALPHABET.indexOf(upper) !== -1;
}
