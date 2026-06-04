/**
 * useMessages — local wrapper around the shared infinite-query hook.
 *
 * The only deviation from the shared hook is a longer gcTime so that
 * previously-visited channels stay in the in-memory cache long enough
 * that hopping between channels in a session reuses the cached data
 * instead of re-fetching. Cheap and risk-free.
 *
 * Everything else (queryFn, pagination cursors, query key shape) is
 * kept identical so the rest of the app keeps interoperating with
 * cache writes from WebSocketContext / send hooks.
 */

import { useEffect, useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  queryKeys,
  type GetMessagesResult,
  type Message,
} from '@quilibrium/quorum-shared';
import { useInvalidateMessages } from '@quilibrium/quorum-shared';
import { useStorageAdapter } from '../../context/StorageContext';
import { getMMKVAdapter } from '../../services/storage/mmkvAdapter';
import { useWebSocket } from '../../context/WebSocketContext';
import {
  attemptHubLogRecovery,
  hasAttemptedRecovery,
} from '../../services/space/messageRecovery';

const MESSAGES_GC_TIME_MS = 30 * 60 * 1000; // 30 minutes
const MESSAGES_STALE_TIME_MS = 30 * 1000; // 30 seconds (matches shared hook)

export interface UseMessagesOptions {
  spaceId: string | undefined;
  channelId: string | undefined;
  enabled?: boolean;
  limit?: number;
}

export function useMessages({
  spaceId,
  channelId,
  enabled = true,
  limit = 50,
}: UseMessagesOptions) {
  const storage = useStorageAdapter();

  // Synchronously seed the first page from MMKV so the channel renders
  // its full cached history on the FIRST paint after navigation,
  // rather than flashing the loading spinner while the async queryFn's
  // microtask resolves. Without this, FlashList saw `messages.length=0`
  // for one or two frames after mount, then re-rendered with the cached
  // page — which presented to users as "only the last message shows for
  // a beat, then the rest appear". The actual MMKV read is synchronous;
  // only the StorageAdapter interface's Promise wrapper was forcing a
  // tick of delay.
  //
  // initialData is treated as "already-fetched" data, but
  // initialDataUpdatedAt=0 marks it as stale enough that the queryFn
  // still runs immediately and reconciles against any concurrent
  // writes (e.g. messages persisted by WebSocketContext between
  // navigation and mount). If MMKV is empty for this channel we return
  // undefined and fall through to the normal "loading…" path.
  const initialData = useMemo(() => {
    if (!enabled || !spaceId || !channelId) return undefined;
    const adapter = getMMKVAdapter();
    const page = adapter.getMessagesSync({
      spaceId,
      channelId,
      direction: 'backward',
      limit,
    });
    if (page.messages.length === 0) return undefined;
    return {
      pages: [page],
      pageParams: [undefined] as (number | undefined)[],
    };
  }, [enabled, spaceId, channelId, limit]);

  const query = useInfiniteQuery({
    queryKey: queryKeys.messages.infinite(spaceId ?? '', channelId ?? ''),
    queryFn: async ({ pageParam }): Promise<GetMessagesResult> => {
      if (!spaceId || !channelId) {
        return { messages: [], nextCursor: null, prevCursor: null };
      }
      return storage.getMessages({
        spaceId,
        channelId,
        cursor: pageParam as number | undefined,
        direction: 'backward',
        limit,
      });
    },
    getNextPageParam: (lastPage) => lastPage.prevCursor,
    getPreviousPageParam: (firstPage) => firstPage.nextCursor,
    initialPageParam: undefined as number | undefined,
    enabled: enabled && !!spaceId && !!channelId,
    staleTime: MESSAGES_STALE_TIME_MS,
    gcTime: MESSAGES_GC_TIME_MS,
    // Cap retained pages so a long session / large scrollback doesn't
    // pin every page in the (Hermes-native) heap for the full 30-min
    // gcTime. Older pages drop from memory and refetch from SQLite on
    // scroll-up. Bidirectional query, so scrolling one way trims the
    // other end.
    maxPages: 6,
    initialData,
    initialDataUpdatedAt: 0,
  });

  // Empty-on-open recovery: if SQLite returns zero rows for this
  // channel and we've never attempted hub-log recovery for the space,
  // request a full server replay. Designed to rescue users hit by
  // first-launch migration glitches that emptied their local cache.
  // No-op (and harmless) for legitimately empty channels — the
  // attempt is marked done either way so it never re-fires.
  //
  // WebSocket may not be connected yet (e.g., on cold start, before
  // initial handshake completes). attemptHubLogRecovery still enqueues
  // the frame via enqueueOutbound — it'll go out once the connection
  // is up and the persistent attempt flag prevents a second try when
  // it does.
  const { enqueueOutbound } = useWebSocket();
  useEffect(() => {
    if (!enabled || !spaceId || !channelId) return;
    if (query.isLoading || query.isFetching) return;
    if (hasAttemptedRecovery(spaceId)) return;
    const firstPage = query.data?.pages?.[0];
    if (!firstPage) return;
    if (firstPage.messages.length > 0) return;
    attemptHubLogRecovery(spaceId, enqueueOutbound);
  }, [
    enabled,
    spaceId,
    channelId,
    query.isLoading,
    query.isFetching,
    query.data,
    enqueueOutbound,
  ]);

  return query;
}

/**
 * Flatten paginated messages into a single array
 *
 * Pages are ordered newest-first (page 0 = newest messages, page N = oldest).
 * Each page contains messages in chronological order (oldest first within page).
 * We reverse the pages so older pages come first, then flatten.
 * Result: all messages in chronological order (oldest first).
 *
 * Dedupes by messageId during the flatten — duplicate entries can appear
 * briefly when the React Query cache has the same message in two pages
 * during a page-boundary transition, or when an ingestion path inserts a
 * message that's also in a freshly-fetched page. The on-disk storage
 * upserts by id so this is purely an in-memory cache concern, but a
 * single dupe was crashing the chat surface (MiniSearch addAll throws on
 * duplicate ids) — drop them at the seam.
 *
 * Older pages come first in the flatten order, so when a duplicate
 * exists we prefer the OLDER page's copy. Pages from older pages tend
 * to be the ones backed by disk reads and contain canonical state;
 * newer pages are more likely to be optimistic / ingestion-injected
 * snapshots that may lack reactions, edits, etc. After the older copy
 * is in, later duplicates are skipped.
 */
export function flattenMessages(
  pages: GetMessagesResult[] | undefined
): Message[] {
  if (!pages) return [];
  const seen = new Set<string>();
  const out: Message[] = [];
  // Reverse pages so oldest page comes first, then flatten with dedupe
  for (const page of [...pages].reverse()) {
    for (const msg of page.messages) {
      if (seen.has(msg.messageId)) continue;
      seen.add(msg.messageId);
      out.push(msg);
    }
  }
  return out;
}

export { useInvalidateMessages };
