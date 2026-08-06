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
| 7 | Space Settings member list never resolves a `.q` | **OPEN** |
| 8 | DM list, DM messages and DM header never resolve a `.q` | **OPEN** |
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

The two ✅ rows are #3 and #6 confirmed working on a real device. The ❌ rows are
#7, #8, and a surface not previously on the list — see below.

## Still to do on mobile

- [ ] **#7 — Space Settings member list.** `SpaceSettingsModal.tsx:838` resolves
      from raw roster rows; only `SpaceChatArea.tsx:245` and `DMChatArea.tsx:173`
      call the public-profile fallback hook, and a `.q` only travels in a public
      profile. `hooks/useMembersWithCachedQns.ts` is written for this and is
      deliberately UNTRACKED until it is wired — it reads already-cached
      profiles via `useQueries` with `enabled: false`, so it costs no requests.
- [ ] **#8 — DM surfaces.** `dm/[id].tsx:390` and `messages/index.tsx:216` use
      `conversation.displayName` raw. Desktop resolves in DMs; mobile does not.
- [ ] **The user profile modal.** `components/UserProfileModal.tsx:259` renders
      the global name as the heading and the `.q` as a separate `@handle` line
      underneath — the same inversion fixed for the OWN profile in #3, on the
      modal that shows somebody else. Same fix shape as `resolveSelfName`.
- [ ] **The broadcast transport (§10a of the design doc).** Now the only route
      a `.q` can reach anyone while #9 is broken. **Blocked on receiver-side
      verification**, which is binding, not optional.
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

### Order to do desktop in

1. (4) forged-`.q` guard — security, tiny, no dependencies
2. (6) audit for direct override reads — must precede any join change
3. The join/config-sync write change, if desktop has equivalent paths
4. (1)+(2)+(3) elect-primary, once the server (#9) is fixed and it can work
5. (5) verification, in lockstep with mobile

## The blocker, restated

`POST /users/:addr/public-profile` carrying any `primary_username` returns HTTP
400 from a misconfigured server-side QNS lookup. Two names tried seconds apart —
one unregistered, one genuinely resolvable — gave byte-identical errors, so the
failure precedes any consideration of the name. Nobody can have a visible `.q`
via that route until it is fixed. Full reproduction in
`issues/.open/2026-08-06-server-rejects-every-primary-username-publish.md`.

This is why the broadcast transport moved from last to first in the design doc.

## Definition of done

- [ ] #7 and #8 closed on mobile, verified on device
- [ ] The user profile modal shows the `.q` as the name
- [ ] Desktop items (4) and (6) done
- [ ] Desktop reaches feature parity on electing and un-electing
- [ ] Receiver-side verification on BOTH clients, or on neither
- [ ] #9 fixed server-side and re-measured, or the broadcast transport ships
      and makes it unnecessary for spacemates
