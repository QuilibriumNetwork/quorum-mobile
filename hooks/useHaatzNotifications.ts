/**
 * useHaatzNotifications — supplementary, auth-free Farcaster notifications
 * sourced from hypersnap (haatz). Keyed by fid; refetched on the same 60s
 * cadence as the official feed so the two stay roughly in sync before the
 * blend/dedup step in useUnifiedNotifications.
 *
 * Errors never propagate (fetchHaatzNotifications swallows them and returns
 * []), so this query has no error state to surface — by design, since haatz
 * is the resilience fallback for when the official feed is unavailable.
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { fetchHaatzNotifications } from '@/services/farcaster/haatzNotifications';
import type { FarcasterNotification } from '@/services/farcasterClient';

export function useHaatzNotifications() {
  const { user } = useAuth();
  const fid = user?.farcaster?.fid;

  return useQuery<FarcasterNotification[]>({
    queryKey: ['haatz-notifications', fid],
    queryFn: () => (fid != null ? fetchHaatzNotifications(fid) : Promise.resolve([])),
    enabled: fid != null,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}
