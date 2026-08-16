/**
 * qnsLookupAddresses / MAX_QNS_LOOKUPS — the bound on how many DM partners'
 * public profiles are worth fetching for the Messages tab, and its siblings
 * (the invite contact picker, the mention/message-input QNS lookups) that
 * enrich the same conversation list and must not drift from the same cap.
 *
 * ## History
 *
 * This file used to also export `useConversationsWithQnsNames`, a hook that
 * fetched each partner's public profile itself and attached a VERIFIED
 * `primary_username` to the conversation row for `app/(tabs)/messages/index.tsx`
 * to read. That row's own `.q` now resolves through `@/identity`'s
 * `useNameResolver` instead (verified the same way, by the same
 * `IdentityScopeProvider`, rather than a second, parallel fetch-and-verify
 * pass) — see that screen's own comment. Nothing reads `primary_username`
 * off a conversation row any more, so the hook was removed rather than kept
 * as a silent, still-network-calling no-op. The address-capping helpers
 * below are unaffected: `messages/index.tsx` still uses `qnsLookupAddresses`
 * to decide which addresses are worth `requestNames`-ing through `@/identity`.
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
 */

/**
 * A Farcaster conversation carries the synthetic address `fid:<n>`
 * (`useFarcasterDirectCasts`), which is not a Quorum account and has no Quorum
 * public profile. Fetching one is a guaranteed 404 per Farcaster DM on every
 * inbox open, so they are excluded rather than allowed to fail quietly.
 */
const isQuorumAddress = (address: string | undefined): address is string =>
  !!address && !address.startsWith('fid:');

/**
 * The most partners worth looking up, however long the inbox is.
 *
 * One page's worth, matching `useConversations`' `limit: 50`. That keeps the
 * common case — a user whose whole DM list fits in one page — completely
 * correct, while making the cost of an enormous inbox flat instead of linear in
 * scroll depth.
 *
 * **The overflow degrades to exactly the previous behaviour**: a partner past
 * the cap is never requested, so `@/identity` falls through to their global
 * name. Nothing renders wrong, a name is simply less specific than it could
 * be — the same trade the space member list already takes for a member who
 * has never posted.
 *
 * Exported so other surfaces reading this same conversation list (e.g. the
 * invite contact picker) can bound their OWN `enrich`/`requestNames` fan-out
 * to the identical cap, rather than each carrying its own copy of `50` that
 * can silently drift from this one.
 */
export const MAX_QNS_LOOKUPS = 50;

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
