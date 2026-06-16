import type { FieldValidationResult } from '@quilibrium/quorum-shared';

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
