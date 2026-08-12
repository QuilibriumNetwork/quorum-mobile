import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import type { RosterNameRow } from '@/identity/identityFromMaps';

/**
 * `spaceId -> address -> name slots`, for every space passed.
 *
 * Reads MMKV, not the network. A roster is a local memory-mapped read, so
 * carrying every space's rosters at the app root costs no requests — which is
 * what makes it affordable for the root scope to hold real data rather than
 * empty maps.
 *
 * A space whose read has not resolved yet contributes `{}` rather than being
 * absent. That is deliberate and safe ONLY because the provider merges
 * rosters per ADDRESS: an empty entry contributes nothing instead of blanking
 * whatever an ancestor already knew for that space.
 */
export function useMultiSpaceRosters(
  spaceIds: string[],
): Record<string, Record<string, RosterNameRow>> {
  const ids = useMemo(() => Array.from(new Set(spaceIds.filter(Boolean))).sort(), [spaceIds]);

  const queries = useQueries({
    queries: ids.map((spaceId) => ({
      queryKey: ['identity-roster', spaceId],
      queryFn: async (): Promise<Record<string, RosterNameRow>> => {
        const members = await getMMKVAdapter().getSpaceMembers(spaceId);
        const map: Record<string, RosterNameRow> = {};
        for (const m of members) {
          const row = m as unknown as {
            address?: string;
            display_name?: string | null;
            global_display_name?: string | null;
          };
          if (row.address) {
            map[row.address] = {
              display_name: row.display_name,
              global_display_name: row.global_display_name,
            };
          }
        }
        return map;
      },
      staleTime: 30 * 1000,
      gcTime: 10 * 60 * 1000,
    })),
  });

  const updatedAtKey = queries.map((q) => q?.dataUpdatedAt ?? 0).join('|');
  return useMemo(() => {
    const out: Record<string, Record<string, RosterNameRow>> = {};
    ids.forEach((spaceId, i) => {
      out[spaceId] = queries[i]?.data ?? {};
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, updatedAtKey]);
}
