import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { mmkvStorage, replaceAndScrubFile } from './storage';
import { stripNeverPersisted } from './shouldPersistQuery';

export const QUERY_CACHE_STORAGE_KEY = 'REACT_QUERY_OFFLINE_CACHE';

/**
 * Restore-side half of the never-persist rules in `shouldPersistQuery.ts`.
 *
 * Writes already refuse those entries; this drops them from a cache read back
 * from disk, before it is hydrated, so the rules hold whatever wrote the file.
 * If anything is dropped, the cleaned cache is written back at once (not at the
 * next cache event) and the file is scrubbed, so no copy of a dropped entry
 * remains on disk. When nothing is dropped this costs one array filter.
 */
export function deserializePersistedClient(raw: string): PersistedClient {
  const { client, removed } = stripNeverPersisted(JSON.parse(raw) as PersistedClient);
  if (removed > 0) {
    replaceAndScrubFile(QUERY_CACHE_STORAGE_KEY, JSON.stringify(client));
  }
  return client;
}

/**
 * Persister for React Query that uses MMKV storage.
 * Syncs query cache to device storage for offline access.
 */
export const queryPersister = createSyncStoragePersister({
  storage: mmkvStorage,
  key: QUERY_CACHE_STORAGE_KEY,
  deserialize: deserializePersistedClient,
});

export default queryPersister;
