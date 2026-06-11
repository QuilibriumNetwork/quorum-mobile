import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  fetchBlockedFids,
  loadBlockedFids,
  saveBlockedFids,
} from '@/services/farcaster/socialGraph';

export interface BlockedFids {
  /** FIDs the current viewer has blocked. */
  fids: Set<number>;
  isLoaded: boolean;
}

/**
 * The set of FIDs the current viewer has blocked, via the Farcaster
 * `/v2/get-blocked-users` endpoint (authed — same list the official client
 * shows, so blocks made from our profile menu reflect here). Seeded from
 * MMKV so it's available instantly and survives offline, and refreshed in
 * the background. Thread views collapse blocked authors' replies.
 */
export function useBlockedFids(): BlockedFids {
  const { user, farcasterAuthToken } = useAuth();
  const fid = user?.farcaster?.fid;

  const cached = useMemo(
    () => (fid ? loadBlockedFids(fid) ?? undefined : undefined),
    [fid],
  );

  const query = useQuery({
    queryKey: ['farcaster-blocked-fids', fid],
    queryFn: async () => {
      const fids = await fetchBlockedFids(farcasterAuthToken!);
      if (fid) saveBlockedFids(fid, fids);
      return fids;
    },
    enabled: Boolean(fid) && Boolean(farcasterAuthToken),
    initialData: cached,
    staleTime: 1000 * 60 * 10, // 10 minutes
    refetchInterval: 1000 * 60 * 15, // background refresh every 15 minutes
  });

  const fids = useMemo(() => new Set(query.data ?? []), [query.data]);
  return { fids, isLoaded: query.data != null };
}
