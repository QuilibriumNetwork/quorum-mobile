/**
 * useMembersWithPublicProfileFallback
 *
 * Takes a member map (address → SpaceMember) plus a list of addresses
 * currently in view, and back-fills missing/empty entries by fetching
 * the public-profile endpoint for each address.
 *
 * Resolution rule (per user spec) for name / avatar / bio:
 *   - If both local member (with profileTimestamp) and public profile
 *     have timestamps: latest wins.
 *   - If only the chat-broadcast (local) has a timestamp: use chat.
 *   - If only the public profile has a timestamp: use public.
 *   - If neither has a timestamp: use public.
 *
 * That merge reconciles two transports for ONE tier — the roster global slot
 * and the public profile both carry the member's global identity. It is not a
 * precedence ladder. The ladder (per-space override → QNS `.q` → global →
 * address) lives in `utils/resolveMemberName`, downstream of this hook, and the
 * two must not be confused: this decides WHICH global value is current, the
 * resolver decides which TIER wins.
 *
 * The QNS `.q` name is carried through separately and untouched by the merge,
 * because it has a single transport and no competing value. See the merge
 * comment below.
 *
 * Public-profile queries are React-Query-backed and shared across the
 * app via key; calling this hook from multiple surfaces won't multiply
 * the network cost.
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
  primary_username?: string;
};

/**
 * Fold one member's roster row together with their fetched public profile.
 *
 * Returns the new row, or `null` when nothing a surface renders would change —
 * the caller uses that to keep the previous map identity and avoid churning
 * every downstream memo.
 *
 * Exported and pure so it can be tested directly. It is worth testing on its
 * own: a silently dropped field here is invisible in the app (a member simply
 * renders under a lesser name, which looks like ordinary missing data), and
 * that is exactly how `primary_username` stayed unplumbed for two months.
 */
export function mergeMemberIdentity(
  address: string,
  local: MemberWithTs | undefined,
  pub: PublicProfile | null,
): MemberWithTs | null {
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

  // The QNS `.q` name is NOT part of the newer-of merge above, and that is not
  // an oversight. The merge exists to reconcile two transports for the SAME
  // tier (the roster global slot and the public profile both carry the member's
  // global identity, so the fresher one wins). `primary_username` has one
  // transport and is its own tier, ranked above the global name by the
  // resolver. There is nothing to reconcile it against — take it whenever a
  // fetch produced one, and keep any value already on the row so a later fetch
  // that 404s does not erase a name we already knew.
  const nextQns = pub?.primary_username || local?.primary_username || '';

  // Only rewrite when a rendered field actually changes, so members that
  // already resolve (override present) keep their identity and don't churn
  // downstream memos.
  const unchanged =
    !!local &&
    nextName === (local.display_name ?? '') &&
    nextIcon === (local.profile_image ?? '') &&
    nextBio === (local.bio ?? '') &&
    nextQns === (local.primary_username ?? '');
  if (unchanged) return null;

  // Built as MemberWithTs, not cast to MemberMap[string]. Shared's
  // `SpaceMember` declares neither the global slots nor `primary_username`, so
  // a direct cast is rejected for insufficient overlap — and casting through
  // `unknown` to silence that would throw away the only type checking this
  // object gets.
  return {
    ...(local ?? ({ address } as MemberWithTs)),
    display_name: nextName,
    profile_image: nextIcon,
    bio: nextBio,
    // Empty string means "no `.q`", matching how the other slots encode
    // "unset". `resolveMemberName` trims and treats it as absent.
    primary_username: nextQns,
  };
}

/**
 * Project a roster ARRAY through the effective member MAP.
 *
 * Surfaces that take `SpaceMember[]` rather than a `MemberMap` — the mention
 * autocomplete and the rendered mention pill — were reading the raw roster,
 * which can never carry `primary_username`: a `.q` reaches the client only in a
 * public profile. They resolved names correctly and were simply handed data
 * that could not contain the answer.
 *
 * Order is taken from the roster, not from the map, because the autocomplete
 * list is presented in roster order and `Object.values` would hand back
 * insertion order instead.
 *
 * A member the map does not know is passed through untouched, so this is safe
 * whatever the map happens to hold.
 */
export function membersWithEffectiveIdentity(
  members: MemberWithTs[] | undefined,
  effective: MemberMap,
): MemberWithTs[] | undefined {
  if (!members) return members;
  return members.map((m) => (effective[m.address] as MemberWithTs) ?? m);
}

export function useMembersWithPublicProfileFallback(
  members: MemberMap,
  visibleAddresses: string[],
): MemberMap {
  // Fetch the public profile for EVERY visible address, not only the ones
  // missing a name or avatar.
  //
  // This used to be gated on `!effName || !effIcon`, which was a sound
  // narrowing while the only thing the public profile added was a fallback
  // name/avatar: once the roster global slot carries those, the fetch buys
  // nothing. It stopped being sound the moment the QNS tier mattered.
  // `primary_username` exists in exactly one place — this response — and it
  // ranks ABOVE the global name. A member with a perfectly good roster name
  // therefore has a `.q` we would never learn about, so the tier could never
  // fire for anyone who had already been seen. The narrow gate was, on its own,
  // enough to keep QNS dead on mobile.
  //
  // Cost is bounded the same way desktop bounds it: the set is the unique
  // senders of the currently loaded messages (2 in a DM), never the full
  // roster, and results are shared app-wide under one React Query key with a
  // 1h staleTime. Matching desktop here is also what makes the two clients
  // render the same member the same way, which is the whole point.
  const addressesToFetch = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const addr of visibleAddresses) {
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      out.push(addr);
    }
    return out;
  }, [visibleAddresses]);

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

      const next = mergeMemberIdentity(addr, local, pub);
      if (next) {
        merged[addr] = next;
        changed = true;
      }
    }
    result = changed ? merged : members;
  }

  cacheRef.current = { members, addressesToFetch, visibleAddresses, dataRefs, result };
  return result;
}
