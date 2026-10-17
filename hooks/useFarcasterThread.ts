import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { lookupFidByUsername } from '@/services/farcaster/mentionExtraction';
import { isFullCastHash, rememberCastAuthor } from '@/services/farcaster/hypersnapWrites';
import { isScamCast } from '@/services/farcaster/scamFilter';
import { getCachedThread, setCachedThread } from '@/services/offline/farcasterFeedCache';
import {
  getDefaultHypersnapClient,
  substituteHypersnapMentions,
  type HypersnapConversationCast,
} from '@quilibrium/quorum-shared';

/** farcaster.xyz's thread lookup: the only service that resolves a cast from a
 *  hash PREFIX (what farcaster.xyz/<user>/0x<prefix> share links carry).
 *  Used for that resolution alone, after Hypersnap could not find it. */
const PREFIX_LOOKUP_URL = 'https://farcaster.xyz/~api/v2/user-thread-casts';
/** How far back through an author's casts to look for a hash prefix. */
const PREFIX_SCAN_PAGES = 3;
const PREFIX_SCAN_PAGE_SIZE = 100;

export interface ThreadCast {
  hash: string;
  threadHash: string;
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
    viewerContext?: {
      following?: boolean;
    };
  };
  text: string;
  timestamp: number;
  parentHash?: string;
  parentAuthor?: {
    fid: number;
    displayName: string;
    username: string;
  };
  parentUrl?: string;
  castType?: string; // "root-embed" for channel placeholders
  channel?: {
    key?: string;
    name?: string;
    imageUrl?: string;
  };
  replies?: {
    count?: number;
    casts?: ThreadCast[];
  };
  reactions?: {
    count?: number;
  };
  recasts?: {
    count?: number;
  };
  embeds?: {
    images?: {
      url?: string;
      alt?: string;
    }[];
    videos?: {
      url?: string;
      thumbnailUrl?: string;
      width?: number;
      height?: number;
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
      embeds?: {
        images?: { url?: string; alt?: string }[];
      };
    }[];
  };
  viewerContext?: {
    reacted?: boolean;
    recast?: boolean;
  };
}

interface ThreadResponse {
  result: {
    casts: ThreadCast[];
  };
}

interface UseFarcasterThreadOptions {
  /** The author's username. Only needed when `castHashPrefix` is a prefix
   *  rather than a full hash. */
  username: string;
  /** A full cast hash, or a prefix from a share link. */
  castHashPrefix: string;
  enabled?: boolean;
  /** Optional source of optimistic pending replies for the resolved
   *  thread. Called with the main cast's hash; the returned casts are
   *  merged into the reply tree (positioned by parentHash + timestamp via
   *  the same `organizeReplies` pass, so they land in the right place).
   *  Kept as a callback so this hook stays decoupled from the optimistic
   *  store. */
  getPendingReplies?: (mainHash: string) => ThreadCast[];
}

// Parse farcaster.xyz URL to extract username and hash prefix
export function parseFarcasterUrl(url: string): { username: string; castHashPrefix: string } | null {
  // Match patterns like:
  // https://farcaster.xyz/username/0xabcdef
  // https://farcaster.xyz/username/0xabcdef12
  const match = url.match(/farcaster\.xyz\/([^\/]+)\/(0x[a-fA-F0-9]+)/);
  if (match) {
    return {
      username: match[1],
      castHashPrefix: match[2],
    };
  }
  return null;
}

/** Convert a HypersnapConversationCast (snake_case, ISO timestamp, etc.)
 *  to the ThreadCast shape the UI already expects. Recurses through
 *  `direct_replies` and re-nests them under `replies.casts` to match the
 *  legacy thread shape. */
