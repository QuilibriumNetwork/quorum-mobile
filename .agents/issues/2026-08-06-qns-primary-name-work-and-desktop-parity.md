---
type: task
title: "QNS primary .q names: everything done, everything left, and how to bring desktop to parity"
status: in-progress
priority: high
created: 2026-08-06
updated: 2026-08-13
area: identity resolution / QNS / cross-client parity
repos: quorum-desktop (has the provider/component layer since 2026-08-11), quorum-mobile (caught up on that layer 2026-08-13 via `feat/resolve-identity`; still ahead on elect/un-elect), quorum-shared (owns the rule: resolveIdentity)
source: consolidation of a day's work on 2026-08-06, written because the work spans two repos and five issue files and nobody should have to reassemble it
related:
  - "issues/2026-08-06-decouple-qns-primary-name-from-public-profile-design.md (the design, incl. §10 and §10a)"
  - "issues/.open/2026-08-06-server-rejects-every-primary-username-publish.md (BLOCKER, not ours)"
  - "issues/.open/2026-08-06-public-profile-toggle-on-with-nothing-published.md"
  - "issues/.open/2026-06-10-primary-username-not-synced-or-published.md (the original, half-answered)"
  - "issues/.secret/ — one security issue lives there, see below"
  - "quorum-desktop .agents/issues/.open/2026-08-05-mobile-identity-parity-after-the-desktop-phase-1-fix.md"
---

# One page for the whole `.q` effort

## Status

