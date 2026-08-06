/**
 * How "no primary QNS name" is spelled, and why it is an empty string rather
 * than `undefined`.
 *
 * ## The sentinel
 *
 * A user elects one of their QNS names as *primary*, which makes it their
 * display name everywhere. Un-electing has to be expressible, and the obvious
 * way to write it — `updateProfile({ primaryUsername: undefined })` — is
 * silently undone by two separate `undefined`-means-absent checks on the way to
 * and from the synced config:
 *
 * 1. The write side only forwards a field to the config when it is
 *    `!== undefined`, so a clear never leaves the device.
 * 2. The read-back side merges with `??`, so even a config that HAD been
 *    cleared would fall back to the stale local value.
 *
 * Both are correct for a partial update — `undefined` genuinely does mean "this
 * update doesn't touch that field" there. So the clear needs a value that
 * *is* a value. Empty string is already what the rest of the identity code
 * means by "not set at this tier" (see `resolveSelfName` and the two-slot
 * roster merge), it is falsy so every `name ? … : …` check keeps working
 * untouched, and it survives both hops above.
 *
 * This matters more than it looks. The failure is invisible: un-electing
 * appears to work, the header falls back to the global name, and the old `.q`
 * comes back at the next login when config sync overlays it. Nothing logs, and
 * the user has no way to tell the difference between "it reverted" and "it
 * never applied".
 */

/**
 * The stored value meaning "I have not elected a primary QNS name".
 *
 * Always clear through this rather than writing `undefined` or `''` inline —
 * the choice is load-bearing (see above) and a bare `undefined` at a call site
 * reads as equally correct.
 */
export const NO_PRIMARY_NAME = '';

/**
 * Resolve the primary name when a synced config arrives from another device.
 *
 * `undefined` from the config means the field is absent — an older client, or a
 * config written before the field existed — so the local value stands. An
 * EMPTY STRING means the other device deliberately un-elected, and must win.
 *
 * This is `??` and not `||`, which is the entire point of naming it. The two
 * read identically at a glance and differ on exactly the value that carries an
 * un-election: `'' || local` resurrects the old name on every login, forever,
 * with nothing logged. Locking it behind a named function with a test means
 * that swap breaks something visible instead of quietly undoing un-elect.
 */
export function mergeSyncedPrimaryName(
  fromConfig: string | undefined,
  local: string | undefined,
): string | undefined {
  return fromConfig ?? local;
}

/** True when the user currently has a primary QNS name elected. */
export function hasPrimaryName(primaryUsername: string | undefined): boolean {
  return !!(primaryUsername ?? '').trim();
}
