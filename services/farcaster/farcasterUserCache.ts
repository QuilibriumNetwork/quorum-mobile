/**
 * Long-lived MMKV cache for normalized Farcaster user records, keyed by FID.
 *
 * Survives app restarts and React Query cache eviction. Read-through:
 * `useFarcasterUserPersistent` (below) seeds React Query's `initialData`
 * from here, then writes back on successful refresh.
 *
 * Records here are never deleted. The cache only grows — a Farcaster user
 * profile is small, FIDs are bounded by the network's user count, and the
 * cost of refetching is the original reason we cache. If memory becomes a
 * concern, add a single LRU window on top.
 */

import { mmkvStorage } from '@/services/offline/storage';
import type { NormalizedUser } from '@quilibrium/quorum-shared';

const KEY_PREFIX = 'farcaster.user.v1:';

function keyOf(fid: number): string {
  return `${KEY_PREFIX}${fid}`;
}

export function getCachedFarcasterUser(fid: number | undefined): NormalizedUser | undefined {
  if (!Number.isFinite(fid) || (fid as number) <= 0) return undefined;
  const raw = mmkvStorage.getItem(keyOf(fid as number));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as NormalizedUser;
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
  }
}
