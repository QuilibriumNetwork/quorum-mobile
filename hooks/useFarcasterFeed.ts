import { useInfiniteQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { useMMKVBoolean } from 'react-native-mmkv';
import { isScamCast } from '@/services/farcaster/scamFilter';
import { normalizedCastToLegacy } from '@/services/farcaster/hypersnapToLegacyShape';
import { rememberCastAuthor } from '@/services/farcaster/hypersnapWrites';
import { useAuth } from '@/context/AuthContext';
import { useFollowingFids } from '@/hooks/useFollowingFids';
import { useFarcasterUsersPrefetch } from '@/hooks/useFarcasterUsersPrefetch';
import { prefetchReplyAncestors, type AncestorSeed } from '@/hooks/useFeedThreadAncestors';
import { getCachedFeed, setCachedFeed } from '@/services/offline/farcasterFeedCache';
import {
  feedPrefsStore,
  K_SHOW_REPLIES_IN_FEED,
  K_SHOW_NON_FOLLOW_REPLIES,
} from '@/services/farcaster/feedPrefs';
import {
  getDefaultHypersnapClient,
  fromHypersnapCast,
} from '@quilibrium/quorum-shared';

const PAGE_SIZE = 25;
const FEED_STALE_TIME_MS = 2 * 60 * 1000;

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

export interface FeedPage {
  items: FarcasterFeedItem[];
  /** Cursor for the next page; `null` at the end of the feed. */
  nextCursor: PageContext | null;
}

interface UseFarcasterFeedOptions {
  enabled?: boolean;
}

export interface PageContext {
  /** Hypersnap's opaque continuation cursor for the following feed. */
  hypersnapCursor: string;
}

/** A page param this build can follow. Anything else — including a cursor
 *  persisted by an older build in another shape — ends the feed instead of
 *  being sent anywhere. */
function isPageContext(value: unknown): value is PageContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PageContext).hypersnapCursor === 'string'
  );
}

/**
 * One page of the viewer's following feed from Hypersnap, down-converted to
 * the FeedPage shape the UI renders. No auth. A viewer who follows no
 * one gets an empty feed.
 */
async function fetchFeedPage(fid: number, pageContext?: PageContext): Promise<FeedPage> {
  const res = await getDefaultHypersnapClient().getFollowingFeed(fid, {
    cursor: pageContext?.hypersnapCursor,
    limit: PAGE_SIZE,
  });
  const items: FarcasterFeedItem[] = res.casts.map((c) => {
    const cast = normalizedCastToLegacy(fromHypersnapCast(c));
    rememberCastAuthor(cast.hash, cast.author.fid);
    return { id: cast.hash, timestamp: cast.timestamp, cast };
  });
  return {
    // Drop wallet-drainer typo-squat casts (hyrpia.xyz) at the fetch
    // boundary, so the rest of the pipeline sees a clean array.
    items: items.filter(
      (item) => !isScamCast(item.cast as unknown as Parameters<typeof isScamCast>[0]),
    ),
    nextCursor: res.next.cursor ? { hypersnapCursor: res.next.cursor } : null,
  };
}

/**
 * Pull the newest casts into the top of the viewer's cached feed, leaving the
 * pages below as they are. For after the viewer posts: invalidating the feed
 * refetched every page it held (six, one after another) to surface one cast.
 * Only casts the feed doesn't already hold, and no older than its newest,
 * are added, so nothing is duplicated and nothing below moves.
 */
export async function prependNewestToFeed(queryClient: QueryClient, fid: number): Promise<void> {
  const queryKey = ['farcaster-feed', fid];
  const current = queryClient.getQueryData<InfiniteData<FeedPage>>(queryKey);
  if (!current || current.pages.length === 0) return;
  const fresh = await fetchFeedPage(fid);
  queryClient.setQueryData<InfiniteData<FeedPage>>(queryKey, (data) => {
    if (!data || data.pages.length === 0) return data;
    const known = new Set(data.pages.flatMap((page) => page.items.map((item) => item.id)));
    const newest = data.pages[0].items[0]?.timestamp ?? 0;
    const added = fresh.items.filter((item) => !known.has(item.id) && item.timestamp >= newest);
    if (added.length === 0) return data;
    const [head, ...rest] = data.pages;
    return { ...data, pages: [{ ...head, items: [...added, ...head.items] }, ...rest] };
  });
}

/** How long a page waits for its reply ancestors before showing anyway. */
const ANCESTOR_PREFETCH_BUDGET_MS = 1500;

/**
 * Resolve the page's reply ancestors before it's shown, so reply cards render
 * complete rather than growing after mount (`prefetchReplyAncestors`). Bounded
 * in time: past the budget the page shows and the cards finish on their own.
 */
