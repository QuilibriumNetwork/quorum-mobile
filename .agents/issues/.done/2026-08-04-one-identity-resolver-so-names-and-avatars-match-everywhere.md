---
type: task
title: "Mobile does not use the shared identity resolver, so names and avatars differ between chat, the roster and the profile modal"
status: done
priority: medium
created: 2026-08-04
updated: 2026-08-04
area: identity resolution / profile sync / mobile-desktop parity
repos: quorum-mobile (adoption); quorum-shared already holds the resolver; quorum-desktop is the reference implementation
source: found while device-testing the join/leave work on 2026-08-04 — the Space owner rendered with name and avatar on their messages and as a bare address in the member list, in the same Space, at the same moment
related:
  - "quorum-desktop .agents/docs/features/identity-resolution-and-profile-sync.md (THE canonical model — 617 lines; read §'What the public-profile feature IS (and is not)' and §'The precedence ladder' FIRST)"
  - "quorum-desktop .agents/docs/features/qns-username-display.md (the ladder's source of record, per the doc above)"
  - "issues/.open/2026-06-10-isprofilepublic-not-syncing-mobile-to-desktop.md"
  - "issues/.open/2026-06-10-primary-username-not-synced-or-published.md"
---

# The same member renders differently depending on which screen you are on

> ## ⚠️ This issue was rewritten 2026-08-04. The first version was wrong.
>
> It described a three-tier ladder (`override → global → public profile`),
> proposed building a new pure resolver, and **omitted QNS entirely**. All three
> were wrong. What follows is verified against source. If you are holding a
> summary that says "build a resolver", discard it — one exists.

## 1. The observation

One Space, one moment, one member (the Space owner): **their messages showed
their avatar and display name; the member list showed a bare address.**

Both surfaces read the same member row from the same query. They disagree
because they resolve identity differently, and only one of them does it via the
canonical path.

## 2. The three facts that define this task

**A. The canonical resolver already exists in `quorum-shared`.**
`src/utils/resolveDisplayName.ts`, exported from `src/utils/index.ts`, with its
own test file. Per the desktop doc it is the implementation of the ladder,
consumed through per-app adapters.

**B. It is importable from mobile TODAY — no version bump needed.** Mobile pins
`@quilibrium/quorum-shared@2.1.0-39`. MEASURED: a probe file importing
`resolveDisplayName` from `@quilibrium/quorum-shared` type-checks clean under
mobile's own `tsc` invocation. (Do not conclude otherwise from grepping
`dist/index.d.ts` for the name — that file re-exports, so a flat grep finds
neither `resolveDisplayName` NOR `deriveInboxAddress`, which mobile demonstrably
imports today. That false signal cost time; use a probe file.)

MEASURED 2026-08-04, second confirmation by a different route: the installed
`node_modules/@quilibrium/quorum-shared@2.1.0-39` ships
`dist/utils/resolveDisplayName.d.ts` and re-exports the symbol from
`dist/utils/index.d.ts`, and the function body is present in all three bundles
(`index.js`, `index.mjs`, `index.native.js` — so the React Native entry has it
too, which is the one that actually matters here).

