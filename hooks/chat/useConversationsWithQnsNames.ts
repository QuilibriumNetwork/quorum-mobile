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
 * The distinction is what bounds N.
 *
 * - A space roster is unbounded by anything the user did: a space with 5,000
 *   members costs 5,000 requests every time Settings opens. That is the fetch
 *   storm both clients refused.
 * - A DM list is bounded by conversations the user personally started or
 *   accepted. It is tens, not thousands, and it grows a page (50) at a time
 *   only as they scroll.
 *
 * Results share `publicProfileQueryKey` with the conversation view and the chat
 * member fallback, at a 1h `staleTime` — so the cost is at most one small GET
 * per partner per hour, reused by every other surface that asks. Desktop's
 * `useConversationsWithProfileBackfill` fetches the same set for the same
 * reason; matching it is what keeps the two clients rendering a partner
 * identically.
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

export function useConversationsWithQnsNames<T extends { address?: string }>(
  conversations: T[],
): (T & { primary_username?: string })[] {
  const addresses = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const c of conversations) {
      if (!isQuorumAddress(c.address) || seen.has(c.address)) continue;
      seen.add(c.address);
      out.push(c.address);
    }
    return out;
  }, [conversations]);

  const queries = useQueries({
    queries: addresses.map((address) => ({
      queryKey: publicProfileQueryKey(address),
      queryFn: async (): Promise<PublicProfile | null> =>
        await getQuorumClient().getPublicProfile(address),
      staleTime: 60 * 60 * 1000, // 1 hour — matches useUserPublicProfile
      gcTime: 24 * 60 * 60 * 1000,
      retry: false,
    })),
  });

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
