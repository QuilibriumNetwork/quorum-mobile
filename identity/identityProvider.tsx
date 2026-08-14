import * as React from 'react';
import { useQueries } from '@tanstack/react-query';
import { getQuorumClient } from '@/services/api/quorumClient';
import { publicProfileQueryKey, type PublicProfile } from '@/hooks/useUserPublicProfile';
import { DEV_CLAIM_EXEMPTION, claimedNamesIn, useClaimRecords } from '@/hooks/useVerifiedQnsNames';
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
  const [requested, setRequested] = React.useState<ReadonlySet<string>>(new Set());
  const request = React.useCallback((address: string) => {
    if (!address) return;
    setRequested((prev) => (prev.has(address) ? prev : new Set(prev).add(address)));
  }, []);

  const addresses = React.useMemo(() => Array.from(requested), [requested]);

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
  // A `primary_username` on a public profile is a CLAIM. It renders with a
  // `.q`, which is the only signal a viewer gets that a name is genuinely
  // owned, so it may not reach the ladder until it has resolved back to the
  // address claiming it.
  //
  // Doing it here rather than upstream of each surface is decision 5.1: every
  // consumer inherits the check, and a surface that forgets it does not exist,
  // because there is no other way in. Unproven includes NOT-YET-KNOWN — a
  // lookup in flight yields no entry, so the name simply is not there. A `.q`
  // shown for even the instant before a lookup lands is the whole attack.
  //
  // The dedup/cap (`claimedNamesIn`) and the resolve-and-cache query
  // (`useClaimRecords`) are the SAME functions `useVerifiedQnsNames` uses for
  // the broadcast/roster path, imported rather than re-implemented. That
  // hook's `staleTime` is a documented security parameter — the window a
  // transferred-away name keeps verifying under its previous owner — and a
  // second copy of that number here would be a second place for it to drift.
  const claimedNames = React.useMemo(
    () => claimedNamesIn(Object.values(profiles).filter((p): p is PublicProfile => p !== null)),
    [profiles],
  );

  const claimRecords = useClaimRecords(claimedNames);

  const verifiedQnsNames = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const [address, profile] of Object.entries(profiles)) {
      const claim = (profile?.primary_username ?? '').trim();
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
  }, [profiles, claimRecords]);

  // MERGE, not replace. `useContext` rather than `useIdentityContext`: the
  // root provider and any isolated test mount legitimately have no ancestor,
  // and that must degrade to "nothing to merge with" rather than throw. Each
  // level merges only with its DIRECT parent, which already carries
  // everything merged in above it.
  const parent = React.useContext(IdentityContext);

  const mergedRostersBySpace = React.useMemo(
    () => (parent ? mergeRostersBySpace(parent.sources.rostersBySpace, rostersBySpace) : rostersBySpace),
    [parent, rostersBySpace],
  );
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
