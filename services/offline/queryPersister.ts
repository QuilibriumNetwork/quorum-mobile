import { AppState, type AppStateStatus } from 'react-native';
import Constants from 'expo-constants';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { logger } from '@quilibrium/quorum-shared';
import { queryCacheStore, removeAndScrubFile, sharedCacheHas } from './storage';
import { stripNeverPersisted } from './shouldPersistQuery';
import { perfMark } from '../observability/perfProbe';

export const QUERY_CACHE_STORAGE_KEY = 'REACT_QUERY_OFFLINE_CACHE';

/** How long a persisted cache is trusted. `shouldPersistQuery.ts` reasons
 *  about QNS claim verification against this value. */
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Bump when the shape of a persisted query's data changes. */
const PERSIST_SCHEMA_VERSION = 2;
/** A cache written by another release or schema version is dropped rather
 *  than hydrated. The data kept is small, so dropping it costs one refetch. */
export const PERSIST_BUSTER = `${PERSIST_SCHEMA_VERSION}:${Constants.expoConfig?.version ?? 'dev'}`;

/** Where builds before the allow-list kept the whole cache: the same key, in
 *  the shared `quorum-cache` store. Removed once, scrubbed (see below). */
export const LEGACY_QUERY_CACHE_KEY = QUERY_CACHE_STORAGE_KEY;

/** Writes wait this long after the last change, and never longer in total
 *  than `PERSIST_MAX_WAIT_MS` from the first unwritten one. */
export const PERSIST_DEBOUNCE_MS = 10_000;
export const PERSIST_MAX_WAIT_MS = 10_000;
/** A blob larger than this is neither written nor restored. The allow-list
 *  keeps it to a few KB; the cap only bounds the cost if that ever stops
 *  being true. Measured in UTF-16 code units, which is what MMKV stores. */
export const PERSIST_MAX_CHARS = 4 * 1024 * 1024;

/**
 * Restore-side half of the never-persist rules in `shouldPersistQuery.ts`.
 *
 * Writes already refuse those entries; this drops them from a cache read back
 * from disk, before it is hydrated, so the rules hold whatever wrote the file.
 * If anything is dropped, the cleaned cache is written back at once (not at the
 * next write) and the file is scrubbed, so no copy of a dropped entry remains
 * on disk. When nothing is dropped this costs one array filter.
 */
export function deserializePersistedClient(raw: string): PersistedClient {
  const { client, removed } = stripNeverPersisted(JSON.parse(raw) as PersistedClient);
  if (removed > 0) {
    queryCacheStore.replaceAndScrub(QUERY_CACHE_STORAGE_KEY, JSON.stringify(client));
  }
  return client;
}

/** Infinite queries are written with their first page only: enough to paint
 *  at launch, a fraction of the size. */
function trimForDisk(client: PersistedClient): PersistedClient {
  const queries = client.clientState.queries.map((query) => {
    const data = query.state.data as { pages?: unknown[]; pageParams?: unknown[] } | undefined;
    if (!data || !Array.isArray(data.pages) || !Array.isArray(data.pageParams) || data.pages.length <= 1) {
      return query;
    }
    return {
      ...query,
      state: { ...query.state, data: { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) } },
    };
  });
  return { ...client, clientState: { ...client.clientState, queries } };
}

/**
 * The React Query persister.
 *
 * The stock sync persister wrote the whole dehydrated cache, stringified, at
 * most once a second, into the store the rest of the app shares. React Query
 * still dehydrates on every cache event (cheap now: an O(1) allow-list check
 * per query, and only a few queries pass), but this persister writes rarely:
 *
 * 1. calls within one event-loop turn coalesce to the last one;
 * 2. a write waits `PERSIST_DEBOUNCE_MS` after the last change, at most
 *    `PERSIST_MAX_WAIT_MS` after the first;
 * 3. a write whose cached state is unchanged is skipped;
 * 4. pending changes are written at once when the app leaves the foreground;
 * 5. a blob over `PERSIST_MAX_CHARS` isn't written, and the stored one is
 *    removed rather than left stale.
 */
