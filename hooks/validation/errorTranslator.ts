import {
  validateDisplayName,
  validateUserBio,
  MAX_BIO_BYTES,
  MAX_DISPLAY_NAME_BYTES,
  type FieldValidationResult,
} from '@quilibrium/quorum-shared';

/**
 * Translates shared validator `errorKey`s into mobile's English UI strings.
 *
 * The shared validators return a structured `{ ok, errorKey, errorVars }` result
 * instead of a hardcoded message, so each consuming app supplies its own copy.
 * Mobile keeps that mapping here, in one place.
 *
 * When mobile adopts a real i18n library later (e.g. Lingui), only this file
 * changes: the `messages` map becomes localized macro calls. Every call site
 * that uses `translateValidationResult` stays untouched.
 */

type Vars = Record<string, string | number> | undefined;

const messages: Record<string, (vars: Vars) => string> = {
  'spaceName.required': () => 'Space name is required',
  'spaceName.tooShort': vars => `Name must be at least ${vars!.min} characters`,
  'spaceName.tooLong': vars => `Name must be ${vars!.max} characters or less`,
  'spaceName.invalidChars': () => 'Space name cannot contain special characters',

  'spaceDescription.invalidChars': () => 'Description cannot contain special characters',
  'spaceDescription.tooLong': vars => `Description must be ${vars!.max} characters or less`,

  // Display name + bio limits are in UTF-8 BYTES (Farcaster-aligned), which
  // are meaningless to users — so the "too long" copy shows no number, matching
  // desktop's displayName.tooLong / userBio.tooLong.
  'displayName.required': () => 'Display name is required',
  'displayName.tooLong': () => 'Display name is too long',
  'displayName.invalidChars': () => 'Display name cannot contain special characters',
  'displayName.reservedMention': () => 'That name is reserved',
  'displayName.reservedImpersonation': () => 'That name is not allowed',
  'displayName.reservedQnsSuffix': () => 'A name ending in ".q" is reserved for verified QNS names',

  'userBio.tooLong': () => 'Bio is too long',
  'userBio.invalidChars': () => 'Bio cannot contain special characters',
};

/**
 * Map a single shared validation result to a UI string, or `undefined` when valid.
 * Falls back to the raw `errorKey` if no translation is registered (so a missing
 * entry surfaces visibly in dev rather than silently swallowing the error).
 */
export function translateValidationResult(result: FieldValidationResult): string | undefined {
  if (result.ok) return undefined;
  return messages[result.errorKey]?.(result.errorVars) ?? result.errorKey;
}

/**
 * Map an array of results (from multi-result validators like `validateSpaceDescription`)
 * to UI strings, dropping the valid ones. Returns the first message via the callers'
 * `[0] ?? null` pattern at the use site.
 */
export function translateValidationResults(results: FieldValidationResult[]): string[] {
  return results
    .map(translateValidationResult)
    .filter((s): s is string => s !== undefined);
}

/**
 * Live (per-keystroke) validation for a display name. Returns a UI error string
 * or `undefined` when valid. Empty/whitespace-only is treated as valid (an empty
 * display name is a deliberate "use my global/QNS name" clear), so the user isn't
 * nagged with "required" while typing. Matches desktop, which validates the
 * display name continuously rather than only on save.
 */
export function displayNameLiveError(value: string): string | undefined {
  if (!value.trim()) return undefined;
  return translateValidationResult(validateDisplayName(value.trim()));
}

/**
 * Live (per-keystroke) validation for a bio. Returns the first UI error string
 * or `undefined` when valid. Empty is valid (clears the bio).
 */
export function bioLiveError(value: string): string | undefined {
  if (!value.trim()) return undefined;
  return translateValidationResults(validateUserBio(value.trim()))[0];
}

// ── Byte-accurate input caps ─────────────────────────────────────────────────
// The display-name / bio limits are in UTF-8 BYTES (to match Farcaster's
// USER_DATA caps so a Quorum profile merges cleanly). React Native's TextInput
// `maxLength` counts UTF-16 code units, not bytes, so it can't enforce a byte
// budget. We hard-cap the input by bytes in onChangeText instead — a silent
// truncate, which is kinder on mobile than making the user hunt-and-delete to
// get under the limit. The limit CONSTANTS come from quorum-shared (the
// cross-platform contract); only the truncation is mobile-local (shared has no
// byte-truncate, and trimming an input field is a UI concern, not validation).

const encoder = new TextEncoder();

/**
 * Return the longest prefix of `text` that fits within `maxBytes` UTF-8 bytes,
 * never splitting a multi-byte character. Fast path: if it already fits, return
 * it unchanged (no allocation).
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (encoder.encode(text).length <= maxBytes) return text;
  // Walk by code points (the spread handles surrogate pairs / emoji correctly),
  // accumulating until the next char would overflow the byte budget.
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    const chBytes = encoder.encode(ch).length;
    if (bytes + chBytes > maxBytes) break;
    bytes += chBytes;
    out += ch;
  }
  return out;
}

/** Hard-cap a display-name input to MAX_DISPLAY_NAME_BYTES (UTF-8 bytes). */
export function capDisplayName(text: string): string {
  return truncateToBytes(text, MAX_DISPLAY_NAME_BYTES);
}

/** Hard-cap a bio input to MAX_BIO_BYTES (UTF-8 bytes). */
export function capBio(text: string): string {
  return truncateToBytes(text, MAX_BIO_BYTES);
}
