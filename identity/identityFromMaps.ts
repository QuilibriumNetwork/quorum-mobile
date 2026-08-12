import type { MemberIdentity } from '@quilibrium/quorum-shared';

/**
 * Pure tier assembly: the ONE place a member's name tiers are merged.
 *
 * Kept out of React deliberately, for two reasons. It makes the merge
 * unit-testable without mounting anything, and it lets a virtualised list
 * resolve hundreds of rows from maps already in memory without registering a
 * query observer per row.
 *
 * ## The QNS tier is verified-only, and that is structural
 *
 * `IdentitySources` carries NO public-profile object. It carries
 * `verifiedQnsNames` — names that have already been resolved back to the
 * address claiming them — and `profileGlobalNames`, the display name from the
 * same profile, which needs no verification because it makes no trust claim.
 *
 * Splitting the profile into those two maps is the whole design. A
 * `primary_username` arriving from a public profile or a broadcast is a CLAIM;
 * the `.q` suffix rendered from it is the only signal a viewer gets that a name
 * is genuinely owned. If this function could see a raw profile, every future
 * caller would have to remember to verify first, and one that forgot would
 * render a forged verified name. It cannot see one, so there is nowhere to put
 * an unverified claim.
 */

/** The roster fields the identity needs. Mirrors a space member row's name slots. */
export interface RosterNameRow {
  /** Per-space OVERRIDE slot. Non-empty means a deliberate per-space name. */
  display_name?: string | null;
  /** GLOBAL slot — the member's global name, pushed into the roster. */
  global_display_name?: string | null;
}

/**
 * Stable empty references. A fresh `{}` literal per render would invalidate
 * every memo built on it, on the surfaces whose entire cost argument is that
 * they do not recompute per tick.
 */
export const EMPTY_LOCAL_NAMES: Record<string, string> = {};
export const EMPTY_ROSTERS_BY_SPACE: Record<string, Record<string, RosterNameRow>> = {};

export interface IdentitySources {
  /** spaceId -> address -> roster row. Local, read from MMKV. */
  rostersBySpace: Record<string, Record<string, RosterNameRow>>;
  /**
   * address -> QNS name that has been VERIFIED to belong to that address.
   * The only source of the `.q` tier. Never populate this from a raw profile
   * or a broadcast field.
   */
  verifiedQnsNames: Record<string, string>;
  /** address -> display name from a fetched public profile. Carries no trust
   *  claim, so it needs no verification. */
  profileGlobalNames: Record<string, string>;
  /**
   * address -> a name known LOCALLY, with no network round-trip: a DM
   * partner's name learned from their own broadcast, or your own device name.
   *
   * LAST `globalName` tier. A published profile is authoritative when present;
   * this is what the peer told you directly. Without it, a partner who never
   * published a profile renders as a truncated address even though the app
   * knows their name — a regression desktop shipped and had to send back.
   */
  locallyKnownNames: Record<string, string>;
  selfAddress: string | null;
}

const nn = (v?: string | null): string | null => {
  const t = (v ?? '').trim();
  return t.length ? t : null;
};

/**
 * Your own device name, as a `locallyKnownNames` entry.
 *
 * Self resolves from the same tiers as anybody else — there is no self
 * special case in the ladder. But your own device profile is a name source
 * nobody else has, and without it a user who never published a public profile
 * renders as their own address in their own header. It is the LAST tier and it
 * can never supply a `.q`, because a device name is not a QNS name.
 *
 * Returns the stable empty reference when there is nothing to contribute.
 */
export function selfLocalNameEntry(
  address: string | null | undefined,
  displayName: string | null | undefined,
): Record<string, string> {
  const name = nn(displayName);
  if (!address || !name) return EMPTY_LOCAL_NAMES;
  return { [address]: name };
}

export function identityFromMaps(
  address: string,
  spaceId: string | undefined,
  sources: IdentitySources,
): MemberIdentity {
  // Only a real space context can have a per-space nickname. With no spaceId
  // — a DM, or a Space you have left — the roster is not consulted at all.
  const row = spaceId ? sources.rostersBySpace[spaceId]?.[address] : undefined;

  return {
    address,
    spaceName: nn(row?.display_name),
    qnsName: nn(sources.verifiedQnsNames[address]),
    // Live roster slot, then the published profile, then a name known only
    // locally. One merge path, never a second parallel lookup.
    globalName:
      nn(row?.global_display_name) ??
      nn(sources.profileGlobalNames[address]) ??
      nn(sources.locallyKnownNames[address]),
  };
}
