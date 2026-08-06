/**
 * useConversationsWithQnsNames — attach each DM partner's QNS `.q` name to the
 * conversation rows the Messages tab renders.
 *
 * ## Why the list needs its own fetch
 *
 * A `.q` travels in one place only: the member's published public profile. It
 * is never on a conversation row, so the inbox could never show one, for
 * anybody. Inside a conversation the chat view already fetches the partner's
 * profile, but the inbox is usually the FIRST screen opened — the cache is cold
 * exactly when the list is drawn, so the free cache-read trick used for space
 * rosters (`useMembersWithCachedQns`) would show nothing here.
 *
 * ## Why fetching is affordable here, when it was refused for a space roster
 *
 * A space roster is unbounded by anything the user did: a space with 5,000
 * members costs 5,000 requests every time Settings opens. That is the fetch
 * storm both clients refused.
 *
 * A DM list is smaller, because it is bounded by conversations the user
 * personally started or accepted — but "smaller" is a claim about typical
 * usage, not an invariant, and this file originally leaned on it as though it
 * were one. It is not: `useUnifiedConversations` flat-maps EVERY accumulated
 * page, React Query keeps every page it has fetched, and the inbox calls
 * `fetchNextPage()` on each `onEndReached`. So the address set grows with how
 * far the user has scrolled, and someone with 800 partners who scrolls their
 * whole inbox would drive 800 lookups — the roster storm again, merely paced by
 * scroll speed instead of fired in one burst.
 *
 * `MAX_QNS_LOOKUPS` makes the bound real rather than assumed. See it below for
 * why the overflow degrades safely.
 *
 * Results share `publicProfileQueryKey` with the conversation view and the chat
 * member fallback, at a 1h `staleTime` — so the cost is at most one small GET
 * per partner per hour, reused by every other surface that asks. Desktop's
 * `useConversationsWithProfileBackfill` fetches the same set for the same
 * reason; matching it is what keeps the two clients rendering a partner
 * identically. Note desktop has NO cap and inherits the same latent problem —
 * flagged in the parity doc.
 *
 * ## What this deliberately does NOT do
 *
 * Desktop's hook also writes resolved name/avatar back to its local
 * conversation row, because a desktop row can hold the literal "Unknown User"
 * placeholder. Mobile has no such placeholder — an unresolved row falls back to
 * a truncated address at render — so there is nothing to repair and no reason
 * to take on write-back. This hook is read-only.
 */

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { getQuorumClient } from '@/services/api/quorumClient';
import {
  publicProfileQueryKey,
  type PublicProfile,
} from '@/hooks/useUserPublicProfile';

/**
 * A Farcaster conversation carries the synthetic address `fid:<n>`
 * (`useFarcasterDirectCasts`), which is not a Quorum account and has no Quorum
 * public profile. Fetching one is a guaranteed 404 per Farcaster DM on every
 * inbox open, so they are excluded rather than allowed to fail quietly.
 */
const isQuorumAddress = (address: string | undefined): address is string =>
  !!address && !address.startsWith('fid:');

/**
 * The most partners this hook will ever look up, however long the inbox is.
 *
 * One page's worth, matching `useConversations`' `limit: 50`. That keeps the
 * common case — a user whose whole DM list fits in one page — completely
 * correct, while making the cost of an enormous inbox flat instead of linear in
 * scroll depth.
 *
 * **The overflow degrades to exactly the previous behaviour**: a partner past
 * the cap has no `primary_username` attached, so the resolver falls through to
 * their global name. Nothing renders wrong, a name is simply less specific than
 * it could be — the same trade the space member list already takes for a member
 * who has never posted.
 */
const MAX_QNS_LOOKUPS = 50;

/**
 * The distinct Quorum partner addresses worth looking up, newest first, capped.
 *
 * **Relies on the caller handing rows in most-recent-first order**, which
 * `useUnifiedConversations` guarantees by sorting on `timestamp` before
 * returning. That coupling is load-bearing and invisible: drop the sort there
 * and this still returns 50 addresses, just an arbitrary 50, so the partners
 * that lose their `.q` would be unpredictable instead of the oldest. Stated
 * here because nothing in the type system carries it.
 *
 * Pure and exported for its tests — the cap is the kind of bound that is easy
 * to write and easy to quietly regress.
 */
export function qnsLookupAddresses(
  conversations: { address?: string }[],
  max: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of conversations) {
    if (out.length >= max) break;
    if (!isQuorumAddress(c.address) || seen.has(c.address)) continue;
    seen.add(c.address);
    out.push(c.address);
  }
  return out;
}

export function useConversationsWithQnsNames<T extends { address?: string }>(
  conversations: T[],
): (T & { primary_username?: string })[] {
  const addresses = useMemo(
    () => qnsLookupAddresses(conversations, MAX_QNS_LOOKUPS),
    [conversations],
  );

  // Memoised, not rebuilt inline. This hook is called from the inbox, which
  // also owns the search box's `useState`, so it re-renders on every keystroke;
  // building the descriptor array there re-allocated one object per loaded
  // partner per character typed. Nothing refetched — React Query dedupes by key
  // — but it was avoidable work on the JS thread while typing.
  const queryOptions = useMemo(
    () =>
      addresses.map((address) => ({
        queryKey: publicProfileQueryKey(address),
        queryFn: async (): Promise<PublicProfile | null> =>
          await getQuorumClient().getPublicProfile(address),
        staleTime: 60 * 60 * 1000, // 1 hour — matches useUserPublicProfile
        gcTime: 24 * 60 * 60 * 1000,
        retry: false,
      })),
    [addresses],
  );

  const queries = useQueries({ queries: queryOptions });

  // Key the memo on the `.q` values themselves, not on the profile objects.
  // `useQueries` returns a fresh array every render, and joining the objects
  // would stringify each to "[object Object]" — a dep that cannot tell one
  // profile from another, so a refetch that CHANGED someone's `.q` would never
  // re-render. The names are the only field read here, so joining them is both
  // cheaper and strictly more precise.
  const qnsKey = queries
    .map((q) => (q?.data as PublicProfile | null | undefined)?.primary_username ?? '')
    .join('|');

  const qnsByAddress = useMemo(() => {
    const out = new Map<string, string>();
    addresses.forEach((address, i) => {
      const name = (queries[i]?.data as PublicProfile | null | undefined)
        ?.primary_username;
      const trimmed = (name ?? '').trim();
      if (trimmed) out.set(address, trimmed);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses, qnsKey]);

  return useMemo(() => {
    if (qnsByAddress.size === 0) return conversations;
    return conversations.map((c) => {
      const qns = c.address ? qnsByAddress.get(c.address) : undefined;
      // Only rewrite rows that gain something, so the rest keep their identity
      // and the list memo downstream does not churn.
      return qns ? { ...c, primary_username: qns } : c;
    });
  }, [conversations, qnsByAddress]);
}
