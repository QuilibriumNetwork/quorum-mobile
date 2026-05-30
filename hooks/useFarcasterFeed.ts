import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { isScamCast } from '@/services/farcaster/scamFilter';
import { normalizedCastToLegacy } from '@/services/farcaster/hypersnapToLegacyShape';
import { useAuth } from '@/context/AuthContext';
import {
  getDefaultHypersnapClient,
  fromHypersnapCast,
} from '@quilibrium/quorum-shared';

const FARCASTER_FEED_URL = 'https://client.farcaster.xyz/v2/feed-items';
const PAGE_SIZE = 20;

export interface FarcasterFeedItem {
  id: string;
  timestamp: number;
  cast: FarcasterCast;
}

export interface FarcasterCast {
  hash: string;
  timestamp: number;
  text: string;
  /** Parent cast hash (set on replies). */
  parentHash?: string;
  /** Parent URL — for channel posts this is the channel URL; for replies
   *  to off-Farcaster content this is the original URL. */
  parentUrl?: string;
  /** Parent author — populated for replies. `username` is best-effort and
   *  may be undefined when only the FID was available at fetch time. */
  parentAuthor?: {
    fid: number;
    username?: string;
    displayName?: string;
  };
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
    viewerContext?: {
      following?: boolean;
    };
  };
  tags?: {
    type?: string;
    id?: string;
    name?: string;
  }[];
  channel?: {
    key?: string;
    name?: string;
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
      type?: string;
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
    casts?: EmbeddedCast[];
  };
  replies?: {
    count?: number;
  };
  reactions?: {
    count?: number;
  };
  recasts?: {
    count?: number;
  };
  viewerContext?: {
    reacted?: boolean;
    recast?: boolean;
  };
}

export interface EmbeddedCast {
  hash: string;
  threadHash?: string;
  author: {
    fid: number;
    displayName: string;
    username: string;
    pfp?: {
      url?: string;
    };
    profile?: {
      accountLevel?: string;
    };
  };
  text: string;
  timestamp: number;
  embeds?: {
    images?: {
      url?: string;
      alt?: string;
    }[];
    videos?: {
      url?: string;
      thumbnailUrl?: string;
    }[];
  };
  replies?: {
    count?: number;
  };
  reactions?: {
    count?: number;
  };
  viewerContext?: {
    reacted?: boolean;
    recast?: boolean;
  };
  recasts?: {
    count?: number;
  };
}

interface FeedPage {
  items: FarcasterFeedItem[];
  /** Cursor for the next page. `number` = legacy `olderThan` timestamp;
   *  PageContext-shaped object = either continuation. `null` = end. */
  nextCursor: number | PageContext | null;
  latestMainCastTimestamp?: number;
  excludeItemIdPrefixes: string[];
}

interface UseFarcasterFeedOptions {
  token?: string;
  enabled?: boolean;
}

interface PageContext {
  /** Legacy /v2/feed-items cursor. */
  olderThan?: number;
  latestMainCastTimestamp?: number;
  excludeItemIdPrefixes?: string[];
  /** Hypersnap continuation cursor — present when the prior page came
   *  from hypersnap. Forwarded to the hypersnap path; if hypersnap fails
   *  on a continuation, the next page falls back to legacy at the same
   *  approximate position via olderThan (best effort). */
  hypersnapCursor?: string;
}

/**
 * Try hypersnap's following feed first; return null on any failure or
 * when the page is empty (so the caller falls back to legacy). The
 * normalized casts are down-converted to the legacy FeedPage shape so
 * downstream UI doesn't need to change.
 */
async function tryHypersnapFollowingFeed(
  fid: number | undefined,
  pageContext: PageContext | undefined,
): Promise<FeedPage | null> {
  if (!fid) return null;
  // Hypersnap cursors are opaque strings; only forward when the prior
  // page came from hypersnap (we tag that on the FeedPage).
  const cursor = pageContext?.hypersnapCursor;
  try {
    const client = getDefaultHypersnapClient();
    const res = await client.getFollowingFeed(fid, { cursor, limit: 25 });
    if (res.casts.length === 0) return null;
    const items: FarcasterFeedItem[] = res.casts.map((c) => {
      const norm = fromHypersnapCast(c);
      const legacy = normalizedCastToLegacy(norm);
      return {
        id: legacy.hash,
        timestamp: legacy.timestamp,
        cast: legacy,
      };
    });
    const filtered = items.filter(
      (item) => !isScamCast(item.cast as unknown as Parameters<typeof isScamCast>[0]),
    );
    return {
      items: filtered,
      nextCursor: res.next.cursor
        ? { hypersnapCursor: res.next.cursor }
        : null,
      latestMainCastTimestamp: undefined,
      excludeItemIdPrefixes: [],
    };
  } catch {
    return null;
  }
}

