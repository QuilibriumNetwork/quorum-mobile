---
type: task
title: "Survey: what mobile's identity migration needs that the desktop plan does not know about"
status: open
priority: high
created: 2026-08-11
updated: 2026-08-11
area: identity resolution / QNS / cross-client architecture
repos: quorum-mobile (this), quorum-desktop (the plan), quorum-shared (the rule)
source: read-only survey run before writing the mobile plan, while desktop's Phase D/E was still finishing
related:
  - "quorum-desktop/.agents/issues/.open/2026-08-10-identity-resolution-architecture-design.md (THE DESIGN)"
  - "quorum-desktop/.agents/issues/.open/2026-08-10-identity-resolution-architecture-plan.md (Phase F Task 9 is the mobile part)"
  - "quorum-desktop/.superpowers/sdd/2026-08-10-identity-resolution-architecture-plan/progress.md (the live deviation ledger)"
  - "issues/2026-08-06-qns-primary-name-work-and-desktop-parity.md (the parity index)"
  - "issues/.open/2026-08-10-invite-contact-picker-renders-an-unresolved-name.md (an instance of finding 3)"
---

# Mobile identity migration: survey

**This is not a plan.** It is the input to one. It records what mobile's
codebase actually contains, what desktop learned while implementing, and the
places where the plan's Phase F ("port Phases B-E against mobile's 17 call
sites") is wrong or incomplete about mobile.

Claims are labelled **MEASURED** (a recorded observation), **READ** (read in
source, with a pointer) or **INFERRED** (reasoned to). That labelling is a
standing rule on this subsystem, adopted after six confident readings were
falsified in one day.

## Status

Survey complete. Nothing has been implemented. One uncommitted change exists on
branch `feat/resolve-identity`: `package.json` + `yarn.lock` moved to
`@quilibrium/quorum-shared@2.1.0-42`. It is deliberately not committed, because
the bump alone does not compile (see §1).

---

## 1. The shared side is settled and safe to build on

**MEASURED.** `2.1.0-42` on npm contains `resolveIdentity` and no longer exports
`resolveDisplayName`:

- shared's `feat/resolve-identity` merged to master as `2efd307` at
  2026-08-10T20:54:08Z
- npm published `2.1.0-42` at 2026-08-10T21:02:57Z, eight minutes later
- the published tarball's `src/utils/resolveDisplayName.ts` matches shared
  master's, and `dist/index.js` exports `resolveIdentity` only

So mobile pinning `-42` gets exactly the rule desktop shipped. There is no
window where the two clients resolve names differently.

**MEASURED.** Bumping to `-42` without touching code breaks the build.
`npx tsc --noEmit` fails at `utils/resolveMemberName.ts:226`
(`has no exported member named 'resolveDisplayName'`), and at runtime that call
site would throw on every member-name render. Mobile has exactly ONE file that
imports shared's resolver, which is what the plan predicted.

This is why the plan requires the bump and the resolver fix in one PR. That part
of the plan is correct and should be kept.

---

## 2. What desktop learned that mobile inherits

Distilled from the SDD ledger. These are not in the plan document; several
contradict it.

### 2.1 Fetching is opt-in, and the member list does NOT fetch

The plan's Task 5 allowed one public-profile fetch per distinct rendered member.
It was measured (200 addresses across 220 rows = 200 concurrent fetches) and the
operator then ruled against it. Final desktop behaviour:

- `<MemberName>` / `useResolvedName` resolve from in-memory maps by default and
  issue **no** request
- an explicit `enrich` prop opts in, used only where the `.q` matters and
  cardinality is bounded (bookmarks, notifications, message headers, DM headers,
  profile card)
- sidebar lurkers show no `.q`. Accepted limitation, design decision 3.

**Mobile already implements this, better.** `hooks/useMembersWithCachedQns.ts`
subscribes to the React Query cache with `enabled: false`, so it is zero-fetch
AND reactive (a `.q` appears if chat fetches that profile while the screen is
open). READ, with the rationale written in its docstring. Mobile should keep
that mechanism rather than port desktop's prop.

### 2.2 Missing providers are crash-class, and the fix is ONE root scope

