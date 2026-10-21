/**
 * The query cache persister writes rarely, small, and to its own store.
 *
 * ## The regression this pins
 *
 * The stock sync persister stringified the whole dehydrated cache and wrote it
 * at most once a second, on every cache event, into the MMKV store the rest of
 * the app shares. That kept the JS thread busy for as long as the app ran, and
 * the blob held nearly every query, decrypted message pages included.
 *
 * ## What is asserted
 *
 * - A burst of cache events produces one write, 10 s after the last change.
 * - A write that would store the same state again is skipped.
 * - Leaving the foreground writes pending changes at once.
 * - Infinite queries are written with their first page only.
 * - A blob over the cap is not written, and the stored one is removed.
 * - The old cache in the shared store is removed and scrubbed, once.
 * - The spaces and conversation lists are seeded from MMKV, marked stale.
 */
import { AppState } from 'react-native';
import { QueryClient } from '@tanstack/react-query';
import type { PersistedClient } from '@tanstack/react-query-persist-client';

const mockDisk = new Map<string, string>();
const mockSetItem = jest.fn((k: string, v: string) => void mockDisk.set(k, v));
const mockRemoveItem = jest.fn((k: string) => void mockDisk.delete(k));
const mockRemoveAndScrubFile = jest.fn();
const mockShared = new Set<string>();
// Each mock is looked up at call time: the factory runs while this file's
// imports load, before the constants above are initialised.
jest.mock('@/services/offline/storage', () => ({
  queryCacheStore: {
    getItem: (k: string) => mockDisk.get(k) ?? null,
    setItem: (k: string, v: string) => mockSetItem(k, v),
    removeItem: (k: string) => mockRemoveItem(k),
    replaceAndScrub: (k: string, v: string) => void mockDisk.set(k, v),
  },
  removeAndScrubFile: (k: string) => {
    mockShared.delete(k);
    mockRemoveAndScrubFile(k);
  },
  sharedCacheHas: (k: string) => mockShared.has(k),
}));
jest.mock('@quilibrium/quorum-shared', () => ({
  ...jest.requireActual('@quilibrium/quorum-shared'),
  logger: { warn: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));
jest.mock('@/services/config/spaceStorage', () => ({ getAllSpaces: () => [{ spaceId: 's1' }] }));
jest.mock('@/services/storage/mmkvAdapter', () => ({
  getConversationsSync: ({ type }: { type: string }) => ({
    conversations: [{ conversationId: `${type}-1` }],
    nextCursor: null,
  }),
}));

// eslint-disable-next-line import/first -- the storage mock must be registered before these load
import {
  LEGACY_QUERY_CACHE_KEY,
  PERSIST_DEBOUNCE_MS,
  PERSIST_MAX_CHARS,
  QUERY_CACHE_STORAGE_KEY,
  createQueryPersister,
  scrubLegacyQueryCache,
} from '@/services/offline/queryPersister';
// eslint-disable-next-line import/first
import { seedLocalQueries } from '@/services/offline/seedLocalQueries';
// eslint-disable-next-line import/first
import { queryKeys } from '@quilibrium/quorum-shared';

function client(data: unknown, timestamp = Date.now()): PersistedClient {
  return {
    timestamp,
    buster: 'test',
    clientState: {
      mutations: [],
      queries: [
        {
          queryKey: ['hypersnap-notifications', 42],
          queryHash: '["hypersnap-notifications",42]',
          state: { data, dataUpdatedAt: 1, status: 'success' } as never,
        },
      ],
    },
  };
}

let appStateHandler: ((state: string) => void) | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  mockDisk.clear();
  mockShared.clear();
  mockSetItem.mockClear();
  mockRemoveItem.mockClear();
  mockRemoveAndScrubFile.mockClear();
  appStateHandler = undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_event: string, handler: (s: string) => void) => {
    appStateHandler = handler;
    return { remove: jest.fn() };
  }) as never);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('turns a burst of cache events into one write, after the debounce', () => {
  const persister = createQueryPersister();
  for (let i = 0; i < 25; i++) persister.persistClient(client({ n: i }));

  jest.advanceTimersByTime(PERSIST_DEBOUNCE_MS - 1);
  expect(mockSetItem).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);

  expect(mockSetItem).toHaveBeenCalledTimes(1);
  expect(JSON.parse(mockDisk.get(QUERY_CACHE_STORAGE_KEY)!).clientState.queries[0].state.data).toEqual({ n: 24 });
});

