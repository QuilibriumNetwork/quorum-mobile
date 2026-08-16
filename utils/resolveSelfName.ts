import { formatResolvedName, type ResolvedMemberName } from '@/identity/useResolvedName';

/**
 * Your OWN name, for the surfaces that render you from the live auth profile
 * rather than from a roster row.
 *
 * Sibling of `resolveMemberName`, which is the rule for everybody else. They
 * are separate because the inputs are: another member resolves from a stored
 * row (per-space override, global slot, QNS name arriving with their public
 * profile), while your own profile screen has your live in-memory `UserInfo`
 * and no roster at all.
 *
 * ## The `.q` does NOT come from here
 *
 * This function used to compose `${user.primaryUsername}.q` itself, trusting
 * that field as though it were already verified. It is not: `primaryUsername`
 * is a CLAIM a member broadcasts, and the ONLY place allowed to turn a claim
 * into a rendered `.q` is `identity/`'s ladder, after `claimedNameBelongsTo`
 * has checked it resolves back to the claiming address (same rule as every
 * other member — see `identity/identityProvider.tsx`). So this function no
 * longer reads `primaryUsername` at all; it structurally cannot produce a
 * `.q`, for self or anyone a future caller might hand it.
 *
 * The `.q` tier now lives in `selfNamePlaceholder`'s `resolvedSelf` parameter,
 * which the caller must obtain from `identity/` itself
 * (`useResolvedMemberName(selfAddress, { global: true })` — self has no
 * per-space tier, so `global: true` always, unlike `resolveMemberName`).
 *
 * ## What THIS function still does
 *
 *   global display name  →  "Unnamed"
 *
 * The global display name needs no verification — it makes no ownership
 * claim the way a QNS name does — so reading it straight off the live
 * `UserInfo` remains safe and is unchanged from before.
 */

export interface SelfNameInput {
  displayName?: string;
}

export interface ResolvedSelfName {
  /** What to render. */
  label: string;
  /**
   * The name an avatar placeholder should derive initials from — the BARE
   * name. `getInitials` splits on non-letters, so a caller appending `.q`
   * itself must never feed the result back in with the suffix attached.
   */
  initialsSource: string;
  /**
   * Always `false`: this function never resolves a QNS tier, so it can never
   * be the one claiming a name is verified. Kept on the type so callers that
   * combine this with a REAL verified result (see `selfNamePlaceholder`)
   * share one result shape.
   */
  isQnsVerified: boolean;
}

/**
 * The placeholder for a per-space name field, e.g. Space Settings → Account.
 *
 * ## A placeholder here is a PROMISE, not decoration
 *
 * Leaving the field empty is the default and means "follow my normal name".
 * The placeholder is how the user is told what that resolves to — so it has to
 * be the name the app would ACTUALLY render, or it is simply untrue.
 *
 * It was `displayName || username`, which got that wrong twice:
 *
 * - It ranked the global name above the QNS name, so a user who had elected
 *   `alice.q` saw a field promising `Alice` while every surface in the app
 *   showed them as `alice.q`. The one screen whose job is to explain the rule
 *   was the screen contradicting it.
 * - `username` is the DEPRECATED alias of `primaryUsername` (see `UserInfo`),
 *   so the QNS name only ever appeared here via a field nothing writes any
 *   more, and then only when no global name existed at all.
 *
 * Kept as a last-resort rung rather than deleted, so a user whose profile still
 * carries the old field does not lose their placeholder entirely.
 *
 * `emptyLabel` is the caller's copy for "we have no name for you", e.g.
 * "Your name in this space" — deliberately NOT `resolveSelfName`'s "Unnamed",
 * which is a rendered name and would read as though it were already your name.
 *
 * ## Where the `.q` comes from
 *
 * `resolvedSelf` is the ONLY source of the suffix — pass the caller's own
 * `useResolvedMemberName(selfAddress, { global: true })` result (or `null`
 * before an address exists). This function only ever renders a `.q` when
 * `resolvedSelf.isQnsVerified` is `true`, a flag `identity/` sets exclusively
 * after checking the claim resolves back to that exact address. There is no
 * code path here that composes a `.q` from a raw field, for self or for
 * anyone a future caller might pass instead — see `__tests__/resolveSelfName.test.ts`
 * for the case this forecloses.
 */
export function selfNamePlaceholder(
  resolvedSelf: ResolvedMemberName | null,
  // `null` as well as `undefined`: the auth context types its user as
  // `UserInfo | null`, and making the caller narrow it would just move the
  // no-user case out of the one function that already has an answer for it.
  user: (SelfNameInput & { username?: string }) | null | undefined,
  emptyLabel: string,
): string {
  // `formatResolvedName` — imported, not re-implemented — is the one place
  // the `.q` suffix is spelled out anywhere in the app (see its own
  // docstring). Duplicating `${name}.q` here would be a second place for
  // that suffix logic to drift from `<MemberName>`'s.
  if (resolvedSelf?.isQnsVerified) return formatResolvedName(resolvedSelf);

  const hasName = !!(user?.displayName ?? '').trim();
  if (hasName) return resolveSelfName(user!).label;

  return (user?.username ?? '').trim() || emptyLabel;
}

export function resolveSelfName(user: SelfNameInput): ResolvedSelfName {
  // Empty string means "not set at this tier" throughout the identity code, so
  // a whitespace-only name must fall through rather than blank the header.
  const global = (user.displayName ?? '').trim();
  if (global) {
    return { label: global, initialsSource: global, isQnsVerified: false };
  }

  return { label: 'Unnamed', initialsSource: 'Unnamed', isQnsVerified: false };
}