`useIdentityContext` throws when used outside a provider. Desktop hit this at
DirectMessage, ThreadPanel, ReactionsModal, SpaceSettingsModal/Account and the
DM sidebar, then shipped a real crash to the operator (pinning a post threw)
because the app-level modal host sat outside every provider. Resolution: mount
one scope above the Router.

**LESSON recorded in the ledger:** the plan's 24-row table did not include the
app shell at all. Any mobile call-site list derived from a table rather than from
grep will have the same hole.

### 2.3 `useMemberIdentity` is an unguarded raw-tier API

It returns the raw tiers and bypasses `resolveIdentity`, so any caller rendering
its fields directly skips the forged-`.q` guard. Desktop found this the hard way
at `Account.tsx`, where a controller premise ("resolveIdentity already applies
presentUnreserved, so this is safe") was **FALSE**. Mobile should either not
export a raw-tier hook, or make the guard intrinsic.

### 2.4 Constraint 5 was violated and sent back: DM names must survive with no profile

In a DM there is no roster row, so desktop's `identityFromMaps` took `globalName`
only from the fetched public profile. A partner who never published one rendered
as a truncated address, even though the app knew their name locally. Fix: a
`locallyKnownNames` map in `IdentitySources`, used as the LAST `globalName`
source. Mobile has the identical exposure and a lot of local DM naming (see §3.4).

### 2.5 Narrowing a click payload to an address drops bio and avatar

Desktop's mention-pill payload narrowing regressed the profile card's bio and
avatar, found only after the fact. The identity module owns the NAME, not the
avatar image or the bio.

### 2.6 The ratchet must restrict the PRIMITIVES, not the old modules

Desktop's first rule listed the modules being deleted, so after Phase E it was a
tombstone that could never fire. Rewritten to restrict `resolveIdentity` (from
shared) and `identityFromMaps` (from the provider) to the identity module only.
Also: eslint `no-restricted-imports` does not see dynamic `await import()`, a
hole desktop flagged and left open.

### 2.7 The loop was lightened mid-run, by the operator

Per-row reviewers were dropped for mechanical rows (targeted test + tsc per step,
full suite + lint once per batch); reviewers were retained for judgement rows and
the final whole-branch review. **Tests were kept throughout** on the stated
grounds that they are the operator's only readable evidence.

---

## 3. What the plan does not know about mobile

These are the findings that make Phase F more than a port.

### 3.1 Mobile has a security layer between the profile cache and the resolver

**READ.** `hooks/useVerifiedQnsNames.ts`. A `primary_username` arriving from a
public profile or a broadcast is a **claim, not a fact**. Mobile strips every
claim that does not resolve back to the claiming address, upstream of the
resolver, by editing the rows. Its docstring states the design intent plainly:
an unverified or in-flight claim simply is not in the row, so no surface needs a
"render optimistically" branch.

Two properties that a naive port would destroy:

- **A broadcast claim lives under a different key** (`claimed_primary_username`)
  from the one the resolver reads (`primary_username`), specifically so that a
  surface which skips verification renders no `.q` rather than an unverified one.
  Fail-closed by construction.
- **Not-yet-known counts as unproven.** A lookup in flight strips the claim,
  because a `.q` shown for even an instant is the whole attack.

Desktop's design has no equivalent layer, and desktop's `identityFromMaps` reads
`primary_username` straight from the public-profile cache. **INFERRED, and the
single most important finding here: porting `identityFromMaps` as written would
route mobile's QNS tier around its own verification and render unverified `.q`
names.** Mobile's provider must take verified rows as its input, not the raw
profile cache.

This needs an explicit RED test in the plan: a provider fed an unverified claim
must not produce `isQnsVerified`.

### 3.2 Mobile resolves names OUTSIDE React, on the WebSocket receive path

**READ.** `context/WebSocketContext.tsx:2958`, `:4825` call
`messageSenderName(...)`, and `:2975`, `:4841` call `logMentionOrReply(...)`,
which itself calls `resolveMemberName` at
`services/notifications/logMentionOrReply.ts:109` and `:219`. These run inside
async message handlers, not inside a render.

Desktop's entire Layer 3 is hooks (`useResolvedName`, `<MemberName>`). **You
cannot call a hook from a WebSocket handler.** Desktop met a lighter version of
this with imperative mention-pill DOM and answered it with `useNameResolver`,
which is still a hook used inside React.

**Consequence for the mobile plan:** mobile's Layer 3 needs two faces, and the
imperative one is not an escape hatch, it is a first-class API:

1. hooks/components for render surfaces
2. a **pure** `(address, spaceId?, sources) -> ResolvedName` for the receive
   path and for pure transforms like `toDisplayMessage`
   (`components/Chat/types.ts:399`, `:524`)

The ratchet then has to permit the pure API in those files while still barring
everything else, which is a different rule shape from desktop's.

### 3.3 Mobile cannot write component render tests today

**MEASURED**, from `jest.config.js` and `package.json`:

- `testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts']` — `.tsx` is **not
  matched**, so a component test would not even run
- `@testing-library/react-native` is **not installed**
- `react-test-renderer@19.1.0` **is** present
- **zero** files under `__tests__/` render a component

This is the largest methodological gap. Desktop's whole migration ran on
per-surface RED render tests: write a failing render assertion, migrate, watch it
go green. Mobile has no such instrument.

What mobile has instead is `__tests__/joinedMemberRendersEverywhere.test.ts` — a
genuinely good **function-level** sweep that feeds a real join row through every
name-producing function. READ, and worth preserving.

**But function-level tests cannot catch the defect this whole project is about.**
Proof, not assertion: `issues/.open/2026-08-10-invite-contact-picker-renders-an-unresolved-name.md`
records `components/ShareInviteSheet.tsx:173` rendering
`conv.displayName || truncateAddress(conv.address)` — a surface that never calls
the resolver at all. Every function-level test was green while that shipped.
Desktop hit the identical bug and its render tests caught it (ledger, rows 19-21).

**Recommendation for the plan:** add `@testing-library/react-native` and extend
`testMatch` to `.tsx` as the FIRST task, before any migration. It is the
instrument this work is verified with, and per the operator's standing rule the
instrument is usually worth more than the fix.

### 3.4 Three stores freeze a resolved name at write time

**READ.** Mobile does not just render names, it persists them:

| store | field | render site |
|---|---|---|
| `services/notifications/mentionReplyLog.ts:62` | `senderName?: string` | notification rows |
| bookmarks (`cachedPreview`) | `senderName` | `components/Chat/BookmarksPanel.tsx:111`, rendered as `?? 'Unknown'` |
| `hooks/chat/useSpaceActivity.ts:19`, `hooks/useUnifiedNotifications.ts:116` | `senderName`, `lastMessageSenderName` | activity + unified notifications |

These are the same two known-broken surfaces desktop had (bookmarks,
notifications) plus a third mobile-only one. Desktop's answer was to delete the
frozen path and resolve at render from `(address, spaceId)`. On mobile that is a
**read-path change against persisted data**, not only a render change, so
migrated code must tolerate rows written by older builds. The plan does not
mention this.

`BookmarksPanel.tsx:111`'s `?? 'Unknown'` is also a caller-supplied fallback,
which design constraint 4 forbids outright.

### 3.5 Farcaster is a SECOND identity namespace and is out of scope

**READ.** `components/AudioSpaceOverlay.tsx`, `BoundChannelFeedPanel.tsx`,
`Chat/FarcasterDirectMessageView.tsx` and `Chat/types.ts:571` all read
`author.displayName ?? author.username ?? \`fid:${fid}\``. These are **Farcaster**
identities (fid / username / displayName), not Quorum members. They have no
address, no roster, no `.q`, and no relationship to `MemberIdentity`.

Desktop has no Farcaster surfaces, so the plan says nothing about them. A grep-
driven sweep will surface them and they must be explicitly excluded, in the plan
and in the ratchet, or an implementer will "migrate" them.

### 3.6 Mobile's pipeline has three stages before the resolver

**READ**, from `components/Chat/SpaceChatArea.tsx:255-256`:

```
memberMap (raw roster)
  -> useMembersWithPublicProfileFallback(map, senderAddresses)   fetch + merge the GLOBAL tier
  -> useVerifiedQnsNamesInMap(fetched)                           strip unverified .q   [SECURITY]
  -> effectiveMemberMap
  -> resolveMemberName(member)                                   the ladder
```

Desktop's provider collapses its equivalent of stage 1 into `identityFromMaps`.
Mobile can do the same for stage 1, but **stage 2 must remain between the profile
cache and the resolver** (see §3.1). The merge in stage 1 also carries a rule
desktop lacks: roster global slot vs public profile is resolved by
`newer-by-timestamp`, not by precedence (`useMembersWithPublicProfileFallback.ts:60-104`).

### 3.7 Provider mounting is structurally EASIER on mobile than desktop

**READ.** Mobile's modals mount inside their route trees rather than at a global
host: `SpaceSettingsModal` inside `app/(tabs)/spaces/[id]/index.tsx:178` and
`[channelId].tsx:443`; `ReactionDetailsModal` inside
`components/Chat/MessagesList.tsx:1685`. So the crash that hit desktop (a modal
host outside every provider) has no direct mobile equivalent.

Two mobile-specific hazards remain, both **INFERRED**:

- Expo Router gives each route its own tree, so a root scope belongs in
  `app/_layout.tsx` (its provider stack is at lines 329-356) and per-space
  rosters must reach it or be scoped lower.
- `SpaceSettingsModal` is `React.lazy` + Suspense, so provider context must be
  above the Suspense boundary.

### 3.8 Mobile's ratchet is a source-scanning jest test, and has no dynamic-import hole

**READ.** `__tests__/noRawOverrideReadsInUi.test.ts` walks `components/` and
`app/` as text, with a required written reason per allowlist entry, plus a
stale-entry check. Because it scans source rather than resolving imports, the
`await import()` hole desktop left open does not exist here. Extend this file
rather than adding eslint rules.

---

## 4. The real call-site list

**MEASURED** by grep, 2026-08-11. Files importing mobile's resolver, excluding
the resolver modules themselves and tests:

| file | shape |
|---|---|
| `components/Chat/MentionableText.tsx:278` | render |
| `components/Chat/MessageInput.tsx:516, 1122, 1124` | mention match + render + avatar |
| `components/Chat/MessageMarkdownRenderer.native.tsx:367` | render, address-only fallback identity |
| `components/Chat/MessagesList.tsx:691, 692, 1707, 1708` | render + avatar |
| `components/Chat/ReactionDetailsModal.tsx:106, 107` | render + avatar |
| `components/Chat/types.ts:399, 524` | **pure transform**, not a component |
| `components/HeaderAvatar.tsx:45` | self tier |
| `components/SpaceSettingsModal.tsx:858, 862, 882, 883, 1668` | render + avatar + placeholder |
| `components/UnifiedProfileHeader.tsx:59, 274` | self tier |
| `context/WebSocketContext.tsx:38` | type import only |
| `services/notifications/logMentionOrReply.ts:109, 219` | **non-React**, receive path |
| `utils/conversationTitle.ts:48` | pure, called from two route files |
| `utils/messagePreview.ts:193` | pure, called from the receive path |

Plus at least two surfaces that **bypass the resolver entirely** and would not
appear in any import-based list:

- `components/ShareInviteSheet.tsx:87, 173, 183` (already filed)
- `components/Chat/DirectMessagesList.tsx:92` — `displayName = displayName || 'Unknown'`
- `components/Chat/DMChatArea.tsx:560` — `displayName || address?.slice(0, 8) || 'DM'`

**The bypass class is the one that matters**, and it is why the plan's "17 call
sites" is the wrong unit of work. Desktop's ledger says the same thing from the
other side: its 24-row table missed three production importers and the entire app
shell.

---

## 5. Decisions — settled with the operator 2026-08-11

### 5.1 Claim verification moves INSIDE the provider

The provider takes the raw profile cache and verifies internally, so no surface
can opt out by forgetting to clean its rows first. Chosen over keeping today's
external ordering, on the grounds that the entire thesis of this design is that
the wrong thing must be unexpressable, and "each screen remembers to verify
first" is exactly one thing left to forget.

**This is a security path, so it carries its own RED requirement:** a provider fed
an unverified claim must not produce `isQnsVerified`, proven by a test shown to
fail without the guard. Note the failure mode is not symmetric — forgetting
verification on the PUBLIC-PROFILE route renders a forged `.q`, whereas the
BROADCAST route already fails closed because the claim sits under a key the
resolver never reads (§3.1). Do not let the broadcast route's safety be mistaken
for the public-profile route's.

### 5.2 The imperative API cannot mint a `.q`, and that is the point

Follows from 5.1 rather than being decided separately. Verification needs a
network batch lookup and React, so the pure function the receive path uses
(§3.2) cannot perform it. It therefore resolves names but never returns
`isQnsVerified`, which is today's behaviour made structural instead of
incidental. Allowlisted to the named non-React callers; everything else uses the
hooks.

The product consequence is bounded by 5.3: surfaces that render at display time
(bookmarks, notifications) go through the hooks and DO get the `.q`. Only
resolution genuinely performed at message-arrival time loses it.

### 5.3 Frozen names: resolve fresh at display, leave the writes alone

Stop reading the stored `senderName` and resolve from `(address, spaceId)` at
render, as desktop did. Do not remove the write side: it touches persisted data
and rows written by older builds, for no additional visible gain.

**Cost, checked rather than estimated** — this was the operator's explicit
question, and the answer is that it is not a cost driver:

- rosters are a local synchronous MMKV read (`services/storage/mmkvAdapter.ts:209`,
  key `spaceMembers:${spaceId}`), cheaper than desktop's IndexedDB read; nothing
  to build
- mobile's bookmarks panel already mounts INSIDE a space tree
  (`SpaceChatArea.tsx:883`, `DMChatArea.tsx:587`), so it inherits the scope it
  needs. Desktop's costly `useMultiSpaceRosters` existed because its bookmarks
  page is global and mobile's is not
- notifications ARE global (`app/(tabs)/profile/index.tsx`,
  `components/ui/AppTabBar.tsx`) and do need a multi-space roster map — a port of
  a hook desktop already wrote and review-approved
- a bookmark row already carries the sender address and `spaceId`, so this is the
  same work as migrating any other render site, not a special mechanism
- the render sites are migrated either way, so deferring means touching those
  files twice

**UNVERIFIED, and the one thing that could raise this estimate:** `bookmarks`
reaches `BookmarksPanel` as a prop from above `SpaceChatArea` and was traced two
hops, not to its source. If it is NOT filtered to the current space, mobile needs
the multi-space roster for bookmarks too. Check before scheduling the row.

Desktop's architecture is not changed to suit this. Rows 1 and 2 shipped through
review there; unpicking merged work to save mobile a cost mobile does not pay is
the more expensive move.

### 5.4 `resolveSelfName` is merged into the one path, migrated last

Parity is the operator's standing preference and it applies here: one way to get
any name, yours included, matching desktop.

**With a mobile-specific input, which is parity rather than a deviation from it.**
Desktop's nav-rail bug happened because its stored auth record carries no QNS
name, so self had nothing good to resolve from. Mobile's live `user` object DOES
carry `primaryUsername`, and that is what lets a space created after your last
profile save render your name with no network call — a deliberate mobile tier,
documented in `utils/resolveMemberName.ts`'s header. So mobile's provider feeds
its self tier from the live auth profile AS WELL AS the published one. The design
places per-client input differences at exactly this layer.

Migrated last, after the machinery is proven. Re-check `HeaderAvatar` and
`UnifiedProfileHeader` specifically: they are mobile's equivalents of the surface
where desktop found its late bug.

### 5.5 Build the render-test instrument FIRST

Add `@testing-library/react-native` and extend `testMatch` to `.tsx` before any
migration (§3.3). It is task one, not a follow-up: it is the instrument every
subsequent step is verified with, and without it the "screen never calls the
resolver" class stays invisible exactly as it did for `ShareInviteSheet`.

## 6. What this survey did NOT verify

- Nothing was run. No test suite, no typecheck beyond the one `-42` failure in
  §1, no app.
- The mobile call-site table is grep-derived; the per-site *semantics* were read
  for `types.ts`, `logMentionOrReply.ts`, `conversationTitle.ts` and
  `SpaceChatArea.tsx` only.
- `yarn harness:qns` was not run. **READ**: `dev/harness/qns-claim-two-bot.scenario.ts`
  asserts wire DELIVERY and claim REJECTION on stored rows. It does **not**
  assert rendered names, so it is not the render instrument the plan implies it
  is (plan Phase F: "verify with `yarn harness:qns`"). It stays valuable for the
  receive path, and it explicitly does not cover the positive case (a genuinely
  owned name rendering as verified) because no test account owns a real name.
- Desktop's branch was still open at the time of writing; its final whole-branch
  review had not landed.

---

*Last updated: 2026-08-11*
