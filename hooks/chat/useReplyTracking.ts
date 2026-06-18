/**
 * useReplyTracking - Track replies to current user's messages in space channels
 *
 * Uses MMKV storage keyed by user address.
 * Provides a standalone incrementReplyCount callable from WebSocket context.
 */

import { useState, useCallback, useEffect } from 'react';
import { createMMKV } from 'react-native-mmkv';
import { useAuth } from '@/context';

const storage = createMMKV({ id: 'reply-tracking' });

function getStorageKey(userAddress: string): string {
  return `reply_counts:${userAddress}`;
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
 * In-memory tracker of the channel the user is currently viewing. Used
 * to suppress reply-count increments for replies that land while the
 * user is already on the channel (otherwise the badge would bump once
 * and the user would have to leave + return to clear it).
 *
 * Ephemeral by design — resets on app restart, which is correct: after
 * restart the user isn't on any channel until they navigate to one.
 */
let activeChannelKey: string | null = null;

export function setActiveChannel(spaceId: string, channelId: string): void {
  activeChannelKey = `${spaceId}:${channelId}`;
}

export function clearActiveChannel(spaceId: string, channelId: string): void {
  // Only clear if we're still the active channel — guards against a
  // stale unmount of a previous channel clobbering the next one's
  // already-set active state.
  if (activeChannelKey === `${spaceId}:${channelId}`) {
    activeChannelKey = null;
  }
}

/**
 * Read the currently-viewed channel key. Exposed so other trackers (e.g.
 * mention tracking) share the SAME active-channel singleton instead of keeping
 * a second one that could drift.
 */
export function getActiveChannelKey(): string | null {
  return activeChannelKey;
}

/**
 * Standalone function to increment reply count — callable outside React (from WebSocket).
 * Skips the bump if the user is already viewing the channel.
 */
export function incrementReplyCount(userAddress: string, channelKey: string): void {
  if (activeChannelKey === channelKey) return;
  const counts = loadCounts(userAddress);
  counts[channelKey] = (counts[channelKey] || 0) + 1;
  saveCounts(userAddress, counts);
}

export function useReplyTracking() {
  const { user } = useAuth();
  const [counts, setCounts] = useState<Record<string, number>>({});

  // Load counts on mount and when user changes
  useEffect(() => {
    if (!user?.address) {
      setCounts({});
      return;
    }
    setCounts(loadCounts(user.address));
  }, [user?.address]);

  // Periodically refresh counts (WebSocket writes directly to storage)
  useEffect(() => {
    if (!user?.address) return;
    const interval = setInterval(() => {
      setCounts(loadCounts(user.address));
    }, 2000);
    return () => clearInterval(interval);
  }, [user?.address]);

  const getReplyCount = useCallback((spaceId: string, channelId: string): number => {
    const key = `${spaceId}:${channelId}`;
    return counts[key] || 0;
  }, [counts]);

  const clearReplyCount = useCallback((spaceId: string, channelId: string): void => {
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
    getReplyCount,
    clearReplyCount,
    refreshCounts,
  };
}