it('skips a write that would store the same state again', () => {
  const persister = createQueryPersister();
  persister.persistClient(client({ n: 1 }, 1000));
  jest.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
  persister.persistClient(client({ n: 1 }, 2000));
  jest.advanceTimersByTime(PERSIST_DEBOUNCE_MS);

  expect(mockSetItem).toHaveBeenCalledTimes(1);
});

it('writes pending changes at once when the app leaves the foreground', () => {
  const persister = createQueryPersister();
  persister.persistClient(client({ n: 1 }));
  jest.advanceTimersByTime(0);
  expect(mockSetItem).not.toHaveBeenCalled();

  appStateHandler!('background');
  expect(mockSetItem).toHaveBeenCalledTimes(1);
});

it('writes an infinite query with its first page only', () => {
  const persister = createQueryPersister();
  persister.persistClient(client({ pages: [['p1'], ['p2'], ['p3']], pageParams: [undefined, 'c2', 'c3'] }));
  jest.advanceTimersByTime(PERSIST_DEBOUNCE_MS);

  const written = JSON.parse(mockDisk.get(QUERY_CACHE_STORAGE_KEY)!);
  expect(written.clientState.queries[0].state.data).toEqual({ pages: [['p1']], pageParams: [null] });
});

it('refuses a blob over the cap and removes the stored one', () => {
  mockDisk.set(QUERY_CACHE_STORAGE_KEY, 'previous');
  const persister = createQueryPersister();
  persister.persistClient(client({ big: 'x'.repeat(PERSIST_MAX_CHARS) }));
  jest.advanceTimersByTime(PERSIST_DEBOUNCE_MS);

  expect(mockSetItem).not.toHaveBeenCalled();
  expect(mockDisk.has(QUERY_CACHE_STORAGE_KEY)).toBe(false);
});

it('does not restore a blob over the cap', () => {
  mockDisk.set(QUERY_CACHE_STORAGE_KEY, 'x'.repeat(PERSIST_MAX_CHARS + 1));
  expect(createQueryPersister().restoreClient()).toBeUndefined();
  expect(mockDisk.has(QUERY_CACHE_STORAGE_KEY)).toBe(false);
});

it('removes and scrubs the old shared-store cache once', () => {
  mockShared.add(LEGACY_QUERY_CACHE_KEY);

  expect(scrubLegacyQueryCache()).toBe(true);
  expect(mockRemoveAndScrubFile).toHaveBeenCalledWith(LEGACY_QUERY_CACHE_KEY);
  expect(scrubLegacyQueryCache()).toBe(false);
  expect(mockRemoveAndScrubFile).toHaveBeenCalledTimes(1);
});

it('seeds the spaces and conversation lists from MMKV, stale so they still re-read on mount', () => {
  const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  seedLocalQueries(qc);

  expect(qc.getQueryData(queryKeys.spaces.all)).toEqual([{ spaceId: 's1' }]);
  expect(qc.getQueryData(queryKeys.conversations.all('direct'))).toEqual({
    pages: [{ conversations: [{ conversationId: 'direct-1' }], nextCursor: null }],
    pageParams: [undefined],
  });
  expect(qc.getQueryState(queryKeys.spaces.all)?.dataUpdatedAt).toBe(0);
  // Stale against the spaces list's own 5-minute staleTime, so it refetches on mount.
  expect(qc.getQueryCache().find({ queryKey: queryKeys.spaces.all })?.isStaleByTime(5 * 60 * 1000)).toBe(true);
  qc.clear();
});
