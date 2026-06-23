/**
 * useSpaceActivity — Track the most recent message per space for inbox sorting/preview.
 *
 * Writes are made from WebSocket handlers when space messages arrive. Reads
 * are done by the unified inbox to surface each space's last activity.
 *
 * Mirrors useReplyTracking's storage pattern so the two stay consistent.
 */

import { useState, useCallback, useEffect } from 'react';
import { createMMKV } from 'react-native-mmkv';
import { coerceMessagePreview, type MessagePreview } from '@/utils/messagePreview';

export interface SpaceActivity {
  timestamp: number;
  /** Typed preview of the last message. Legacy rows stored a raw string and are
   *  coerced on read (see loadActivity). */
  preview?: MessagePreview;
  senderName?: string;
  channelId?: string;
}

const storage = createMMKV({ id: 'space-activity' });
const STORAGE_KEY = 'space_activity';

function loadActivity(): Record<string, SpaceActivity> {
  const raw = storage.getString(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, SpaceActivity>;
    // Coerce legacy string previews (possibly emoji-prefixed) to the typed
    // shape on read so old MMKV rows render without emoji and never crash.
    for (const key of Object.keys(parsed)) {
      const entry = parsed[key];
      if (entry && entry.preview !== undefined) {
        entry.preview = coerceMessagePreview(entry.preview);
      }
    }
    return parsed;
  } catch {
    return {};
  }
}

function saveActivity(activity: Record<string, SpaceActivity>): void {
  storage.set(STORAGE_KEY, JSON.stringify(activity));
}

/**
 * Standalone writer — callable from WebSocket handlers (outside React).
 * Only updates if the new timestamp is newer than what's stored.
 */
export function recordSpaceActivity(
  spaceId: string,
  activity: SpaceActivity
): void {
  const current = loadActivity();
  const existing = current[spaceId];
  if (existing && existing.timestamp >= activity.timestamp) return;
  current[spaceId] = activity;
  saveActivity(current);
}

/**
 * Standalone reader — safe to call from any hook.
 */
export function getSpaceActivity(spaceId: string): SpaceActivity | undefined {
  const all = loadActivity();
  return all[spaceId];
}

/**
 * Hook that exposes the full activity map, refreshed on an interval.
 * Matches the polling pattern used by useReplyTracking.
 */
export function useSpaceActivity() {
  const [activity, setActivity] = useState<Record<string, SpaceActivity>>(() =>
    loadActivity()
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setActivity(loadActivity());
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const getActivity = useCallback(
    (spaceId: string): SpaceActivity | undefined => activity[spaceId],
    [activity]
  );

  return { activity, getActivity };
}