function fromHypersnapConversation(c: HypersnapConversationCast): ThreadCast {
  const ts = Date.parse(c.timestamp);
  const author = c.author;
  const channelObj = c.channel
    ? { key: c.channel.id, name: c.channel.name, imageUrl: c.channel.image_url }
    : undefined;

  const embeds = (() => {
    if (!c.embeds || c.embeds.length === 0) return undefined;
    const images: { url?: string; alt?: string }[] = [];
    const videos: NonNullable<NonNullable<ThreadCast['embeds']>['videos']> = [];
    const urls: NonNullable<NonNullable<ThreadCast['embeds']>['urls']> = [];
    const quoteCasts: NonNullable<NonNullable<ThreadCast['embeds']>['casts']> = [];
    // Match the shared `classifyBareUrl` extension/host heuristics —
    // hypersnap returns raw URLs without enrichment, so we have to
    // sort them into image/video/url ourselves. m3u8 (HLS) covers the
    // `stream.farcaster.xyz` CDN that hosts Farcaster's first-party
    // video uploads.
    const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|$)/i;
    const VIDEO_EXT = /\.(mp4|mov|webm|m4v|m3u8)(\?|$)/i;
    for (const e of c.embeds) {
      if ('url' in e) {
        const url = e.url;
        if (IMAGE_EXT.test(url) || url.includes('imagedelivery.net')) {
          images.push({ url });
        } else if (VIDEO_EXT.test(url)) {
          // No thumbnailUrl from hypersnap — VideoPlayer renders a
          // black poster + play overlay in that case.
          videos.push({ url });
        } else {
          urls.push({ openGraph: { url, sourceUrl: url } });
        }
      } else if ('cast_id' in e) {
        quoteCasts.push({
          hash: `0x${e.cast_id.hash.replace(/^0x/, '')}`,
          author: {
            fid: e.cast_id.fid,
            displayName: '',
            username: '',
          },
          text: '',
          timestamp: 0,
        });
      }
    }
    return {
      images: images.length ? images : undefined,
      videos: videos.length ? videos : undefined,
      urls: urls.length ? urls : undefined,
      casts: quoteCasts.length ? quoteCasts : undefined,
    };
  })();

  const directReplies = (c.direct_replies ?? []).map(fromHypersnapConversation);

  return {
    hash: `0x${c.hash.replace(/^0x/, '')}`,
    threadHash: c.thread_hash ? `0x${c.thread_hash.replace(/^0x/, '')}` : `0x${c.hash.replace(/^0x/, '')}`,
    author: {
      fid: author.fid,
      displayName: author.display_name,
      username: author.username,
      pfp: author.pfp_url ? { url: author.pfp_url } : undefined,
      viewerContext: author.viewer_context?.following !== undefined
        ? { following: author.viewer_context.following }
        : undefined,
    },
    text: substituteHypersnapMentions(
      c.text,
      c.mentioned_profiles_ranges ?? [],
      c.mentioned_profiles ?? [],
    ),
    timestamp: Number.isFinite(ts) ? ts : 0,
    parentHash: c.parent_hash ? `0x${c.parent_hash.replace(/^0x/, '')}` : undefined,
    parentAuthor: c.parent_author?.fid != null
      ? { fid: c.parent_author.fid, displayName: '', username: '' }
      : undefined,
    parentUrl: c.parent_url,
    channel: channelObj,
    replies: {
      count: c.replies.count,
      casts: directReplies.length ? directReplies : undefined,
    },
    reactions: { count: c.reactions.likes_count },
    recasts: { count: c.reactions.recasts_count },
    embeds,
  };
}

/** Flatten a hypersnap conversation tree into a flat array:
 *  [main, ...replies]. */
function hypersnapConversationToFlatCasts(root: ThreadCast): ThreadCast[] {
  const out: ThreadCast[] = [];
  const walk = (c: ThreadCast) => {
    out.push(c);
    const nested = c.replies?.casts ?? [];
    for (const r of nested) walk(r);
  };
  walk(root);
  return out;
}

/** The thread around a cast, by full hash: its parents (walked up to the root),
 *  the cast, and its replies, flat, from Hypersnap. */
async function fetchThreadFromHypersnap(castHash: string): Promise<ThreadCast[]> {
  const client = getDefaultHypersnapClient();
  const res = await client.getCastConversation(castHash.toLowerCase().replace(/^0x/, ''), {
    replyDepth: 5,
  });
  const root = fromHypersnapConversation(res.conversation.cast);

  // Walk up the parent chain: hypersnap's conversation endpoint roots
  // the tree at the queried cast and only returns descendants, but the
  // thread UI expects parents above the focused cast. We chase
  // parent_hash + parent_author.fid pairs until we hit the root.
  const parents: ThreadCast[] = [];
  let cursor: ThreadCast = root;
  const SAFETY = 16;
  for (let i = 0; i < SAFETY; i++) {
    const pHash = cursor.parentHash?.replace(/^0x/, '');
    const pFid = cursor.parentAuthor?.fid;
    if (!pHash || !pFid) break;
    let parent;
    try {
      parent = await client.getCastByHash(pFid, pHash);
    } catch {
      break;
    }
    const parentNormalized = fromHypersnapConversation(parent);
    parents.unshift(parentNormalized);
    cursor = parentNormalized;
  }

  const casts = [...parents, ...hypersnapConversationToFlatCasts(root)];
  for (const c of casts) rememberCastAuthor(c.hash, c.author.fid);
  return casts;
}

/** Find the full hash for a prefix among the author's recent casts on
 *  Hypersnap. Null when the author is unknown or the cast is older than the
 *  scan reaches. */
