import * as React from 'react';
import { resolveIdentity } from '@quilibrium/quorum-shared';
import { identityFromMaps } from './identityFromMaps';
import { useIdentityContext } from './identityProvider';
import { truncateAddress } from '@/utils/formatAddress';
import type { ResolvedMemberName, UseResolvedNameOptions } from './useResolvedName';

export interface NameResolver {
  /** Resolve one address synchronously from the maps the surrounding provider
   *  already holds. Safe inside a loop or callback. Does NOT request a
   *  profile — call `requestNames` for addresses that should show a `.q`. */
  resolve: (address: string, opts?: UseResolvedNameOptions) => ResolvedMemberName;
  /** Request public profiles for a whole SET in one call. Dedupes against
   *  addresses already requested, so calling it every render is a no-op. */
  requestNames: (addresses: Iterable<string>) => void;
}

/**
 * Bulk resolution for surfaces that turn N addresses into labels inside a loop,
 * where N is not known until the data is parsed — a `.map()` over reactors, a
 * search filter, a sort key. A hook cannot be called per address in that shape.
 *
 * `resolve` is a pure read of `identityFromMaps` + `resolveIdentity`, the same
 * ladder `<MemberName>` uses, so a pill and a header can never disagree about
 * the same member. Its identity changes only when the provider's sources or
 * default scope change, so it is safe in a dependency array.
 *
 * A single-address surface should use `<MemberName>` instead.
 */
export function useNameResolver(): NameResolver {
  const { sources, defaultSpaceId, request } = useIdentityContext();

  const resolve = React.useCallback(
    (address: string, opts: UseResolvedNameOptions = {}): ResolvedMemberName => {
      const effectiveSpaceId = opts.spaceId ?? defaultSpaceId;
      const identity = identityFromMaps(address, effectiveSpaceId, sources);
      const scope = opts.global || !effectiveSpaceId ? 'global' : 'space';
      if (!identity.spaceName && !identity.qnsName && !identity.globalName) {
        return { name: truncateAddress(identity.address), isQnsVerified: false };
      }
      return resolveIdentity(identity, { scope });
    },
    [sources, defaultSpaceId],
  );

  const requestNames = React.useCallback(
    (addresses: Iterable<string>) => {
      for (const address of addresses) request(address);
    },
    [request],
  );

  return React.useMemo(() => ({ resolve, requestNames }), [resolve, requestNames]);
}
