import * as React from 'react';
import { useQueries } from '@tanstack/react-query';
import { getQuorumClient } from '@/services/api/quorumClient';
import { publicProfileQueryKey, type PublicProfile } from '@/hooks/useUserPublicProfile';
import {
  DEV_CLAIM_EXEMPTION,
  claimIn,
  claimedNamesIn,
  useClaimRecords,
  type ClaimingRow,
} from '@/hooks/useVerifiedQnsNames';
import { claimedNameBelongsTo } from '@/utils/verifyQnsClaim';
import {
  EMPTY_LOCAL_NAMES,
  type IdentitySources,
  type RosterNameRow,
} from './identityFromMaps';

/**
 * Shallow merge of a flat `address -> value` map: `own` wins per key, `parent`
 * fills the rest. Returns one of the two inputs UNCHANGED (same reference)
 * when the other is empty, so merging with nothing does not allocate.
 */
export function mergeFlat<T>(
  parent: Record<string, T>,
  own: Record<string, T>,
): Record<string, T> {
  if (Object.keys(parent).length === 0) return own;
  if (Object.keys(own).length === 0) return parent;
  return { ...parent, ...own };
}

/**
 * Merge for `rostersBySpace` — TWO levels (spaceId, then address), not one
 * shallow merge of the outer map.
 *
 * A shallow merge would let a child's roster REPLACE the parent's wholesale
 * for any space both know about. A child whose own read has not resolved yet
 * legitimately holds `{}` for that space, so the shallow version would blank
 * every row the parent already had — introducing the exact regression this
 * merge exists to prevent. Per-address instead: an empty child contributes
 * nothing and the parent's rows keep showing, while a loaded child row still
 * wins for its own key.
 */
export function mergeRostersBySpace(
  parent: Record<string, Record<string, RosterNameRow>>,
  own: Record<string, Record<string, RosterNameRow>>,
): Record<string, Record<string, RosterNameRow>> {
  if (Object.keys(parent).length === 0) return own;
  const ownSpaceIds = Object.keys(own);
  if (ownSpaceIds.length === 0) return parent;

  const merged: Record<string, Record<string, RosterNameRow>> = { ...parent };
  for (const spaceId of ownSpaceIds) {
    const parentRoster = parent[spaceId];
    merged[spaceId] = parentRoster ? mergeFlat(parentRoster, own[spaceId]) : own[spaceId];
  }
  return merged;
}

/**
 * The broadcast claim each of `addresses` carries on a roster row, across every
 * space in scope.
 *
 * A key is present only when some row actually carried the field, so a caller
 * can tell ABSENT from EMPTY. `claimIn` depends on that distinction: absent
 * means "this transport said nothing, use the public profile", empty is an
 * un-election that must override a profile still carrying the old name.
 *
 * ## Bounded by `addresses`, which is the requested set
 *
 * Rosters are unbounded by anything the user did — a 5,000-member space would
 * otherwise feed 5,000 claims into the verifier the moment any surface in that
 * space mounts. Only addresses something has actually asked to resolve are
 * considered, which is the same bound the public-profile fetch already uses.
 * This adds no new fan-out: it adds NAMES to a batch that is already capped at
 * one request by `claimedNamesIn`, never new per-address requests.
 *
 * ## One person, two spaces, two claims
 *
 * `verifiedQnsNames` is flat (address -> name) but rosters are per-space, so a
 * member whose spaces disagree needs a deterministic rule. Both halves of this
 * one are fail-closed:
 *
 * 1. **Any present-and-empty claim un-elects.** Dropping a primary name
 *    broadcasts the clear to every space; one space having heard it is enough.
 *    A space that merely never got the message still holds the old name, and
 *    preferring that would keep rendering a name its owner has abandoned.
 * 2. **Otherwise the first non-empty claim in SORTED space-id order.** Sorted
 *    rather than insertion order because merging with a parent scope reorders
 *    the keys, and a claim that flapped between renders would flicker a name.
 *
 * Neither half can promote a name nobody owns. Verification runs afterwards and
 * is unconditional, so this only decides which claim gets TESTED — its worst
 * outcome is under-showing a real name, which is invisible and self-correcting.
 */
export function rosterClaimsFor(
  addresses: readonly string[],
  rostersBySpace: Record<string, Record<string, RosterNameRow>>,
): Record<string, string> {
  const spaceIds = Object.keys(rostersBySpace).sort();
  if (!spaceIds.length || !addresses.length) return EMPTY_ROSTER_CLAIMS;

  const out: Record<string, string> = {};
  for (const address of addresses) {
    let claim: string | undefined;
    for (const spaceId of spaceIds) {
      const raw = rostersBySpace[spaceId]?.[address]?.claimed_primary_username;
      if (raw === undefined || raw === null) continue;
      const trimmed = raw.trim();
      // Rule 1: an un-election ends the scan; nothing later can revive it.
      if (!trimmed) {
        claim = '';
        break;
      }
      // Rule 2: keep the first, but keep scanning — a later space may still
      // carry the un-election that outranks it.
      if (claim === undefined) claim = trimmed;
    }
    if (claim !== undefined) out[address] = claim;
  }

  return Object.keys(out).length ? out : EMPTY_ROSTER_CLAIMS;
}

