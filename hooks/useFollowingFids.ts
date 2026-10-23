import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  fetchFollowingFids,
  loadFollowingFidsEntry,
  onFollowChange,
  saveFollowingFids,
} from '@/services/farcaster/socialGraph';

/**
 * How old the follow set may get before it's downloaded again. It's the
 * whole list as signed messages (about 110 KB compressed per 1,000 follows),
 * follows made in this app are applied locally (`recordFollowChange`), so
 * this only picks up changes made on other clients.
 */
export const FOLLOWING_STALE_MS = 6 * 60 * 60 * 1000;

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

  const queryClient = useQueryClient();
  const cached = useMemo(() => (fid ? loadFollowingFidsEntry(fid) : null), [fid]);

  const query = useQuery({
    queryKey: ['farcaster-following-fids', fid],
    queryFn: async () => {
      const fids = await fetchFollowingFids(fid!);
      saveFollowingFids(fid!, fids);
      return fids;
    },
    enabled: Boolean(fid),
    initialData: cached?.fids,
    // The saved set's real age, so it's refreshed when it's actually old
    // rather than counted fresh from every launch.
    initialDataUpdatedAt: cached?.fetchedAt,
    staleTime: FOLLOWING_STALE_MS,
  });

  // Follows and unfollows made here show at once.
  useEffect(() => {
    if (!fid) return;
    return onFollowChange((changed) => {
      if (changed !== fid) return;
      const entry = loadFollowingFidsEntry(fid);
      // Keeps the set's age, so a local follow doesn't put off the refresh.
      if (entry) queryClient.setQueryData(['farcaster-following-fids', fid], entry.fids, { updatedAt: entry.fetchedAt });
    });
  }, [fid, queryClient]);

  const fids = useMemo(() => new Set(query.data ?? []), [query.data]);
  return { fids, isLoaded: query.data != null };
}
