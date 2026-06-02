import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  fetchFollowingFids,
  loadFollowingFids,
  saveFollowingFids,
} from '@/services/farcaster/socialGraph';

export interface FollowingFids {
  /** FIDs the current viewer follows. */
  fids: Set<number>;
  /** True once we have a list (persisted or freshly fetched). Until then,
   *  callers should NOT treat "not in set" as "not followed" — they'd hide
   *  everything. */
  isLoaded: boolean;
}

/**
 * The set of FIDs the current viewer follows. Seeded from MMKV so a cold
 * start renders immediately with the last-known graph, then refreshed from
 * the hub in the background. Used to filter non-follow replies out of the
 * main feed.
 */
export function useFollowingFids(): FollowingFids {
  const { user } = useAuth();
  const fid = user?.farcaster?.fid;

  const cached = useMemo(
    () => (fid ? loadFollowingFids(fid) ?? undefined : undefined),
    [fid],
  );

  const query = useQuery({
    queryKey: ['farcaster-following-fids', fid],
    queryFn: async () => {
      const fids = await fetchFollowingFids(fid!);
      saveFollowingFids(fid!, fids);
      return fids;
    },
    enabled: Boolean(fid),
    initialData: cached,
    staleTime: 1000 * 60 * 30, // 30 minutes
    refetchOnWindowFocus: true,
  });

  const fids = useMemo(() => new Set(query.data ?? []), [query.data]);
  return { fids, isLoaded: query.data != null };
}
