---
type: bug
title: "QuorumIdentityBadge fires an uncapped fid-link lookup for every rendered cast"
status: open
priority: medium
ai_generated: true
created: 2026-08-13
updated: 2026-08-13
area: "Farcaster social feed / identity resolution / network cost"
---

# QuorumIdentityBadge fires an uncapped fid-link lookup for every rendered cast

## Summary

Every mounted `components/SocialFeed/content/QuorumIdentityBadge.tsx` calls
`hooks/useQuorumIdentityForFid.ts`, which issues a `getUserByFarcasterFid`
request (`/users/by-fid/:fid`). That lookup runs for **every rendered cast**,
not only for casts whose author actually has a linked Quorum identity, and it is
**not capped**.

In `components/SocialFeed/views/ThreadDetailView.tsx` the casts render inside a
plain `ScrollView` with no windowing (`parentCasts.map(...)`, `replies.map(...)`),
and `hooks/useFarcasterThread.ts` bounds reply *depth* (`replyDepth: 5`) but not
*breadth* — `hypersnapConversationToFlatCasts` flattens the whole tree with no
slice. So opening a thread with N casts issues N fid-link requests.

MEASURED (2026-08-13, during the identity-migration final review): a 61-cast
thread fires 61 fid-link lookups.

## Why this is filed separately

This is a **different endpoint** from the profile-fetch fan-out that was fixed on
the `feat/resolve-identity` branch, and it **pre-dates** that branch.

That branch fixed the profile side: `QuorumIdentityBadge`'s `enrich` prop is now
required with no default, and `ThreadDetailView` caps the enriched set at
`MAX_QNS_LOOKUPS` (50) distinct author fids — MEASURED 61 → 50 `getPublicProfile`
calls. The fid-link lookup was explicitly out of scope for that work and was left
untouched, verified by `git diff` showing `useQuorumIdentityForFid.ts` unchanged.

So the thread screen no longer issues 61+ profile fetches on top of 61 fid
lookups. It still issues the 61 fid lookups.

## Why it matters

Thread size is externally controlled. A viral cast is exactly the worst case, and
this is the same shape of unbounded, externally-driven fan-out that
`MAX_QNS_LOOKUPS` exists to cap everywhere else in the app.

## Suggested direction

Not prescriptive — the right fix depends on what the endpoint costs and whether
results are cacheable across casts:

- Cap the fid-link lookups the same way the profile fetches are now capped, using
  the shared `qnsLookupAddresses` / `MAX_QNS_LOOKUPS` pattern.
- Or batch them: one request for the thread's distinct author fids rather than
  one per cast.
- Or window `ThreadDetailView` (it is the only one of the badge's three call
  sites that is not a `FlashList`), which would bound both this and any future
  per-cast work by the viewport.

## Verification bar

Whatever the fix, it needs a fetch-count test in the shape the branch established
— mount the surface with well over the cap's worth of distinct authors and assert
the observed request count. See `__tests__/threadDetailViewFetchBound.test.tsx`
for the profile-side equivalent. A number, not an argument.

## Related

- `.agents/issues/2026-08-11-mobile-identity-resolution-plan.md` — the migration
  that fixed the profile-side fan-out and surfaced this one.

---

*Last updated: 2026-08-13*
