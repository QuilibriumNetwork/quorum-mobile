import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { getCachedProfile, setCachedProfile } from '@/services/offline/farcasterFeedCache';

const PROFILE_CASTS_URL = 'https://farcaster.xyz/~api/v2/profile-casts';

export interface ProfileAuthor {
  fid: number;
  displayName: string;
  username: string;
  pfp?: {
    url?: string;
    verified?: boolean;
  };
  profile?: {
    bio?: {
      text?: string;
    };
    location?: {
      description?: string;
    };
    accountLevel?: string;
    bannerImageUrl?: string;
  };
  followerCount?: number;
  followingCount?: number;
  viewerContext?: {
    following?: boolean;
  };
}

export interface ProfileCast {
  hash: string;
  threadHash: string;
  author: ProfileAuthor;
  text: string;
  timestamp: number;
  castType?: string;
  replies?: {
    count?: number;
  };
  reactions?: {
    count?: number;
  };
  recasts?: {
    count?: number;
  };
  channel?: {
    key?: string;
    name?: string;
    imageUrl?: string;
  };
  embeds?: {
    images?: {
      url?: string;
      alt?: string;
    }[];
    videos?: {
      url?: string;
      sourceUrl?: string;
      thumbnailUrl?: string;
      width?: number;
      height?: number;
      duration?: number;
    }[];
    urls?: {
      type?: string;
      openGraph?: {
        url?: string;
        sourceUrl?: string;
        title?: string;
        description?: string;
        domain?: string;
        image?: string;
        useLargeImage?: boolean;
        frameEmbedNext?: {
          frameUrl?: string;
          frameEmbed?: {
            version?: string;
            imageUrl?: string;
            button?: {
              title?: string;
              action?: {
                type?: string;
                name?: string;
                url?: string;
                splashImageUrl?: string;
                splashBackgroundColor?: string;
              };
            };
          };
        };
      };
    }[];
    casts?: {
      hash: string;
      threadHash?: string;
      author: {
        fid: number;
        displayName: string;
        username: string;
        pfp?: { url?: string };
      };
      text: string;
      timestamp: number;
      channel?: {
        key?: string;
        name?: string;
      };
      embeds?: {
        images?: { url?: string; alt?: string }[];
        videos?: { url?: string; thumbnailUrl?: string }[];
      };
    }[];
  };
  viewerContext?: {
    reacted?: boolean;
    recast?: boolean;
  };
}

export interface ProfilePage {
  casts: ProfileCast[];
  cursor?: string;
  author?: ProfileAuthor;
}

interface UseFarcasterProfileOptions {
  fid: number;
  token?: string;
  enabled?: boolean;
}

async function fetchProfilePage(
  fid: number,
  token?: string,
  cursor?: string
): Promise<ProfilePage> {
  let url = `${PROFILE_CASTS_URL}?fid=${fid}&limit=15`;
  if (cursor) {
    url += `&cursor=${cursor}`;
  }

  const headers: Record<string, string> = {
    accept: '*/*',
    'content-type': 'application/json',
    origin: 'https://farcaster.xyz',
    referer: 'https://farcaster.xyz/',
  };

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch profile (${response.status})`);
  }

  const json = await response.json();
  const casts: ProfileCast[] = json.result?.casts ?? [];
  const nextCursor = json.next?.cursor;

  // Get author info from first cast
  const author = casts[0]?.author;

  return { casts, cursor: nextCursor, author };
}

export function useFarcasterProfile({
  fid,
  token,
  enabled = true,
}: UseFarcasterProfileOptions) {
  // Paint the last-known profile instantly from MMKV on cold start, then
  // refresh in the background (initialDataUpdatedAt preserves staleness).
  const cached = useMemo(() => getCachedProfile(fid), [fid]);

  const query = useInfiniteQuery({
    queryKey: ['farcaster-profile', fid],
    queryFn: ({ pageParam }) => fetchProfilePage(fid, token, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => {
      if (!lastPage.cursor) return undefined;
      return lastPage.cursor;
    },
    enabled: enabled && fid > 0,
    staleTime: 1000 * 60 * 2, // 2 minutes
    // Cap retained pages so a long scroll session doesn't pin every page
    // in the JS heap; dropped pages refetch from the network on demand.
    maxPages: 6,
    initialData: cached?.data,
    initialDataUpdatedAt: cached?.updatedAt,
  });

  // Persist the freshest first page so re-opening this profile paints
  // instantly.
  useEffect(() => {
    if (query.isFetched && query.data && query.data.pages.length > 0) {
      setCachedProfile(fid, query.data);
    }
  }, [query.data, query.isFetched, fid]);

  // Flatten all pages into a single array
  const casts = query.data?.pages.flatMap((page) => page.casts) ?? [];

  // Get author from first page
  const author = query.data?.pages[0]?.author;

  return {
    author,
    casts,
    isLoading: query.isLoading,
    isFetchingNextPage: query.isFetchingNextPage,
    error: query.error?.message ?? null,
    hasNextPage: query.hasNextPage ?? true,
    fetchNextPage: query.fetchNextPage,
    refetch: query.refetch,
  };
}
