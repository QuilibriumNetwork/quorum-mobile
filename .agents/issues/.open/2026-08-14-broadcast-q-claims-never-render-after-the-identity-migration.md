---
type: bug
title: "Broadcast .q claims never render, so a user with no public profile has no .q anywhere"
status: open
priority: high
ai_generated: true
created: 2026-08-14
updated: 2026-08-14
area: "Identity resolution / QNS / quorum-shared parity"
---

# Broadcast `.q` claims never render, so a user with no public profile has no `.q` anywhere

## Summary

A `.q` name reaches the client by **two** transports. After the identity
migration, the ladder can only see **one** of them.

`identity/identityProvider.tsx:160-175` builds `verifiedQnsNames` — the sole
source of the `.q` tier, per `identity/identityFromMaps.ts:105` — by iterating
`profiles`, the map of **fetched public profiles**, and reading
`profile?.primary_username`. Nothing else contributes to it.

The other transport is the broadcast. `context/WebSocketContext.tsx:774`,
`:2796` and `:4714` each store an incoming profile broadcast's claim under
`claimed_primary_username`, on the roster row and the DM conversation row. That
key exists precisely so a claim delivered over the wire is not confused with a
verified one — see `hooks/useVerifiedQnsNames.ts:142-173` (`claimIn`), which
treats the two transports as equals and documents that the broadcast **wins
whenever present**, because an empty broadcast is an un-election that has to be
able to clear a name.

The provider never sees that key. `identity/identityFromMaps.ts`'s
`RosterNameRow` declares only `display_name` and `global_display_name`, and
`hooks/useMultiSpaceRosters.ts:30-41` copies only those two fields out of the
stored member row. So a broadcast claim is received, verified-capable, stored —
and then dropped on the floor before it reaches the ladder.

## Consequence

**A user who has not published a public profile has no `.q` on any migrated
surface**, even though their claim arrived, was stored, and would verify.

That is most of the point of the feature for privacy-minded users, and it makes
the Public Profile toggle silently load-bearing for QNS in a way nothing in the
UI says. The operator's own reading during the manual sweep was that "public
profile ON or OFF doesn't change anything for the qns name" — which is what the
two-transport design intends, and what the code no longer does.

## Why it did not show up as a regression earlier

Pre-migration, `stripUnverifiedNamesInMap` promoted a verified
`claimed_primary_username` into `primary_username` **on the member map**, and
the surfaces rendered from that map. Both chat areas still call it
(`components/Chat/DMChatArea.tsx:200` and
`components/Chat/SpaceChatArea.tsx:256`), so the promotion still happens — but
nothing renders its result any more. `components/Chat/MessagesList.tsx:368-378` resolves the
message header through `@/identity` **explicitly instead of** the precomputed
`item.userName` that carried it. The old path is intact and inert.

No test caught it because every migrated test supplies a public profile
carrying `primary_username`. Not one supplies a roster or conversation row
carrying **only** `claimed_primary_username`, which is the shape a real
non-public user has.

## Why this is not a ten-line fix

The obvious change — carry the claim on `RosterNameRow` and verify it in the
provider — puts every member of every joined space into `claimedNamesIn`, at the
app root, on every launch. That is the unbounded roster fan-out this branch
spent its final review capping (`MAX_QNS_LOOKUPS`, `qnsLookupAddresses`). A
5,000-member space would drive the resolve batch directly.

It also needs a rule the flat `verifiedQnsNames` map does not currently imply:
a claim is global, but `rostersBySpace` is per-space, so the same address can
present a claim in more than one space and something has to decide precedence
(and what happens when they disagree, which is a signal in itself).

## Suggested direction

Not prescriptive; the bound is the hard part, not the plumbing.

- Bound the roster-claim set the same way the profile fetches are bounded, and
  reuse `qnsLookupAddresses` / `MAX_QNS_LOOKUPS` rather than introducing a
  second cap that can drift.
- Or make it demand-driven, the way `request()` already makes profile fetches
  demand-driven: a claim is verified when a surface actually asks to resolve
  that address, not for the whole roster up front. This matches the existing
  `enrich` opt-in and is probably the smaller change.
- The DM case is separately bounded and much cheaper (one partner per
  conversation), so it could land first — `conversationData.claimed_primary_username`
  is already threaded to `DMChatArea.tsx:175-177`.

## Verification bar

A test that mounts `IdentityScopeProvider` with a roster (or conversation) row
carrying **only** `claimed_primary_username`, no public profile at all, and
asserts the `.q` renders. Plus the impersonation control the profile path
already has: a broadcast claim whose record derives back to a *different*
address must still be refused. See
`__tests__/identityProviderVerification.test.tsx` for the shape.

Prove it fails before the fix. The whole reason this defect survived is that
the existing tests pass with or without the broadcast transport wired.

## Related

- `.agents/issues/2026-08-11-mobile-identity-resolution-plan.md` — the migration
  that introduced this.
- `9dbd47b` — the two sibling defects found in the same sweep (the dead dev
  exemption, and DM partners resolving to addresses).

---

*Last updated: 2026-08-14*
