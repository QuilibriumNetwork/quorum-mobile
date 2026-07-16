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

type MemberWithTs = MemberMap[string] & {
  profileTimestamp?: number;
  global_display_name?: string;
  global_profile_image?: string;
  global_bio?: string;
};

// Effective per-field value BEFORE the public-profile fetch: a non-empty
// per-space OVERRIDE wins; otherwise the roster GLOBAL slot (the sender's
// global identity, pushed via the two-slot update-profile). Empty string
// means "not set at this tier" — fall through. See identity-resolution doc.
function effectiveLocal(
  override: string | undefined,
  global: string | undefined,
): string | undefined {
  return override || global || undefined;
}

export function useMembersWithPublicProfileFallback(
  members: MemberMap,
  visibleAddresses: string[],
): MemberMap {
  // Determine which addresses need a public-profile query. A member's name/
  // avatar is resolved by: override → roster global slot → public profile.
  // So we only need the public-profile fetch when NEITHER the override NOR the
  // roster global slot supplies the field (name or avatar). This narrows the
  // fetch set now that a global rename is pushed into the roster global slot —
  // most members resolve without any fetch. (Bio is NOT gated on, to avoid a
  // fetch storm; the merge still fills bio from public profile when a fetch
  // happens for another reason.) The public profile is still fetched for the
  // QNS `.q` name it uniquely carries when nothing else resolves.
  const addressesToFetch = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const addr of visibleAddresses) {
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      const m = members[addr] as MemberWithTs | undefined;
      const effName = effectiveLocal(m?.display_name, m?.global_display_name);
      const effIcon = effectiveLocal(m?.profile_image, m?.global_profile_image);
      if (!m || !effName || !effIcon) {
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
    visibleAddresses: string[];
    dataRefs: (PublicProfile | null)[];
    result: MemberMap;
  } | null>(null);

  const cached = cacheRef.current;
  const sameInputs =
    cached !== null &&
    cached.members === members &&
    cached.addressesToFetch === addressesToFetch &&
    cached.visibleAddresses === visibleAddresses &&
    cached.dataRefs.length === dataRefs.length &&
    cached.dataRefs.every((d, i) => d === dataRefs[i]);
  if (sameInputs) return cached!.result;

  let result: MemberMap;
  {
    // Build the effective map. For every VISIBLE member, resolve each field by
    // precedence: per-space OVERRIDE → roster GLOBAL slot → public profile.
    // The override always wins when non-empty. Between the roster global slot
    // and the public profile, prefer whichever is newer by timestamp (both
    // carry the sender's global identity; the roster slot is the live push, the
    // public profile is the stranger-fallback). This runs even when nothing was
    // fetched, so a global rename pushed into the roster slot renders without a
    // public profile (works for non-public users). See identity-resolution doc.
    const fetchIndex = new Map<string, number>();
    addressesToFetch.forEach((addr, i) => fetchIndex.set(addr, i));

    let changed = false;
    const merged: MemberMap = { ...members };
    for (const addr of new Set(visibleAddresses)) {
      if (!addr) continue;
      const local = members[addr] as MemberWithTs | undefined;
      const fi = fetchIndex.get(addr);
      const pub = fi != null ? dataRefs[fi] : null;

      // Resolve one field: override wins; else newer-of(global slot, public).
      const globalTs = (local as { globalProfileTimestamp?: number } | undefined)?.globalProfileTimestamp ?? 0;
      const pubTs = pub?.timestamp ?? -1;
      const globalNewer = globalTs >= pubTs;
      const pick = (
        override: string | undefined,
        globalSlot: string | undefined,
        pubVal: string | undefined,
      ): string => {
        if (override) return override;
        const g = globalSlot || undefined;
        const p = pubVal || undefined;
        if (globalNewer) return g || p || '';
        return p || g || '';
      };

      const nextName = pick(local?.display_name, local?.global_display_name, pub?.display_name);
      const nextIcon = pick(local?.profile_image, local?.global_profile_image, pub?.profile_image);
      const nextBio = pick(local?.bio, local?.global_bio, pub?.bio);

      // Only rewrite when a rendered field actually changes, so members that
      // already resolve (override present) keep their identity and don't churn
      // downstream memos.
      if (
        !local ||
        nextName !== (local.display_name ?? '') ||
        nextIcon !== (local.profile_image ?? '') ||
        nextBio !== (local.bio ?? '')
      ) {
        merged[addr] = {
          ...(local ?? { address: addr }),
          display_name: nextName,
          profile_image: nextIcon,
          bio: nextBio,
        } as MemberMap[string];
        changed = true;
      }
    }
    result = changed ? merged : members;
  }

  cacheRef.current = { members, addressesToFetch, visibleAddresses, dataRefs, result };
  return result;
}