async function findHashByPrefixOnHypersnap(
  username: string,
  prefix: string,
): Promise<string | null> {
  const fid = await lookupFidByUsername(username);
  if (!fid) return null;
  const client = getDefaultHypersnapClient();
  let cursor: string | undefined;
  for (let i = 0; i < PREFIX_SCAN_PAGES; i++) {
    const res = await client.getUserCasts(fid, { cursor, limit: PREFIX_SCAN_PAGE_SIZE });
    const hit = res.casts.find((c) => c.hash.toLowerCase().replace(/^0x/, '').startsWith(prefix));
    if (hit) return hit.hash;
    if (!res.next.cursor) return null;
    cursor = res.next.cursor;
  }
  return null;
}

/** Resolve a prefix through farcaster.xyz's thread lookup. */
async function findHashByPrefixOnFarcasterXyz(
  username: string,
  prefix: string,
): Promise<string | null> {
  const url = `${PREFIX_LOOKUP_URL}?castHashPrefix=0x${prefix}&username=${encodeURIComponent(username)}&limit=1`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: '*/*',
      'content-type': 'application/json',
      origin: 'https://farcaster.xyz',
      referer: 'https://farcaster.xyz/',
    },
  });
  if (!response.ok) return null;
  const json = (await response.json()) as ThreadResponse;
  const hit = (json.result?.casts ?? []).find((c) =>
    c.hash.toLowerCase().replace(/^0x/, '').startsWith(prefix),
  );
  return hit?.hash ?? null;
}

async function fetchThread(username: string, castHashPrefix: string): Promise<ThreadCast[]> {
  if (isFullCastHash(castHashPrefix)) {
    return fetchThreadFromHypersnap(castHashPrefix);
  }

  const prefix = castHashPrefix.toLowerCase().replace(/^0x/, '');
  if (!username || !prefix) return [];
  const fullHash =
    (await findHashByPrefixOnHypersnap(username, prefix).catch(() => null)) ??
    (await findHashByPrefixOnFarcasterXyz(username, prefix).catch(() => null));
  if (!fullHash) throw new Error('Cast not found');
  return fetchThreadFromHypersnap(fullHash);
}

// Flatten nested replies into a linear array with depth info
export interface FlattenedCast extends ThreadCast {
  depth: number;
}

/**
 * Build the reply tree from explicit `parent_hash` links rather than
 * trusting any single API's nested `direct_replies` shape. Hypersnap
 * returns a depth-bounded tree (`reply_depth`) which can flatten deeper
 * replies into the immediate-children list of the root, and optimistic
 * pending replies arrive as a flat array with `parentHash` pointers.
 * Indexing by `parent_hash` handles both shapes the same way.
 *
 * Returns descendants of `mainHash` in depth-first order, with each
 * cast's `depth` set to its distance from `mainHash`. Siblings within
 * a level are sorted oldest-first so the conversation reads
 * top-to-bottom.
 *
 * Replies whose `parent_hash` isn't reachable from `mainHash` (because
 * the parent is missing from the response, or sits above mainHash in
 * the chain) are appended at depth 0 at the end so they're not lost.
 */
function organizeReplies(replies: ThreadCast[], mainHash: string): FlattenedCast[] {
  const mainKey = mainHash.toLowerCase();
  const childrenOf = new Map<string, ThreadCast[]>();
  for (const c of replies) {
    if (isScamCast(c as unknown as Parameters<typeof isScamCast>[0])) continue;
    const parentKey = c.parentHash?.toLowerCase();
    if (!parentKey) continue;
    if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
    childrenOf.get(parentKey)!.push(c);
  }
  // Sort siblings oldest-first within each parent bucket.
  for (const list of childrenOf.values()) {
    list.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }

  const out: FlattenedCast[] = [];
  const seen = new Set<string>();
  const visit = (parentKey: string, depth: number) => {
    const children = childrenOf.get(parentKey) ?? [];
    for (const child of children) {
      const key = child.hash.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...child, depth });
      visit(key, depth + 1);
    }
  };
  visit(mainKey, 0);

  // Orphans — anything we didn't reach from mainHash. Append at depth 0
  // so the user still sees the cast (better than silently dropping it).
  for (const c of replies) {
    const key = c.hash.toLowerCase();
    if (seen.has(key)) continue;
    if (isScamCast(c as unknown as Parameters<typeof isScamCast>[0])) continue;
    seen.add(key);
    out.push({ ...c, depth: 0 });
  }

  return out;
}

/** Dedupe casts by hash. The walked parent chain can overlap the
 *  conversation tree, and a thread cached by an older build can repeat
 *  casts. React's `key` collision errors come straight from this.
 *  First occurrence wins so the conversation order from the source is
 *  preserved. */