async function prefetchPageAncestors(queryClient: QueryClient, page: FeedPage): Promise<void> {
  const seeds: AncestorSeed[] = [];
  const pageHashes = new Set<string>();
  for (const item of page.items) {
    pageHashes.add(item.cast.hash.toLowerCase().replace(/^0x/, ''));
    if (item.cast.parentHash) {
      seeds.push({ parentHash: item.cast.parentHash, parentAuthorFid: item.cast.parentAuthor?.fid });
    }
  }
  if (seeds.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    prefetchReplyAncestors(queryClient, seeds, pageHashes).catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ANCESTOR_PREFETCH_BUDGET_MS);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

export function useFarcasterFeed({ enabled = true }: UseFarcasterFeedOptions = {}) {
  const { user } = useAuth();
  const fid = user?.farcaster?.fid;
  const queryKey = ['farcaster-feed', fid];
  const queryClient = useQueryClient();

  // Paint the last-known feed instantly from MMKV on cold start, then
  // refresh in the background. `initialDataUpdatedAt` carries the persist
  // time so React Query's staleness logic still applies to restored data.
  const cached = useMemo(() => getCachedFeed(fid), [fid]);

  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }) => {
      const page = await fetchFeedPage(fid as number, isPageContext(pageParam) ? pageParam : undefined);
      await prefetchPageAncestors(queryClient, page);
      return page;
    },
    initialPageParam: undefined as PageContext | undefined,
    getNextPageParam: (lastPage) =>
      isPageContext(lastPage.nextCursor) ? lastPage.nextCursor : undefined,
    enabled: enabled && typeof fid === 'number' && fid > 0,
    staleTime: FEED_STALE_TIME_MS,
    // No `maxPages`. This feed only pages older, so a dropped first page never
    // came back: the page after it led the list, and every refetch started from
    // that page's cursor, so the top of the feed froze at that time for as long
    // as the query lived (and across launches, while the whole query was
    // persisted). Memory is bounded instead by `refresh` trimming to the first
    // page.
    initialData: cached?.data,
    initialDataUpdatedAt: cached?.updatedAt,
  });

  // Persist the freshest first page so the next cold start paints instantly.
  useEffect(() => {
    if (query.isFetched && query.data && query.data.pages.length > 0) {
      setCachedFeed(fid, query.data);
    }
  }, [query.data, query.isFetched, fid]);

  // Flatten all pages into a single array
  const allItems = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );

  // Bulk-resolve parent authors for replies whose parent username is
  // missing (hypersnap only returns the parent FID) — one bulk lookup per
  // page instead of N per-cast fetches when ParentContextLine renders.
  const parentAuthorFids = useMemo(() => {
    const fids: number[] = [];
    for (const item of allItems) {
      const parent = item.cast?.parentAuthor;
      if (item.cast?.parentHash && parent?.fid && !parent.username) {
        fids.push(parent.fid);
      }
    }
    return fids;
  }, [allItems]);
  useFarcasterUsersPrefetch(parentAuthorFids);

  // Main-feed reply filtering, in two layers (a reply is any cast with a
  // parentHash):
  //   1. showRepliesInFeed OFF → drop every reply, leaving only top-level
  //      casts. Default ON.
  //   2. otherwise, showNonFollowReplies OFF → drop replies authored by
  //      people the viewer doesn't follow (own replies always stay).
  //      Default OFF. We only apply this once the follow set is loaded —
  //      before that, "not in set" doesn't mean "not followed", and we'd
  //      wrongly hide everything.
  // Thread views are unaffected by both — they always show every reply.
  const [showRepliesInFeedRaw] = useMMKVBoolean(
    K_SHOW_REPLIES_IN_FEED,
    feedPrefsStore,
  );
  const showRepliesInFeed = showRepliesInFeedRaw ?? true;
  const [showNonFollowReplies] = useMMKVBoolean(
    K_SHOW_NON_FOLLOW_REPLIES,
    feedPrefsStore,
  );
  const { fids: followingFids, isLoaded: followsLoaded } = useFollowingFids();

  const data = useMemo(() => {
    if (!showRepliesInFeed) {
      // Hide all replies outright.
      return allItems.filter((item) => !item.cast?.parentHash);
    }
    if (showNonFollowReplies || !followsLoaded) return allItems;
    return allItems.filter((item) => {
      const cast = item.cast;
      const isReply = Boolean(cast?.parentHash);
      if (!isReply) return true;
      const authorFid = cast?.author?.fid;
      if (authorFid === fid) return true; // always show the viewer's own replies
      return typeof authorFid === 'number' && followingFids.has(authorFid);
    });
  }, [allItems, showRepliesInFeed, showNonFollowReplies, followsLoaded, followingFids, fid]);

  // Refresh KEEPS the existing pages visible while the fetch runs in
  // the background — `refetch` does not clear the cache. Only when the
  // fetch resolves with new data does React Query swap the pages in.
  // (Previously this called resetQueries which dumped everything and
  // produced a blank feed during the loading window — see the loading
  // state cleanup in SocialFeedModal.)
  //
  // It refetches the first page only. An infinite query refetches every page
  // it holds, one after another, so a pull fetched every page scrolled through;
  // the user is at the top when they pull, so dropping the rest doesn't move
  // anything.
  const refresh = async () => {
    queryClient.setQueryData<InfiniteData<FeedPage>>(queryKey, (data) =>
      data && data.pages.length > 1
        ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
        : data,
    );
    await query.refetch();
  };

  /**
   * `refresh`, only when what's loaded is older than the feed's staleTime.
   * Staleness is read from the cache, not `query.isStale`: that is this
   * render's snapshot, and a feed fetched just before the app was backgrounded
   * still reads fresh when it comes back days later, until something
   * re-renders it.
   */
  const refreshIfStale = async () => {
    const current = queryClient.getQueryCache().find({ queryKey, exact: true });
    if (!current || current.state.data === undefined || current.state.fetchStatus === 'fetching') return;
    if (current.isStaleByTime(FEED_STALE_TIME_MS)) await refresh();
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
    refreshIfStale,
    // A refetch of what's loaded, not a next page.
    isRefetching: query.isRefetching && !query.isFetchingNextPage,
  };
}
