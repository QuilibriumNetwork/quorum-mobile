/**
 * useUserPublicProfile — fetches a user's public profile by address.
 *
 * Returns null when the user hasn't opted in (404 from server) or hasn't
 * yet been observed on the network. Cached for an hour with React Query
 * so chat surfaces don't refetch on every render. Used as a fallback
 * when our local SpaceMember record is empty or stale.
 */

import { useQuery } from '@tanstack/react-query';
import {
  getQuorumClient,
  type PublicProfileResponse,
} from '@/services/api/quorumClient';

/**
 * Re-exported from the API client rather than re-declared.
 *
 * This used to be a hand-written interface that happened to omit
 * `primary_username`. The field was on the wire the whole time; the narrower
 * type quietly discarded it, so no member ever carried a `.q` name and the QNS
 * rung of the resolution ladder could never fire. Aliasing the client's own
 * type means a field added to the response can no longer be lost here.
 */
export type PublicProfile = PublicProfileResponse;

export const publicProfileQueryKey = (address: string | undefined) =>
  ['user-public-profile', address ?? ''] as const;

export function useUserPublicProfile(
  address: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery<PublicProfile | null>({
    queryKey: publicProfileQueryKey(address),
    queryFn: async () => {
      if (!address) return null;
      return await getQuorumClient().getPublicProfile(address);
    },
    enabled: (options?.enabled ?? true) && !!address,
    staleTime: 60 * 60 * 1000, // 1 hour
    gcTime: 24 * 60 * 60 * 1000, // 24 hours
    retry: false,
  });
}
