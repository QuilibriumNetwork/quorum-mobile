/**
 * The persisted link caches can't grow without limit, and expire.
 *
 * Link probes and mini-app manifests are kept on disk so a relaunch doesn't
 * fetch every link again. The feed shows an open-ended set of links, so the
 * store holding them must stay bounded: past its cap the oldest entries leave
 * the disk, whichever session wrote them.
 */
import { createPersistedTtlCache } from '@/services/offline/persistedTtlCache';

// The cache's MMKV store, as a map this test can look into.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    createMMKV: () => ({
      getString: (k: string) => store.get(k),
      set: (k: string, v: string) => void store.set(k, v),
      remove: (k: string) => store.delete(k),
      getAllKeys: () => [...store.keys()],
      clearAll: () => store.clear(),
    }),
  };
});
const disk: Map<string, string> = jest.requireMock('react-native-mmkv').__store;

const PREFIX = 'test-cache:v1:';
const keysOnDisk = () => [...disk.keys()].filter((k) => k.startsWith(PREFIX));

let now = 1_000_000;
beforeEach(() => {
  disk.clear();
  now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

it('keeps at most maxEntries on disk, dropping the oldest written', () => {
  const cache = createPersistedTtlCache<string>({ prefix: PREFIX, ttlMs: 60_000, maxEntries: 3 });
  for (const k of ['a', 'b', 'c', 'd', 'e']) {
    now += 1;
    cache.set(`https://${k}.invalid/`, k);
  }
  expect(keysOnDisk()).toHaveLength(3);

  cache.forgetInMemory();
  expect(cache.get('https://a.invalid/')).toBeUndefined();
  expect(cache.get('https://b.invalid/')).toBeUndefined();
  expect(cache.get('https://e.invalid/')).toBe('e');
});

it('counts entries an earlier session wrote toward the cap', () => {
  const first = createPersistedTtlCache<string>({ prefix: PREFIX, ttlMs: 60_000, maxEntries: 3 });
  for (const k of ['a', 'b', 'c']) {
    now += 1;
    first.set(k, k);
  }
  // A new session: a fresh cache over the same disk.
  const second = createPersistedTtlCache<string>({ prefix: PREFIX, ttlMs: 60_000, maxEntries: 3 });
  now += 1;
  second.set('d', 'd');

  expect(keysOnDisk()).toHaveLength(3);
  expect(second.get('a')).toBeUndefined();
  expect(second.get('d')).toBe('d');
});

it('stores null as an answer, distinct from no answer', () => {
  const cache = createPersistedTtlCache<string | null>({ prefix: PREFIX, ttlMs: 60_000, maxEntries: 3 });
  cache.set('https://none.invalid', null);
  cache.forgetInMemory();
  expect(cache.get('https://none.invalid')).toBeNull();
  expect(cache.get('https://other.invalid')).toBeUndefined();
});

it('expires entries, and drops expired ones from disk', () => {
  const cache = createPersistedTtlCache<string>({ prefix: PREFIX, ttlMs: 60_000, maxEntries: 10 });
  cache.set('old', 'old');
  now += 60_001;
  expect(cache.get('old')).toBeUndefined();

  cache.forgetInMemory();
  cache.set('new', 'new');
  expect(keysOnDisk()).toHaveLength(1);
});

it('clears its own keys and nothing else', () => {
  disk.set('someone-else', 'x');
  const cache = createPersistedTtlCache<string>({ prefix: PREFIX, ttlMs: 60_000, maxEntries: 10 });
  cache.set('a', 'a');
  cache.clear();
  expect(keysOnDisk()).toHaveLength(0);
  expect(disk.get('someone-else')).toBe('x');
  expect(cache.get('a')).toBeUndefined();
});
