/**
 * Farcaster Search hooks for users, channels, and casts
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo, useCallback, useState, useEffect } from 'react';

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

      // Fetch users and channels in parallel
      const [usersRes, channelsRes, castsRes] = await Promise.all([
        fetch(`https://client.warpcast.com/v2/search-users?q=${encodeURIComponent(q)}&limit=${maxUsers}`, { headers }),
        fetch(`https://client.warpcast.com/v2/search-channels?q=${encodeURIComponent(q)}&limit=${maxChannels}`, { headers }),
        fetch(`https://client.warpcast.com/v2/search-casts?q=${encodeURIComponent(q)}&limit=5`, { headers }),
      ]);

      const [usersData, channelsData, castsData] = await Promise.all([
        usersRes.ok ? usersRes.json() : { result: { users: [] } },
        channelsRes.ok ? channelsRes.json() : { result: { channels: [] } },
        castsRes.ok ? castsRes.json() : { result: { casts: [] } },
      ]);

      return {
        users: usersData.result?.users ?? [],
        channels: channelsData.result?.channels ?? [],
        casts: castsData.result?.casts ?? [],
      };
    },
    enabled: enabled && q.trim().length > 0,
    staleTime: 5 * 60 * 1000, // 5 minutes - re-running the same search rarely changes
    gcTime: 30 * 60 * 1000, // 30 minutes
  });
}

// Search users with pagination
export function useSearchUsers({
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
    queryKey: ['farcasterSearchUsers', q, limit],
    queryFn: async ({ pageParam }) => {
      if (!q.trim()) {
        return { users: [], next: undefined };
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

      let url = `https://client.warpcast.com/v2/search-users?q=${encodeURIComponent(q)}&limit=${limit}`;
      if (pageParam) {
        url += `&cursor=${pageParam}`;
      }

      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error('Failed to search users');
      }

      const data = await response.json();
      return {
        users: data.result?.users ?? [],
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
    maxPages: 6,
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
    maxPages: 6,
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

// Search casts with pagination
export function useSearchCasts({
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
    queryKey: ['farcasterSearchCasts', q, limit],
    queryFn: async ({ pageParam }) => {
      if (!q.trim()) {
        return { casts: [], next: undefined };
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

      let url = `https://client.warpcast.com/v2/search-casts?q=${encodeURIComponent(q)}&limit=${limit}`;
      if (pageParam) {
        url += `&cursor=${pageParam}`;
      }

      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error('Failed to search casts');
      }

      const data = await response.json();
      return {
        casts: data.result?.casts ?? [],
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
    maxPages: 6,
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
