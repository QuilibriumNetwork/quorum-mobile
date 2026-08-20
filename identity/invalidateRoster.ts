import type { QueryClient } from '@tanstack/react-query';

/**
 * Tell the identity ladder a space's member rows changed on disk.
 *
 * The ladder's names come from ['identity-roster', spaceId] (an MMKV read,
 * observed at the app root for its whole life), NOT from
 * queryKeys.spaces.members. A permanently-mounted observer never refetches a
 * stale query on its own, so without this call a member's rename reaches the
 * avatar (members cache, patched in place) and not the name — the split a
 * device test caught: avatar live, name only after restart.
 */
export function invalidateRosterCaches(queryClient: QueryClient, spaceId: string): void {
  queryClient.invalidateQueries({ queryKey: ['identity-roster', spaceId] });
}
