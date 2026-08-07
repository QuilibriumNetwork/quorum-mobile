/**
 * Mobile adapter over the shared `resolveDisplayName` rule.
 *
 * There is ONE rule for which name a member shows, it lives in
 * `@quilibrium/quorum-shared`, and every mobile surface goes through this file
 * to reach it. Before this existed, four screens each had their own partial
 * ladder and the same member rendered differently depending on which one you
 * were looking at: name and avatar on their messages, a bare address in the
 * member list, in the same space at the same moment.
 *
 * ## The ladder
 *
 *   per-space override  →  QNS `.q` name  →  global slot  →  self  →  address
 *
 * Shared owns the ordering of the first three. The last two are mobile's, for
 * reasons worth stating so nobody "simplifies" them away:
 *
 * - **self** — for your OWN row your live in-memory profile is authoritative
 *   and free. It is what makes a space created AFTER your last profile save
 *   render its owner correctly with no network call. Desktop has no equivalent
 *   tier; if it is ever promoted into shared, delete it here.
 * - **address** — shared's fallback is a naive `slice(0,6)…slice(-4)`, which is
 *   not Qm-aware. Mobile's `truncateAddress` counts entropy characters AFTER
 *   the constant `Qm` prefix and is already parity-matched with desktop, so the
 *   last rung stays local. Handing this to shared would silently regress every
 *   address label in the app.
 *
 * ## Two slots, not one
 *
 * A roster row carries the per-space OVERRIDE (`display_name` / `name` /
 * `profile_image`) separately from the GLOBAL slot (`global_display_name` /
 * `global_profile_image`). Empty override means "follow global", which is the
 * default, so a resolver that reads only the override renders most members as
 * addresses. That is exactly the bug this file fixes at the reaction and
 * mention surfaces.
 *
 * ## An override that merely ECHOES the global name is not a per-space name
 *
 * A roster row cannot say whether its override was chosen for this space or is
 * just the member's global name copied in. So when the two are equal we treat
 * the override as an echo and let the ladder continue to the QNS name, matching
 * desktop's `resolveSpaceMemberName`.
 *
 * This comment previously said the opposite — that the check was unnecessary
 * because "the override slot is no longer stamped at join". That was false the
 * whole time it was written: both join paths and config sync stamped the
 * joiner's GLOBAL name straight into the override, so merely joining a space
 * froze that name above the member's `.q` forever. Those writes now target the
 * global slot, and this check heals the rows they already left behind.
 *
 * **The trade, taken deliberately:** a member who genuinely chose a per-space
 * name identical to their global one has it demoted here. The rendered string
 * only differs if they also have a `.q`, in which case the `.q` wins — and
 * there is no way to tell that case from the echo, because the stored data is
 * byte-identical. Desktop accepts the same trade.
 *
 * **What it does NOT heal:** a row whose override was stamped at join and whose
 * owner has since renamed globally. The override is then a STALE echo that no
 * longer equals the global name, so it still reads as deliberate. That gap is
 * pre-existing and decays as rows are rewritten; the write-side fix stops it
 * growing.
 *
 * ## Avatars are not names
 *
 * `quorum-shared` has a rule for names only. The avatar ladder is separate,
 * lives in `resolveMemberAvatar` below, and has NO QNS step, because a `.q`
 * name carries no picture. Do not merge the two.
 */

import { hasReservedQnsSuffix, resolveDisplayName } from '@quilibrium/quorum-shared';
import { truncateAddress } from './formatAddress';

export interface ResolvedMemberName {
  /** The name to display. Never empty. */
  name: string;
  /** True only when `name` is the QNS username — render it with a `.q` suffix. */
  isQnsVerified: boolean;
  /**
   * True when every tier missed and `name` is the truncated address, i.e. we do
   * not actually know who this is. Call sites that treat "no name" differently
   * from "a name" — avatar initials, search text, mention matching — should read
   * this rather than string-comparing `name` against the address.
   */
  isAddressFallback: boolean;
}

/**
 * The identity fields a roster row carries. Deliberately a loose shape: rows
 * reach the UI from several queries and not all of them declare the two-slot
 * fields on their static type.
 */
export interface ResolvableMember {
  address: string;
  /** Per-space OVERRIDE slot. Non-empty means a deliberate per-space name. */
  display_name?: string | null;
  /** SDK wire alias sitting in the same override tier as `display_name`. */
  name?: string | null;
  /** GLOBAL slot — the member's global name, pushed into the roster. */
  global_display_name?: string | null;
  /** Per-space OVERRIDE avatar. */
  profile_image?: string | null;
  /** GLOBAL slot avatar. */
  global_profile_image?: string | null;
  /** QNS `.q` name. Travels only with the public profile, never in messages. */
  primary_username?: string | null;
}

/** The viewer's own live profile, used only for the viewer's own row. */
export interface SelfIdentity {
  address?: string;
  displayName?: string;
  username?: string;
  profileImage?: string;
}

const present = (s?: string | null): string | undefined => {
  const t = (s ?? '').trim();
  return t.length ? t : undefined;
};