**2026-08-16 — mobile's identity migration is on `master` as PR #249** (`feat:
names resolve through one verified ladder, so a .q shows wherever a name does`),
which lands everything the 2026-08-13 entry below describes as being on the
branch. 79 commits, 24 migrated surfaces, 986 tests, both guards RED-proven.

**This index stays open**, because parity is the point of the file and desktop
is now behind on three separate axes rather than one:

1. **No broadcast transport.** Desktop's `update-profile` payload has no QNS
   field, so a desktop client cannot announce a `.q` — and cannot store one it
   receives (`claimed_primary_username`: zero occurrences in `quorum-desktop/src`).
2. **No receiver-side verification of profile claims.** Desktop has no
   `claimedNameBelongsTo` equivalent; it renders `primary_username` off a fetched
   public profile without checking the name resolves back to the claimant.
3. **The elect/un-elect flow is still mobile-only**, as recorded below.

Axis 2 is the one that matters most: while it stands, "desktop shows a `.q` and
mobile does not" is an EXPECTED divergence — mobile correctly refusing an
unverified claim — rather than a mobile defect. Anyone comparing the clients
needs that stated before they file the wrong bug.

**2026-08-13 — the shared echo-demotion item (item 1 of "What belongs in
`quorum-shared`" below) is now fully absorbed, closed on shared, desktop AND
mobile.** Mobile's remaining half of that item — bump `@quilibrium/quorum-shared`
to `2.1.0-42` and migrate onto the new `resolveIdentity`/provider layer — turned
out to be the whole `identity/` module and Phase D migration on
`feat/resolve-identity` (24 live call sites). It is done: the completion ratchet
(`__tests__/rawNameFieldAudit.test.ts`'s `TO_MIGRATE`) is empty, and a second
guard (`__tests__/identityPrimitivesGuard.test.ts`) restricts `resolveIdentity`
and `identityFromMaps` to `identity/` and one adapter file, RED-proven. Not
deleted silently here — see the item's own entry further down for the update
that supersedes its earlier "mobile's step is now..." TODO framing.

**2026-08-09 — mobile is DONE end to end; every remaining item on this page is
desktop.** PR #245 shipped receiver-side verification on all four mobile
surfaces plus the broadcast transport, so a mobile user can elect a `.q` and
other mobile users see it.

Three defects were found and fixed on the way, none of which this document
predicted:

- electing a name reached nobody (three compounding causes)
- **any** profile change could lose its broadcast to a re-render — a rename or
  avatar change equally, not just `.q`; filed separately in
  `issues/.done/2026-08-09-a-profile-change-could-silently-never-reach-anyone.md`
- the DM header rendered an unverified claim while the message bubbles beneath
  it were verified

The receive path is now covered by a two-bot harness scenario
(`yarn harness:qns`) rather than by argument. Note for whoever takes desktop:
the receive side CANNOT be tested on one device — Triple Ratchet participants
cannot decrypt their own echoed messages — so budget for the harness rather than
planning a manual check.

**2026-08-06 — mobile shipped in PR #239** (`fix: joining a space no longer
freezes your global name, and a .q resolves on every surface`), 16 commits.

What landed: breaks 1–8c of the chain below. Joins and config sync write the
global slot instead of the per-space override, rows already stamped are healed
at read time, and every name surface now resolves through the one ladder — the
member list, all four DM surfaces, both mention surfaces, the call screens, the
profile modal, your own avatar and the per-space name placeholder. A display
name ending in `.q` can no longer forge the verified marker. Two regression
instruments shipped with it: a test that runs the real join output through every
name path, and a guard that fails on any new raw override read in `components/`
or `app/`. 608 tests, verified on device with the fake-QNS sweep switch.

**2026-08-09 — two desktop items below have since landed and are marked so
inline.** Desktop shipped the forged-`.q` guard (`06c38370d`, 2026-08-06) and a
fake-QNS dev page (`9a76045f7`, #315, 2026-08-06). Everything else in the
desktop list is still open. Verified by reading desktop source, not from the
commit subjects.

**This file stays open.** It is the index for work that is mostly NOT done:

- Desktop parity — the security guard and the test harness landed; the feature
  work (elect-primary, un-elect, the sentinel, the placeholder) has not started
- The two `quorum-shared` moves
- Receiver-side verification, and the broadcast transport that depends on it
- The server blocker (#9), which is not ours and which keeps a `.q` invisible to
  every real user until it is fixed

**Read this first.** The work touches two repos and is spread across five other
issue files. This is the index and the parity plan; the others hold detail.

## HANDOFF — the whole `.q` effort in one table (2026-08-09)

**Point a fresh agent at THIS FILE and nothing else.** It is the index; the
others are detail you read only when you reach them. The effort spans nine issue
files across two repos, which is why this section exists.

### State

| Piece | Mobile | Desktop |
|---|---|---|
| Forged-suffix guard (a name ending `.q` is dropped) | ✅ #239 | ✅ `06c38370d` |
| Elect / un-elect a primary name | ✅ #238 | ❌ no UI at all |
| `.q` renders on every name surface | ✅ #239 | ✅ (its own earlier work) |
| Receiver-side verification | ✅ **#245** | ❌ |
| Broadcast transport (the only working delivery route) | ✅ **#245** | ❌ neither sends nor reads |
| Two-bot harness proving the receive path | ✅ `yarn harness:qns` | ❌ |

### What is actually left, and it is NOT all desktop

**Desktop — the large one.** Everything in the ❌ column. Read the desktop
sections further down this file; they are still accurate. The binding rule:
**desktop must not start reading `primary_username` off the broadcast without
shipping verification in the same release.** Today it ignores the field, so its
users are degraded (no `.q` shows), not exposed — and that is the only thing
making the current split safe.

**Mobile — five smaller items, all real:**

1. Two on-device cost measurements — §9 of
   `issues/.open/2026-08-06-verify-a-claimed-q-name-receiver-side-plan.md`:
   requests on opening a busy channel, and that a fast member-list scroll does
   not fire one per virtualisation tick. That surface cost zero before #245.
2. A revoked delegated name still shows to its holder —
   `issues/.open/2026-08-09-a-delegated-name-can-be-revoked-and-you-are-the-last-to-know.md`.
   Decided and specified, not built. Preferred fix is to fold it into the
   verification work, which now exists.
3. §6a merged-Farcaster mode —
   `issues/2026-08-06-decouple-qns-primary-name-from-public-profile-design.md`.
4. `issues/.open/2026-08-04-qns-names-and-the-identity-coverage-instrument.md`
   has items deliberately left open.
5. `issues/.open/2026-08-06-public-profile-toggle-on-with-nothing-published.md`.

**Not ours, and not blocking:** the server refuses every `primary_username`
publish (`issues/.open/2026-08-06-server-rejects-every-primary-username-publish.md`,
upstream #240). The broadcast routes around it entirely, which is why #245 was
worth shipping while it is still broken. It also makes
`issues/.open/2026-06-10-primary-username-not-synced-or-published.md` a
waiting-on-server file rather than a client one.

### Two things that will waste a day if you do not know them

- **The receive side cannot be tested on one device, at any effort.** Triple
  Ratchet participants cannot decrypt their own echoed messages, so a sender
  never sees its own broadcast arrive. Use `yarn harness:qns` (two processes,
  real crypto, production relay). Do not plan a manual check.
- **Metro's output is unusable for verification** and the Android log buffer
  holds about forty seconds of this app. Use `.agents/scripts/qlog.sh`, which
  starts a filtered `adb` capture BEFORE the action. Its output stays outside the
  repo on purpose — device logs carry real addresses.

### Reading order for a fresh agent

0. **If your task is name RESOLUTION or rendering — anything about which name
   shows on screen — read
   `quorum-desktop/.agents/issues/.open/2026-08-10-identity-resolution-architecture-design.md`
   first and treat it as authoritative over this file.** It supersedes the
   shared-code section below (see the note under item 1 there). This file
   remains the index for everything else: the elect/un-elect feature, the server
   blocker, receiver-side verification.
1. This file, whole.
2. `issues/.open/2026-08-06-verify-a-claimed-q-name-receiver-side-plan.md` — the
   design that shipped, including the rules (fail closed, never render
   optimistically) that any desktop port must also honour.
3. `issues/2026-08-06-decouple-qns-primary-name-from-public-profile-design.md` —
   why the broadcast exists at all.
4. `issues/.secret/` — the threat model. Not indexed; ask for the path.
5. The rest only as this file points at them.

## START HERE if you are picking up the desktop work cold

You are working in **`quorum-desktop`**, with `quorum-mobile` as the reference
implementation and `quorum-shared` as the place two rules should end up. All
three repos sit side by side on this machine.

**Read, in this order, and do not skip 2 — it is the one that stops you porting
the wrong thing:**

1. This whole file. The chain table tells you what was broken; the desktop
   sections tell you what desktop is missing.
2. **"What belongs in `quorum-shared`, and what does not"** below. Two of the
   items are rules that must move to shared rather than be copied a third time.
   Copying them is the failure mode this section exists to prevent.
3. `issues/.secret/2026-08-06-a-display-name-can-impersonate-a-verified-q-name.md`
   in THIS repo — the security item, with the working mechanism. Desktop is
   exposed to it today.
4. Desktop's own `.agents/docs/features/qns-username-display.md`, which records
   decisions desktop already made (including why it refuses to fetch a full
   roster). Do not overturn those without reading them.

**Reference implementations in `quorum-mobile`**, all on branch
`fix/join-stamps-global-name-into-per-space-override`:

| what | mobile file |
|---|---|
| the ladder, echo demotion, forgery guard | `utils/resolveMemberName.ts` |
| your own name (no per-space tier) | `utils/resolveSelfName.ts` |
| the DM title rule | `utils/conversationTitle.ts` |
| roster array ← public-profile map | `hooks/useMembersWithPublicProfileFallback.ts` (`membersWithEffectiveIdentity`) |
| free cache read, no requests | `hooks/useMembersWithCachedQns.ts` |
| the DM list's own fetch, and why it is affordable | `hooks/chat/useConversationsWithQnsNames.ts` |
| electing / un-electing a primary name | `services/profile/primaryNameChange.ts`, `republishSelfProfile.ts`, `utils/primaryName.ts` |

**How to verify anything you change.** Do not hand the operator a manual test
first — build or use the harness. Mobile's dev panel (`services/dev/fakeQns.ts`)
injects synthetic public profiles at `QuorumClient.getPublicProfile`, the single
seam every profile read passes through, and its "give everyone a `.q`" switch
makes every name surface in the app testable on one device. **Desktop now has
its own** (`src/dev/fake-qns/`, PR #315, 2026-08-06) — this line previously said
it did not. Note the reason mobile's module docstring gives for injecting at the
client seam rather than the hook: desktop already tried the hook-level version,
and it failed silently because all the public-profile hooks share one React
Query key.

**Two standing rules for this work**, both learned the hard way here:

- Every fix needs a test that has been shown to FAIL without it. Revert the fix,
  watch it go red, put it back. An assertion that passes either way is worse
  than no test.
- Label every claim MEASURED / READ / INFERRED. On this subsystem specifically,
  four confident readings were falsified by measurement in a single day.

## The one-line state

A primary `.q` name is meant to be your name everywhere, outranking your global
display name. It has never worked end to end, for anyone, because **nine things
were broken in series.** Seven are now fixed on mobile. One is a server bug that
is not ours. One is client work still to do. **Desktop has none of the fixes.**

## The chain

| # | Break | State |
|---|---|---|
| 1 | Mobile's type boundary silently dropped `primary_username` from every API response | fixed, PR #236 |
| 2 | Mobile never fetched public profiles for known members, so it never arrived | fixed, PR #236 |
| 3 | Your own profile header ranked the global name above your `.q` | fixed, PR #238 |
| 4 | Electing a name published nothing — local write plus an alert | fixed, PR #238 |
| 5 | No un-elect existed; make-private and transfer left you publishing a name you no longer held | fixed, PR #238 |
| 6 | Joining a space stamped your GLOBAL name into everyone's per-space override, which outranks the `.q`, forever | fixed, branch `fix/join-stamps-global-name-into-per-space-override` |
| 6b | Config sync did the same on every new device | fixed, same branch |
| 6c | Rows already stamped stayed broken | fixed, same branch (read-time echo check) |
| 7 | Space Settings member list never resolves a `.q` | fixed, same branch |
| 8 | DM list, DM messages and DM header never resolve a `.q` | fixed, same branch |
| 8b | Both mention surfaces were handed the raw roster, which cannot carry a `.q` | fixed, same branch |
| 8c | Calls, the header avatar tap (and through it the kick/mute/block confirmations), and your own header avatar | fixed, same branch |
| 9 | The server refuses every publish carrying a `primary_username` | **BLOCKED — not ours** |

Plus one security issue found on the way, filed in `.secret/`: a display name
ending in `.q` renders identically to a verified one. Mitigated at the resolver
on mobile (same branch) and on desktop (`06c38370d`) — **both clients now drop a
forged suffix.** What remains there is receiver-side verification: neither
client checks that a claim arriving in the proper `primary_username` field
actually belongs to the sender.

**Two standing product rules for anything touching `.q` display**, both stated
by the operator and both cheap to violate by accident:

1. **The `.q` suffix is the only signal.** No badge, no icon, no tooltip — see
   the note below, which has now been re-proposed twice.
2. **The user explicitly chooses which `.q` to show.** Electing is a button
   press on one specific name. Nothing may elect on their behalf: not on
   registration, not when they hold exactly one eligible name, not when a name
   is delegated to them. Holding a name with no primary elected is a legitimate
   state. Un-electing automatically is allowed (and exists) when a name stops
   pointing at them; promoting a replacement is not. Recorded at the choke point
   in `services/profile/primaryNameChange.ts`, and in
   `issues/.open/2026-08-09-a-delegated-name-can-be-revoked-and-you-are-the-last-to-know.md`.

**Do not propose a verified badge as the fix.** "No badge — the suffix is the
signal" is a settled design decision from 2026-06-10
(`quorum-desktop/.agents/issues/port-from-mobile/.done/2026-06-10-qns-username-display-design.md:66`,
restated in that plan at :778). The `.secret/` issue was written without it and
listed a badge as fix direction (2); that direction is rejected and the file now
says so. The consequence is that the suffix carries the whole trust claim alone,
which makes receiver-side verification the only remaining defence rather than
one option among three.

## Measured on device, 2026-08-06

Operator ran this with the fake-QNS dev panel, own account with a `.q` set:

| Surface | Result |
|---|---|
| Own profile screen | ✅ shows the `.q` |
| Space messages | ✅ shows the `.q` |
| Space Settings member list | ❌ still the global name |
| DM messages | ❌ still the global name |
| DM header | not tested (needs a second client) |
| User profile modal (tap an avatar) | ❌ still the global name |

Re-measured later the same day, after #7/#8 landed: the member list, DM
messages and the profile modal opened from a DM all show the `.q`.

### One device is enough — the second device is not needed

The operator twice deferred testing a surface ("I only have one device").
That is not a real constraint here: the dev panel's switch **2 · Give EVERYONE
a `.q`** (`services/dev/fakeQns.ts`, `giveEveryoneAName`) synthesizes a stable
fake `.q` for every address with no explicit entry, injected at
`QuorumClient.getPublicProfile` — the single seam every profile read goes
through. Its own hint names this exact case: "Only needed for the few surfaces
that can never render you: a DM partner's name, a blocked user."

So the DM list, the DM header and a partner's profile modal are all testable
solo. The panel invalidates the 1h profile cache on every change, but a screen
already open still holds a resolved member map — leave and re-enter before
believing a negative result.

## Still to do on mobile

- [x] **#7 — Space Settings member list.** Wired to `useMembersWithCachedQns`,
      which reads already-cached profiles via `useQueries` with `enabled: false`
      and so costs no requests.
- [x] **#8 — DM surfaces.** The list, the header and the messages all resolve.
      The list needed its own fetch (`hooks/chat/useConversationsWithQnsNames.ts`)
      rather than a cache read, because the inbox is usually the first screen
      opened and the cache is cold exactly when it is drawn.
- [x] **#8b — mentions.** Both the `@` autocomplete and the rendered pill
      already called the resolver and were handed `membersData`, the raw roster.
      They now read the same enriched map the message headers use, at no extra
      fetch (`membersWithEffectiveIdentity`).
- [x] **#8c — the surfaces found by sweeping every name render.** The audio and
      video call screens, the DM header avatar tap (which feeds the kick, mute
      and block confirmations), and your own header avatar, which derived its
      initials from `displayName || primaryUsername` — the ladder upside down.
- [ ] **The user profile modal's dead `@handle` line.** `UserProfileModal.tsx:260`
      renders `@{user.primaryUsername}` under the name. No caller populates
      `MessageUserInfo.primaryUsername`, so it never renders — the modal is
      correct today only because every caller now passes an already-resolved
      `userName`. Either populate the field and show a real secondary handle, or
      delete it. Leaving dead identity code next to a trust marker is how the
      next person reintroduces the inversion.
- [ ] **Receiver-side verification of a claimed `.q`.** Planned in detail in
      `issues/.open/2026-08-06-verify-a-claimed-q-name-receiver-side-plan.md`,
      including the cost analysis, the cache TTL as a security parameter, and
      the rule that a failed check degrades the NAME and never the message.
- [ ] **The broadcast transport (§10a of the design doc).** Now the only route
      a `.q` can reach anyone while #9 is broken. **Blocked on the verification
      above**, which is binding, not optional.
- [ ] **Merged Farcaster mode** fans the resolved display name to Farcaster's
      display name, never the fname.

## Desktop parity — the actual point of this document

Desktop is behind on everything below. Audited 2026-08-06; findings are from
reading desktop source, not assumed from mobile.

### How the two clients got out of step, since it explains the shape of this

Desktop fixed the join stamping on **2026-08-05** in PR #313 — four commits:
`f991082a9` (own override slot), `f12106a5b` (an incoming join is a global
identity), `b069bd637` (one-time clear of legacy overrides) and `6bd2df171` (a
tripwire on unexpected writes to the own override slot).

Mobile's equivalent was NOT fixed alongside it. It was filed as an open
question in desktop's own
`.agents/issues/.open/2026-08-05-mobile-identity-parity-after-the-desktop-phase-1-fix.md`
— "**UNKNOWN — the urgent one**... This is the item to answer first" — and sat
unanswered for a day. The answer, found 2026-08-06, was yes: mobile stamped on
both join paths AND on config sync, so it was still manufacturing the traps
desktop had just cleared, on every member's device. That file predicted this
consequence exactly.

**The lesson to carry into the desktop work: a fix that lands on one client and
leaves the other as a TODO is not a shipped fix.** The clients share a network,
so the unfixed one keeps producing the state the fixed one is cleaning up.

Two things desktop has that mobile still does not, both worth porting BACK:

- **`6bd2df171`, the tripwire** on unexpected writes to your own override slot.
  Mobile has no equivalent instrument, and its equivalent bug had lived for
  months undetected.
- **`b069bd637`, the one-time legacy clear.** Mobile instead heals at READ time
  via the echo demotion, which is less invasive but cannot heal a row whose
  owner has since renamed globally (that override is now a STALE echo and reads
  as deliberate). Desktop's own file says not to port its clear blindly — it was
  justified by a measurement on a real account. Measure mobile before deciding.

### What desktop already has, and does better

- **One publish call site**, not four: `useUserSettings.saveChanges`
  (`src/hooks/business/user/useUserSettings.ts:436-465`). Mobile had the publish
  block copy-pasted; when mobile adds the elect-primary flow desktop should
  route through this rather than growing a second copy.
- **The echo check mobile had to re-add**: `resolveSpaceMemberName`
  (`src/utils/resolveMemberName.ts:66`) already compares the roster name against
  the global name. Mobile deleted this on a false premise and has now restored
  it. Desktop needs no change here.

### What desktop must gain

1. **The whole elect-primary feature.** Desktop has NO UI to set a primary name
   and never publishes `primary_username` — `src/api/PublicProfileService.ts:22-27`
   says so outright and always signs the v1 payload. Port mobile's
   `services/profile/primaryNameChange.ts` + `republishSelfProfile.ts`, wired
   into `useUserSettings.saveChanges`.
2. **Un-elect, and clearing on make-private / transfer.** Desktop has no QNS
   registration or marketplace at all, so this only matters once it does. Track
   with (1).
3. **The `NO_PRIMARY_NAME` empty-string sentinel** (`utils/primaryName.ts`).
   Desktop's config bridge will hit the same `undefined`-means-absent problem
   the moment it can clear a field. Do not let it be discovered again.
4. **The forged-`.q` guard — do this one first, it is the security item.**
   Desktop renders a claimed name with no check that it does not end in `.q`,
   and its `isQnsVerified` is likewise not surfaced. Port mobile's
   `presentName` / `presentQnsName` from `utils/resolveMemberName.ts` into
   desktop's `resolveMemberName`. Small, self-contained, no dependencies.
5. **Receiver-side verification (§10a)**, whenever it lands on mobile. A client
   that renders the wire field without checking it exposes its own users
   regardless of what the other client does. **Both clients or neither.**
6. **Re-check `messageSenderName`-style surfaces.** Mobile had two places
   reading the per-space override directly instead of going through the
   resolver, which broke the moment joins stopped stamping that slot. Desktop
   may have equivalents; grep for direct `displayName` reads on roster rows
   before porting the join change.
7. **The per-space name field's placeholder.** Leaving that field empty means
   "follow my normal name", and the placeholder is how the user is told what
   that resolves to — so it is a promise and must be the name the app would
   actually render, including the `.q`. Desktop's shows a static
   `t\`Display Name\`` (`SpaceSettingsModal/Account.tsx:217`) and promises
   nothing; mobile's promised the wrong name until 2026-08-06. Port mobile's
   `selfNamePlaceholder` (`utils/resolveSelfName.ts`). Small, self-contained,
   and the screen in question is the one that explains the whole two-slot model
   to the user — worth more than its size.

