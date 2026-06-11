/**
 * useFarcasterUsersPrefetch — given a list of FIDs (typically the parent
 * authors of every visible cast in a feed page), bulk-resolve any that
 * aren't already cached and write the results to MMKV + React Query's
 * per-FID query cache.
 *
 * Effect: `useFarcasterUserPersistent(fid)` calls from individual
 * `ParentContextLine` components hit the cache immediately and render
 * `@handle` without a per-cast network round-trip. Latency on a fresh
 * feed page drops from "N parallel single-FID lookups" to "one bulk
 * lookup", typically ~100ms once instead of 100ms × N.
 */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  fetchFarcasterUsersBulk,
  farcasterQueryKeys,
  logger,
  type NormalizedUser,
} from '@quilibrium/quorum-shared';
import {
  getCachedFarcasterUser,
  setCachedFarcasterUser,
} from '@/services/farcaster/farcasterUserCache';

const PREFETCH_DEBOUNCE_MS = 150;

export function useFarcasterUsersPrefetch(fids: (number | undefined)[]): void {
  const queryClient = useQueryClient();
  const fetchedRef = useRef<Set<number>>(new Set());

  // Stable signature: sorted unique-fids array — changes only when the
  // *set* of FIDs we're rendering changes, not on every render.
  const stableKey = useFidsSignature(fids);

  useEffect(() => {
    // Bound the session-lifetime dedupe set — a very long browsing
    // session would otherwise grow it indefinitely. Clearing just means
    // already-cached FIDs get re-confirmed against the caches below.
    if (fetchedRef.current.size > 20000) {
      fetchedRef.current.clear();
    }
    const unique = uniquePositiveFids(fids);
    const missing = unique.filter((fid) => {
      if (fetchedRef.current.has(fid)) return false;
      // Already in React Query memory?
      const cached = queryClient.getQueryData(farcasterQueryKeys.user(fid));
      if (cached) {
        fetchedRef.current.add(fid);
        return false;
      }
      // Already on disk? Hydrate React Query from MMKV and skip the network.
      const persisted = getCachedFarcasterUser(fid);
      if (persisted) {
        queryClient.setQueryData(farcasterQueryKeys.user(fid), persisted);
        fetchedRef.current.add(fid);
        return false;
      }
      return true;
    });

    if (missing.length === 0) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      fetchFarcasterUsersBulk(missing)
        .then((users) => {
          if (cancelled) return;
          for (const user of users) {
            queryClient.setQueryData(farcasterQueryKeys.user(user.fid), user);
            setCachedFarcasterUser(user);
            fetchedRef.current.add(user.fid);
          }
          // Mark "tried but not in the bulk response" FIDs so we don't
          // repeatedly refire — they'll fall through to per-FID lookups
          // if rendered.
          for (const fid of missing) fetchedRef.current.add(fid);
        })
        .catch((err: unknown) => {
          logger.warn('[farcaster] bulk user prefetch failed', err);
        });
    }, PREFETCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [stableKey, fids, queryClient]);
}

function uniquePositiveFids(fids: (number | undefined)[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const fid of fids) {
    if (fid && Number.isFinite(fid) && fid > 0 && !seen.has(fid)) {
      seen.add(fid);
      out.push(fid);
    }
  }
  return out;
}

function useFidsSignature(fids: (number | undefined)[]): string {
  const ref = useRef<string>('');
  const next = uniquePositiveFids(fids).sort((a, b) => a - b).join(',');
  if (next !== ref.current) ref.current = next;
  return ref.current;
}

// Convenience re-export so call sites can read user shape without
// importing from quorum-shared directly.
export type { NormalizedUser };
