/**
 * Pure next-prefix suggestion + validation logic for the dev-only DM test
 * burst tool (T2). Split out from dmBurstPrefs.ts (which wraps this with
 * MMKV persistence) so it can be unit-tested without touching a native
 * module — importing react-native-mmkv triggers its native constructor at
 * module load time, which isn't available under jest.
 */

/** Persisted/typed burst prefix: 1-3 letters or digits (e.g. "A", "AA", "R2", "ZZ9"). */
const VALID_PREFIX_RE = /^[A-Z0-9]{1,3}$/;
/** Only the pure-letter subset participates in the auto-suggestion sequence. */
const LETTERS_ONLY_RE = /^[A-Z]{1,3}$/;

/**
 * Given the last-used prefix (or null/undefined/unrecognized for "never
 * used"), returns the next unused letter prefix, spreadsheet-column style:
 * A → B → … → Y → Z → AA → AB → … → AZ → BA → … A value containing a digit
 * (or anything else unrecognized) falls back to "A", same as "never used".
 */
export function nextBurstPrefix(lastUsed: string | null | undefined): string {
  const upper = lastUsed?.trim().toUpperCase() ?? '';
  if (!LETTERS_ONLY_RE.test(upper)) return 'A';
  return incrementLetters(upper);
}

/**
 * Bijective base-26 increment (A=1 … Z=26, AA=27 … ) — the same scheme
 * spreadsheet column names follow, so it composes cleanly: Z → AA, AZ → BA.
 */
function incrementLetters(letters: string): string {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 65 + 1);
  }
  n += 1;

  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

/** True for 1-3 letters/digits (case-insensitive), trimmed of whitespace. */
export function isValidBurstPrefix(prefix: string): boolean {
  const upper = prefix.trim().toUpperCase();
  return VALID_PREFIX_RE.test(upper);
}
