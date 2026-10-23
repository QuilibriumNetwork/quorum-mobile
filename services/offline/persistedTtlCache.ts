/**
 * persistedTtlCache — a small key-value cache in MMKV whose entries expire,
 * for answers worth keeping across launches but not for good:
 * what a link in the feed turned out to be, whether a site publishes a
 * mini-app manifest. Without it every link was fetched again on every launch.
 *
 * Each entry is its own MMKV key, `<prefix><hash of the key>`, holding when it
 * was written, the full key and the value. The hash keeps MMKV keys short
 * whatever the URL; the full key is compared on read, so two keys that share a
 * hash read as a miss, never as each other's answer.
 *
 * Bounded: past `maxEntries` the oldest-written entries are removed. Which
 * entries exist is learned once per session by listing the store's keys, as
 * `farcasterUserCache` does, so an entry written by any earlier session is
 * still counted and evictable, and no index has to be rewritten on each write.
 * Expired entries are dropped during that listing too.
 *
 * Reads go through an in-memory copy, so a list re-rendering its cells
 * doesn't parse JSON for each one.
 *
 * Its own small store, as the follow set has (`socialGraph.ts`), rather than
 * the shared one: listing it reads only these entries, and importing it
 * doesn't load the config service and native crypto behind
 * `services/offline/storage` into every module that renders a link.
 */

import { createMMKV, type MMKV } from 'react-native-mmkv';

let store: MMKV | null = null;
const getStore = () => (store ??= createMMKV({ id: 'quorum-link-cache' }));

/** Remove every cached link answer from disk, for a reset or sign-out: which
 *  links someone's feed showed is theirs. In-memory copies last until the
 *  process ends. */
export function clearPersistedTtlCaches(): void {
  try {
    getStore().clearAll();
  } catch {
    // Nothing more to do.
  }
}

export interface PersistedTtlCache<T> {
  /** The value stored for `key`, or undefined when there is none or it has
   *  expired. A stored `null` comes back as `null`. */
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  /** Remove every entry, in memory and on disk. */
  clear(): void;
  /** Forget the in-memory copies and leave the disk alone: what a relaunch
   *  does. For tests. */
  forgetInMemory(): void;
}

export interface PersistedTtlCacheOptions {
  /** Starts every MMKV key of this cache. Include a version, and bump it when
   *  the stored shape changes, so old entries are never read back. */
  prefix: string;
  ttlMs: number;
  maxEntries: number;
}

interface Entry<T> {
  value: T;
  savedAt: number;
}

/** 32-bit FNV-1a, in base 36. Not for security; only to keep keys short. */
function hashKey(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Stored as `<savedAt>\n<JSON of { k, v }>`, so listing the entries reads
 *  their ages without parsing them. JSON never holds a raw newline. */
function encode<T>(key: string, value: T, savedAt: number): string {
  return `${savedAt}\n${JSON.stringify({ k: key, v: value })}`;
}

function savedAtOf(raw: string): number | undefined {
  const t = Number(raw.slice(0, raw.indexOf('\n')));
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

export function createPersistedTtlCache<T>(options: PersistedTtlCacheOptions): PersistedTtlCache<T> {
  const { prefix, ttlMs, maxEntries } = options;
  /** Recently read or written entries by key, least recently used first. */
  const memory = new Map<string, Entry<T>>();
  /** MMKV key to when it was written, oldest first. Loaded on first write. */
  let onDisk: Map<string, number> | null = null;

  const storageKey = (key: string) => `${prefix}${hashKey(key)}`;
  const isFresh = (savedAt: number) => Date.now() - savedAt < ttlMs;

  function remember(key: string, entry: Entry<T>): void {
    memory.delete(key);
    memory.set(key, entry);
    if (memory.size > maxEntries) {
      const oldest = memory.keys().next().value;
      if (oldest !== undefined) memory.delete(oldest);
    }
  }

  function readDisk(key: string): Entry<T> | undefined {
    try {
      const raw = getStore().getString(storageKey(key));
      if (!raw) return undefined;
      const savedAt = savedAtOf(raw);
      if (savedAt === undefined) return undefined;
      const stored = JSON.parse(raw.slice(raw.indexOf('\n') + 1)) as { k?: unknown; v: T };
      if (stored?.k !== key) return undefined;
      return { value: stored.v, savedAt };
    } catch {
      return undefined;
    }
  }

  function loadOnDisk(): Map<string, number> {
    if (onDisk) return onDisk;
    const found: [string, number][] = [];
    try {
      const disk = getStore();
      for (const k of disk.getAllKeys()) {
        if (!k.startsWith(prefix)) continue;
        const raw = disk.getString(k);
        const savedAt = raw ? savedAtOf(raw) : undefined;
        if (savedAt === undefined || !isFresh(savedAt)) {
          disk.remove(k);
          continue;
        }
        found.push([k, savedAt]);
      }
    } catch {
      // Best effort: entries not seen here are overwritten or expire unread.
    }
    found.sort((a, b) => a[1] - b[1]);
    onDisk = new Map(found);
    return onDisk;
  }

  return {
    get(key) {
      const inMemory = memory.get(key);
      if (inMemory) {
        if (isFresh(inMemory.savedAt)) return inMemory.value;
        memory.delete(key);
        return undefined;
      }
      const stored = readDisk(key);
      if (!stored || !isFresh(stored.savedAt)) return undefined;
      remember(key, stored);
      return stored.value;
    },

    set(key, value) {
      const savedAt = Date.now();
      remember(key, { value, savedAt });
      try {
        const index = loadOnDisk();
        const disk = getStore();
        const sk = storageKey(key);
        disk.set(sk, encode(key, value, savedAt));
        index.delete(sk);
        index.set(sk, savedAt);
        while (index.size > maxEntries) {
          const oldest = index.keys().next().value;
          if (oldest === undefined) break;
          index.delete(oldest);
          disk.remove(oldest);
        }
      } catch {
        // Best-effort cache; the in-memory copy still answers this session.
      }
    },

    clear() {
      memory.clear();
      try {
        const disk = getStore();
        for (const k of disk.getAllKeys()) {
          if (k.startsWith(prefix)) disk.remove(k);
        }
      } catch {
        // Nothing more to do.
      }
      onDisk = null;
    },

    forgetInMemory() {
      memory.clear();
      onDisk = null;
    },
  };
}
