import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  fetchMutedFids,
  loadMutedFids,
  saveMutedFids,
} from '@/services/farcaster/socialGraph';

export interface MutedFids {
  /** FIDs the current viewer has muted. */
  fids: Set<number>;
  isLoaded: boolean;
}

/**
 * The set of FIDs the current viewer has muted, via the Farcaster
 * `/v2/get-muted-users` endpoint (authed). Mirrors {@link useBlockedFids}:
 * MMKV-seeded, background-refreshed. Thread views collapse muted authors'
 * replies the same way as blocked ones.
 */
export function useMutedFids(): MutedFids {
  const { user, farcasterAuthToken } = useAuth();
  const fid = user?.farcaster?.fid;

  const cached = useMemo(
    () => (fid ? loadMutedFids(fid) ?? undefined : undefined),
    [fid],
  );

  const query = useQuery({
    queryKey: ['farcaster-muted-fids', fid],
    queryFn: async () => {
      const fids = await fetchMutedFids(farcasterAuthToken!);
      if (fid) saveMutedFids(fid, fids);
      return fids;
    },
    enabled: Boolean(fid) && Boolean(farcasterAuthToken),
    initialData: cached,
    staleTime: 1000 * 60 * 10, // 10 minutes
    refetchInterval: 1000 * 60 * 15, // background refresh every 15 minutes
    refetchOnWindowFocus: true,
  });

  const fids = useMemo(() => new Set(query.data ?? []), [query.data]);
  return { fids, isLoaded: query.data != null };
}
