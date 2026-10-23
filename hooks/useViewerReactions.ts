/**
 * Keeps the optimistic store's record of what the viewer has liked and recast
 * current: fetched from the hub API (`services/farcaster/viewerReactions.ts`)
 * and handed to the store, which feed cards read per cast. Mounted by the feed.
 *
 * Kept on the phone, so a launch shows the last window at once and a refresh
 * downloads only the newest few (`refreshViewerReactions`). It refreshes when
 * stale (10 minutes), and the viewer's own likes and recasts are added to it
 * as they land, so it doesn't need to refetch after each one.
 */
import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import {
  loadViewerReactions,
  refreshViewerReactions,
  saveViewerReactions,
  type ViewerReactions,
} from '@/services/farcaster/viewerReactions';
import { setViewerReactions } from '@/services/feed/optimisticFeedStore';

export const viewerReactionsQueryKey = (fid: number | undefined) => ['viewer-reactions', fid ?? 0] as const;

export function useViewerReactions(): ViewerReactions | undefined {
  const { user } = useAuth();
  const fid = user?.farcaster?.fid;
  const queryClient = useQueryClient();
  const saved = useMemo(() => (typeof fid === 'number' && fid > 0 ? loadViewerReactions(fid) : null), [fid]);

  const { data } = useQuery({
    queryKey: viewerReactionsQueryKey(fid),
    queryFn: async () => {
      const previous =
        queryClient.getQueryData<ViewerReactions>(viewerReactionsQueryKey(fid)) ?? loadViewerReactions(fid as number);
      const next = await refreshViewerReactions(fid as number, previous);
      saveViewerReactions(fid as number, next);
      return next;
    },
    enabled: typeof fid === 'number' && fid > 0,
    initialData: saved ?? undefined,
    initialDataUpdatedAt: saved?.fetchedAt,
    staleTime: 10 * 60 * 1000,
  });

  // Also runs when the account changes and the new one has no data yet, so
  // the previous account's likes don't show on the new one's feed.
  useEffect(() => {
    setViewerReactions(data?.likes ?? [], data?.recasts ?? []);
  }, [data, fid]);

  return data;
}
