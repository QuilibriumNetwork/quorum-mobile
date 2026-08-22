/**
 * Clamp a timestamp that arrived on the wire before using it as a clock.
 *
 * ## Why a wire timestamp needs bounding at all
 *
 * Several receive paths use a sender-supplied timestamp to decide last-write-
 * wins: the newer value is applied, the older one is discarded. That is fine
 * while the timestamp is roughly honest. It stops being fine the moment you
 * notice the sender chooses it.
 *
 * A far-future value does not merely win once. It wins *forever*: it is written
 * into the stored row as the high-water mark, and every subsequent update —
 * including the rightful owner's own correction — is then refused by the same
 * comparison that let it in. One frame turns into a permanent state change,
 * with no path back that does not involve rebuilding the row from scratch.
 *
 * ## Why clamp rather than reject
 *
 * Rejecting a too-far-future timestamp needs a tolerance, and any tolerance is
 * arbitrary: too tight and an ordinary device with a fast clock has its genuine
 * updates dropped, too loose and the pin still works for the length of the
 * window. Clamping needs no threshold and fails in the harmless direction — a
 * skewed sender's update still applies, it just cannot claim to be from the
 * future.
 *
 * `Math.min` is the whole point, and the direction matters: it can only ever
 * pull a timestamp BACKWARD. A message that genuinely was created earlier keeps
 * its earlier stamp, so honest ordering between two real messages survives
 * untouched — including a message that sat in a queue and arrives late. Only
 * claims about the future are flattened.
 *
 * ## Prior art, and a duplicate worth consolidating
 *
 * `buildJoinedMemberRow` (services/space/joinedMemberRow.ts) already does
 * exactly this to a join's `joinedAt`, with its own private copy of both
 * functions and the same reasoning ("makes it impossible to pin a name forever
 * by claiming the year 3000"). It should adopt this module, and deliberately
 * does not do so here: consolidating it means touching the join path, and
 * `utils/deriveAddress.ts` makes the same call about its own five hand-rolled
 * copies for the same reason — not in the same change as security work.
 * Recorded rather than silently left, so the duplication is a known one-line
 * follow-up instead of drift nobody notices.
 *
 * Depends on nothing. Import it freely.
 */

/**
 * Rejects the shapes an unvalidated wire payload can put in a numeric field.
 *
 * Worth being explicit about the ones that are not merely absent: a NEGATIVE
 * number is truthy, so the common `value || Date.now()` idiom accepts it and
 * stores a nonsensical clock; `NaN` poisons every comparison it touches, making
 * both `>=` and `<` false so a row can neither be updated nor protected.
 */
export function isPlausibleTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * @param value the sender-supplied timestamp, entirely untrusted
 * @param now   the receiver's clock, injectable so callers stay testable
 * @returns `value` when it is plausible and not in the future, otherwise `now`
 */
export function clampWireTimestamp(value: unknown, now: number): number {
  return isPlausibleTimestamp(value) ? Math.min(value, now) : now;
}
