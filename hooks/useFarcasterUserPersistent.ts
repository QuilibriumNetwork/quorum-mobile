/**
 * useFarcasterUserPersistent — wraps shared's useFarcasterUser with MMKV
 * read-through caching so user records never disappear from the UI.
 *
 *  - In-memory: gcTime: Infinity → React Query never evicts the entry
 *    during a session, regardless of how long since it was last accessed.
 *  - On disk: seeded from MMKV as initialData on first mount; written
 *    back whenever a fresh fetch resolves with a non-null user.
 *  - Lazy refresh: staleTime: 30 minutes → cached data renders instantly,
 *    background refetch runs only if the entry hasn't been refreshed within
 *    the window.
 *
 * Result: a user we've ever seen will keep rendering with their last-known
 * displayName / username / pfp even after a cold restart, and silently
 * updates when the network is available.
 */

import { useEffect, useMemo } from 'react';
import {
  useFarcasterUser,
  type NormalizedUser,
} from '@quilibrium/quorum-shared';
import {
  getCachedFarcasterUser,
  setCachedFarcasterUser,
} from '@/services/farcaster/farcasterUserCache';

const STALE_TIME_MS = 30 * 60_000;

export interface UseFarcasterUserPersistentOptions {
  enabled?: boolean;
  token?: string;
}

export function useFarcasterUserPersistent(
  fid: number | undefined,
  options: UseFarcasterUserPersistentOptions = {},
) {
  // Read MMKV once per fid; useMemo locks the value for this render so the
  // initialData ref stays stable across re-renders.
  const initialData = useMemo(() => getCachedFarcasterUser(fid), [fid]);

  const query = useFarcasterUser(fid, {
    enabled: options.enabled,
    token: options.token,
    staleTime: STALE_TIME_MS,
    gcTime: Infinity,
    initialData,
  });

  // Persist on every fresh refetch. We check isFetched so stale initialData
  // pulled from MMKV doesn't trigger a redundant write.
  useEffect(() => {
    if (query.data && query.isFetched) {
      setCachedFarcasterUser(query.data);
    }
  }, [query.data, query.isFetched]);

  return query;
}
