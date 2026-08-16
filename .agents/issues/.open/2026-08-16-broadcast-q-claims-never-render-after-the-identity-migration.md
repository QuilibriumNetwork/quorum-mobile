---
type: bug
title: "Broadcast .q claims never reach the identity ladder, so the only working .q transport renders nothing"
status: open
priority: critical
complexity: medium
ai_generated: true
created: 2026-08-16
updated: 2026-08-16
area: "Identity resolution / QNS / feat/resolve-identity branch"
repos: quorum-mobile (desktop is a separate, later piece — see §9)
source: found 2026-08-16 while diagnosing a manual fake-QNS sweep on the feat/resolve-identity branch
related:
  - "issues/2026-08-11-mobile-identity-resolution-plan.md (the migration that caused this)"
  - "issues/2026-08-06-decouple-qns-primary-name-from-public-profile-design.md (why the broadcast transport exists; mobile's half SHIPPED)"
  - "issues/.open/2026-08-06-verify-a-claimed-q-name-receiver-side-plan.md (the verification this must reuse; shipped mobile-side in PR #245)"
  - "issues/.open/2026-08-06-server-rejects-every-primary-username-publish.md (upstream #240 — why the OTHER transport is dead)"
---

# Broadcast `.q` claims never reach the identity ladder

## For the agent picking this up — read this first

This is a **regression on the `feat/resolve-identity` branch**, and it is
**merge-blocking**. The branch is otherwise finished and verified. This is the
last item.

You do **not** need a working server, and you do **not** need the fake-QNS dev
tool, to verify your fix. Read §7 before assuming otherwise — an earlier pass
wrongly concluded this was untestable and parked it.

Do not start by reading the whole migration plan. Read this file, then the four
files named in §3.

---

## 1. The bug in plain words

A QNS `.q` name reaches another user by two routes:

- **Route A — the public profile.** The owner publishes a profile to the
  server; your client fetches it; the name is in `primary_username`.
- **Route B — the broadcast.** The owner's client announces the name directly
  to every space they are in (and to DM partners). Your client stores it on
  that member's local roster row as `claimed_primary_username`, verifies it,
  and promotes it.

