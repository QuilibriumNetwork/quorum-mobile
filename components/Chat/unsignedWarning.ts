/**
 * One predicate for "does this row get the unsigned-message warning?".
 *
 * WHY THIS IS ITS OWN MODULE: the rule was written out three times inside
 * MessagesList (header glyph, inline glyph, compact-row glyph). Three copies of
 * a security-facing claim is three chances for one of them to say something the
 * others don't, and the whole point of the glyph is that the user can trust it.
 * It also lives here so it can be unit-tested — the copies were inside a
 * component and only observable by rendering one.
 *
 * The rule, in order:
 *
 * 1. System and error rows are chrome, not messages from anyone. Nothing to say
 *    about their authorship.
 * 2. `signatureNotApplicable` — the transport has no per-message signature at
 *    all (Farcaster direct casts). "Unsigned" is not a verdict here, it is a
 *    category error: there is no signature to be missing. This has to be
 *    checked BEFORE the signature itself, because a naive
 *    `!originalMessage?.signature` reads every non-Quorum message as unsigned
 *    and told Farcaster users their messages "may not be from the sender".
 * 3. A present Quorum signature means signed. (Validity is settled upstream —
 *    an invalid signature never reaches the renderer, it is dropped on receive.)
 * 4. A message still in flight has not been signed *yet*; warning on it would
 *    flash a scare on every send.
 *
 * Anything left is a genuinely unsigned Quorum message — deniable-mode sends,
 * mostly — which is exactly what the glyph is for.
 */

import type { DisplayMessage } from './types';

export function shouldShowUnsignedWarning(item: DisplayMessage): boolean {
  if (item.renderType === 'system' || item.renderType === 'error') return false;
  if (item.signatureNotApplicable) return false;
  if (item.originalMessage?.signature) return false;
  if (item.sendStatus === 'sending' || item.sendStatus === 'failed') return false;
  return true;
}
