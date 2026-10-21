/**
 * Keeps the optimistic store's record of what the viewer has liked and recast
 * current: fetched from the hub API (`services/farcaster/viewerReactions.ts`)
 * and handed to the store, which feed cards read per cast. Mounted by the feed.
 *
 * Not persisted. It refetches when stale (10 minutes), and the viewer's own
 * likes and recasts are added to it as they land, so it doesn't need to
 * refetch after each one.
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import {
  VIEWER_LIKES_WINDOW,
  VIEWER_RECASTS_WINDOW,
  fetchViewerReactionHashes,
} from '@/services/farcaster/viewerReactions';
import { setViewerReactions } from '@/services/feed/optimisticFeedStore';

export const viewerReactionsQueryKey = (fid: number | undefined) => ['viewer-reactions', fid ?? 0] as const;

export function useViewerReactions(): { likes: string[]; recasts: string[] } | undefined {
  const { user } = useAuth();
  const fid = user?.farcaster?.fid;

  const { data } = useQuery({
    queryKey: viewerReactionsQueryKey(fid),
    queryFn: async () => {
      const [likes, recasts] = await Promise.all([
        fetchViewerReactionHashes(fid as number, 'Like', VIEWER_LIKES_WINDOW),
        fetchViewerReactionHashes(fid as number, 'Recast', VIEWER_RECASTS_WINDOW),
      ]);
      return { likes, recasts };
    },
    enabled: typeof fid === 'number' && fid > 0,
    staleTime: 10 * 60 * 1000,
  });

  // Also runs when the account changes and the new one has no data yet, so
  // the previous account's likes don't show on the new one's feed.
  useEffect(() => {
    setViewerReactions(data?.likes ?? [], data?.recasts ?? []);
  }, [data, fid]);

  return data;
}
