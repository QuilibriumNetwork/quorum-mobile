/**
 * useUnifiedNotifications — gathers the notification panel's inputs (the two
 * Farcaster feeds, the Quorum mention log, the background-push chat log, mute
 * state, dismissal watermark) and hands them to `partitionNotifications`.
 *
 * All the actual logic — cross-source dedup, dismissal, muted-DM exclusion,
 * badge arithmetic — lives in that pure module so it can be unit-tested
 * without a renderer. This file should stay thin.
 *
 * Two sections come back: "Mentions & messages" (Quorum mentions/replies plus
 * background message pings) and "Farcaster". The notifications tab and the
 * bell-icon badge both consume this so they stay in sync.
 */

import { useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  flattenFarcasterNotifications,
  useFarcasterNotifications,
} from './useFarcasterNotifications';
import { useHaatzNotifications } from './useHaatzNotifications';
import { useDMMute } from '@/hooks/chat/useDMMute';
import {
  getLastSeenTimestamp,
  useNotificationLog,
} from '@/services/notifications/notificationLog';
import {
  getQuorumTabUnreadCount,
  useMentionReplyLog,
} from '@/services/notifications/mentionReplyLog';
import { useFarcasterClearedBefore } from '@/services/notifications/farcasterDismissal';
import { partitionNotifications } from '@/services/notifications/partitionNotifications';
import type { UnifiedNotification } from '@/services/notifications/partitionNotifications';

// Re-exported so existing consumers keep importing the row type from the hook.
export type {
  UnifiedNotification,
  UnifiedNotificationSource,
} from '@/services/notifications/partitionNotifications';

export interface UnifiedNotificationsResult {
  items: UnifiedNotification[];
  /** Quorum mentions/replies + background message pings, newest-first. */
  quorumItems: UnifiedNotification[];
  /** Farcaster activity, newest-first. */
  farcasterFeedItems: UnifiedNotification[];
  unreadCount: number;
  /** Farcaster rows currently hidden by the dismissal watermark (dev panel). */
  dismissedCount: number;
  isLoading: boolean;
  isFetchingMore: boolean;
  hasMore: boolean;
  fetchMore: () => void;
  refetch: () => void;
  farcasterEnabled: boolean;
  /** Surfaces fetch errors to the screen so the user can see why the
   *  Farcaster portion of the feed is empty (auth expiry, 5xx, etc.)
   *  instead of being told there are no notifications. */
  farcasterError: Error | null;
}

export function useUnifiedNotifications(): UnifiedNotificationsResult {
  const { farcasterAuthToken } = useAuth();
  const { entries: chatEntries } = useNotificationLog();
  const { entries: quorumEntries } = useMentionReplyLog();
  const farcasterQuery = useFarcasterNotifications(farcasterAuthToken ?? undefined);
  // Supplementary auth-free source (hypersnap/haatz). Blended in and
  // deduped against the official feed so notifications still show when the
  // farcaster.xyz bearer token is missing or expired.
  const haatzQuery = useHaatzNotifications();
  // Consuming the hook (vs reading MMKV) makes the panel recompute the moment
  // a mute toggles.
  const { mutedConversations } = useDMMute();
  // Local dismissal watermark — Farcaster rows can't be cleared server-side.
  const clearedBefore = useFarcasterClearedBefore();

  const officialFarcaster = useMemo(
    () => flattenFarcasterNotifications(farcasterQuery.data?.pages),
    [farcasterQuery.data?.pages],
  );

  const partition = useMemo(
    () =>
      partitionNotifications({
        quorumEntries,
        chatEntries,
        officialFarcaster,
        haatzFarcaster: haatzQuery.data ?? [],
        clearedBefore,
        mutedConversations,
        lastSeen: getLastSeenTimestamp(),
        quorumTabUnread: getQuorumTabUnreadCount(),
      }),
    [quorumEntries, chatEntries, officialFarcaster, haatzQuery.data, clearedBefore, mutedConversations],
  );

  return {
    items: partition.items,
    quorumItems: partition.quorumItems,
    farcasterFeedItems: partition.farcasterFeedItems,
    unreadCount: partition.unreadCount,
    dismissedCount: partition.dismissedCount,
    isLoading: farcasterQuery.isLoading || haatzQuery.isLoading,
    isFetchingMore: farcasterQuery.isFetchingNextPage,
    // Stop paging once the fetched pages reach the dismissal watermark —
    // everything older is dismissed, so further pages would be entirely
    // filtered out and infinite scroll would spin for nothing.
    hasMore: !!farcasterQuery.hasNextPage && !partition.reachedWatermark,
    fetchMore: () => {
      if (
        farcasterQuery.hasNextPage &&
        !farcasterQuery.isFetchingNextPage &&
        !partition.reachedWatermark
      ) {
        void farcasterQuery.fetchNextPage();
      }
    },
    refetch: () => {
      void farcasterQuery.refetch();
      void haatzQuery.refetch();
    },
    farcasterEnabled: !!farcasterAuthToken,
    // Only surface the official-feed error when the blended list is empty —
    // if haatz (or anything) filled the feed, a farcaster.xyz auth lapse or
    // 5xx shouldn't show an error banner. Per the resilience requirement:
    // don't error out just because the official source didn't appear.
    farcasterError:
      partition.farcasterFeedItems.length > 0
        ? null
        : ((farcasterQuery.error as Error | null) ?? null),
  };
}
