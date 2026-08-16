---
type: bug
title: "Broadcast .q claims never reach the identity ladder, so the only working .q transport renders nothing"
status: in-progress
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

## Status

**2026-08-16 — shipped in PR #249** (`feat: names resolve through one verified
ladder, so a .q shows wherever a name does`).

**Deliberately NOT moved to `.done/`.** The fix is unit-verified by 11 tests in
`__tests__/identityProviderRosterClaims.test.tsx` — covering the reported
symptom (a `.q` from a roster claim with no public profile at all), the
impersonation refusal, the empty-claim un-election, the in-flight case, and the
DM path — and the whole suite is green at 986/986. But this defect was FOUND on
a device, and the transport it restores is the only one that works end to end,
so a unit-green result is not the observation that closes it.

**To close this file:** run a fake-QNS sweep on a device where another account
has used "Announce for real", and confirm that account's `.q` renders in a space
channel and in a DM. If it does, move this to `.done/` and tick the box below.
If it does not, the fix is incomplete and this file is where that belongs.

- [ ] Device-confirmed: a broadcast `.q` renders in a space channel and in a DM

**2026-08-16 — implemented, unit-verified.** The fix is the one planned in §4,
with no deviation.

| Change | Where |
|---|---|
| Claim added to the roster shape | `identity/identityFromMaps.ts` — `RosterNameRow.claimed_primary_username` |
| Populated from the stored row | `hooks/useMultiSpaceRosters.ts` — copied verbatim, empty string included |
| Precedence rule reused, not re-derived | `hooks/useVerifiedQnsNames.ts` — `claimIn` exported |
| Both broadcast sources joined to profile claims | `identity/identityProvider.tsx` — `broadcastClaimsFor` + `claimRows`, one checkpoint |
| **DM claims reach the ladder** | `identity/identityProvider.tsx` `conversationClaimsFrom` + `conversationClaims` prop, wired in `identity/RootIdentityScope.tsx` |
| Misleading copy corrected (§8) | `services/profile/primaryNameChange.ts` |

### §4 was incomplete: it only covered spaces

Found by an independent review pass, then confirmed against source. §4's numbered
steps talk only about `RosterNameRow` and `useMultiSpaceRosters`, but §1 defines
Route B as reaching "every space they are in **(and to DM partners)**", and the
two halves land in **different rows**:

- a space claim → the space member row, read by `useMultiSpaceRosters`
- a DM claim → the **conversation row** (`context/WebSocketContext.tsx:768-771`,
  `storage.saveConversation`), which no roster hook ever sees

A DM also resolves with **no `spaceId`**, so `identityFromMaps` consults no
roster row at all for one. Implementing §4 literally would therefore have left
every DM-only partner without a `.q` — and a DM between two people who share no
space is precisely the case the public-profile route can never serve, since the
server refuses every publish carrying the field. Fixed here rather than filed
separately, because "the broadcast renders" is the whole point of the issue and
half of it does not count.

`conversationClaims` is a PROP, not part of `IdentitySources`: sources must have
nowhere to hold an unverified claim, which is what stops a downstream consumer
rendering one. The cost is that a nested scope cannot inherit DM claims the way
it inherits rosters. Acceptable today (the root scope is the only provider
mounted, and it is the one holding the conversations), and noted in the prop's
docstring so it is not rediscovered as a bug.

Two further design points worth knowing before touching this again:

- **`broadcastClaimsFor` is bounded by the REQUESTED set**, not by the roster or
  the inbox. It adds names to a batch already capped at one request by
  `claimedNamesIn`; it never adds a per-address fetch. Pinned by two fetch-count
  tests asserting a number, each with 200 unrequested claimants alongside.
  **Consequence worth knowing:** a surface that does not `enrich` gets no `.q`,
  because nothing put its addresses in the requested set. That is §4.3's
  demand-driven bound working as specified, not a defect — but it does mean
  adding a `.q` to a new surface means opting that surface in.
- **Roster claims are read off the MERGED rosters**, so `parent` is now read at
  the top of the provider rather than half-way down. A nested scope must be able
  to verify a claim carried by a row its parent loaded, because `requested` is
  per-provider state.

**Verified:**

- 12 tests in `__tests__/identityProviderRosterClaims.test.tsx` (8 space, 4 DM),
  every one proven red before its half of the fix and green after. The one test
  that was already green throughout is the Route A guard, which had to stay that
  way.
- 2 tests added to `__tests__/rootIdentityScopeWiring.test.tsx` pinning that
  something actually HANDS the provider a DM claim. Proven red by removing just
  the `conversationClaims` prop from `RootIdentityScope`. Without these the DM
  gap would have been invisible in exactly the way the space gap was: the claim
  arrives, is stored, is verifiable, and nothing reads it.
- `__tests__/primaryNameChange.test.ts` — one test's assertions inverted, because
  they encoded the now-false belief that a private profile hides a `.q`.
- All four impersonation/in-flight tests proven to go RED when
  `claimedNameBelongsTo` is stubbed to `true` in the provider, and green with it
  restored. A security test that cannot fail is worse than none.
- Full suite 966/967 (three consecutive runs, identical), `npx tsc --noEmit`
  clean on every touched file, lint clean (warnings only, all pre-existing
  patterns).

> **A flake was found and fixed, and the shape is worth remembering.** The DM
> impostor test anchored its `waitFor` on `mockResolveBatch` having been called.
> A DM has no roster, so the impostor's fallback name arrives with the FETCHED
> profile, while the claim comes from `conversationClaims`, which is present on
> the very first render. The batch therefore fires before the profile lands, and
> the assertion ran against a truncated address about 40% of the time. The `.q`
> half was true either way, which is exactly what made it read as green. It now
> waits for the name to SETTLE and then asserts the absence. Confirmed stable
> over 8 consecutive runs.
>
> Generalising: in this provider, roster/conversation claims are synchronous and
> profiles are not, so any assertion that mixes the two needs an anchor on the
> slower one.

> The single failure is `rawNameFieldAudit` flagging
> `components/dev/QnsExplainPanel.tsx`, a file added by concurrent work in
> commits `38dd909` / `700a9fa` and not touched here. It reads raw name fields
> and has not been added to that audit's exception list. Not this change's, but
> it is red on the branch and someone has to own it.

> The un-election test initially passed for the WRONG reason — before the
> profile promise settles there is no claim to look up, so "no `.q`" is
> momentarily true even in an implementation that ignores the roster entirely.
> It now renders the `.q` FIRST and asserts the clear afterwards. Worth
> remembering: in this provider almost any single-render "no name" assertion can
> pass by racing.

### Device attempt 2026-08-16 — BLOCKED, and the blocker is not this code

Attempted with an account that genuinely owns a registered, resolvable name as
sender, and a dev-build test account as receiver. Result: the `Why no .q?` panel
reported **`NO-CLAIM`** with `profile fetched: yes`, i.e. nothing ever arrived to
verify.

**Cause: the sending device runs a build that predates the transport.** Its QNS
list renders a static "★ Primary" badge where both `master` and this branch
render a **"Remove as Primary" button**. That badge is the pre-`950545e` (#238,
2026-08-06) UI, so the build necessarily predates `e93cd26` (#245, 2026-08-09),
which is what added `primaryUsername` to the wire. That build has nothing to
send, so no amount of re-electing or reconnecting would have produced a claim.

**Worth recording before anyone re-derives it:**

- `GET names.quilibrium.com/resolve/<name>` for the sender's name returns a
  `resolveKey`, and `deriveAddress` on it yields **exactly** that account's own
  address. MEASURED 2026-08-16 against live infrastructure. So the ownership
  check will pass the moment a claim arrives; nothing on the name side needs
  fixing.
- The RECEIVING test account appeared to have a `.q` of its own, and it was
  **not a real name** — the resolver answered `NAME_NOT_FOUND` for it. It was the
  fake-QNS overlay still running with "give everyone a name" already switched
  off. The overlay must be disabled ENTIRELY, not partially, or readings stay
  polluted. It also means that account can never be a sender for a positive test.
- A spare name cannot be pointed at a harness bot: `submitResolveKeyUpdate`
  (`components/qns/NameDetailModal.tsx:177-215`) always sets the resolve key to
  `user.publicKey`. There is no UI route to a third-party resolve key.

**Still open, and this is why the issue is not closed:**

- **The ACCEPT branch over real infrastructure.** Narrower than it was. The
  existing `qns-claim-two-bot` harness already proves, over the production relay,
  that a claim survives the wire into the peer's conversation row and that a
  FORGED claim is refused. The ownership maths is confirmed against live resolver
  data (above). What remains unproven is only that a genuinely owned name makes
  the whole round trip and renders — the one path that needs a sender with #245
  AND a name resolving to it.
- **What would close it:** a sender running #245 or later as the name's owner.
  Either update the sending device to a post-2026-08-09 build, or run a harness
  bot on that account key (`loadOrCreateIdentity` already accepts an
  env-supplied `privateKeyHex`, and deliberately never persists it). The second
  costs one extra device registration on that account, permanently.
- **Desktop** (§9), unchanged and still out of scope here.

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
| The ladder's only `.q` source | `identity/identityProvider.tsx:153-186` — `claimedNames` (`:153`) and `verifiedQnsNames` (`:160`) are both built from fetched **profiles only** |
| The shape the provider reads a roster row through | `identity/identityFromMaps.ts:27-33` — `RosterNameRow` has **no claim field** |
| What actually loads roster rows | `hooks/useMultiSpaceRosters.ts:38-41` — copies only `display_name` / `global_display_name` |
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

   ⚠️ **`claimedNameBelongsTo` is only half of what you have to reuse.** It
   answers "does this name belong to this address"; it says nothing about
   *which* of the two claims to test when an address has both a roster claim and
   a profile claim. That precedence rule lives in `claimIn`
   (`hooks/useVerifiedQnsNames.ts:169-173`), and it is deliberately **presence,
   not truthiness** — an empty broadcast claim is an un-election and MUST beat a
   stale profile claim. `claimIn` is module-private today, so **export it and
   call it**; do not re-derive the rule. Writing the obvious
   `rosterClaim ?? profileClaim` (or any truthiness test) compiles, passes a
   naive test, and silently reintroduces risk 4 below — an un-elected name that
   never clears.
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
- **The other tiers already do exactly this.** `globalName` already merges
  three sources (roster global slot → public profile → locally-known name) —
  `identity/identityFromMaps.ts:145-148`. QNS having two transports is the same
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
  and a nickname that merely repeats the global name does **not** bury it.
  `resolveIdentity` already demotes the join echo — the `space !== global` guard
  at `quorum-shared/src/utils/resolveDisplayName.ts:113-118`. Pin it here; do
  not re-implement it mobile-side.
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

**Fix the code comment directly above it too** (`:118-120`), which asserts the
same false thing: *"A private profile is where the `.q` stops: the published
profile is the only thing that carries one to anyone else."* Leave it in place
and the next reader treats the corrected string as the bug and reverts it.

## 9. Explicitly out of scope

**Desktop.** Verified 2026-08-16: desktop has no broadcast transport at all. It
sends only `displayName` / `userIcon` / `bio`
(`quorum-desktop/src/hooks/business/spaces/useSpaceProfile.ts:313-323`), and its
receive handler `applyProfileUpdate`
(`quorum-desktop/src/services/MessageService.ts:269`) writes six fields, none of
them a QNS name — so a `primaryUsername` from mobile is silently dropped.

Desktop also **renders an unverified claim**, which is worse than the wording
"does not verify" suggests: `qnsName: nn(profile?.primary_username)`
(`quorum-desktop/src/identity/identityProvider.tsx:108`, re-verified on `main`
2026-08-16) pipes a fetched profile field straight into the `.q` tier with no
resolver check anywhere in the path. That is exactly the impersonation vector
the decoupling design describes in its §6c-3 — a transferred-away name keeps
rendering for its old owner — live on desktop today, independent of anything
this issue changes.

Both are tracked in the receiver-side plan §7 and its Definition of Done. Do not
widen this issue to cover them; do not file the desktop verification gap as
cosmetic parity either.

---

*Last updated: 2026-08-16*

## Review Log
**2026-08-16 - claude-opus-5**: First review pass. Verified every file:line anchor in the issue against the code on feat/resolve-identity (mobile) and main (desktop); the diagnosis and the fix direction both hold. Found one real gap in the fix plan and three stale/understated references, all corrected in place. Issue stays open — it is not fixed, only better specified.
- CONFIRMED the regression: identity/identityProvider.tsx:153-186 builds claimedNames and verifiedQnsNames from fetched profiles ONLY; RosterNameRow (identityFromMaps.ts:27-33) has no claim field and useMultiSpaceRosters.ts:38-41 copies only display_name/global_display_name. The broadcast claim IS still stored (WebSocketContext.tsx:769, 2791, 4709) and the verification machinery IS intact (useVerifiedQnsNames.ts claimIn :169, settleClaim :273, useClaimRecords :370) — the ladder simply has no input for it. rawNameFieldAudit TO_MIGRATE is empty at :174, so the old promotion path is genuinely inert as claimed.
- GAP IN THE FIX PLAN, added to section 4 step 2: the plan said to reuse claimedNameBelongsTo, but that is only the OWNERSHIP check. The precedence rule — broadcast claim wins whenever PRESENT including empty, which is what makes un-election work — lives in claimIn (useVerifiedQnsNames.ts:169-173), which is module-private. An implementer following the plan literally would write 'rosterClaim ?? profileClaim', which compiles, passes a naive test, and silently reintroduces risk 5.4 (a cleared name that never clears). Plan now says: export claimIn and call it, do not re-derive.
- Corrected stale reference in section 4: the globalName multi-transport precedent was cited as identityFromMaps.ts:108-111 (that range is inside a docstring); the actual merge is :145-148 and it is three sources, not two.
- Section 7 verification bar said 'resolveIdentity already demotes the join echo — pin it' without saying where. Located and cited it: the space !== global guard at quorum-shared/src/utils/resolveDisplayName.ts:113-118.
- Section 8 was incomplete: it flagged the false user-facing string at primaryNameChange.ts:118-121 but not the code comment immediately above it (:118-120) asserting the same falsehood ('a private profile is where the .q stops'). Left in place, the next reader reverts the corrected copy to match the comment. Now called out.
- Section 9 understated desktop. Re-verified on quorum-desktop main: identityProvider.tsx:108 does 'qnsName: nn(profile?.primary_username)' — it does not merely fail to verify, it pipes an unverified fetched claim straight into the .q tier. That is the impersonation vector the decoupling design describes in its 6c-3, live on desktop today. Reworded so it is not filed as cosmetic parity. Desktop send/receive claims also re-verified exact: useSpaceProfile.ts:313-323 sends only displayName/userIcon/bio, MessageService.ts:269 applyProfileUpdate writes six fields, none QNS.
- Frontmatter and folder agree (type: bug, status: open, in .open/) — no change needed.

**2026-08-16 - claude-opus-5**: Implementation pass (not a review). Implemented the fix per section 4, plus a gap in section 4 itself that an independent review caught. Issue stays in-progress: the device leg of section 7 is the only thing left, and nothing automated substitutes for it.
- IMPLEMENTED as planned: claimed_primary_username added to RosterNameRow; populated in useMultiSpaceRosters; claimIn exported from useVerifiedQnsNames and reused rather than re-derived; broadcastClaimsFor + claimRows in identityProvider joining both transports into the ONE existing verification checkpoint; bounded by the demand-driven requested set, no new per-address fetch.
- SECTION 4 WAS INCOMPLETE and this is the important finding. Its numbered steps cover only rosters, but section 1 defines Route B as reaching spaces AND DM partners, and the two land in different rows: a space claim on the member row, a DM claim on the CONVERSATION row (WebSocketContext.tsx:768-771 -> storage.saveConversation). A DM also resolves with no spaceId, so identityFromMaps consults no roster at all. Implementing section 4 literally would have shipped with every DM-only partner still missing their .q — the exact case the public-profile route can never serve. Added conversationClaimsFrom + a conversationClaims prop, wired in RootIdentityScope. Kept as a PROP, not in IdentitySources, so sources still have nowhere to hold an unverified claim.
- Also did the section 8 adjacent fix: the elect-primary message claimed a private profile hides the .q, which stopped being true at the decoupling. Its paired test in primaryNameChange.test.ts asserted /private/i and had to be inverted — the test encoded the false belief too.
- VERIFICATION. 12 tests in identityProviderRosterClaims.test.tsx (8 space, 4 DM) plus 2 in rootIdentityScopeWiring.test.tsx, each proven red before its half of the fix. The wiring tests matter independently: the provider tests prove it verifies a DM claim once handed one, and nothing there proves anything HANDS it one — which is precisely how the space half shipped broken. All four impersonation/in-flight tests proven to go red when claimedNameBelongsTo is stubbed to true.
- FOUND AND FIXED A FLAKE IN MY OWN TEST. The DM impostor test anchored waitFor on the resolver batch being called; a DM has no roster so the fallback name arrives with the fetched profile, while the claim is present on first render, so the batch fires first and the assertion hit a truncated address ~40% of runs. The .q half was true either way, which is what made it look green. Re-anchored on the settled name; stable over 8 runs.
- Full suite 966/967 across three identical runs, tsc clean on every touched file, lint clean. The one failure is rawNameFieldAudit flagging components/dev/QnsExplainPanel.tsx, added by CONCURRENT work in commits 38dd909 and 700a9fa and not touched here — it reads raw name fields and is not in that audit's exception list. Red on the branch, but not this change's, and someone has to own it.
- Note for whoever picks this up: concurrent commits 38dd909 and 700a9fa swept part of this work into them alongside an unrelated dev-panel feature. The working tree is complete and coherent; the history is mixed.
