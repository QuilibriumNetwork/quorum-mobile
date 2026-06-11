/**
 * Long-lived MMKV cache for normalized Farcaster user records, keyed by FID.
 *
 * Survives app restarts and React Query cache eviction. Read-through:
 * `useFarcasterUserPersistent` (below) seeds React Query's `initialData`
 * from here, then writes back on successful refresh.
 *
 * Bounded by a simple LRU window: a lastAccess timestamp per FID lives in
 * an in-memory index (persisted to MMKV periodically), and once the cache
 * grows past MAX_CACHED_USERS, the oldest ~10% are evicted in one batch.
 * Reads only touch the in-memory index (no MMKV write per read); the
 * index is flushed on eviction and every INDEX_FLUSH_EVERY writes, and is
 * reconciled against the actual on-disk keys on first use per session so
 * entries written before the index existed (or lost to an unflushed
 * index) stay evictable.
 */

import { mmkvStorage, storage } from '@/services/offline/storage';
import type { NormalizedUser } from '@quilibrium/quorum-shared';

const KEY_PREFIX = 'farcaster.user.v1:';
const INDEX_KEY = 'farcaster.user.v1:__index';
/** Cap on cached user records; a record is ~300 bytes, so ~1.5 MB total. */
const MAX_CACHED_USERS = 5000;
/** Evict ~10% past the cap so eviction is amortized, not per-write. */
const EVICT_BATCH = Math.floor(MAX_CACHED_USERS / 10);
/** Flush the access index at most every N writes — it's ~80 KB of JSON at
 *  the cap, too heavy to rewrite per user during a bulk prefetch. Losing
 *  a few updates to an app kill only makes eviction order approximate. */
const INDEX_FLUSH_EVERY = 25;

let accessIndex: Map<number, number> | null = null;
let writesSinceFlush = 0;

function keyOf(fid: number): string {
  return `${KEY_PREFIX}${fid}`;
}

function loadIndex(): Map<number, number> {
  if (accessIndex) return accessIndex;
  const idx = new Map<number, number>();
  try {
    const raw = mmkvStorage.getItem(INDEX_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, number>;
      for (const [fidStr, ts] of Object.entries(obj)) {
        const fid = Number(fidStr);
        if (Number.isFinite(fid) && fid > 0 && typeof ts === 'number') {
          idx.set(fid, ts);
        }
      }
    }
  } catch {
    // Corrupted index — rebuilt from disk keys below.
  }
  // Reconcile against what's actually on disk (once per session): records
  // written before the index existed must still count toward the cap.
  try {
    const now = Date.now();
    for (const key of storage.getAllKeys()) {
      if (!key.startsWith(KEY_PREFIX) || key === INDEX_KEY) continue;
      const fid = Number(key.slice(KEY_PREFIX.length));
      if (Number.isFinite(fid) && fid > 0 && !idx.has(fid)) {
        idx.set(fid, now);
      }
    }
  } catch {
    // best-effort; the index still works for entries we've seen
  }
  accessIndex = idx;
  return idx;
}

function flushIndex(idx: Map<number, number>): void {
  try {
    const obj: Record<number, number> = {};
    for (const [fid, ts] of idx) obj[fid] = ts;
    mmkvStorage.setItem(INDEX_KEY, JSON.stringify(obj));
  } catch {
    // Storage failures are non-fatal — eviction order just gets coarser.
  }
  writesSinceFlush = 0;
}

/** Evict the oldest ~10% when the cache exceeds the cap. Returns true if
 *  anything was evicted. */
function evictIfNeeded(idx: Map<number, number>): boolean {
  if (idx.size <= MAX_CACHED_USERS) return false;
  const oldest = [...idx.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, EVICT_BATCH);
  for (const [fid] of oldest) {
    idx.delete(fid);
    try {
      mmkvStorage.removeItem(keyOf(fid));
    } catch {
      // non-fatal — the index entry is gone either way
    }
  }
  return true;
}

export function getCachedFarcasterUser(fid: number | undefined): NormalizedUser | undefined {
  if (!Number.isFinite(fid) || (fid as number) <= 0) return undefined;
  const raw = mmkvStorage.getItem(keyOf(fid as number));
  if (!raw) return undefined;
  try {
    const user = JSON.parse(raw) as NormalizedUser;
    // In-memory touch only — flushed with the next write batch.
    loadIndex().set(fid as number, Date.now());
    return user;
  } catch {
    return undefined;
  }
}

export function setCachedFarcasterUser(user: NormalizedUser): void {
  if (!Number.isFinite(user.fid) || user.fid <= 0) return;
  try {
    mmkvStorage.setItem(keyOf(user.fid), JSON.stringify(user));
  } catch {
    // Storage failures are non-fatal — React Query memory cache continues to work.
    return;
  }
  const idx = loadIndex();
  idx.set(user.fid, Date.now());
  const evicted = evictIfNeeded(idx);
  writesSinceFlush += 1;
  if (evicted || writesSinceFlush >= INDEX_FLUSH_EVERY) {
    flushIndex(idx);
  }
}