**Route A is dead server-side** — the API rejects every publish carrying a
`primary_username` (upstream
[#240](https://github.com/QuilibriumNetwork/quorum-mobile/issues/240)). Nobody
has one. **Route B works today**, is mobile-only, and is therefore the only way
a `.q` reaches anyone anywhere in the product right now.

Before this branch, mobile rendered Route B. The migration rebuilt name
resolution around a single provider that reads **only Route A**. The broadcast
still arrives, is still stored, is still verified — the ladder simply stopped
looking at it.

**Net effect of shipping the branch as-is: every user who owns a QNS name and
elected it loses their `.q` everywhere, and it will look like the server bug
rather than ours.**

## 2. Why it is a regression, not a pre-existing gap

READ, with the comparison run:

- On `master`, the message header rendered `item.userName`, built by
  `resolveMemberName(member)` from the member map that
  `useVerifiedQnsNamesInMap` had **already promoted the verified broadcast
  claim into** — `git show master:components/Chat/MessagesList.tsx:691,1183`.
- On this branch, `components/Chat/MessagesList.tsx:368-378` deliberately
  resolves through `@/identity` **instead of** `item.userName`.
- The promotion still runs (`components/Chat/SpaceChatArea.tsx:256`,
  `components/Chat/DMChatArea.tsx:200`) and is now **inert** — the
  `rawNameFieldAudit` ratchet has `TO_MIGRATE` empty, so no surface reads the
  promoted field any more.

## 3. Where the pieces are

Read these four, in this order:

| What | Where |
|---|---|
| The ladder's only `.q` source | `identity/identityProvider.tsx:160-175` — builds `verifiedQnsNames` from fetched **profiles only** |
| The shape the provider reads a roster row through | `identity/identityFromMaps.ts:28-33` — `RosterNameRow` has **no claim field** |
| What actually loads roster rows | `hooks/useMultiSpaceRosters.ts:30-41` — copies only `display_name` / `global_display_name` |
| The existing verification + promotion | `hooks/useVerifiedQnsNames.ts` — `claimIn` (`:169`), `settleClaim` (`:273`), `useClaimRecords` (`:370`) |

Supporting facts (already verified, do not re-derive):

- The claim is stored by `context/WebSocketContext.tsx:769, 2791, 4709` as
  `claimed_primary_username`.
- It is broadcast by `context/WebSocketContext.tsx` (~`:6647`,
  `primaryUsername: user.primaryUsername ?? NO_PRIMARY_NAME`) on a fingerprint
  that includes the primary name (~`:6563`), so electing in-session rebroadcasts.
- The wire field is **additive and undeclared** in `quorum-shared` —
  `UpdateProfileMessage` has no QNS field. That is deliberate (client-only
  change, no shared release). Do not "fix" this by adding it to shared.

## 4. The fix

Feed roster claims into the provider's existing verification, demand-driven.

1. Add the claim to `RosterNameRow` (e.g. `claimedQnsName?: string | null`) and
   populate it in `useMultiSpaceRosters` from the stored row's
   `claimed_primary_username`.
2. In `IdentityScopeProvider`, include roster claims alongside profile claims
   when building `claimedNames` / `verifiedQnsNames`, running them through the
   **same** `claimedNameBelongsTo` check that already guards the profile path.
3. **Bound it demand-driven.** Only verify a claim for an address something has
   actually asked to resolve. The provider already has this mechanism —
   `request(address)` (`identity/identityProvider.tsx:92-96`), driven by the
   `enrich` opt-in. Roster claims ride the same trigger. Reuse
   `qnsLookupAddresses` / `MAX_QNS_LOOKUPS` from
   `hooks/chat/useConversationsWithQnsNames.ts`; do not introduce a second cap.

### Why this is architecturally sound

- **It adds an INPUT, not a second decision point.** The migration's core
  invariant is one ladder with one verification checkpoint, and a data shape
  (`IdentitySources` carries no profile object, only `verifiedQnsNames`) where
  an unverified claim has nowhere to live. This preserves all of that.
- **The other tiers already do exactly this.** `globalName` already merges two
  transports (roster global slot + public profile) —
  `identity/identityFromMaps.ts:108-111`. QNS having two transports is the same
  shape, not a new pattern.
- **It restores prior behaviour** rather than inventing any.

### The alternative to reject

Pointing the surfaces back at the member map (`effectiveMemberMap`) would "fix"
the symptom by re-splitting name resolution into two paths — precisely what the
migration removed, and what caused the 19-defect audit that started it. Do not.

## 5. Risks, in the order they should worry you

1. **Fetch cost.** Verification is a network call and rosters can hold
   thousands of members. Getting the bound wrong reintroduces the fetch storm
   this branch spent its final review capping. **Mitigation:** demand-driven
   only, shared cap, plus a fetch-count test in the shape the branch already
   uses (`__tests__/threadDetailViewFetchBound.test.tsx`,
   `__tests__/shareInviteSheetFetchBound.test.tsx`) — assert a number.
2. **A new attacker-influenced input.** Anyone in your space can broadcast any
   claim. Only the verification stands between that and a forged `.q`. The
   impostor test in §7 is not optional.
3. **Two spaces, one person, two claims.** `verifiedQnsNames` is flat
   (address → name) but `rostersBySpace` is per-space. Pick a deterministic
   rule and state it in a comment. Do not let it flap between renders.
4. **Un-election.** An empty broadcast claim means "cleared" — presence, not
   truthiness, is the test (`hooks/useVerifiedQnsNames.ts:150-156`). Check the
   clearing path still works once the provider reads the field; a stale claim
   could otherwise linger for the 1h TTL.
5. **Flicker.** A claim verified asynchronously means global name → `.q`
   shortly after mount. Already true for the profile path (R2 in the
   receiver-side plan: never render `.q` optimistically, only upgrade INTO it).
   Do not regress that direction.

## 6. Hard rules

- **Never write a roster claim into `verifiedQnsNames` without
  `claimedNameBelongsTo` passing.** There is exactly one place that writes that
  map; keep it that way.
- **Nothing outside `identity/` may append `.q`.** `formatResolvedName` is the
  only place the suffix is spelled.
- **Do not touch `staleTime` on `useClaimRecords`.** It is a documented security
  parameter (the window a transferred-away name keeps verifying under its
  previous owner), not a perf knob.
- **Do not add the field to `quorum-shared`.** The wire field is deliberately
  additive and undeclared.

## 7. Verification bar

**Unit — required, and each must be proven to fail before the fix:**

- A roster row carrying **only** `claimed_primary_username` (no public profile
  at all) renders the `.q`.
- An impostor: same claim, but the resolver's record derives back to a
  *different* address → renders no `.q`. Use the genuine ed448 pair already in
  `__tests__/identityProviderVerification.test.tsx`; leave
  `@/utils/verifyQnsClaim` **unmocked**.
- A deliberate per-space nickname still outranks the `.q` inside that space,
  and a nickname that merely repeats the global name does **not** bury it
  (`resolveIdentity` already demotes the join echo — pin it).
- A fetch-count test proving the bound holds with well over `MAX_QNS_LOOKUPS`
  distinct claimants.

**Device — now possible, and this is the part an earlier pass got wrong:**

Electing a primary name is **not** blocked by upstream #240. The local write is
the source of truth and happens first
(`services/profile/primaryNameChange.ts:78`); only the public-profile publish
fails. The receiver-side plan already recorded this on 2026-08-09 ("Electing a
primary name is NOT blocked by the server bug").

So an account that **owns a real QNS name** can elect it, and the broadcast
carries it to a second account today, with no public profile and no server fix.
That is a genuine end-to-end test. It needs a real registered name — the
fake-QNS tool exists because *test* accounts own none, not because owning one is
impossible.

**The fake-QNS overlay cannot see this bug.** It injects a synthesized *public
profile* (`services/dev/fakeQns.ts` hooks `getPublicProfile`), which is Route A
— the route that already works. It will report green while Route B is broken.
Do not use it as evidence here.

## 8. Adjacent small fix, do it in the same change

`services/profile/primaryNameChange.ts:118-121` tells the user:

> "Your profile is private, so only you can see it. Turn on Public Profile to
> show `name.q` to other people."

That predates the decoupling and is now false — the broadcast carries the name
to their spaces regardless of the toggle, and it points the user at the one
route that is server-broken. Same class as the Public Profile toggle copy the
decoupling design flags in its §1.

## 9. Explicitly out of scope

**Desktop.** Verified 2026-08-16: desktop has no broadcast transport at all. It
sends only `displayName` / `userIcon` / `bio`
(`quorum-desktop/src/hooks/business/spaces/useSpaceProfile.ts:313-323`), and its
receive handler `applyProfileUpdate`
(`quorum-desktop/src/services/MessageService.ts:269`) writes six fields, none of
them a QNS name — so a `primaryUsername` from mobile is silently dropped.
Desktop also does not verify the profile-path claim at all
(`quorum-desktop/src/identity/identityProvider.tsx:108`).

That is tracked in the receiver-side plan §7 and its Definition of Done. Do not
widen this issue to cover it.

---

*Last updated: 2026-08-16*