function dedupeByHash<T extends { hash: string }>(casts: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of casts) {
    const key = c.hash.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export function useFarcasterThread({
  username,
  castHashPrefix,
  enabled = true,
  getPendingReplies,
}: UseFarcasterThreadOptions) {
  // Paint the last-known thread instantly from MMKV on cold start, then
  // refresh in the background (initialDataUpdatedAt preserves staleness).
  const cached = useMemo(() => getCachedThread(castHashPrefix), [castHashPrefix]);

  const query = useQuery({
    queryKey: ['farcaster-thread', username, castHashPrefix],
    queryFn: () => fetchThread(username, castHashPrefix),
    // A full hash needs no username, so the query never waits on one
    // (typical when navigating from a reply card into the parent's thread).
    enabled: enabled && Boolean(castHashPrefix),
    staleTime: 1000 * 60 * 2, // 2 minutes
    initialData: cached?.casts,
    initialDataUpdatedAt: cached?.updatedAt,
  });

  // Persist the freshest casts so re-opening this thread paints instantly.
  useEffect(() => {
    if (query.isFetched && query.data && query.data.length > 0) {
      setCachedThread(castHashPrefix, query.data);
    }
  }, [query.data, query.isFetched, castHashPrefix]);

  // Filter out "root-embed" casts (channel placeholders) AND any
  // wallet-drainer typo-squat casts (hyrpia.xyz). Then dedupe by hash
  // so the rendering code can use cast.hash as a stable React key.
  const actualCasts = dedupeByHash(
    query.data?.filter(
      (cast) =>
        cast.castType !== 'root-embed' &&
        !isScamCast(cast as unknown as Parameters<typeof isScamCast>[0]),
    ) ?? [],
  );

  // Find the target cast - the one matching our castHashPrefix.
  // When navigating to a reply-of-a-reply, the API may return parent
  // casts first, then the target, then any descendants. We need to:
  //   - identify the parents (everything strictly before target)
  //   - show the target as the focused cast
  //   - show descendants as replies
  // Without exposing the parents, taps from a reply notification lose
  // the conversation context — the user lands on the reply with no
  // sense of what was being replied to.
  // Compared without `0x`: Hypersnap hands out bare hashes (notification
  // rows, pushes), while the casts here are always normalized to `0x…`.
  const targetPrefix = castHashPrefix.toLowerCase().replace(/^0x/, '');
  const targetCastIndex = actualCasts.findIndex((cast) =>
    cast.hash.toLowerCase().replace(/^0x/, '').startsWith(targetPrefix)
  );

  const parentCasts =
    targetCastIndex > 0 ? actualCasts.slice(0, targetCastIndex) : [];
  // When the find fails we used to fall back to actualCasts[0], but that
  // can land on the wrong cast (e.g., navigating to a parent whose
  // hypersnap conversation root happens to be a reply, where the parent
  // walk hasn't returned yet). Leave mainCast undefined instead so the
  // ThreadDetailView falls through to its placeholderCast — which is
  // keyed to castHashPrefix and therefore renders the back arrow on the
  // intended cast.
  const mainCast = targetCastIndex >= 0 ? actualCasts[targetCastIndex] : undefined;
  const replies = targetCastIndex >= 0
    ? actualCasts.slice(targetCastIndex + 1)
    : [];

  // Organize replies into a depth-aware list via parent_hash links.
  // Hypersnap's `direct_replies` and the pending replies converge here,
  // and depth comes from the actual parent chain rather than a nested
  // structure that may be truncated by the API's reply-depth limit.
  // The caller (ThreadDetailView) shifts these depths by
  // `parentCasts.length + 1` so the visual indent is continuous from
  // the root parent down through the replies.
  // Merge any optimistic pending replies before organizing, so they're
  // positioned by parentHash + timestamp like real replies (a just-posted
  // reply lands at the bottom of its parent's sibling group).
  const pendingReplies = mainCast && getPendingReplies ? getPendingReplies(mainCast.hash) : [];
  const flattenedReplies = mainCast
    ? organizeReplies(pendingReplies.length ? [...replies, ...pendingReplies] : replies, mainCast.hash)
    : [];

  // Extract channel info from root-embed if present
  const rootEmbed = query.data?.find((cast) => cast.castType === 'root-embed');
  const channelContext = rootEmbed?.channel;

  return {
    parentCasts,
    mainCast,
    replies: flattenedReplies,
    allCasts: actualCasts,
    channelContext,
    isLoading: query.isLoading,
    error: query.error?.message ?? null,
    refetch: query.refetch,
  };
}
