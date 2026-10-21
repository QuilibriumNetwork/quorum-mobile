/**
 * Farcaster Search hooks for users, channels, and casts.
 *
 * Users and casts are searched on Hypersnap. Channels and a user's followed
 * channels are searched on client.warpcast.com: Hypersnap has no channel
 * metadata or channel follows (FARCASTER_TECH_DEBT.md).
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo, useCallback, useState, useEffect } from 'react';
import {
  DEFAULT_HYPERSNAP_BASE_URL,
  fromHypersnapCast,
  type HypersnapCast,
  type HypersnapUser,
} from '@quilibrium/quorum-shared';
import { normalizedCastToLegacy } from '@/services/farcaster/hypersnapToLegacyShape';
import { rememberCastAuthor } from '@/services/farcaster/hypersnapWrites';

// Types matching the Farcaster API
export interface SearchUser {
  fid: number;
  username: string;
  displayName: string;
  pfp?: { url?: string };
  profile?: {
    bio?: { text?: string };
  };
  followerCount?: number;
  followingCount?: number;
  viewerContext?: {
    following?: boolean;
    followedBy?: boolean;
  };
}

export interface SearchChannel {
  key: string;
  name: string;
  description?: string;
  imageUrl?: string;
  followerCount?: number;
  viewerContext?: {
    following: boolean;
  };
}

export interface SearchCast {
  hash: string;
  threadHash: string;
  author: {
    fid: number;
    username: string;
    displayName: string;
    pfp?: { url?: string };
  };
  text: string;
  timestamp: number;
  replies?: { count?: number };
  reactions?: { count?: number };
  recasts?: { count?: number };
  channel?: { key?: string; name?: string };
}

/** Search users on Hypersnap: username prefix, then display-name words,
 *  each ranked by follower count. One page, no viewer context. */
async function searchUsersOnHypersnap(q: string, limit: number): Promise<SearchUser[]> {
  // The server strips leading `@`s and answers 400 if nothing is left.
  if (!q.trim().replace(/^@+/, '')) return [];
  const res = await fetch(
    `${DEFAULT_HYPERSNAP_BASE_URL}/v2/farcaster/user/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    { headers: { accept: 'application/json' } },
  );
  if (!res.ok) throw new Error('Failed to search users');
  const json = (await res.json()) as { users?: HypersnapUser[] };
  return (json.users ?? []).map((u) => {
    const bio = u.profile?.bio?.text;
    return {
      fid: u.fid,
      username: u.username,
      displayName: u.display_name ?? '',
      pfp: u.pfp_url ? { url: u.pfp_url } : undefined,
      profile: bio ? { bio: { text: bio } } : undefined,
      followerCount: u.follower_count,
      followingCount: u.following_count,
    };
  });
}

/** Search casts on Hypersnap. Its search has no paging (`next` is always
 *  empty) and returns no counts beyond what the cast object carries. */
async function searchCastsOnHypersnap(q: string, limit: number): Promise<SearchCast[]> {
  const res = await fetch(
    `${DEFAULT_HYPERSNAP_BASE_URL}/v2/farcaster/cast/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    { headers: { accept: 'application/json' } },
  );
  if (!res.ok) throw new Error('Failed to search casts');
  const json = (await res.json()) as { result?: { casts?: HypersnapCast[] } };
  return (json.result?.casts ?? []).map((c) => {
    const cast = normalizedCastToLegacy(fromHypersnapCast(c));
    rememberCastAuthor(cast.hash, cast.author.fid);
    return {
      hash: cast.hash,
      threadHash: cast.hash,
      author: {
        fid: cast.author.fid,
        username: cast.author.username,
        displayName: cast.author.displayName,
        pfp: cast.author.pfp,
      },
      text: cast.text,
      timestamp: cast.timestamp,
      replies: cast.replies,
      reactions: cast.reactions,
      recasts: cast.recasts,
      channel: cast.channel,
    };
  });
}

interface SearchSummaryResult {
  users: SearchUser[];
  channels: SearchChannel[];
  casts: SearchCast[];
}

// Debounce hook
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

// Search summary - get quick preview of all result types
export function useSearchSummary({
  q,
  token,
  maxUsers = 5,
  maxChannels = 5,
  enabled = true,
}: {
  q: string;
  token?: string;
  maxUsers?: number;
  maxChannels?: number;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ['farcasterSearchSummary', q, maxUsers, maxChannels],
    queryFn: async (): Promise<SearchSummaryResult> => {
      if (!q.trim()) {
        return { users: [], channels: [], casts: [] };
      }

      const headers: Record<string, string> = {
        accept: '*/*',
        'content-type': 'application/json',
        origin: 'https://warpcast.com',
        referer: 'https://warpcast.com/',
      };
      if (token) {
        headers['authorization'] = `Bearer ${token}`;
      }

      // Fetch all three in parallel
      const [users, channelsRes, casts] = await Promise.all([
        searchUsersOnHypersnap(q, maxUsers).catch(() => [] as SearchUser[]),
        fetch(`https://client.warpcast.com/v2/search-channels?q=${encodeURIComponent(q)}&limit=${maxChannels}`, { headers }),
        searchCastsOnHypersnap(q, 5).catch(() => [] as SearchCast[]),
      ]);

      const channelsData = channelsRes.ok ? await channelsRes.json() : { result: { channels: [] } };

      return {
        users,
        channels: channelsData.result?.channels ?? [],
        casts,
      };
    },
    enabled: enabled && q.trim().length > 0,
    staleTime: 5 * 60 * 1000, // 5 minutes - re-running the same search rarely changes
    gcTime: 30 * 60 * 1000, // 30 minutes
  });
}

