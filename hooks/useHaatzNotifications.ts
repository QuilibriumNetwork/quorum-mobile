/**
 * useHaatzNotifications — the viewer's Farcaster notifications from Hypersnap
 * (haatz), paginated. Keyed by fid; no auth. Refetches every 60s while
 * focused so the bell badge stays current without push.
 */

import { useInfiniteQuery } from '@tanstack/react-query';
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
    // Cap retained pages so a long session doesn't pin every page in the
    // JS heap; dropped pages refetch from the network on demand.
    maxPages: 6,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
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
