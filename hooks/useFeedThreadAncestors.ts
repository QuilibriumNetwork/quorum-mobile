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

import { useMemo } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { perfMark } from '@/services/observability/perfProbe';
import {
  DEFAULT_HYPERSNAP_BASE_URL,
  fromHypersnapCast,
  useFarcasterCast,
  type HypersnapCast,
  type NormalizedCast,
} from '@quilibrium/quorum-shared';

/** Hard ceiling on ancestor cast lookups per feed unit. */
export const MAX_ANCESTOR_FETCHES = 3;

const GC_TIME_MS = 10 * 60 * 1000;

export interface AncestorSeed {
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
  // parent fid) ends the chain — a unit must never show a hole. Memoised so
  // the feed card's derived posts keep their identity between renders.
  const ancestors = useMemo(() => {
    const out: NormalizedCast[] = [];
    for (const cast of [p1, p2, p3]) {
      if (!cast) break;
      out.push(cast);
    }
    return out;
  }, [p1, p2, p3]);

  const top = ancestors[ancestors.length - 1];
  // The top of the chain is the root only when it is not itself a reply to
  // another cast. (URL-parents — channel/off-Farcaster — do not make a cast
  // a reply for feed-threading purposes, matching isThreadableReply.)
  const rootKnown = ancestors.length > 0 && !top.parentHash;

  return { ancestors, rootKnown };
}

// ---- resolving a page's ancestors up front ---------------------------------

/** Most hashes one bulk lookup carries. */
const BULK_LOOKUP_MAX = 25;

/** The key `useFarcasterCast` caches a cast under (quorum-shared). */
const castQueryKey = (hash: string, fid: number) => ['farcaster', 'cast', { hash, fid }] as const;

const bareHash = (hash: string) => hash.toLowerCase().replace(/^0x/, '');

/** Casts by bare lowercase hash, from Hypersnap's bulk lookup. A failed chunk
 *  is skipped; whatever it held is looked up by the card itself. */
async function fetchCastsBulk(hashes: string[]): Promise<Map<string, NormalizedCast>> {
  const found = new Map<string, NormalizedCast>();
  for (let i = 0; i < hashes.length; i += BULK_LOOKUP_MAX) {
    const chunk = hashes.slice(i, i + BULK_LOOKUP_MAX);
    try {
      const res = await fetch(
        `${DEFAULT_HYPERSNAP_BASE_URL}/v2/farcaster/cast/bulk?hashes=${chunk.map(encodeURIComponent).join(',')}`,
        { headers: { accept: 'application/json' } },
      );
      if (!res.ok) continue;
      const json = (await res.json()) as { casts?: HypersnapCast[] };
      for (const c of json.casts ?? []) {
        const cast = fromHypersnapCast(c);
        found.set(bareHash(cast.hash), cast);
      }
    } catch {
      // Best effort.
    }
  }
  return found;
}

/**
 * Resolve the ancestors a page of feed replies will ask for, in bulk, and put
 * them in the cache under the keys `useFeedThreadAncestors` reads, so the
 * reply cards render with their ancestors instead of growing after mount.
 *
 * Each card used to run its own chain of up to three lookups, one after
 * another, after it mounted: up to ~75 sequential requests for a page, and a
 * card that grew from one cast to four, shifting the feed under the reader.
 * This makes one bulk request per level (at most `MAX_ANCESTOR_FETCHES`
 * levels, same bound as the cards), each covering the whole page.
 *
 * Seeds whose parent is on the same page are skipped (a self-reply chain is
 * collapsed into one row and fetches nothing). Anything not found is left to
 * the card's own lookup.
 */
export async function prefetchReplyAncestors(
  queryClient: QueryClient,
  seeds: AncestorSeed[],
  pageHashes: ReadonlySet<string> = new Set(),
): Promise<void> {
  perfMark('feed-ancestors');
  let level = seeds.filter((seed) => fetchableParent(seed) && !pageHashes.has(bareHash(seed.parentHash!)));
  for (let depth = 0; depth < MAX_ANCESTOR_FETCHES && level.length > 0; depth++) {
    const wanted = new Map<string, { hash: string; fid: number }>();
    const next: AncestorSeed[] = [];
    for (const seed of level) {
      const hash = seed.parentHash!;
      const fid = seed.parentAuthorFid!;
      const cached = queryClient.getQueryData<NormalizedCast | null>(castQueryKey(hash, fid));
      if (cached !== undefined) {
        if (cached) next.push({ parentHash: cached.parentHash, parentAuthorFid: fidOf(cached) });
        continue;
      }
      wanted.set(`${bareHash(hash)}:${fid}`, { hash, fid });
    }
    if (wanted.size > 0) {
      const found = await fetchCastsBulk(Array.from(new Set(Array.from(wanted.values(), (w) => w.hash))));
      for (const { hash, fid } of wanted.values()) {
        const cast = found.get(bareHash(hash));
        if (!cast) continue;
        queryClient.setQueryData(castQueryKey(hash, fid), cast);
        next.push({ parentHash: cast.parentHash, parentAuthorFid: fidOf(cast) });
      }
    }
    level = next.filter(fetchableParent);
  }
}
