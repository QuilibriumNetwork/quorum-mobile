import { useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { isScamCast } from '@/services/farcaster/scamFilter';

const CHANNEL_INFO_URL = 'https://farcaster.xyz/~api/v2/channel';
const CHANNEL_FEED_URL = 'https://client.farcaster.xyz/v2/feed-items';

export interface ChannelInfo {
  key: string;
  name: string;
  description?: string;
  imageUrl?: string;
  headerImageUrl?: string;
  followerCount?: number;
  memberCount?: number;
  headerAction?: {
    title?: string;
    target?: string;
  };
  headerActionMetadata?: {
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
}

export interface ChannelCast {
  hash: string;
  threadHash: string;
  author: {
    fid: number;
    displayName: string;
    username: string;
    pfp?: {
      url?: string;
      verified?: boolean;
    };
    profile?: {
      accountLevel?: string;
    };
  };
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

interface ChannelPage {
  casts: ChannelCast[];
  cursor?: PageContext;
}

interface UseFarcasterChannelOptions {
  channelKey: string;
  token?: string;
  enabled?: boolean;
}

async function fetchChannelInfo(
  channelKey: string,
  token?: string
): Promise<ChannelInfo> {
  const url = `${CHANNEL_INFO_URL}?key=${channelKey}`;

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
    throw new Error(`Failed to fetch channel info (${response.status})`);
  }

  const json = await response.json();
  const ch = json.result?.channel;

  if (!ch) {
    throw new Error('Channel not found');
  }

  return {
    key: ch.key,
    name: ch.name,
    description: ch.description,
    imageUrl: ch.imageUrl,
    headerImageUrl: ch.headerImageUrl,
    followerCount: ch.followerCount,
    memberCount: ch.memberCount,
    headerAction: ch.headerAction,
    headerActionMetadata: ch.headerActionMetadata,
  };
}

interface PageContext {
  olderThan?: number;
  latestMainCastTimestamp?: number;
  excludeItemIdPrefixes?: string[];
}

interface ChannelFeedItem {
  id: string;
  timestamp: number;
  cast: ChannelCast;
}

async function fetchChannelFeed(
  channelKey: string,
  token?: string,
  pageContext?: PageContext
): Promise<ChannelPage> {
  const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const body: Record<string, unknown> = {
    feedKey: channelKey,
    feedType: 'default',
    updateState: true,
  };

  if (pageContext?.olderThan) {
    body.olderThan = pageContext.olderThan;
    body.latestMainCastTimestamp = pageContext.latestMainCastTimestamp;
    body.excludeItemIdPrefixes = pageContext.excludeItemIdPrefixes ?? [];
    body.castViewEvents = [];
  }

  const headers: Record<string, string> = {
    accept: '*/*',
    'content-type': 'application/json; charset=utf-8',
    'idempotency-key': idempotencyKey,
    origin: 'https://farcaster.xyz',
    referer: 'https://farcaster.xyz/',
  };

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(CHANNEL_FEED_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch channel feed (${response.status})`);
  }

  const json = await response.json();
  const rawItems: ChannelFeedItem[] = json?.result?.items ?? [];
  // See useFarcasterFeed: drop wallet-drainer typo-squat casts at
  // the fetch boundary so cursors/exclude lists stay coherent.
  const items = rawItems.filter(
    (item) => !isScamCast(item.cast as unknown as Parameters<typeof isScamCast>[0]),
  );

  // Extract casts from feed items
  const casts: ChannelCast[] = items.map((item) => item.cast);

  // Use the last item's timestamp as the cursor for the next page
  const lastItem = items[items.length - 1];
  const latestMainCastTimestamp = json?.result?.latestMainCastTimestamp;
  const nextCursor = latestMainCastTimestamp ?? (lastItem ? lastItem.timestamp : null);
  const excludeItemIdPrefixes = items.map((item) => item.id.slice(2, 10));

  return {
    casts,
    cursor: nextCursor ? {
      olderThan: nextCursor,
      latestMainCastTimestamp,
      excludeItemIdPrefixes,
    } : undefined
  };
}

export function useFarcasterChannel({
  channelKey,
  token,
  enabled = true,
}: UseFarcasterChannelOptions) {
  // Fetch channel info
  const channelQuery = useQuery({
    queryKey: ['farcaster-channel-info', channelKey],
    queryFn: () => fetchChannelInfo(channelKey, token),
    enabled: enabled && Boolean(channelKey),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  // Fetch channel feed with infinite scroll
  const feedQuery = useInfiniteQuery({
    queryKey: ['farcaster-channel-feed', channelKey],
    queryFn: ({ pageParam }) => fetchChannelFeed(channelKey, token, pageParam),
    initialPageParam: undefined as PageContext | undefined,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.cursor) return undefined;
      // Accumulate all exclude prefixes from all pages
      const allExcludePrefixes = allPages.flatMap(
        (page) => page.cursor?.excludeItemIdPrefixes ?? []
      );
      return {
        ...lastPage.cursor,
        excludeItemIdPrefixes: allExcludePrefixes,
      };
    },
    enabled: enabled && Boolean(channelKey),
    staleTime: 1000 * 60 * 2, // 2 minutes
  });

  // Flatten all pages into a single array. Memoised on the query data so the
  // returned `casts` keeps a STABLE identity across renders — without this it was
  // a fresh array (and a fresh `[]` when disabled) every render, which churned
  // any consumer that lists `casts` as a memo/effect dep. In SpaceChatArea that
  // rebuilt the `messages` array on every render, and FlashList re-anchored the
  // chat to the top (first message) on any re-render (e.g. opening a modal).
  const feedData = feedQuery.data;
  const casts = useMemo(
    () => feedData?.pages.flatMap((page) => page.casts) ?? [],
    [feedData],
  );

  return {
    channel: channelQuery.data,
    casts,
    isLoading: channelQuery.isLoading || feedQuery.isLoading,
    isFetchingNextPage: feedQuery.isFetchingNextPage,
    error: channelQuery.error?.message ?? feedQuery.error?.message ?? null,
    hasNextPage: feedQuery.hasNextPage ?? true,
    fetchNextPage: feedQuery.fetchNextPage,
    refetch: () => {
      channelQuery.refetch();
      feedQuery.refetch();
    },
  };
}