/**
 * A stored display name that would forge the verified-QNS marker is not a name.
 *
 * `.q` is a trust marker: it is appended at render ONLY for a name that came
 * from the QNS tier, and display names are forbidden from ending in `.q` for
 * exactly that reason. But `validateDisplayName` runs on the four local text
 * inputs and NOWHERE on receive, so a modified client could broadcast a display
 * name of `alice.q` and every recipient would render it identically to a real
 * one — `isQnsVerified` is not surfaced anywhere, so the suffix is the only
 * signal there is.
 *
 * Enforced here, at the single choke point every name surface goes through,
 * rather than at each of the several write paths. That covers rows already
 * stored with a forged name, and cannot be bypassed by a write path added later
 * or one this fix missed.
 *
 * Dropping rather than stripping: a name that tried to forge the marker has
 * told us what it is, and falling through to the next tier is the fail-closed
 * choice. Stripping would render it as somebody else's bare name instead.
 *
 * Shared's helper, not a local `endsWith`, so this and the input validator can
 * never disagree — it also folds confusable Unicode dots, which a hand-rolled
 * check would miss.
 *
 * ## This is NOT a redundant copy of shared's guard — do not delete it
 *
 * `quorum-shared` ≥ 2.1.0-40 applies the same rule inside `resolveDisplayName`,
 * so it looks like this local check became belt-and-braces. It did not, and
 * removing it is a measured regression (two tests go red with shared's guard
 * fully active):
 *
 * The gate below only calls shared when `override || qns || global` has
 * content, precisely so shared's non-Qm-aware `slice(0,6)…slice(-4)` fallback
 * can never reach the screen. Drop this check and a row whose ONLY name is a
 * forged one passes that gate with a truthy string, shared then drops every
 * tier itself, and its own truncation is returned — `QmPeer…zzzz` instead of
 * mobile's `QmPeerAEgV…imzzzz`.
 *
 * Worse, `isAddressFallback` comes back **false**, because as far as this
 * function knows shared returned a name. Call sites read that flag to decide
 * avatar initials, search text and mention matching, so the damage is
 * functional rather than cosmetic.
 *
 * Guarding here keeps the two decisions where they belong: shared decides which
 * TIER wins, mobile decides what "we know nobody" looks like.
 */
const presentName = (s?: string | null): string | undefined => {
  const t = present(s);
  if (!t) return undefined;
  return hasReservedQnsSuffix(t) ? undefined : t;
};

/**
 * A QNS name is stored BARE — the suffix is presentation. One arriving with a
 * `.q` already on it is malformed however it got here, and would otherwise
 * render as `alice.q.q`, so it is not trusted as a claim.
 */
const presentQnsName = (s?: string | null): string | undefined => {
  const t = present(s);
  if (!t) return undefined;
  return hasReservedQnsSuffix(t) ? undefined : t;
};

const isSelf = (member: ResolvableMember, self?: SelfIdentity): boolean =>
  !!self?.address && member.address === self.address;

/**
 * Resolve the name for a space or DM member.
 *
 * Pass `self` wherever the viewer can appear in the list (member rosters,
 * reaction lists, mentions). Omit it and the viewer's own row falls through to
 * their address whenever the space has no stored identity for them yet.
 */
export function resolveMemberName(
  member: ResolvableMember,
  opts: { self?: SelfIdentity } = {},
): ResolvedMemberName {
  const storedOverride = presentName(member.display_name) ?? presentName(member.name);
  const qns = presentQnsName(member.primary_username);
  const global = presentName(member.global_display_name);

  // Demote an override that merely repeats the global name. It is the join
  // echo, not a name chosen for this space, and leaving it in the override tier
  // is what let it outrank the member's `.q` (see the header).
  const override = storedOverride && storedOverride === global ? undefined : storedOverride;

  // Delegate the ordering of the tiers shared owns. Only call it when one of
  // them actually has content, so shared's non-Qm-aware address fallback can
  // never reach the screen.
  if (override || qns || global) {
    const resolved = resolveDisplayName(
      {
        address: member.address,
        display_name: global,
        primary_username: qns,
      },
      { spaceOverrideName: override },
    );
    return {
      name: resolved.name,
      isQnsVerified: resolved.isQnsVerified,
      isAddressFallback: false,
    };
  }

  if (isSelf(member, opts.self)) {
    const live = present(opts.self?.displayName) ?? present(opts.self?.username);
    if (live) return { name: live, isQnsVerified: false, isAddressFallback: false };
  }

  return {
    name: truncateAddress(member.address),
    isQnsVerified: false,
    isAddressFallback: true,
  };
}

/**
 * Resolve the avatar for a space or DM member.
 *
 * `override → global slot → self`, with no QNS step. Returns `undefined` when
 * nothing resolves, so callers keep rendering their own initials placeholder
 * rather than being handed a broken image source.
 */
export function resolveMemberAvatar(
  member: ResolvableMember,
  opts: { self?: SelfIdentity } = {},
): string | undefined {
  const resolved =
    present(member.profile_image) ?? present(member.global_profile_image);
  if (resolved) return resolved;

  if (isSelf(member, opts.self)) return present(opts.self?.profileImage);

  return undefined;
}

/**
 * Flatten a resolved name to a plain string, appending `.q` when it is the
 * verified QNS username. Use at call sites that need a bare string (search
 * text, accessibility labels, mention matching).
 */
export function formatResolvedName(resolved: ResolvedMemberName): string {
  return resolved.isQnsVerified ? `${resolved.name}.q` : resolved.name;
}
