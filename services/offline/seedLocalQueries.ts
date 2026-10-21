/**
 * Seed the spaces list and the conversation lists from their own MMKV stores
 * when the query client is created, so they paint on the first render.
 *
 * They used to paint from the persisted React Query cache. That cache now
 * holds only a short allow-list (`shouldPersistQuery.ts`), and these queries
 * read local storage through promises, which would leave the lists empty for
 * the first frames of every launch. The reads here are the same ones their
 * query functions make, done synchronously. The seeded data is marked stale
 * (`updatedAt: 0`), so each list still re-reads its store when it mounts,
 * exactly as a restored cache entry did.
 */
import type { QueryClient } from '@tanstack/react-query';
import { logger, queryKeys } from '@quilibrium/quorum-shared';
import { getAllSpaces } from '@/services/config/spaceStorage';
import { getConversationsSync } from '@/services/storage/mmkvAdapter';

/** Page size `useConversations` asks for. */
const CONVERSATION_PAGE_SIZE = 50;

export function seedLocalQueries(queryClient: QueryClient): void {
  try {
    queryClient.setQueryData(queryKeys.spaces.all, getAllSpaces(), { updatedAt: 0 });
    for (const type of ['direct', 'group'] as const) {
      const page = getConversationsSync({ type, limit: CONVERSATION_PAGE_SIZE });
      queryClient.setQueryData(
        queryKeys.conversations.all(type),
        { pages: [page], pageParams: [undefined] },
        { updatedAt: 0 },
      );
    }
  } catch (e) {
    // The queries load the same data on mount; a failed seed only costs the
    // instant first paint.
    logger.warn('[seedLocalQueries] seed failed:', e instanceof Error ? e.message : e);
  }
}
