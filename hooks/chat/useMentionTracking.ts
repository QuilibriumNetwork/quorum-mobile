/**
 * useMentionTracking - Track @mentions of the current user in space channels.
 *
 * Mirrors useReplyTracking exactly (MMKV, keyed by user address, 2s poll), and
 * deliberately reuses that hook's `activeChannelKey` singleton (via the shared
 * `incrementReplyCount` guard pattern) so a mention that lands while the user is
 * already viewing the channel doesn't bump the badge. The channel screen already
 * calls setActiveChannel/clearActiveChannel, so this tracker gets the same
 * active-channel suppression for free.
 *
 * Desktop renders ONE channel-row badge = mentions + replies combined (see
 * ChannelList.tsx "Combined count for single badge"). Mobile mirrors that: the
 * channel row sums getMentionCount + getReplyCount into a single badge. This
 * hook owns the mention half; useReplyTracking owns the reply half.
 */

import { useState, useCallback, useEffect } from 'react';
import { createMMKV } from 'react-native-mmkv';
import { useAuth } from '@/context';
import { getActiveChannelKey } from './useReplyTracking';

const storage = createMMKV({ id: 'mention-tracking' });

function getStorageKey(userAddress: string): string {
  return `mention_counts:${userAddress}`;
}

function loadCounts(userAddress: string): Record<string, number> {
  const raw = storage.getString(getStorageKey(userAddress));
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveCounts(userAddress: string, counts: Record<string, number>): void {
  storage.set(getStorageKey(userAddress), JSON.stringify(counts));
}

/**
 * Standalone incrementer — callable outside React (from WebSocketContext on the
 * receive path). Skips the bump if the user is already viewing the channel,
 * using the SAME active-channel singleton as reply tracking.
 */
export function incrementMentionCount(userAddress: string, channelKey: string): void {
  if (getActiveChannelKey() === channelKey) return;
  const counts = loadCounts(userAddress);
  counts[channelKey] = (counts[channelKey] || 0) + 1;
  saveCounts(userAddress, counts);
}

export function useMentionTracking() {
  const { user } = useAuth();
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!user?.address) {
      setCounts({});
      return;
    }
    setCounts(loadCounts(user.address));
  }, [user?.address]);

  // Periodically refresh (WebSocket writes directly to storage).
  useEffect(() => {
    if (!user?.address) return;
    const interval = setInterval(() => {
      setCounts(loadCounts(user.address));
    }, 2000);
    return () => clearInterval(interval);
  }, [user?.address]);

  const getMentionCount = useCallback((spaceId: string, channelId: string): number => {
    const key = `${spaceId}:${channelId}`;
    return counts[key] || 0;
  }, [counts]);

  const clearMentionCount = useCallback((spaceId: string, channelId: string): void => {
    if (!user?.address) return;
    const key = `${spaceId}:${channelId}`;
    setCounts(prev => {
      const next = { ...prev };
      delete next[key];
      saveCounts(user.address, next);
      return next;
    });
  }, [user?.address]);

  const refreshCounts = useCallback(() => {
    if (!user?.address) return;
    setCounts(loadCounts(user.address));
  }, [user?.address]);

  return {
    getMentionCount,
    clearMentionCount,
    refreshCounts,
  };
}
