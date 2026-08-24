/**
 * Pure thread-unit composition for the home feed.
 *
 * A "feed unit" is the stack of cards one feed row renders for a cast that
 * belongs to a conversation: `[root] [elision] [parent] [reply]`. The rules
 * live here — outside `SocialFeedModal.tsx` — so they can be unit-tested
 * without mounting the modal.
 *
 * Invariants (bounty: "Make Quorum Conversation Threads Visually Obvious"):
 *  - No more than MAX_VISIBLE_THREAD_POSTS casts of one thread are ever
 *    visible in a single feed unit. Collapsed context is represented by one
 *    elision row, never by more cards.
 *  - When the thread root is known and the chain is deeper than the cap, the
 *    unit is `root … last-two` — the root anchors the conversation and the
 *    tail keeps the reply's immediate relationship visible.
 *  - When the root is NOT known (ancestors still loading, unresolvable, or
 *    deeper than the fetch ceiling), the unit is `… last-N`: the elision row
 *    on top says "this continues above" without pretending the top card is
 *    the root.
 */

import type { FeedPost } from './types';

/** Hard cap on casts of one thread shown in a single home-feed unit. */
export const MAX_VISIBLE_THREAD_POSTS = 3;

export type ThreadUnitItem =
  | { kind: 'cast'; post: FeedPost }
  | { kind: 'elision' };

/** A feed row that may carry a collapsed self-reply chain (root-first). When
 *  `__chain` is set the row renders the whole chain as one unit; the row's own
 *  identity/fields are the chain root's (see collapseSelfChains). */
export type FeedPostWithChain = FeedPost & { __chain?: FeedPost[] };

/**
 * Compose the visible unit for a root-first conversation slice.
 *
 * @param chain     Root-first contiguous slice of the conversation ending at
 *                  the cast that earned the feed slot (the tip).
 * @param rootKnown Whether `chain[0]` is the true top of the visible
 *                  conversation for this unit (a non-reply, or the cast this
 *                  unit deliberately anchors on, e.g. a self-chain root).
 */
export function buildThreadUnit(chain: FeedPost[], rootKnown: boolean): ThreadUnitItem[] {
  if (chain.length === 0) return [];
  const casts = chain.map((post): ThreadUnitItem => ({ kind: 'cast', post }));

  if (chain.length <= MAX_VISIBLE_THREAD_POSTS) {
    // Nothing hidden below the cap — but if the top card is not the root,
    // one elision row says the conversation continues above it.
    return rootKnown || chain.length === 1 ? casts : [{ kind: 'elision' }, ...casts];
  }

  if (rootKnown) {
    // Root anchors the unit; intermediate casts collapse into the elision.
    return [
      casts[0],
      { kind: 'elision' },
      ...casts.slice(chain.length - (MAX_VISIBLE_THREAD_POSTS - 1)),
    ];
  }

  // Root unreachable: keep the freshest slice, elision on top.
  return [{ kind: 'elision' }, ...casts.slice(chain.length - MAX_VISIBLE_THREAD_POSTS)];
}

/** Casts visible in a unit (excludes elision rows). */
export function visibleCastCount(items: ThreadUnitItem[]): number {
  return items.filter((i) => i.kind === 'cast').length;
}

/**
 * Collapse self-reply chains — a user rapidly replying to their own casts
 * (A → B → C) — into a single feed row so the thread shows once, root-first,
 * instead of as three overlapping parent/reply pairs.
 *
 * Chain members are gathered by walking `parentHash` links (they are NOT
 * guaranteed adjacent in the ranked feed) and only when consecutive casts
 * share an author. Each chain is emitted at its newest cast's (tip's) position
 * and keyed by the root, so the row's identity stays stable as the chain grows.
 * Cross-author replies are left untouched (FeedReplyCard fetches their parent).
 */
export function collapseSelfChains(posts: FeedPost[]): FeedPostWithChain[] {
  const byHash = new Map<string, FeedPost>();
  for (const p of posts) byHash.set(p.hash.toLowerCase(), p);

  // The in-feed parent of a cast, but only when it's the same author.
  const selfParent = (p: FeedPost): FeedPost | undefined => {
    if (!p.parentHash) return undefined;
    const parent = byHash.get(p.parentHash.toLowerCase());
    return parent && parent.authorFid > 0 && parent.authorFid === p.authorFid
      ? parent
      : undefined;
  };

  // Casts that are the self-parent of another cast — i.e. not a chain tip.
  const hasSelfChild = new Set<string>();
  for (const p of posts) {
    const parent = selfParent(p);
    if (parent) hasSelfChild.add(parent.hash.toLowerCase());
  }

  const chainByTip = new Map<string, FeedPost[]>();
  const absorbed = new Set<string>(); // non-tip members, hidden as their own rows
  for (const p of posts) {
    // Walk up only from a tip: a self-reply with no self-reply of its own.
    if (!selfParent(p) || hasSelfChild.has(p.hash.toLowerCase())) continue;
    const chain: FeedPost[] = [p];
    let cur: FeedPost | undefined = p;
    let parent: FeedPost | undefined;
    // Cap guards against a pathological/cyclic parentHash graph.
    while ((parent = selfParent(cur)) && chain.length < 64) {
      chain.push(parent);
      absorbed.add(parent.hash.toLowerCase());
      cur = parent;
    }
    chain.reverse(); // root → tip
    chainByTip.set(p.hash.toLowerCase(), chain);
  }

  if (chainByTip.size === 0) return posts;

  const result: FeedPostWithChain[] = [];
  for (const p of posts) {
    const key = p.hash.toLowerCase();
    if (absorbed.has(key)) continue; // shown inside its chain's row
    const chain = chainByTip.get(key);
    // Emit at the tip's position, but adopt the root's identity/fields.
    result.push(chain ? { ...chain[0], __chain: chain } : p);
  }
  return result;
}