### What belongs in `quorum-shared`, and what does not

Audited 2026-08-06 by reading all three repos. **The rules are duplicated and
have already drifted; the adapters are correctly separate.** Those are different
problems and only the first is worth fixing.

Shared owns `resolveDisplayName` (the tier ORDER only), `hasReservedQnsSuffix`,
`validation/displayName`, `formatAddress` and `qns/resolver`. Everything else
lives twice.

**Move to shared — these are rules, and a rule that exists twice is a rule that
will disagree with itself:**

1. **The echo demotion — ✅ DONE, 2026-08-13. Absorbed on shared, desktop AND
   mobile; nothing left to plan for either client.** Shared shipped it
   2026-08-10; mobile's remaining half (bump the dependency and migrate onto
   it) shipped 2026-08-13 — see that update at the bottom of this item. It
   shipped as part of a larger change rather than on its own, so the analysis
   below is kept only as the argument that produced it. Read the ✅ box after
   it, then stop.

   MEASURED 2026-08-11: `resolveIdentity` in `quorum-shared` applies the demotion
   (`if (space && space !== global) return …`, i.e. an override equal to the
   global name falls through to the QNS tier), and it is published — npm
   `@quilibrium/quorum-shared@2.1.0-42`, 2026-08-10 21:02Z, exports
   `MemberIdentity` and `resolveIdentity` from
   `dist/utils/resolveDisplayName.d.ts`. **Mobile pins `2.1.0-40`, so mobile does
   not have it yet; that is a bump, not a blocker.**

   An override equal to the global name is the join echo,
   not a per-space name. Mobile applies it INSIDE its one resolver; desktop
   exposes it as a separate `resolveSpaceMemberName` you have to remember to
   call instead of `resolveMemberName`. Desktop's shape is the fragile one —
   "use this function, not that one, in space contexts" is enforced by nothing,
   and the audit found the mobile equivalent of that mistake at four call sites.

   **This one is NOT ready to implement from this document, and an earlier
   version of this line pretended it was** by saying `resolveDisplayName`
   "already receives both values". Two things have to be settled first:

   - **`resolveDisplayName`'s `display_name` parameter means different things
     in the two clients.** Mobile passes the GLOBAL name into it
     (`utils/resolveMemberName.ts`, `display_name: global`); desktop passes the
     roster row's own name (`src/utils/resolveMemberName.ts`,
     `display_name: realDisplayNameOrUndefined(member.displayName)`). The same
     parameter is therefore the global tier on one client and something closer
     to the override on the other. Nothing can move into shared until that
     contract is named, because the echo check compares exactly these two values.
   - **Desktop's `resolveSpaceMemberName` does not call shared at all.** It
     re-implements the whole ladder by hand
     (`src/utils/resolveMemberName.ts:66` onward). So desktop currently has two
     resolvers, only one of which delegates. Unifying those is the actual first
     step, and it is a bigger job than "port the echo check".

   Treat this as a design task with its own short spec, not as a port. It is
   also why it must not gate the security item below.

   > ### ✅ 2026-08-10 — that spec now exists, SHIPPED, and ABSORBS this item
   >
   > **`quorum-desktop/.agents/issues/.open/2026-08-10-identity-resolution-architecture-design.md`**
   >
   > Do not implement this item on its own. The spec settles the blocker named
   > above — it names the contract explicitly (`spaceName` / `globalName`, so
   > "the same parameter means different things in the two clients" cannot
   > recur) and unifies desktop's two resolvers as a consequence rather than as
   > a separate job.
   >
   > It goes considerably further, because the echo demotion turned out to be
   > one symptom of a larger defect: the resolver takes three optional fields
   > that must travel together, and omitting one does not degrade the answer, it
   > INVERTS it. 45 files across the two repos pass those fields by hand. The
   > spec makes a partial identity impossible to express.
   >
   > **Sequencing: desktop first, mobile second, and mobile is not blocked
   > meanwhile.** Desktop consumes shared via a local symlink and mobile via
   > pinned npm `2.1.0-40`, so desktop can land the breaking shared change
   > without mobile noticing. ⚠️ The corollary: do NOT bump mobile's shared
   > version onto a build carrying the new required fields until mobile migrates
   > in the same stroke.
   >
   > Mobile's own step is step 6 of that document. Read it there rather than
   > planning from here.
   >
   > **2026-08-11 update — desktop's side is done and mobile is unblocked.**
   > Shared merged (`2efd307`) and published (`2.1.0-42`). Desktop migrated all
   > ~24 call sites plus a second tranche the plan's table never saw (search,
   > moderation modals, the app shell), deleted `resolveMemberName.ts`,
   > `resolveSelfName.ts`, `resolveGlobalSender.ts`, `conversationSearch.ts`,
   > `profileCardIdentity.ts` and `ResolvedName.tsx`, and turned the lint rule
   > from an allowlist ratchet into a live guard restricting `resolveIdentity`
   > and `identityFromMaps` to `src/identity/`.
   >
   > So mobile's step is now: bump `2.1.0-40` → `2.1.0-42` **and** migrate its
   > one shared-importing file in the same PR (the change is breaking by
   > design), then port the provider/component layer across its 17 call sites.
   >
   > **2026-08-13 update — DONE. This item is now fully absorbed on both
   > clients, not just shared and desktop.** Mobile bumped to `2.1.0-42`,
   > migrated `utils/resolveMemberName.ts` onto `resolveIdentity` in the same
   > PR, and built the `identity/` module (`identityFromMaps`, a root
   > `IdentityScopeProvider`, `<MemberName>`/`useResolvedName`) that every live
   > name-rendering surface now goes through — 24 call sites across the
   > `feat/resolve-identity` branch's Phase D rows. The completion ratchet
   > (`__tests__/rawNameFieldAudit.test.ts`'s `TO_MIGRATE`) is empty, and a
   > second guard (`__tests__/identityPrimitivesGuard.test.ts`) now restricts
   > `resolveIdentity`/`identityFromMaps` themselves to `identity/` and one
   > adapter file, RED-proven against a throwaway import — mobile's equivalent
   > of desktop's live guard mentioned above. There is no remaining shared
   > echo-demotion work on either client; item 1 is closed.
2. **The forged-`.q` guard — DONE on all three repos, 2026-08-06.** Shared
   `#77`, desktop `06c38370d` on `main`. Mobile already had it. The history
   below is kept because the gap it describes is the argument for item 1.

   The guard now lives inside `resolveDisplayName`, so every tier it resolves
   drops a name that would forge the marker. Mobile is covered twice (its own
   adapter still has the rule; the duplicate can go when mobile bumps its shared
   dep — it is on `2.1.0-39` from npm, and npm has not been published past that).

   Desktop consumes shared through a **local symlink** (`link:../quorum-shared`,
   resolved and verified), so it picked the guard up the moment shared was
   rebuilt — no publish needed. Its full suite passes: 1119 tests.

   **Shared alone did not cover desktop, and that is the lesson worth keeping.**
   Desktop has TWO resolvers and only one delegates. `resolveSpaceMemberName`
   (`src/utils/resolveMemberName.ts`) hand-rolls the ladder and returns early on
   the roster name, the QNS name and the global name — all three unguarded. It
   reaches the shared-backed `resolveMemberName` only when every tier is empty,
   where there is nothing left to forge. And it is what 10+ surfaces call:
   messages, mentions, reactions, notifications, pinned messages, the channel
   view. So immediately after the shared fix, desktop was guarded in DMs and
   unguarded in every space context.

   Closed in `06c38370d` by routing those three reads through
   `hasReservedQnsSuffix`, applied BEFORE the roster-vs-global echo comparison —
   compared raw, a forged roster name differs from the global one, which reads
   as a deliberate per-space name and returns the forged string outright. Nine
   tests; reverting the guard turns five red. Full desktop suite green (1128).

   **This is the concrete proof of why item 1 matters: a rule placed in shared
   protects only the paths that actually call shared.** Desktop's second
   resolver still needs to be made to delegate, and until it is, every future
   rule added to shared will have to be manually mirrored into it — exactly the
   drift this section exists to end.

   *(Superseded note: this item previously read "desktop has zero uses of
   `hasReservedQnsSuffix`". True when written, and still true of desktop's own
   source — it now inherits the rule through shared instead, on one of its two
   paths.)*

   The principle that put it here still holds, and is the reason the remaining
   desktop gap is not acceptable: a rule enforced in one client and not the
   other is worth less than it looks, because the two clients share a network. A
   forged name a mobile user never sees is one a desktop user reads instead.
3. **The DM title rule** — a conversation's `displayName` is a GLOBAL name, not
   a per-conversation override, because a DM cannot be renamed. Mobile now has
   this in one place (`utils/conversationTitle.ts`); desktop resolves DM names
   inline. This rule is one line and getting it wrong hides the `.q` in every
   DM, which is exactly what happened on mobile.

**Keep per-client — these are not rules, and moving them would cost more than
the duplication:**

- **The two adapters themselves.** Mobile's rows are snake_case
  (`display_name`, `primary_username`), desktop's are camelCase. A thin
  translating adapter each is the honest cost of that; it is not duplication.
- **The address fallback.** Shared's `truncate` is a naive `slice(0,6)…slice(-4)`
  and is not Qm-aware. Both clients deliberately override it, and mobile picks
  `long` for DM surfaces and `medium` elsewhere. Presentational.
- **The self tier.** Mobile resolves its own row from a live in-memory profile;
  desktop has no equivalent concept.
- **Every hook.** Different query clients, different storage, different
  placeholder semantics (desktop repairs an "Unknown User" row; mobile has no
  such placeholder and falls back at render).

**Sequencing note.** Do (2) first and standalone — it is small, security-
relevant and has no dependencies. Do NOT block it on (1), which touches shared's
most-called function and wants its own test pass.

### Order to do desktop in

**Ready to implement straight from this document:** items 4, 6 and 7. They are
small, self-contained, and every fact they rest on is cited with a file:line.

~~**Needs a short design spec first:** the shared echo-demotion move.~~ **Done —
the spec was written, implemented and published (2026-08-10). See the ✅ box in
item 1.** Nothing here is waiting on a spec any more.

**Blocked on the server:** items 1, 2 and 3 (elect-primary and un-elect) cannot
be tested end to end until #9 is fixed, because nothing can be published.

1. (4) forged-`.q` guard — security, tiny, no dependencies. Put it in shared
   (see above) rather than porting mobile's copy, so this is the last time it
   has to be written. **Start here.**
2. (6) audit for direct override reads — must precede any join change. Mobile's
   sweep found **seven** such surfaces, six of them not on any list beforehand,
   and three were the same expression copy-pasted in one file. Budget for that
   rather than assuming desktop has one or two. Grep for direct `displayName`
   reads on roster rows AND on conversation rows; the conversation ones were
   the easiest to miss because they look like they belong there.
3. (7) the per-space placeholder — independent of everything else, and cheap.
4. Build desktop's fake-profile harness (see START HERE) before any further
   render work, so the rest can actually be verified.
5. The join/config-sync write change, if desktop has equivalent paths
6. ~~The shared echo-demotion move, after its spec exists~~ — ✅ done
   2026-08-10 in `resolveIdentity`; mobile's remaining share is the version bump
   + migration in one PR (item 1's ✅ box)
7. (1)+(2)+(3) elect-primary, once the server (#9) is fixed and it can work
8. (5) receiver-side verification, in lockstep with mobile

Note on ordering (2) before (3): on mobile the join fix and the surfaces that
read the override slot by hand were shipped as separate commits, and between
them freshly-joined members rendered as bare addresses. Doing (2) first avoids
reproducing that window on desktop.

## The blocker, restated

> **Filed upstream 2026-08-07 as
> [quorum-mobile#240](https://github.com/QuilibriumNetwork/quorum-mobile/issues/240).**
> Nothing on the client side can move it. If someone asks "what is left for `.q`
> names to work for real users", the answer is that issue and nothing else.

`POST /users/:addr/public-profile` carrying any `primary_username` returns HTTP
400 from a misconfigured server-side QNS lookup. Two names tried seconds apart —
one unregistered, one genuinely resolvable — gave byte-identical errors, so the
failure precedes any consideration of the name. Nobody can have a visible `.q`
via that route until it is fixed. Full reproduction in
`issues/.open/2026-08-06-server-rejects-every-primary-username-publish.md`.

This is why the broadcast transport moved from last to first in the design doc.

## Definition of done

- [x] #7 and #8 closed on mobile
- [x] #8b and #8c closed on mobile
- [ ] All of the above re-measured on device with switch 2 on (one device is
      enough — see above)
- [ ] The user profile modal's dead `@handle` line resolved either way
- [x] The echo demotion and the forged-`.q` guard live in `quorum-shared` —
      both inside `resolveIdentity`, published as `2.1.0-42` (MEASURED
      2026-08-11).
- [x] Mobile bumped to a shared version carrying `resolveIdentity` **and**
      migrated in the same PR (Phase F of
      `quorum-desktop/.agents/issues/.open/2026-08-10-identity-resolution-architecture-plan.md`)
      — DONE 2026-08-13, `feat/resolve-identity`. Pinned at `2.1.0-42`; every
      live name-rendering surface resolves through `@/identity`; the
      migration ratchet (`__tests__/rawNameFieldAudit.test.ts`) is empty and a
      primitives guard keeps it that way.
- [ ] Desktop items (4) and (6) done
- [ ] Desktop reaches feature parity on electing and un-electing
- [ ] Receiver-side verification on BOTH clients, or on neither
- [ ] #9 fixed server-side and re-measured, or the broadcast transport ships
      and makes it unnecessary for spacemates

---

*Last updated: 2026-08-11*
