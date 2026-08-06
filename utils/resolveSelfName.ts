/**
 * Your OWN name, for the surfaces that render you from the live auth profile
 * rather than from a roster row.
 *
 * Sibling of `resolveMemberName`, which is the rule for everybody else. They
 * are separate because the inputs are: another member resolves from a stored
 * row (per-space override, global slot, QNS name arriving with their public
 * profile), while your own profile screen has your live in-memory `UserInfo`
 * and no roster at all. The ORDER is the same, and must stay that way.
 *
 * ## The rule
 *
 *   QNS `.q` name  →  global display name  →  "Unnamed"
 *
 * A primary QNS name REPLACES the global display name — it is not a decoration
 * shown alongside it. That is the whole meaning of electing one primary: you
 * are saying this is what you go by. Every other surface already behaves that
 * way because shared's `resolveDisplayName` ranks `primary_username` above
 * `display_name`.
 *
 * The profile header used to compute `displayName || primaryUsername` inline in
 * three separate layouts, which inverts it: the global name won and the `.q`
 * was demoted to a small line underneath. Your own profile was the one screen
 * in the app disagreeing with the rule about who you are.
 *
 * Note there is no per-space tier here, and that is correct rather than an
 * omission — the profile screen is not inside a space. A per-space name still
 * outranks the `.q` where a space exists; see `resolveMemberName`.
 *
 * ## What this does NOT do
 *
 * It does not delete or hide the global display name, only unrank it. The name
 * stays in the edit sheet because it is still doing real work:
 *
 * - A `.q` travels ONLY in a published public profile. With a private profile
 *   nobody else can see yours, so the global name is what they render you as.
 *   Removing it would leave those people with an address.
 * - A QNS name can be transferred away or un-elected, and the global name is
 *   what you fall back to.
 */

export interface SelfNameInput {
  primaryUsername?: string;
  displayName?: string;
}

export interface ResolvedSelfName {
  /** What to render. Carries the `.q` suffix when the QNS name won. */
  label: string;
  /**
   * The name an avatar placeholder should derive initials from — the BARE name,
   * without the `.q`. `getInitials` splits on non-letters, so handing it
   * "gatto.q" yields two initials from one name.
   */
  initialsSource: string;
  /** True when `label` is the QNS name, for call sites that style it. */
  isQnsVerified: boolean;
}

export function resolveSelfName(user: SelfNameInput): ResolvedSelfName {
  const qns = (user.primaryUsername ?? '').trim();
  if (qns) {
    return { label: `${qns}.q`, initialsSource: qns, isQnsVerified: true };
  }

  // Empty string means "not set at this tier" throughout the identity code, so
  // a whitespace-only name must fall through rather than blank the header.
  const global = (user.displayName ?? '').trim();
  if (global) {
    return { label: global, initialsSource: global, isQnsVerified: false };
  }

  return { label: 'Unnamed', initialsSource: 'Unnamed', isQnsVerified: false };
}