/** Stable empty reference, so a scope with no claims does not hand its memos a
 *  fresh object every render. */
const EMPTY_ROSTER_CLAIMS: Record<string, string> = {};

interface IdentityContextValue {
  sources: IdentitySources;
  /** Scope for call sites that do not pass a spaceId. */
  defaultSpaceId?: string;
  /** Ask for an address's public profile if it is not already cached. */
  request: (address: string) => void;
}

const IdentityContext = React.createContext<IdentityContextValue | null>(null);

export const useIdentityContext = (): IdentityContextValue => {
  const ctx = React.useContext(IdentityContext);
  if (!ctx) {
    throw new Error(
      'useResolvedName/<MemberName> used outside <IdentityScopeProvider>. ' +
        'The root scope is mounted in app/_layout.tsx; a detached host may need its own.',
    );
  }
  return ctx;
};

export const IdentityScopeProvider: React.FunctionComponent<{
  /** The Space this subtree lives in, if any. Absent for DMs and global views.
   *  NOT inherited from an enclosing scope: a detached surface that omits it
   *  gets the global ladder even when an ancestor is scoped to a Space. */
  spaceId?: string;
  rostersBySpace: Record<string, Record<string, RosterNameRow>>;
  selfAddress: string | null;
  locallyKnownNames?: Record<string, string>;
  children: React.ReactNode;
}> = ({
  spaceId,
  rostersBySpace,
  selfAddress,
  locallyKnownNames = EMPTY_LOCAL_NAMES,
  children,
}) => {
  // MERGE, not replace. `useContext` rather than `useIdentityContext`: the
  // root provider and any isolated test mount legitimately have no ancestor,
  // and that must degrade to "nothing to merge with" rather than throw. Each
  // level merges only with its DIRECT parent, which already carries
  // everything merged in above it.
  //
  // Read FIRST, above the claim plumbing, because roster claims are read off
  // the MERGED rosters: a nested scope must be able to verify a claim carried
  // by a row its parent loaded. A parent only verifies addresses IT was asked
  // for, and `requested` is per-provider state, so a child that skipped the
  // merge would silently drop the `.q` for anything it requested itself.
  const parent = React.useContext(IdentityContext);

  const [requested, setRequested] = React.useState<ReadonlySet<string>>(new Set());
  const request = React.useCallback((address: string) => {
    if (!address) return;
    setRequested((prev) => (prev.has(address) ? prev : new Set(prev).add(address)));
  }, []);

  const addresses = React.useMemo(() => Array.from(requested), [requested]);

  const mergedRostersBySpace = React.useMemo(
    () => (parent ? mergeRostersBySpace(parent.sources.rostersBySpace, rostersBySpace) : rostersBySpace),
    [parent, rostersBySpace],
  );

  const queries = useQueries({
    queries: addresses.map((address) => ({
      queryKey: publicProfileQueryKey(address),
      queryFn: (): Promise<PublicProfile | null> => getQuorumClient().getPublicProfile(address),
      staleTime: 60 * 60 * 1000,
      gcTime: 24 * 60 * 60 * 1000,
      retry: false,
    })),
  });

  // `useQueries` returns a fresh array every render, so memo on a fingerprint
  // of the per-query data instead. `dataUpdatedAt` rather than presence:
  // a write that replaces an already-loaded profile is non-null before and
  // after, so a truthy flag cannot see it.
  const updatedAtKey = queries.map((q) => q?.dataUpdatedAt ?? 0).join('|');
  const profiles = React.useMemo(() => {
    const map: Record<string, PublicProfile | null> = {};
    addresses.forEach((a, i) => {
      map[a] = queries[i]?.data ?? null;
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses, updatedAtKey]);

  // The display name needs no verification: it makes no trust claim.
  const profileGlobalNames = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const [address, profile] of Object.entries(profiles)) {
      const name = (profile?.display_name ?? '').trim();
      if (name) map[address] = name;
    }
    return map;
  }, [profiles]);

  // ── The claim check, INSIDE the provider ────────────────────────────────
  //
  // A `primary_username` is a CLAIM. It renders with a `.q`, which is the only
  // signal a viewer gets that a name is genuinely owned, so it may not reach
  // the ladder until it has resolved back to the address claiming it.
  //
  // Doing it here rather than upstream of each surface is decision 5.1: every
  // consumer inherits the check, and a surface that forgets it does not exist,
  // because there is no other way in. Unproven includes NOT-YET-KNOWN — a
  // lookup in flight yields no entry, so the name simply is not there. A `.q`
  // shown for even the instant before a lookup lands is the whole attack.
  //
  // The dedup/cap (`claimedNamesIn`), the two-transport precedence (`claimIn`)
  // and the resolve-and-cache query (`useClaimRecords`) are the SAME functions
  // `useVerifiedQnsNames` uses, imported rather than re-implemented. That
  // hook's `staleTime` is a documented security parameter — the window a
  // transferred-away name keeps verifying under its previous owner — and a
  // second copy of that number here would be a second place for it to drift.
  //
  // ── TWO transports, one checkpoint ──────────────────────────────────────
  //
  // A claim arrives either on a fetched public profile (`primary_username`) or
  // over the space/DM broadcast, stored on the local roster row
  // (`claimed_primary_username`). The public-profile route is dead server-side
  // — the API rejects every publish carrying the field — so the broadcast is
  // the only one that currently delivers anything, and a ladder reading only
  // profiles renders no `.q` for anyone.
  //
  // Both are untrusted and both go through the SAME check below. This adds an
  // INPUT, not a second decision point: there is still exactly one place that
  // writes `verifiedQnsNames`, and `IdentitySources` still has nowhere to put
  // an unverified claim.
  const rosterClaims = React.useMemo(
    () => rosterClaimsFor(addresses, mergedRostersBySpace),
    [addresses, mergedRostersBySpace],
  );

  // One row per requested address carrying both transports, so the name that
  // gets LOOKED UP and the name that gets CHECKED are the same value. Deriving
  // them separately is how a claim comes to be verified against a record that
  // was never fetched for it.
  const claimRows = React.useMemo(() => {
    const rows: Record<string, ClaimingRow> = {};
    for (const address of addresses) {
      rows[address] = {
        address,
        primary_username: profiles[address]?.primary_username,
        claimed_primary_username: rosterClaims[address],
      };
    }
    return rows;
  }, [addresses, profiles, rosterClaims]);

  const claimedNames = React.useMemo(
    () => claimedNamesIn(Object.values(claimRows)),
    [claimRows],
  );

  const claimRecords = useClaimRecords(claimedNames);

  const verifiedQnsNames = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const [address, row] of Object.entries(claimRows)) {
      const claim = claimIn(row);
      if (!claim) continue;
      // `DEV_CLAIM_EXEMPTION` is the fake-QNS overlay's seam, and it is
      // `undefined` in any non-dev build (it is gated at the `require()`, not
      // here — see its definition). A synthesized name is registered nowhere,
      // so it can NEVER pass the real check; without this the overlay injects
      // names and the check strips every one of them, and the instrument
      // reports success while every QNS surface renders exactly as it did
      // before it existed.
      //
      // This clause was missing when verification moved into this provider,
      // which is precisely how it failed: the exemption was threaded into
      // `stripUnverifiedNames*` — the path this replaced — so it kept passing
      // its own tests while the app-wide path silently lost it. Pinned by
      // `identityProviderDevExemption.test.tsx`.
      if (
        DEV_CLAIM_EXEMPTION?.(claim, address) ||
        claimedNameBelongsTo(claimRecords.get(claim), address)
      ) {
        map[address] = claim;
      }
    }
    return map;
  }, [claimRows, claimRecords]);

  const mergedProfileGlobalNames = React.useMemo(
    () => (parent ? mergeFlat(parent.sources.profileGlobalNames, profileGlobalNames) : profileGlobalNames),
    [parent, profileGlobalNames],
  );
  const mergedVerifiedQnsNames = React.useMemo(
    () => (parent ? mergeFlat(parent.sources.verifiedQnsNames, verifiedQnsNames) : verifiedQnsNames),
    [parent, verifiedQnsNames],
  );
  const mergedLocallyKnownNames = React.useMemo(
    () => (parent ? mergeFlat(parent.sources.locallyKnownNames, locallyKnownNames) : locallyKnownNames),
    [parent, locallyKnownNames],
  );

  React.useEffect(() => {
    if (selfAddress) request(selfAddress);
  }, [selfAddress, request]);

  const value = React.useMemo<IdentityContextValue>(
    () => ({
      sources: {
        rostersBySpace: mergedRostersBySpace,
        verifiedQnsNames: mergedVerifiedQnsNames,
        profileGlobalNames: mergedProfileGlobalNames,
        locallyKnownNames: mergedLocallyKnownNames,
        selfAddress,
      },
      // NOT merged — always this provider's own prop. See the prop docstring.
      defaultSpaceId: spaceId,
      request,
    }),
    [
      mergedRostersBySpace,
      mergedVerifiedQnsNames,
      mergedProfileGlobalNames,
      mergedLocallyKnownNames,
      selfAddress,
      spaceId,
      request,
    ],
  );

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
};
