/**
 * farcasterFeedCache — small, synchronous MMKV caches for the Farcaster
 * feed, profile, and thread queries so a cold start paints the last-known
 * content instantly, then refreshes from the network in the background.
 *
 * This mirrors the `farcasterDMCache` pattern: per-key payloads read
 * synchronously on mount via `initialData` (no restore race, no spinner),
 * deliberately separate from the app-wide React Query persister. Each
 * payload also carries `updatedAt`, surfaced through
 * `initialDataUpdatedAt` so React Query's staleness logic still applies
 * to restored data.
 *
 * Only a trimmed first page is cached (the screens show newest-first),
 * which bounds the stored size; older pages still load from the network
 * on scroll. Profiles and threads are open-ended key spaces, so each
 * keeps a recency ring — writing past the cap evicts the oldest entry.
 */

import { mmkvStorage } from '@/services/offline/storage';
import type { FeedPage, PageContext } from '@/hooks/useFarcasterFeed';
import type { ProfilePage } from '@/hooks/useFarcasterProfile';
import type { ThreadCast } from '@/hooks/useFarcasterThread';

const feedKey = (fid: number | undefined) => `fc-feed-cache:v1:${fid ?? 'anon'}`;
const profileKey = (fid: number) => `fc-profile-cache:v1:${fid}`;
const threadKey = (castHashPrefix: string) =>
  `fc-thread-cache:v1:${castHashPrefix.toLowerCase()}`;

const PROFILE_INDEX_KEY = 'fc-profile-cache:index:v1';
const THREAD_INDEX_KEY = 'fc-thread-cache:index:v1';

/** Cap the cached first page so a deep feed doesn't bloat MMKV. */
const MAX_CACHED_ITEMS = 25;
/** How many distinct profiles / threads to keep cached on disk. */
const MAX_CACHED_PROFILES = 100;
const MAX_CACHED_THREADS = 50;

/** Infinite-query data shape, matching what useInfiniteQuery expects. */
export interface CachedFeedData {
  pages: FeedPage[];
  pageParams: (PageContext | undefined)[];
}
export interface CachedFeed {
  data: CachedFeedData;
  updatedAt: number;
}

export interface CachedProfileData {
  pages: ProfilePage[];
  pageParams: (string | undefined)[];
}
export interface CachedProfile {
  data: CachedProfileData;
  updatedAt: number;
}

export interface CachedThread {
  casts: ThreadCast[];
  updatedAt: number;
}

/**
 * Recency ring for open-ended key spaces (profiles, threads): keeps a
 * JSON array of recently-written cache keys; touching a key moves it to
 * the back, and overflow evicts (removes) the oldest entries' payloads.
 */
function touchRingIndex(indexKey: string, entryKey: string, max: number): void {
  let keys: string[] = [];
  try {
    const raw = mmkvStorage.getItem(indexKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) keys = parsed.filter((k) => typeof k === 'string');
    }
  } catch {
    // corrupted index — rebuild from scratch
  }
  const next = keys.filter((k) => k !== entryKey);
  next.push(entryKey);
  while (next.length > max) {
    const evicted = next.shift();
    if (evicted) mmkvStorage.removeItem(evicted);
  }
  mmkvStorage.setItem(indexKey, JSON.stringify(next));
}

/** JSON round-trips `undefined` page params to `null`; normalize back so
 *  restored params compare equal to `initialPageParam`. */
function normalizePageParams<T>(params: (T | null | undefined)[]): (T | undefined)[] {
  return params.map((p) => p ?? undefined);
}

// ---- feed (first page, keyed by viewer fid) -------------------------------
export function getCachedFeed(fid: number | undefined): CachedFeed | undefined {
  try {
    const raw = mmkvStorage.getItem(feedKey(fid));
    if (!raw) return undefined;
    const cached = JSON.parse(raw) as CachedFeed;
    if (!cached?.data?.pages?.length) return undefined;
    cached.data.pageParams = normalizePageParams(cached.data.pageParams ?? []);
    return cached;
  } catch {
    return undefined;
  }
}

export function setCachedFeed(
  fid: number | undefined,
  data: { pages: FeedPage[]; pageParams: unknown[] },
): void {
  try {
    const first = data.pages[0];
    if (!first || first.items.length === 0) return;
    // Persist only a trimmed first page so the feed paints instantly; the
    // rest paginates from the network.
    const trimmed: CachedFeed = {
      data: {
        pages: [
          {
            items: first.items.slice(0, MAX_CACHED_ITEMS),
            nextCursor: first.nextCursor,
            latestMainCastTimestamp: first.latestMainCastTimestamp,
            excludeItemIdPrefixes: first.excludeItemIdPrefixes,
          },
        ],
        pageParams: [undefined],
      },
      updatedAt: Date.now(),
    };
    mmkvStorage.setItem(feedKey(fid), JSON.stringify(trimmed));
  } catch {
    // best-effort cache; ignore write failures
  }
}

// ---- profile (first page, keyed by profile fid) ---------------------------
export function getCachedProfile(fid: number): CachedProfile | undefined {
  if (!Number.isFinite(fid) || fid <= 0) return undefined;
  try {
    const raw = mmkvStorage.getItem(profileKey(fid));
    if (!raw) return undefined;
    const cached = JSON.parse(raw) as CachedProfile;
    if (!cached?.data?.pages?.length) return undefined;
    cached.data.pageParams = normalizePageParams(cached.data.pageParams ?? []);
    return cached;
  } catch {
    return undefined;
  }
}

export function setCachedProfile(
  fid: number,
  data: { pages: ProfilePage[]; pageParams: unknown[] },
): void {
  if (!Number.isFinite(fid) || fid <= 0) return;
  try {
    const first = data.pages[0];
    if (!first || first.casts.length === 0) return;
    const trimmed: CachedProfile = {
      data: {
        pages: [
          {
            casts: first.casts.slice(0, MAX_CACHED_ITEMS),
            cursor: first.cursor,
            author: first.author,
          },
        ],
        pageParams: [undefined],
      },
      updatedAt: Date.now(),
    };
    mmkvStorage.setItem(profileKey(fid), JSON.stringify(trimmed));
    touchRingIndex(PROFILE_INDEX_KEY, profileKey(fid), MAX_CACHED_PROFILES);
  } catch {
    // best-effort cache; ignore write failures
  }
}

// ---- thread (flat cast list, keyed by cast hash prefix) -------------------
export function getCachedThread(castHashPrefix: string | undefined): CachedThread | undefined {
  if (!castHashPrefix) return undefined;
  try {
    const raw = mmkvStorage.getItem(threadKey(castHashPrefix));
    if (!raw) return undefined;
    const cached = JSON.parse(raw) as CachedThread;
    if (!Array.isArray(cached?.casts) || cached.casts.length === 0) return undefined;
    return cached;
  } catch {
    return undefined;
  }
}

export function setCachedThread(
  castHashPrefix: string | undefined,
  casts: ThreadCast[],
): void {
  if (!castHashPrefix || casts.length === 0) return;
  try {
    const trimmed: CachedThread = {
      casts: casts.slice(0, MAX_CACHED_ITEMS),
      updatedAt: Date.now(),
    };
    mmkvStorage.setItem(threadKey(castHashPrefix), JSON.stringify(trimmed));
    touchRingIndex(THREAD_INDEX_KEY, threadKey(castHashPrefix), MAX_CACHED_THREADS);
  } catch {
    // best-effort cache; ignore write failures
  }
}