**C. Mobile uses neither it nor any adapter.** Grep for `resolveDisplayName` and
`resolveMemberName` across mobile: **zero hits** (the only match for the wider
pattern is mobile's own `resolveMemberIdentity` in `SpaceSettingsModal.tsx`).

**Desktop's adoption is far broader than "the DM surfaces" — correct that
before planning.** MEASURED: `resolveMemberName` / `resolveSpaceMemberName` are
imported by ~20 desktop files, covering the space roster (`space/Channel.tsx`),
mentions (`MentionDropdown`, `MessageComposer`, `MessageMarkdownRenderer`),
messages (`Message.tsx`), reactions (`ReactionsList`, `ReactionsModal`), threads,
notifications, pinned messages and `user/UserProfile.tsx` — plus DM. Desktop is
therefore a complete reference for every surface §4 lists, not a partial one.

So this is **not** "design and build a resolver". It is **"adopt the one that
exists, and delete mobile's partial reimplementations"**.

## 3. The actual ladder (and why the first draft was wrong)

From the desktop doc, quoted rather than paraphrased:

```
custom per-space name (C override)  →  QNS primary username .q (B)
  →  global display name (C global slot, else B)  →  truncated address
```

Two corrections this forces:

**QNS `.q` usernames are a TIER, and they outrank the global display name.**
The first draft of this issue did not mention QNS at all. Any implementation
that skips it is wrong regardless of how consistent it makes the surfaces.

**The public profile is NOT a tier. It is a SOURCE for one.** The doc is
explicit: the public-profile toggle is the opt-in *be discoverable* feature, so
non-spacemates see your name instead of your address. It does not hold a
different identity from your global one. Inside a space it is consulted only as
a fallback source for the global display name — and it is the only carrier of
the `.q` name.

So `global slot` and `public profile` are **two transports for the same tier**,
which is why mobile's existing hook compares their timestamps rather than
ranking them. Calling them separate tiers (as the first draft did) mis-states
the model.

**Name and avatar do not share a ladder.** Avatar and bio are
`override → global slot → public`, with **no QNS step**. Any resolver call site
must respect that difference.

### 3a. What the shared resolver actually is (READ, `quorum-shared/src/utils/resolveDisplayName.ts`)

```ts
resolveDisplayName(
  member: { address: string; display_name?; name?; primary_username? },
  opts?: { spaceOverrideName?: string | null },
): { name: string; isQnsVerified: boolean }
```

Body order: `spaceOverrideName → primary_username → display_name → name →
truncate(address)`. So the quoted ladder in §3 is confirmed against source.

Two properties of it that constrain everything below:

**It is NAME-ONLY.** There is no shared avatar or bio resolver.
`quorum-shared/src/utils/avatar.ts` holds only `getInitials` /
`getColorFromDisplayName` / colour helpers — no precedence logic, and grep for
`resolveAvatar|resolveProfileImage` across `quorum-shared/src` returns nothing.
So "adopt the shared resolver" cannot by itself satisfy the avatar/bio half of
this task. See `## Blockers`.

**It does not merge the global slot against the public profile.** It reads one
already-resolved `display_name`. The newer-timestamp-wins merge that mobile's
hook performs is *upstream* of it and stays mobile's job. "Delegate precedence to
shared" therefore means delegating only the `override → QNS → display → address`
ordering, not the two-transport merge.

## 4. What mobile has instead, and what to delete

| Where | What it does | Fate |
|---|---|---|
| `hooks/useMembersWithPublicProfileFallback.ts` | Real ladder minus QNS: override → global slot → public, newer-timestamp-wins between the last two. Gates fetches, ref-caches, React-Query-backed. **Good code.** | Keep the fetching/caching shell; replace its inlined precedence with the shared resolver |
| `components/Chat/SpaceChatArea.tsx:245`, `DMChatArea.tsx:173` | The hook's ONLY two consumers | Unchanged behaviour — this is the reference, it must not regress |
| `components/SpaceSettingsModal.tsx` `resolveMemberIdentity` | Added 2026-08-04 (`6dd5ba6`). override → global → **self live profile** → address. Fixes the reported symptom; is a 4th partial ladder; **no QNS** | Delete once the shared path is adopted |
| Roster / profile modal / reaction list / mentions | Raw `member.display_name \|\| member.name` | Route through the adapter |

**One tier mobile invented that the doc's ladder does not have: SELF.** For your
own row, your live in-memory profile is authoritative and free. It is what makes
a Space created *after* your last profile save render its owner correctly with
no network call. **Do not silently drop it when adopting the shared resolver** —
either establish that the shared ladder covers the case, or raise it as a
proposed addition to the shared resolver so both clients gain it.

### 4a. The trap: the hook flattens the slots the adapter needs to see

This is the single most likely way a naive adoption goes wrong, so it is stated
before the plan rather than left to be discovered.

Desktop's `resolveSpaceMemberName` exists because **a roster `display_name`
cannot say whether it is a deliberate per-space name or just the global name
echoed at join.** Desktop disambiguates by comparing it against a *separately
carried* `globalDisplayName` (READ, `quorum-desktop/src/utils/resolveMemberName.ts:66-85`):
differs → deliberate, roster wins; equal → QNS wins; global unknown → keep the
roster name.

Mobile's hook destroys the inputs to that comparison. READ,
`hooks/useMembersWithPublicProfileFallback.ts:158-176`: it collapses
override / global slot / public profile into a single `display_name` on the
merged member (`merged[addr] = { ...local, display_name: nextName, ... }`).
Downstream, `display_name` may be any of the three, and `global_display_name` is
carried through unchanged from `local` but is no longer distinguishable from what
won.

Consequence: **an adapter placed downstream of this hook physically cannot
mirror `resolveSpaceMemberName`** — it would see `roster === global` for a
member whose global name simply won, and hand the row to QNS. Either the hook
stops flattening and returns the slots separately (preferred; it is the same
shape desktop feeds its adapter), or the adapter is called *inside* the hook
where the three values are still distinct. Decide this before writing the
adapter, not after.

## 5. Research to do BEFORE writing code

This is the part that must not be skipped; the first draft of this issue is what
happens otherwise.

1. **Read both desktop docs in full** — `identity-resolution-and-profile-sync.md`
   (617 lines) and `qns-username-display.md`. The first has a MAP section
   ("everything about people show as an address") that likely already names
   several of these symptoms.
2. ~~Read `resolveDisplayName` and its tests~~ — **ANSWERED, see §3a.** It is
   name-only, takes an already-merged `display_name`, and does know about QNS via
   `primary_username`. Still read `resolveDisplayName.test.ts` before writing the
   adapter's table tests, so the two agree case-for-case.
3. ~~Read desktop's adapters~~ — **ANSWERED, see §4a.** Both exist in
   `quorum-desktop/src/utils/resolveMemberName.ts`: `resolveMemberName` (DM /
   global) and `resolveSpaceMemberName` (space). Mirror them, do not invent.
   One desktop-only detail: it demotes the literal `'Unknown User'` via
   `realDisplayNameOrUndefined`. Mobile has **zero** occurrences of that literal,
   so do not copy that step without first finding mobile's equivalent placeholder
   (if any).
4. **QNS on mobile — ANSWERED, and the gap is much smaller than assumed.**
   MEASURED: `services/api/quorumClient.ts:829` already declares
   `getPublicProfile(): Promise<{ …; primary_username?: string; … }>`, so the
   `.q` name **is already arriving over the wire on every public-profile fetch
   mobile makes.** It is discarded at the type boundary:
   `hooks/useUserPublicProfile.ts:13-19` re-declares a narrower `PublicProfile`
   with no `primary_username`, and
   `useMembersWithPublicProfileFallback.ts:158-160` merges only name / icon /
   bio. Note the hook's own comment at line 61 claims the fetch happens "for the
   QNS `.q` name it uniquely carries" — **that comment is currently false**, and
   fixing it is part of this work.
   So this is a field widening plus a merge line, **not** a separate prerequisite
   piece of work. What still needs checking: whether `primary_username` is
   populated server-side for the accounts under test, and whether it reaches the
   in-space member row at all or only ever via the public profile (desktop's
   identity-coverage module states the latter — see §6).
5. **Answer the parity question explicitly:** after this, do desktop and mobile
   render the same name and avatar for the same member on every comparable
   surface? Where they cannot, say why. Divergence here is exactly the class of
   bug where one client shows a name and the other an address for the same
   person.
6. ~~Check whether desktop needs the same adoption sweep~~ — **MOSTLY ANSWERED,
   see §2.** Desktop routes space, mention, reaction, thread, notification and
   profile surfaces through the adapters, not just DM. Remaining check is narrow:
   confirm the desktop *space settings / member management* surface does too,
   since that is the exact screen this issue was found on.

## 6. How we verify

| Lane | What |
|---|---|
| **L1** | The mobile adapter is table-tested against the same cases as shared's `resolveDisplayName` tests, plus: QNS beats global, override beats QNS, avatar ladder has no QNS step, empty string means "unset" and falls through |
| **L2** | The Space owner shows the same name and avatar in a message, the roster, the profile modal and a mention. Edit the global profile; all four change together. Set a per-space override; only that Space changes |
| **L2 (parity)** | The same member, same Space, side by side on desktop and mobile: identical name and avatar |
| **L3** | No public-profile request storm when opening settings on a Space with many members — the roster is a LIST, unlike the chat sender set. Measure request counts, do not assume |

**The control that makes L2 meaningful:** include a member who resolves from a
per-space override. If everything converges for the owner but the override stops
winning, the precedence got inverted.

### 6a. Do not hand-build the instrument — desktop already has one

`quorum-desktop/src/dev/identity-coverage/` (`identityCoverageCore.ts` pure core,
`identityCoverageDb.ts` storage reads, `IdentityCoverage.tsx` page) exists
precisely to answer this issue's question with a number: it counts the members
who **land on the last rung of the ladder** (truncated address) rather than
inspecting one slot, and it deliberately keeps the local pessimistic count
separate from "a render-time public-profile fetch could still save this". Its
header docs also record the correction that makes it trustworthy: reading only
the per-space override slot — as the older `dm-debug` probes did — over-counts,
because follow-global leaves that slot empty on purpose.

Port the pure core to mobile (it has no DOM, no IndexedDB, no network, no clock
by design) and read the number before and after. That is a stronger L2/L3 than
counting screens by eye, it is repeatable, and it is the same figure desktop
reports — which is what makes the parity lane comparable rather than anecdotal.

Its header also states, as READ: QNS `primary_username` "is not a field of a
stored member row, it arrives with the public profile". Cross-check that against
mobile before designing the QNS path (§5.4).

## 7. Definition of done

- [x] Mobile consumes shared `resolveDisplayName` through an adapter mirroring desktop's `resolveMemberName` **and** `resolveSpaceMemberName`
- [x] The adapter receives the per-space, global and public values as **separate** inputs — not the hook's flattened `display_name` (§4a)
- [ ] `useMembersWithPublicProfileFallback` keeps its fetch/cache shell and its newer-timestamp-wins merge (shared does NOT do that merge, §3a), delegates only the ladder ordering, and chat behaviour is unchanged
- [x] `resolveMemberIdentity` in `SpaceSettingsModal` is deleted, not left alongside
- [ ] `PublicProfile` in `hooks/useUserPublicProfile.ts` carries `primary_username`, the merge propagates it, and the stale comment at `useMembersWithPublicProfileFallback.ts:61` is made true
- [ ] QNS `.q` names resolve for **other members** on mobile, not only for self
- [x] The SELF tier is either covered, adopted into shared, or explicitly dropped with a reason
- [x] Avatar/bio use the no-QNS ladder; name uses the QNS ladder — with the avatar resolver's home decided (see `## Blockers`)
- [x] Every surface in §4 uses the adapter or is recorded as not needing it
- [ ] Identity-coverage number ported from desktop and recorded before/after (§6a)
- [ ] Desktop/mobile parity checked on a real pair of clients (§6 L2 parity)
- [ ] Request count measured on a large Space, not assumed

## Status

Shipped as PR #225 (`7acfff6`), squash-merged to master 2026-08-04.

**What landed.** One adapter, `utils/resolveMemberName.ts`, over shared's
`resolveDisplayName`, consumed by nine surfaces: the space member list (its
local `resolveMemberIdentity` deleted), the blocked-users list, reaction
details, mention pills, mention autocomplete, the markdown mention renderer,
the profile-modal handoff from both mentions and reactions, message sender
names, and reply-preview authors. Avatars got their own no-QNS ladder, since
shared has a rule for names only.

Two defects surfaced on the way and were fixed in the same PR: a hand-typed
`@name` produced a pill that was styled, tappable and notified nobody; and
sending did not dismiss the mention menu.

**Verified:** 350 tests pass, 30 new for the ladder, and those were confirmed
capable of failing — removing the global-slot tier turns exactly 5 red.
Typecheck and lint unchanged from baseline. Two independent review passes
before merge, every finding fixed in the branch.

**Deliberately NOT done**, tracked in
`.open/2026-08-04-qns-names-and-the-identity-coverage-instrument.md`:

- QNS `.q` names for other members. The adapter handles the tier; nothing
  plumbs `primary_username` onto a member row yet.
- `useMembersWithPublicProfileFallback` was not touched at all. That is *why*
  the shipped change is safe (chat's path is untouched), but the hook still
  holds its own inlined precedence.
- The identity-coverage instrument (§6a) was not ported.

The last two boxes — real-client parity and the request-count measurement — are
unmeasurable at current scale: there are no real multi-user spaces to measure,
the app is in beta. Recorded here so nobody re-opens this expecting numbers
that cannot exist yet. The §6 L3 fetch-storm concern was also resolved by
avoiding the question entirely: no new network requests were added, matching
what desktop does.

## Blockers

- 🛑 **There is no shared avatar/bio resolver, so this task cannot be "adopt the
  shared one" for half its scope.** `quorum-shared` exposes name precedence only
  (§3a). Two ways forward, and it is the owner's call, not the implementer's:
  - **Add `resolveAvatar` (or a combined `resolveIdentity`) to `quorum-shared`**
    and adopt it on both clients. Correct by the parity goal, but it is a
    `quorum-shared` change plus a version bump plus a desktop migration — real
    scope beyond this issue's title.
  - **Implement the avatar ladder inside the mobile adapter only** for now, and
    file the shared promotion separately. Unblocks mobile immediately, but
    knowingly creates the second implementation this issue exists to remove.
- 🛑 **§4a forces a change to `useMembersWithPublicProfileFallback`'s return
  shape** (stop flattening, or call the adapter inside the hook). Either way its
  two chat consumers are touched, and §4 marks that path "must not regress". Not
  a blocker to starting, but it is larger than "keep the shell, swap the
  precedence" implies — confirm the appetite before the adapter is written.

*Last updated: 2026-08-04*

## Review Log
**2026-08-04 - claude-opus-5**: Verified every factual claim against quorum-shared, quorum-desktop and mobile source. Core premise holds (the resolver exists, is importable, mobile does not use it); five material gaps corrected.
- CONFIRMED: resolveDisplayName ships in the installed 2.1.0-39 dist including index.native.js; ladder quote matches source exactly; SpaceChatArea.tsx:245, DMChatArea.tsx:173 and commit 6dd5ba6 are all accurate; zero adapter hits in mobile.
- CORRECTED: desktop adoption is ~20 files across space/mentions/reactions/threads/notifications/profile, not 'the DM surfaces' - research item 6 was largely already answered.
- ADDED 3a: shared resolveDisplayName is NAME-ONLY (no avatar/bio resolver exists in shared) and does not do the global-vs-public timestamp merge - so 'delegate precedence' was overstated in the DoD.
- ADDED 4a: the hook flattens override/global/public into one display_name at line 158, which destroys the exact inputs desktop's resolveSpaceMemberName compares - an adapter downstream of the hook cannot mirror desktop. Most likely failure mode, now stated up front.
- ANSWERED research item 4: QNS already arrives on mobile - quorumClient.ts:829 returns primary_username, but useUserPublicProfile.ts:13 re-declares a narrower type that drops it. Not a prerequisite piece of work, a field widening. Also flagged the hook's line-61 comment as currently false.
- ADDED 6a: desktop already has an identity-coverage instrument (src/dev/identity-coverage/) producing a single before/after number for this exact ladder - port it rather than eyeballing screens.
- FLAGGED in Blockers (owner's call, not resolved): where the avatar resolver lives (shared + version bump + desktop migration, vs mobile-only and a second implementation), and that the hook's return shape must change, touching the two chat consumers §4 says must not regress.
