/**
 * useMembersWithPublicProfileFallback
 *
 * Takes a member map (address → SpaceMember) plus a list of addresses
 * currently in view, and back-fills missing/empty entries by fetching
 * the public-profile endpoint for each address.
 *
 * Resolution rule (per user spec):
 *   - If both local member (with profileTimestamp) and public profile
 *     have timestamps: latest wins.
 *   - If only the chat-broadcast (local) has a timestamp: use chat.
 *   - If only the public profile has a timestamp: use public.
 *   - If neither has a timestamp: use public.
 *
 * Public-profile queries are React-Query-backed and shared across the
 * app via key; calling this hook from multiple surfaces won't multiply
 * the network cost. We only fire queries for addresses where the local
 * record is missing or has no display_name — fully-populated members
 * are passed through untouched, avoiding an N×fetch per chat render.
 */

import { useMemo, useRef } from 'react';
import { useQueries } from '@tanstack/react-query';
import { getQuorumClient } from '@/services/api/quorumClient';
import {
  publicProfileQueryKey,
  type PublicProfile,
} from '@/hooks/useUserPublicProfile';
import type { MemberMap } from '@/components/Chat/types';

type MemberWithTs = MemberMap[string] & { profileTimestamp?: number };

export function useMembersWithPublicProfileFallback(
  members: MemberMap,
  visibleAddresses: string[],
): MemberMap {
  // Determine which addresses need a public-profile query — addresses
  // where we have no local record, or the record exists but has no
  // display_name AND no profile_image. Fully-populated members aren't
  // queried.
  const addressesToFetch = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const addr of visibleAddresses) {
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      const m = members[addr];
      if (!m || (!m.display_name && !m.profile_image)) {
        out.push(addr);
      }
    }
    return out;
  }, [members, visibleAddresses]);

  const queries = useQueries({
    queries: addressesToFetch.map((address) => ({
      queryKey: publicProfileQueryKey(address),
      queryFn: async (): Promise<PublicProfile | null> => {
        return await getQuorumClient().getPublicProfile(address);
      },
      staleTime: 60 * 60 * 1000,
      gcTime: 24 * 60 * 60 * 1000,
      retry: false,
    })),
  });

  // Important perf note. `useQueries` returns a fresh array reference
  // every render, so a `useMemo([..., queries])` would invalidate on
  // every render even when nothing material changed — yielding a new
  // `effectiveMemberMap` identity, which then forces every downstream
  // memo (the `messages` array, MiniSearch indexing, FlashList data,
  // etc.) to recompute. With a busy chat that work piles up on the JS
  // thread and starves things like the back-button gesture.
  //
  // Cache the result manually on a ref instead. We only rebuild when
  // (a) `members` or `addressesToFetch` change identity, or (b) any of
  // the per-address query data references changes — React Query keeps
  // those stable until a refetch produces new data.
  const dataRefs: (PublicProfile | null)[] = queries.map(q => q?.data ?? null);
  const cacheRef = useRef<{
    members: MemberMap;
    addressesToFetch: string[];
    dataRefs: (PublicProfile | null)[];
    result: MemberMap;
  } | null>(null);

  const cached = cacheRef.current;
  const sameInputs =
    cached !== null &&
    cached.members === members &&
    cached.addressesToFetch === addressesToFetch &&
    cached.dataRefs.length === dataRefs.length &&
    cached.dataRefs.every((d, i) => d === dataRefs[i]);
  if (sameInputs) return cached!.result;

  let result: MemberMap;
  if (addressesToFetch.length === 0) {
    result = members;
  } else {
    const merged: MemberMap = { ...members };
    addressesToFetch.forEach((addr, i) => {
      const pub = dataRefs[i];
      if (!pub) return;
      const local = members[addr] as MemberWithTs | undefined;
      // Per-field fallback. Whichever source is "newer" by timestamp
      // is preferred, but only if it has a non-empty value for that
      // field — otherwise we fall through to the other source.
      // This matters when a user broadcasts a partial update (e.g.
      // avatar-only with no displayName): their profileTimestamp gets
      // stamped recently while display_name stays empty. Without the
      // per-field fallback, the all-or-nothing "useChat" branch would
      // pin them to the empty local record and ignore the public
      // profile that has the real name.
      const chatTs = local?.profileTimestamp;
      const chatIsNewer = chatTs != null && chatTs >= pub.timestamp;
      const pickField = (localVal: string | undefined, pubVal: string) => {
        // When the local (per-space) record is the newer source, its value
        // WINS — including a deliberate empty '' (a cleared avatar / name),
        // which must not fall back to the older public-profile value.
        // `!== undefined` keeps the intended "explicit clear wins" without
        // resurrecting the global value. Absent (undefined) still falls
        // through to the public profile (partial-update / never-set case).
        if (chatIsNewer) return localVal !== undefined ? localVal : pubVal || '';
        return pubVal || localVal || '';
      };
      merged[addr] = {
        ...(local ?? { address: addr }),
        display_name: pickField(local?.display_name, pub.display_name),
        profile_image: pickField(local?.profile_image, pub.profile_image),
        bio: pickField(local?.bio, pub.bio),
      } as MemberMap[string];
    });
    result = merged;
  }

  cacheRef.current = { members, addressesToFetch, dataRefs, result };
  return result;
}
