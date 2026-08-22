import type { FeedPost } from '@/components/SocialFeed/types';

export type FeedPostWithChain = FeedPost & { __chain?: FeedPost[] };

export type ThreadPreviewEntry =
  | { type: 'cast'; cast: FeedPost }
  | { type: 'gap'; omittedCount?: number };

export interface FeedThreadTarget {
  hash: string;
  username: string;
  opensParent: boolean;
}

/** Keep feed-card navigation independent from how much context is displayed. */
export function selectFeedThreadTarget(
  post: FeedPost,
  openOwnThread: boolean,
): FeedThreadTarget | undefined {
  if (post.parentHash && !openOwnThread) {
    return { hash: post.parentHash, username: '', opensParent: true };
  }
  if (!post.hash || !post.username) return undefined;
  return { hash: post.hash, username: post.username, opensParent: false };
}

/**
 * Select the smallest useful home-feed preview for a root-first ancestor path.
 * The focused/bumped cast is always the final member of `chain`.
 */
export function buildThreadPreview(
  chain: readonly FeedPost[],
  options: { hasEarlierContext?: boolean } = {},
): ThreadPreviewEntry[] {
  if (chain.length <= 3) {
    const casts = chain.map((cast) => ({ type: 'cast' as const, cast }));
    return options.hasEarlierContext
      ? [{ type: 'gap' }, ...casts]
      : casts;
  }

  return [
    { type: 'cast', cast: chain[0] },
    { type: 'gap', omittedCount: chain.length - 3 },
    { type: 'cast', cast: chain[chain.length - 2] },
    { type: 'cast', cast: chain[chain.length - 1] },
  ];
}

/**
 * Collapse linear self-reply paths found in the loaded feed. Branches remain
 * separate units: each leaf receives its own ancestor path. The original rows
 * are emitted at their leaf positions so reply-bumping order is unchanged.
 */
export function collapseSelfReplyChains(posts: readonly FeedPost[]): FeedPostWithChain[] {
  const byHash = new Map<string, FeedPost>();
  for (const post of posts) byHash.set(post.hash.toLowerCase(), post);

  const selfParent = (post: FeedPost): FeedPost | undefined => {
    if (!post.parentHash) return undefined;
    const parent = byHash.get(post.parentHash.toLowerCase());
    return parent && parent.authorFid > 0 && parent.authorFid === post.authorFid
      ? parent
      : undefined;
  };

  const hasSelfChild = new Set<string>();
  for (const post of posts) {
    const parent = selfParent(post);
    if (parent) hasSelfChild.add(parent.hash.toLowerCase());
  }

  const chainByTip = new Map<string, FeedPost[]>();
  const absorbed = new Set<string>();
  for (const post of posts) {
    if (!selfParent(post) || hasSelfChild.has(post.hash.toLowerCase())) continue;

    const chain: FeedPost[] = [post];
    const visited = new Set([post.hash.toLowerCase()]);
    let cursor: FeedPost | undefined = post;
    let parent: FeedPost | undefined;

    while ((parent = selfParent(cursor)) && chain.length < 64) {
      const key = parent.hash.toLowerCase();
      if (visited.has(key)) break;
      visited.add(key);
      chain.push(parent);
      cursor = parent;
    }

    chain.reverse();
    chainByTip.set(post.hash.toLowerCase(), chain);
    for (const member of chain.slice(0, -1)) absorbed.add(member.hash.toLowerCase());
  }

  const result: FeedPostWithChain[] = [];
  for (const post of posts) {
    const key = post.hash.toLowerCase();
    if (absorbed.has(key)) continue;
    const chain = chainByTip.get(key);
    // Keep the bumped tip's row identity. Two branches can share the same root;
    // adopting that root's id/hash would give FlashList duplicate keys and make
    // optimistic deletion target the wrong cast.
    result.push(chain ? { ...post, __chain: chain } : post);
  }
  return result;
}
