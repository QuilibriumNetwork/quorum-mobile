/**
 * useHegemonyGovernance — fetches the parsed /hegemony governance feed
 * (proposals + reputation-weighted FOR/AGAINST tallies + reply threads) from
 * the hypersnap portal API. Cached for 60s to match the backend's own cache.
 */

import { useQuery } from '@tanstack/react-query';
import { fetchGovernance, type ChannelCast } from '@/services/governance/governanceClient';

export function useHegemonyGovernance(options?: { enabled?: boolean }) {
  const query = useQuery<ChannelCast[]>({
    queryKey: ['hegemony-governance'],
    queryFn: fetchGovernance,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled ?? true,
  });

  return {
    casts: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    isRefetching: query.isRefetching,
  };
}