export function createQueryPersister(): Persister {
  let pending: PersistedClient | undefined;
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  let firstPendingAt: number | undefined;
  let lastWrittenState: string | undefined;
  let appStateSubscription: { remove: () => void } | undefined;

  const flush = () => {
    if (coalesceTimer !== undefined) {
      clearTimeout(coalesceTimer);
      coalesceTimer = undefined;
    }
    if (writeTimer !== undefined) {
      clearTimeout(writeTimer);
      writeTimer = undefined;
    }
    firstPendingAt = undefined;
    const client = pending;
    pending = undefined;
    if (!client) return;

    perfMark('rq-persist');
    const trimmed = trimForDisk(client);
    const state = JSON.stringify(trimmed.clientState);
    if (state === lastWrittenState) return;
    const raw = JSON.stringify(trimmed);
    if (raw.length > PERSIST_MAX_CHARS) {
      logger.warn(`[queryPersister] cache is ${raw.length} chars, over the cap; not persisting it`);
      queryCacheStore.removeItem(QUERY_CACHE_STORAGE_KEY);
      lastWrittenState = undefined;
      return;
    }
    try {
      queryCacheStore.setItem(QUERY_CACHE_STORAGE_KEY, raw);
      lastWrittenState = state;
    } catch (e) {
      logger.warn('[queryPersister] write failed:', e instanceof Error ? e.message : e);
    }
  };

  const scheduleWrite = () => {
    const now = Date.now();
    if (firstPendingAt === undefined) firstPendingAt = now;
    if (writeTimer !== undefined) clearTimeout(writeTimer);
    const wait = Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, firstPendingAt + PERSIST_MAX_WAIT_MS - now));
    writeTimer = setTimeout(flush, wait);
  };

  const onAppStateChange = (next: AppStateStatus) => {
    if (next !== 'active') flush();
  };

  return {
    persistClient: (client) => {
      pending = client;
      appStateSubscription ??= AppState.addEventListener('change', onAppStateChange);
      if (coalesceTimer !== undefined) return;
      coalesceTimer = setTimeout(() => {
        coalesceTimer = undefined;
        scheduleWrite();
      }, 0);
    },
    restoreClient: () => {
      const raw = queryCacheStore.getItem(QUERY_CACHE_STORAGE_KEY);
      if (!raw) return undefined;
      if (raw.length > PERSIST_MAX_CHARS) {
        queryCacheStore.removeItem(QUERY_CACHE_STORAGE_KEY);
        return undefined;
      }
      try {
        return deserializePersistedClient(raw);
      } catch {
        queryCacheStore.removeItem(QUERY_CACHE_STORAGE_KEY);
        return undefined;
      }
    },
    removeClient: () => {
      pending = undefined;
      lastWrittenState = undefined;
      if (coalesceTimer !== undefined) clearTimeout(coalesceTimer);
      if (writeTimer !== undefined) clearTimeout(writeTimer);
      coalesceTimer = writeTimer = firstPendingAt = undefined;
      appStateSubscription?.remove();
      appStateSubscription = undefined;
      queryCacheStore.removeItem(QUERY_CACHE_STORAGE_KEY);
    },
  };
}

export const queryPersister = createQueryPersister();

/**
 * Remove the cache earlier builds persisted into the shared store, and leave
 * no copy of it behind. It held nearly every query, including decrypted
 * message pages copied out of the encrypted messages database, in a file with
 * no encryption. MMKV is append-only, so a plain removal would leave those
 * bytes in the file until a compaction; `removeAndScrubFile` overwrites them.
 *
 * Costs two compactions of the shared store, once: later launches find the key
 * gone and return at once. Nothing reads the old blob, so it can run after the
 * first screen is up.
 */
export function scrubLegacyQueryCache(): boolean {
  if (!sharedCacheHas(LEGACY_QUERY_CACHE_KEY)) return false;
  try {
    removeAndScrubFile(LEGACY_QUERY_CACHE_KEY);
    return true;
  } catch (e) {
    logger.warn('[queryPersister] legacy cache scrub failed:', e instanceof Error ? e.message : e);
    return false;
  }
}

export default queryPersister;
