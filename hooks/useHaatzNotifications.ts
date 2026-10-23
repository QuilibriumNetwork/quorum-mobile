/**
 * useHaatzNotifications — the viewer's Farcaster notifications from Hypersnap
 * (haatz), paginated. Keyed by fid; no auth. `useHaatzNotificationsPoll`
 * keeps it current for the bell badge without push.
 */

import { useEffect } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { fetchHaatzNotifications } from '@/services/farcaster/haatzNotifications';
import type {
  FarcasterNotification,
  FarcasterNotificationsPage,
} from '@/services/farcasterClient';

export function useHaatzNotifications() {
  const { user } = useAuth();
  const fid = user?.farcaster?.fid;

  return useInfiniteQuery<
    FarcasterNotificationsPage,
    Error,
    { pages: FarcasterNotificationsPage[]; pageParams: (string | undefined)[] },
    readonly ['hypersnap-notifications', number | undefined],
    string | undefined
  >({
    queryKey: ['hypersnap-notifications', fid] as const,
    queryFn: ({ pageParam }) => fetchHaatzNotifications(fid as number, pageParam),
    initialPageParam: undefined,
    // Hypersnap can hand back a cursor past the end of what it indexes; an
    // empty page ends the list rather than paging on through nothing.
    getNextPageParam: (last) =>
      last && last.notifications.length > 0 && last.nextCursor ? last.nextCursor : undefined,
    enabled: fid != null && fid > 0,
    // No `maxPages`: notifications only page older, so a dropped first page
    // never came back, and every refetch started from the page after it; the
    // list and the badge stopped seeing new notifications.
    staleTime: 30_000,
    // Not polled itself: `useHaatzNotificationsPoll` watches a few-row probe
    // and refetches this only when something new has arrived.
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

/** Rows in the probe: enough to see a new notification past a dismissed one. */
const POLL_PROBE_LIMIT = 5;
const POLL_INTERVAL_MS = 60_000;

const newestTimestamp = (page: FarcasterNotificationsPage | null | undefined) =>
  Math.max(0, ...(page?.notifications ?? []).map((n) => n.timestamp ?? 0));

/**
 * Keeps the notifications list current for the bell badge. Mount it once (the
 * tab bar): each observer of a polled query runs its own timer.
 *
 * The list's first page is 25 notifications, each with a full cast and author
 * (about 80 KB before compression), and it used to be fetched every minute
 * whether or not anything had changed. This polls the newest few instead and
 * refetches the list only when one is newer than what it holds. Once the list
 * has been scrolled into more pages it isn't refetched (that would reload
 * every page): someone is reading it, and pull-to-refresh and coming back to
 * the app still refresh it.
 */
export function useHaatzNotificationsPoll(): void {
  const { user } = useAuth();
  const fid = user?.farcaster?.fid;
  const queryClient = useQueryClient();

  const { data: probe } = useQuery({
    queryKey: ['hypersnap-notifications-head', fid] as const,
    queryFn: () => fetchHaatzNotifications(fid as number, undefined, POLL_PROBE_LIMIT),
    enabled: fid != null && fid > 0,
    refetchInterval: POLL_INTERVAL_MS,
    retry: 1,
  });

  useEffect(() => {
    if (!probe || fid == null) return;
    const listKey = ['hypersnap-notifications', fid] as const;
    const list = queryClient.getQueryData<{ pages: FarcasterNotificationsPage[] }>(listKey);
    if (!list || list.pages.length > 1) return;
    if (newestTimestamp(probe) > newestTimestamp(list.pages[0])) {
      void queryClient.refetchQueries({ queryKey: listKey, exact: true }, { cancelRefetch: false });
    }
  }, [probe, fid, queryClient]);
}

export function flattenFarcasterNotifications(
  pages: (FarcasterNotificationsPage | null | undefined)[] | undefined,
): FarcasterNotification[] {
  if (!pages) return [];
  const seen = new Set<string>();
  const out: FarcasterNotification[] = [];
  for (const page of pages) {
    // A page restored from a persisted cache written by another build can be
    // null or a different shape at runtime. Skip it rather than crash the
    // tab-bar icon, which would soft-brick navigation until app data is wiped.
    if (!page || !Array.isArray(page.notifications)) continue;
    for (const n of page.notifications) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
    }
  }
  return out;
}
