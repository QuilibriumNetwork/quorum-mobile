import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { fromHypersnapCast, getDefaultHypersnapClient } from '@quilibrium/quorum-shared';
import { useFollowingFids } from '@/hooks/useFollowingFids';
import { normalizedCastToLegacy } from '@/services/farcaster/hypersnapToLegacyShape';
import { fetchHubUserData, isProUser } from '@/services/farcaster/hypersnapUsers';
import { rememberCastAuthor } from '@/services/farcaster/hypersnapWrites';
import { getCachedProfile, setCachedProfile } from '@/services/offline/farcasterFeedCache';

/** Hypersnap page size; its user-casts feed includes replies, which the
 *  profile filters out, so pages are fetched larger than they render. */
const CASTS_PAGE_SIZE = 50;
/** Keep reading until a page has this many top-level casts (or the feed
 *  ends), so a run of replies doesn't render as an empty profile. */
const MIN_CASTS_PER_PAGE = 10;
const MAX_REQUESTS_PER_PAGE = 3;

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
  enabled?: boolean;
}

/** `geo:<lat>,<long>` is how the protocol stores a location; there is no
 *  place name to show for it. */
function displayableLocation(value: string | undefined): string | undefined {
  if (!value || /^geo:/i.test(value)) return undefined;
  return value;
}

async function fetchProfileAuthor(fid: number): Promise<ProfileAuthor> {
  const [user, hub, pro] = await Promise.all([
    getDefaultHypersnapClient().getUserByFid(fid),
    // Banner, location and Pro are header extras: a failure leaves them out.
    fetchHubUserData(fid).catch(() => ({ banner: undefined, location: undefined })),
    isProUser(fid).catch(() => false),
  ]);
  const bio = user.profile?.bio?.text;
  const location = displayableLocation(hub.location);
  return {
    fid: user.fid,
    displayName: user.display_name ?? '',
    username: user.username,
    pfp: user.pfp_url ? { url: user.pfp_url } : undefined,
    profile: {
      bio: bio ? { text: bio } : undefined,
      location: location ? { description: location } : undefined,
      accountLevel: pro ? 'pro' : undefined,
      bannerImageUrl: hub.banner,
    },
    followerCount: user.follower_count,
    followingCount: user.following_count,
  };
}

/** One page of the account's own top-level casts (replies excluded). */
async function fetchProfileCasts(
  fid: number,
  cursor?: string,
): Promise<{ casts: ProfileCast[]; cursor?: string }> {
  const client = getDefaultHypersnapClient();
  const casts: ProfileCast[] = [];
  let next: string | undefined = cursor;
  for (let i = 0; i < MAX_REQUESTS_PER_PAGE; i++) {
    const res = await client.getUserCasts(fid, { cursor: next, limit: CASTS_PAGE_SIZE });
    for (const c of res.casts) {
      const cast = normalizedCastToLegacy(fromHypersnapCast(c));
      if (cast.parentHash) continue;
      rememberCastAuthor(cast.hash, cast.author.fid);
      casts.push({ ...cast, threadHash: cast.hash } as ProfileCast);
    }
    next = res.next.cursor ?? undefined;
    if (!next || casts.length >= MIN_CASTS_PER_PAGE) break;
  }
  return { casts, cursor: next };
}

/** A profile page from Hypersnap. The first page also carries the author. */
async function fetchProfilePage(fid: number, cursor?: string): Promise<ProfilePage> {
  if (cursor) return fetchProfileCasts(fid, cursor);
  const [author, page] = await Promise.all([fetchProfileAuthor(fid), fetchProfileCasts(fid)]);
  return { ...page, author };
}

export function useFarcasterProfile({
  fid,
  enabled = true,
}: UseFarcasterProfileOptions) {
  // Paint the last-known profile instantly from MMKV on cold start, then
  // refresh in the background (initialDataUpdatedAt preserves staleness).
  const cached = useMemo(() => getCachedProfile(fid), [fid]);

  const query = useInfiniteQuery({
    queryKey: ['farcaster-profile', fid],
    queryFn: ({ pageParam }) => fetchProfilePage(fid, pageParam),
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

  // Author from the first page. Whether the viewer follows them comes from
  // the viewer's own follow list (Hypersnap's user object has no viewer
  // context); unknown until that list loads.
  const { fids: followingFids, isLoaded: followsLoaded } = useFollowingFids();
  const pageAuthor = query.data?.pages[0]?.author;
  const author = useMemo(
    () =>
      pageAuthor && followsLoaded
        ? { ...pageAuthor, viewerContext: { following: followingFids.has(pageAuthor.fid) } }
        : pageAuthor,
    [pageAuthor, followsLoaded, followingFids],
  );

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
