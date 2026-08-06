/**
 * useMembersWithCachedQns — attach QNS `.q` names to roster rows WITHOUT
 * issuing a single network request.
 *
 * ## The problem it solves
 *
 * A `.q` name travels only in a member's published public profile, never in a
 * roster row. So any screen that renders names straight from the roster — the
 * space member list, the blocked-users list — can never show a `.q`, for
 * anybody, including you. That is not a resolver bug: the ladder is correct,
 * the data simply never arrives.
 *
 * ## Why it does not just fetch
 *
 * The obvious fix, one public-profile fetch per roster member, is the exact
 * fetch storm desktop looked at and refused. From its own feature doc: "The
 * full roster is deliberately never fetched (fetch-storm protection)." A
 * member list is a LIST — unlike a chat, whose sender set is bounded by what is
 * on screen — so fetching per row scales with space size and fires on every
 * settings open.
 *
 * Desktop's answer is to cheap-merge from `effectiveMembers`, the senders whose
 * profiles chat already fetched, and accept that a member who never posted
 * shows no `.q`. This hook reaches the same outcome by a different route:
 * mobile's settings modal is mounted at the space route rather than inside the
 * chat tree, so it cannot be handed that map — but React Query's cache is
 * global, and chat has already filled it under `publicProfileQueryKey`. Reading
 * it is free.
 *
 * ## Same accepted limitation as desktop
 *
 * A member whose profile is not in the cache shows no `.q`. In practice that
 * means someone who has not posted in a channel you have opened. They gain one
 * the moment they do. This is a deliberate trade, not an oversight — see the
 * desktop doc's "Sidebar lurkers" limitation, which is the identical case.
 *
 * ## Why `enabled: false` rather than `getQueryData`
 *
 * `getQueryData` is a one-shot read and would not update if a profile landed
 * while the modal was open — the channel behind it is still mounted and still
 * fetching. A disabled query subscribes to the cache entry without ever
 * fetching, so the row re-renders when the data arrives. The `queryFn` throws
 * rather than returning null: it must never run, and if it somehow did, a null
 * would be written over a real cached profile and silently erase names.
 */

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  publicProfileQueryKey,
  type PublicProfile,
} from '@/hooks/useUserPublicProfile';

/** Loose on purpose: roster rows reach this from several queries and not all of
 *  them declare the identity fields on their static type. */
type RosterRow = { address: string } & Record<string, unknown>;

export function useMembersWithCachedQns<T extends RosterRow>(members: T[]): T[] {
  const addresses = useMemo(
    () => Array.from(new Set(members.map((m) => m.address).filter(Boolean))),
    [members],
  );

  const cached = useQueries({
    queries: addresses.map((address) => ({
      queryKey: publicProfileQueryKey(address),
      queryFn: (): Promise<PublicProfile | null> => {
        // Unreachable while `enabled` is false. Loud rather than silent,
        // because the quiet alternative — resolving null — would overwrite a
        // real cached profile and blank out names across the app.
        throw new Error(
          'useMembersWithCachedQns must never fetch; it reads the cache chat fills.',
        );
      },
      enabled: false,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
    })),
  });

  const qnsByAddress = useMemo(() => {
    const out = new Map<string, string>();
    addresses.forEach((address, i) => {
      const name = (cached[i]?.data as PublicProfile | null | undefined)
        ?.primary_username;
      const trimmed = (name ?? '').trim();
      if (trimmed) out.set(address, trimmed);
    });
    return out;
    // `cached` is a fresh array every render, so key the memo on the values that
    // actually matter rather than the array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses, cached.map((q) => q?.data).join('|')]);

  return useMemo(() => {
    if (qnsByAddress.size === 0) return members;
    return members.map((m) => {
      const qns = qnsByAddress.get(m.address);
      // Only rewrite rows that gain something, so the rest keep their identity
      // and downstream memos do not churn.
      return qns ? ({ ...m, primary_username: qns } as T) : m;
    });
  }, [members, qnsByAddress]);
}
