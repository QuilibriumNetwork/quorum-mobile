/**
 * Bounded ancestor hydration for a home-feed reply unit.
 *
 * Fetches up to MAX_ANCESTOR_FETCHES ancestors of a reply (nearest first) so
 * the feed can render `root … parent reply` instead of only the immediate
 * parent. The ceiling is STRUCTURAL: exactly three `useFarcasterCast` slots
 * exist, chained on each other's result, so a hostile/deep thread can never
 * fan out further (see `__tests__/threadDetailViewFetchBound.test.tsx` for
 * the precedent this follows; pinned by
 * `__tests__/useFeedThreadAncestors.test.tsx`).
 *
 * Hypersnap needs `hash + author fid` for a cast lookup, and each cast only
 * learns its parent's fid from the fetched parent (`parentAuthor.fid`), so
 * ancestor discovery is inherently sequential — a fixed chain of enabled-
 * gated hooks, not a loop.
 *
 * Results are cached by React Query (same keys as every other cast lookup in
 * the app), so scrolling past the same conversation repeatedly does not
 * refetch.
 */

import { useFarcasterCast, type NormalizedCast } from '@quilibrium/quorum-shared';

/** Hard ceiling on ancestor cast lookups per feed unit. */
export const MAX_ANCESTOR_FETCHES = 3;

const GC_TIME_MS = 10 * 60 * 1000;

interface AncestorSeed {
  parentHash?: string;
  parentAuthorFid?: number;
}

export interface FeedThreadAncestors {
  /** Contiguous resolved ancestors, NEAREST first (parent, grandparent, …).
   *  Truncated at the first unresolved level so the chain never has gaps. */
  ancestors: NormalizedCast[];
  /** True when the topmost resolved ancestor is the thread root (not itself
   *  a reply). False while loading, on failure, or when the conversation
   *  continues above the fetch ceiling. */
  rootKnown: boolean;
}

function fidOf(cast: NormalizedCast | null | undefined): number | undefined {
  const fid = cast?.parentAuthor?.fid;
  return Number.isFinite(fid) && (fid as number) > 0 ? fid : undefined;
}

/** A cast is a fetchable reply when it names both a parent hash and fid. */
function fetchableParent(seed: AncestorSeed): boolean {
  return (
    !!seed.parentHash &&
    Number.isFinite(seed.parentAuthorFid) &&
    (seed.parentAuthorFid as number) > 0
  );
}

export function useFeedThreadAncestors(
  seed: AncestorSeed,
  enabled: boolean,
): FeedThreadAncestors {
  const want1 = enabled && fetchableParent(seed);
  const { data: p1 } = useFarcasterCast(
    want1 ? seed.parentHash : undefined,
    want1 ? seed.parentAuthorFid : undefined,
    { enabled: want1, gcTime: GC_TIME_MS },
  );

  const want2 = want1 && !!p1?.parentHash && fidOf(p1) !== undefined;
  const { data: p2 } = useFarcasterCast(
    want2 ? p1!.parentHash : undefined,
    want2 ? fidOf(p1) : undefined,
    { enabled: want2, gcTime: GC_TIME_MS },
  );

  const want3 = want2 && !!p2?.parentHash && fidOf(p2) !== undefined;
  const { data: p3 } = useFarcasterCast(
    want3 ? p2!.parentHash : undefined,
    want3 ? fidOf(p2) : undefined,
    { enabled: want3, gcTime: GC_TIME_MS },
  );

  // Contiguous prefix only: a gap (still loading / fetch failed / missing
  // parent fid) ends the chain — a unit must never show a hole.
  const ancestors: NormalizedCast[] = [];
  for (const cast of [p1, p2, p3]) {
    if (!cast) break;
    ancestors.push(cast);
  }

  const top = ancestors[ancestors.length - 1];
  // The top of the chain is the root only when it is not itself a reply to
  // another cast. (URL-parents — channel/off-Farcaster — do not make a cast
  // a reply for feed-threading purposes, matching isThreadableReply.)
  const rootKnown = ancestors.length > 0 && !top.parentHash;

  return { ancestors, rootKnown };
}
