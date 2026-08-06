---
type: task
title: "QNS primary .q names: everything done, everything left, and how to bring desktop to parity"
status: in-progress
priority: high
created: 2026-08-06
updated: 2026-08-06
area: identity resolution / QNS / cross-client parity
repos: quorum-mobile (ahead), quorum-desktop (behind), quorum-shared (validator only)
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

**Read this first.** The work touches two repos and is spread across five other
issue files. This is the index and the parity plan; the others hold detail.

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
makes every name surface in the app testable on one device. **Desktop has no
equivalent and should get one before the render work**, for the reason mobile's
module docstring gives: desktop already tried the hook-level version, and it
failed silently because all the public-profile hooks share one React Query key.

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
ending in `.q` renders identically to a verified one. Mitigated on mobile at the
resolver (same branch); **desktop is still exposed**.

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

### What belongs in `quorum-shared`, and what does not

Audited 2026-08-06 by reading all three repos. **The rules are duplicated and
have already drifted; the adapters are correctly separate.** Those are different
problems and only the first is worth fixing.

Shared owns `resolveDisplayName` (the tier ORDER only), `hasReservedQnsSuffix`,
`validation/displayName`, `formatAddress` and `qns/resolver`. Everything else
lives twice.

**Move to shared — these are rules, and a rule that exists twice is a rule that
will disagree with itself:**

1. **The echo demotion.** An override equal to the global name is the join echo,
   not a per-space name. Mobile applies it INSIDE its one resolver; desktop
   exposes it as a separate `resolveSpaceMemberName` you have to remember to
   call instead of `resolveMemberName`. Desktop's shape is the fragile one —
   "use this function, not that one, in space contexts" is enforced by nothing,
   and the audit found the mobile equivalent of that mistake at four call sites.
   It belongs inside `resolveDisplayName`, which already receives both values.
2. **The forged-`.q` guard.** A display name ending in `.q` must never reach the
   render path. **Desktop has zero uses of `hasReservedQnsSuffix`** — grep
   confirms — so the forgery in `.secret/` works against it today. A security
   rule enforced in one client and not the other is worth less than it looks:
   the two clients share a network. This one must be un-bypassable and identical
   on both, which means shared.
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

1. (4) forged-`.q` guard — security, tiny, no dependencies. Put it in shared
   (see above) rather than porting mobile's copy, so this is the last time it
   has to be written.
2. (6) audit for direct override reads — must precede any join change. Mobile's
   sweep found **seven** such surfaces, six of them not on any list beforehand,
   and three were the same expression copy-pasted in one file. Budget for that
   rather than assuming desktop has one or two. Grep for direct `displayName`
   reads on roster rows AND on conversation rows; the conversation ones were
   the easiest to miss because they look like they belong there.
3. The join/config-sync write change, if desktop has equivalent paths
4. (1)+(2)+(3) elect-primary, once the server (#9) is fixed and it can work
5. (5) verification, in lockstep with mobile

Note on ordering (2) before (3): on mobile the join fix and the surfaces that
read the override slot by hand were shipped as separate commits, and between
them freshly-joined members rendered as bare addresses. Doing (2) first avoids
reproducing that window on desktop.

## The blocker, restated

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
- [ ] The echo demotion and the forged-`.q` guard live in `quorum-shared`
- [ ] Desktop items (4) and (6) done
- [ ] Desktop reaches feature parity on electing and un-electing
- [ ] Receiver-side verification on BOTH clients, or on neither
- [ ] #9 fixed server-side and re-measured, or the broadcast transport ships
      and makes it unnecessary for spacemates