async function fetchFeedPage(
  token: string,
  fid: number | undefined,
  pageContext?: PageContext,
  topItemHash?: string
): Promise<FeedPage> {
  // Hypersnap-first when we have a FID. Skip when the prior page already
  // pinned us to the legacy cursor.
  if (!pageContext || pageContext.hypersnapCursor) {
    const hypersnapPage = await tryHypersnapFollowingFeed(fid, pageContext);
    if (hypersnapPage) return hypersnapPage;
  }

  const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const body: Record<string, unknown> = {
    feedKey: 'home',
    feedType: 'default',
    updateState: true,
  };

  if (pageContext?.olderThan) {
    body.olderThan = pageContext.olderThan;
    body.latestMainCastTimestamp = pageContext.latestMainCastTimestamp;
    body.excludeItemIdPrefixes = pageContext.excludeItemIdPrefixes ?? [];
    body.castViewEvents = [];
  }

  // Include castViewEvents when refreshing to get new content
  if (!pageContext?.olderThan && topItemHash) {
    body.castViewEvents = [
      {
        ts: Date.now(),
        hash: topItemHash,
        on: 'home',
      },
    ];
  }

  const response = await fetch(FARCASTER_FEED_URL, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      'idempotency-key': idempotencyKey,
      origin: 'https://farcaster.xyz',
      referer: 'https://farcaster.xyz/',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(
      errorData?.message || `Farcaster request failed (${response.status})`
    );
  }

  const json = await response.json();

  const rawItems: FarcasterFeedItem[] = json?.result?.items ?? [];
  // Drop wallet-drainer typo-squat casts (hyrpia.xyz). Filtering at
  // the fetch boundary means the rest of the feed pipeline (cursors,
  // exclude lists, optimistic updates) sees a clean array — no
  // gaps, no special-case rendering branches downstream.
  const items = rawItems.filter(
    (item) => !isScamCast(item.cast as unknown as Parameters<typeof isScamCast>[0]),
  );

  // Use the last item's timestamp as the cursor for the next page
  // Always provide a cursor if we have items - the API may return fewer than PAGE_SIZE
  const lastItem = items[items.length - 1];
  const latestMainCastTimestamp = json?.result?.latestMainCastTimestamp;
  // Use latestMainCastTimestamp for the next page cursor
  const nextCursor = latestMainCastTimestamp ?? (lastItem ? lastItem.timestamp : null);
  // Collect item ID prefixes for exclusion
  const excludeItemIdPrefixes = items.map((item) => item.id.slice(2, 10)); // Remove 0x prefix, take 8 chars

  return { items, nextCursor, latestMainCastTimestamp, excludeItemIdPrefixes };
}

export function useFarcasterFeed({ token, enabled = true }: UseFarcasterFeedOptions) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const fid = user?.farcaster?.fid;
  const queryKey = ['farcaster-feed', token, fid];
  const topItemHashRef = useRef<string | undefined>(undefined);

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => {
      // On refresh (no pageParam), pass the top item hash
      const hashForRefresh = pageParam === undefined ? topItemHashRef.current : undefined;
      return fetchFeedPage(token!, fid, pageParam, hashForRefresh);
    },
    initialPageParam: undefined as PageContext | undefined,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.nextCursor === null) return undefined;
      if (typeof lastPage.nextCursor === 'object') {
        // Hypersnap continuation — forward as-is.
        return lastPage.nextCursor;
      }
      // Legacy continuation — accumulate exclude prefixes.
      const allExcludePrefixes = allPages.flatMap((page) => page.excludeItemIdPrefixes);
      return {
        olderThan: lastPage.nextCursor,
        latestMainCastTimestamp: lastPage.latestMainCastTimestamp,
        excludeItemIdPrefixes: allExcludePrefixes,
      } as PageContext;
    },
    enabled: enabled && Boolean(token),
    staleTime: 1000 * 60 * 2, // 2 minutes
  });

  // Flatten all pages into a single array
  const data = query.data?.pages.flatMap((page) => page.items) ?? [];

  // Track the top item hash for refresh requests
  if (data.length > 0 && data[0].cast?.hash) {
    topItemHashRef.current = data[0].cast.hash;
  }

  // Refresh KEEPS the existing pages visible while the fetch runs in
  // the background — `refetch` does not clear the cache. Only when the
  // fetch resolves with new data does React Query swap the pages in.
  // (Previously this called resetQueries which dumped everything and
  // produced a blank feed during the loading window — see the loading
  // state cleanup in SocialFeedModal.)
  const refresh = async () => {
    await query.refetch();
  };

  const wrappedFetchNextPage = () => {
    return query.fetchNextPage();
  };

  return {
    data,
    isLoading: query.isLoading,
    isFetchingNextPage: query.isFetchingNextPage,
    error: query.error?.message ?? null,
    hasNextPage: query.hasNextPage ?? true, // Default to true until we know otherwise
    fetchNextPage: wrappedFetchNextPage,
    refetch: refresh,
    isRefetching: query.isRefetching || query.isFetching,
  };
}
