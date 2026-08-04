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
 * ## One case this does NOT handle, on purpose
 *
 * Desktop's `resolveSpaceMemberName` compares the roster name against the
 * global name to spot a row that merely ECHOES the global value rather than
 * carrying a deliberate per-space one. We do not, because since the
 * follow-global work (2026-07-16) the override slot is no longer stamped at
 * join, so a non-empty override really is deliberate.
 *
 * That holds for rows written after that date. A LEGACY row stamped before it
 * still looks like a deliberate override, so its stale echo will outrank the
 * member's QNS `.q` name here while desktop demotes it — the same member can
 * read differently on the two clients until the row is cleared. This is a
 * pre-existing, documented, decaying gap (see the desktop doc's "Known
 * limitations (accepted)"), not something this file introduced. Do not treat
 * the invariant above as airtight for old data.
 *
 * ## Avatars are not names
 *
 * `quorum-shared` has a rule for names only. The avatar ladder is separate,
 * lives in `resolveMemberAvatar` below, and has NO QNS step, because a `.q`
 * name carries no picture. Do not merge the two.
 */

import { resolveDisplayName } from '@quilibrium/quorum-shared';
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
  const override = present(member.display_name) ?? present(member.name);
  const qns = present(member.primary_username);
  const global = present(member.global_display_name);

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
