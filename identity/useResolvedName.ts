import * as React from 'react';
import { resolveIdentity, type MemberIdentity } from '@quilibrium/quorum-shared';
import { identityFromMaps, type IdentitySources } from './identityFromMaps';
import { useIdentityContext } from './identityProvider';
import { truncateAddress } from '@/utils/formatAddress';

export interface ResolvedMemberName {
  name: string;
  isQnsVerified: boolean;
}

export interface UseResolvedNameOptions {
  /** Override the surrounding scope. Detached surfaces that carry their own
   *  spaceId (bookmarks, notifications) pass it here. */
  spaceId?: string;
  /** Force the global ladder even inside a Space. Rarely needed. */
  global?: boolean;
  /**
   * Opt in to a public-profile fetch for this address. Default `false`: the
   * name resolves from maps already in memory and issues NO request, so a
   * member with no cached profile renders their roster name and no `.q`.
   *
   * This gates only whether a request is ISSUED. A profile some other enriched
   * call site already fetched is still read here.
   *
   * Only the member sidebar must never enrich — its cardinality is a whole
   * Space's membership, and one request per row is a measured fetch storm.
   * Bounded surfaces should enrich.
   */
  enrich?: boolean;
}

function useIdentityAndScope(
  address: string,
  spaceId: string | undefined,
  enrich: boolean,
): { identity: MemberIdentity; effectiveSpaceId: string | undefined; sources: IdentitySources } {
  const { sources, defaultSpaceId, request } = useIdentityContext();
  React.useEffect(() => {
    if (enrich) request(address);
  }, [address, enrich, request]);
  const effectiveSpaceId = spaceId ?? defaultSpaceId;
  const identity = React.useMemo(
    () => identityFromMaps(address, effectiveSpaceId, sources),
    [address, effectiveSpaceId, sources],
  );
  return { identity, effectiveSpaceId, sources };
}

/** The identity behind a name, for callers that need the tiers.
 *
 *  WARNING: these are RAW tiers. They have not been through the ladder, and a
 *  caller rendering one directly skips the forged-suffix guard `resolveIdentity`
 *  applies. Desktop shipped a forgery this way. Render through
 *  `useResolvedMemberName` unless you genuinely need the tiers themselves. */
export function useMemberIdentity(
  address: string,
  { spaceId, enrich = false }: { spaceId?: string; enrich?: boolean } = {},
): MemberIdentity {
  return useIdentityAndScope(address, spaceId, enrich).identity;
}

/** The structured result, for callers that style the suffix. */
export function useResolvedMemberName(
  address: string,
  { spaceId, global = false, enrich = false }: UseResolvedNameOptions = {},
): ResolvedMemberName {
  const { identity, effectiveSpaceId } = useIdentityAndScope(address, spaceId, enrich);
  const scope = global || !effectiveSpaceId ? 'global' : 'space';
  return React.useMemo(() => {
    const resolved = resolveIdentity(identity, { scope });
    // Shared's own fallback is a naive slice(0,6)…slice(-4), which is not
    // Qm-aware. Mobile's truncateAddress counts entropy characters AFTER the
    // constant `Qm` prefix and is parity-matched with desktop, so the last
    // rung stays local — handing it to shared would regress every address
    // label in the app.
    if (!identity.spaceName && !identity.qnsName && !identity.globalName) {
      return { name: truncateAddress(identity.address), isQnsVerified: false };
    }
    return resolved;
  }, [identity, scope]);
}

/** The resolved name as a plain string, with `.q` when verified. For
 *  accessibility labels, notification bodies, search text and modal payloads. */
export function useResolvedName(address: string, opts: UseResolvedNameOptions = {}): string {
  const r = useResolvedMemberName(address, opts);
  return r.isQnsVerified ? `${r.name}.q` : r.name;
}