// Search users (Hypersnap; one page — its search does not paginate)
export function useSearchUsers({
  q,
  limit = 50,
  enabled = true,
}: {
  q: string;
  limit?: number;
  enabled?: boolean;
}) {
  const result = useInfiniteQuery({
    queryKey: ['farcasterSearchUsers', q, limit],
    queryFn: async (): Promise<{ users: SearchUser[]; next?: string }> => {
      if (!q.trim()) {
        return { users: [], next: undefined };
      }
      return { users: await searchUsersOnHypersnap(q, limit), next: undefined };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next,
    enabled: enabled && q.trim().length > 0,
    staleTime: 60 * 1000,
    // No `maxPages`: results only page forward, so a dropped first page would
    // never come back, and a refetch would start from the page after it.
  });

  const users = useMemo(() => {
    return result.data?.pages.flatMap(page => page.users) ?? [];
  }, [result.data]);

  const onEndReached = useCallback(() => {
    if (result.hasNextPage && !result.isFetchingNextPage) {
      result.fetchNextPage();
    }
  }, [result.hasNextPage, result.isFetchingNextPage, result.fetchNextPage]);

  return {
    ...result,
    users,
    onEndReached,
  };
}

// Search channels with pagination
export function useSearchChannels({
  q,
  token,
  limit = 20,
  enabled = true,
}: {
  q: string;
  token?: string;
  limit?: number;
  enabled?: boolean;
}) {
  const result = useInfiniteQuery({
    queryKey: ['farcasterSearchChannels', q, limit],
    queryFn: async ({ pageParam }) => {
      if (!q.trim()) {
        return { channels: [], next: undefined };
      }

      const headers: Record<string, string> = {
        accept: '*/*',
        'content-type': 'application/json',
        origin: 'https://warpcast.com',
        referer: 'https://warpcast.com/',
      };
      if (token) {
        headers['authorization'] = `Bearer ${token}`;
      }

      let url = `https://client.warpcast.com/v2/search-channels?q=${encodeURIComponent(q)}&limit=${limit}`;
      if (pageParam) {
        url += `&cursor=${pageParam}`;
      }

      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error('Failed to search channels');
      }

      const data = await response.json();
      return {
        channels: data.result?.channels ?? [],
        next: data.next?.cursor,
      };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => {
      if (!lastPage.next) return undefined;
      return lastPage.next;
    },
    enabled: enabled && q.trim().length > 0,
    staleTime: 60 * 1000,
    // No `maxPages`: results only page forward, so a dropped first page would
    // never come back, and a refetch would start from the page after it.
  });

  const channels = useMemo(() => {
    return result.data?.pages.flatMap(page => page.channels) ?? [];
  }, [result.data]);

  const onEndReached = useCallback(() => {
    if (result.hasNextPage && !result.isFetchingNextPage) {
      result.fetchNextPage();
    }
  }, [result.hasNextPage, result.isFetchingNextPage, result.fetchNextPage]);

  return {
    ...result,
    channels,
    onEndReached,
  };
}

// Search casts (Hypersnap; one page — its search does not paginate)
export function useSearchCasts({
  q,
  limit = 50,
  enabled = true,
}: {
  q: string;
  limit?: number;
  enabled?: boolean;
}) {
  const result = useInfiniteQuery({
    queryKey: ['farcasterSearchCasts', q, limit],
    queryFn: async (): Promise<{ casts: SearchCast[]; next?: string }> => {
      if (!q.trim()) {
        return { casts: [], next: undefined };
      }
      return { casts: await searchCastsOnHypersnap(q, limit), next: undefined };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next,
    enabled: enabled && q.trim().length > 0,
    staleTime: 60 * 1000,
    // No `maxPages`: results only page forward, so a dropped first page would
    // never come back, and a refetch would start from the page after it.
  });

  const casts = useMemo(() => {
    return result.data?.pages.flatMap(page => page.casts) ?? [];
  }, [result.data]);

  const onEndReached = useCallback(() => {
    if (result.hasNextPage && !result.isFetchingNextPage) {
      result.fetchNextPage();
    }
  }, [result.hasNextPage, result.isFetchingNextPage, result.fetchNextPage]);

  return {
    ...result,
    casts,
    onEndReached,
  };
}

// Get user's followed channels
export function useUserFollowedChannels({
  fid,
  token,
  enabled = true,
}: {
  fid?: number;
  token?: string;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ['farcasterUserChannels', fid],
    queryFn: async (): Promise<SearchChannel[]> => {
      if (!fid) return [];

      const headers: Record<string, string> = {
        accept: '*/*',
        'content-type': 'application/json',
        origin: 'https://warpcast.com',
        referer: 'https://warpcast.com/',
      };
      if (token) {
        headers['authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(
        `https://client.warpcast.com/v2/user-following-channels?fid=${fid}&limit=50`,
        { headers }
      );

      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      return data.result?.channels ?? [];
    },
    enabled: enabled && !!fid,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
