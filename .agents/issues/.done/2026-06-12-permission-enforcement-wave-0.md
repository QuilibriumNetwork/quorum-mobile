---
status: done
created: 2026-06-12
updated: 2026-06-13
type: task
title: "Wave 0 — enforce permissions on mobile by consuming shared helpers"
runtime-test: required
progress: "FULLY SHIPPED. PR #76 (2026-06-13): receive-side delete validation + read-only channel enforcement. PR #77: dropped pin/mute/thread junk. refactor/use-shared-permission-helpers (2026-06-18): hook-layer rewire — useHasPermission / useUserPermissions / useUserRoles now delegate to shared helpers. DEFERRED (not part of this task): @everyone (26a) -> Wave 1; user:mute -> dropped (mobile mute is personal/local, see 0.3)."
priority: high (closes 2 live access-control gaps + 1 latent footgun in one change; @everyone/26a deferred to Wave 1)
source-audit: ../quorum-desktop\.agents\tasks\port-to-mobile\candidates.md (rows 26a-c, 27; "Recommended sequencing" → Wave 0)
extends:
  - quorum-shared-migration/2026-05-29-mobile-adopt-shared-permission-helpers.md (the read-side hook rewire — Wave 0 builds on it)
related:
  - quorum-shared-migration/2026-05-30-mobile-adopt-shared-role-mutation-helpers.md (mutation helpers — separate, not part of Wave 0)
---

# Wave 0 — Permission enforcement on mobile (consume shared helpers)

> **One change, four gaps closed.** Mobile reimplements permission logic locally and never calls shared's `hasPermission` / `createChannelPermissionChecker` / `canManageReadOnlyChannel`. As a result several access-control checks desktop performs simply don't happen on mobile. Routing mobile through the shared helpers fixes all of them.

> **🔍 Second-pass verification (2026-06-12).** Every code claim below was re-verified against the live mobile/desktop/installed-shared source (4 parallel reads). All shared-helper availability, the `2.1.0-26` no-bump claim, and all 6 desktop references confirmed accurate. **Two corrections applied:** (1) **0.2 (@everyone) deferred to Wave 1** — mobile's entire mention-metadata pipeline is dead (always sends empty `mentions`, never sets `everyone:true`, no `@everyone` in autocomplete), so there is nothing concrete to *enforce* in Wave 0; the gate belongs on real metadata, which Wave 1 wires. (2) **0.4 corrected** — the channel screen does NOT expose a `currentChannel` object today; it does `channelsData.find(...)` only to pull `channelName` and discards the `Channel`. So 0.4 must first stop discarding that object. See inline notes.

## Why this is first (correctness, not feature work)

These are **live broken invariants**, not missing features. Desktop enforces them; mobile silently doesn't:

- **26a — `@everyone` unenforced** *(deferred to Wave 1 — see 0.2)*. Any space member *could* `@everyone` regardless of the `mention:everyone` role permission — **but mobile never sends `everyone:true` at all today** (no mention metadata is wired). So the *enforcement gate* has nothing to fire on in Wave 0; it lands with the mention pipeline in Wave 1.
- **26b — `user:mute` unenforced.** Mobile's mute is a local-only MMKV toggle with no permission check; any member can mute anyone. (Also a *local-only-vs-broadcast* convergence question vs desktop — see "Out of scope" below.)
- **27 — Read-only channels unenforced.** A channel set read-only on desktop and synced to mobile shows mobile users a fully active composer; they can post.
- **26c — Owner-permission masking (latent).** Mobile's permission hooks omit the `isSpaceOwner` short-circuit; masked at the one current caller, but breaks any future caller and the two zero-caller hooks.

All four share ONE root cause: **mobile duplicates a partial copy of permission logic instead of consuming shared.** Wave 0 ships the three *enforceable-today* gaps — **26b (mute), 27 (read-only), 26c (owner-masking)**; 26a (@everyone) rides along in Wave 1.

## No shared work, no version bump (verified 2026-06-12)

Everything needed is already in the published `@quilibrium/quorum-shared@2.1.0-26` that mobile has installed:

- `dist/index.d.ts` re-exports `* from './utils'`.
- Present in the installed dist (runtime + types): `hasPermission`, `getUserPermissions`, `getUserRoles` (`utils/permissions`), `createChannelPermissionChecker`, `hasChannelPermission`, `canManageReadOnlyChannel`, `UnifiedPermissionSystem` (`utils/channelPermissions`).
- `Channel.isReadOnly?: boolean` + `Channel.managerRoleIds?: string[]` are on the shared `Channel` type (`types/space.ts:56-57`), already imported by mobile.

Mobile currently imports **none** of the permission helpers (confirmed: zero hits for `canManageReadOnlyChannel` / `createChannelPermissionChecker`, and the only `from '@quilibrium/quorum-shared'` near permissions is types). So this is pure consumption work in `quorum-mobile`.

**Bump only matters for later waves** (receipts wire-types, `DMUpdateProfileMessage`), NOT this one.

---

## Shared helper signatures (already available)

```ts
// @quilibrium/quorum-shared  (utils/permissions.ts)
hasPermission(userAddress: string, permission: Permission, space: Space | undefined, isSpaceOwner?: boolean): boolean
getUserPermissions(userAddress: string, space: Space | undefined, isSpaceOwner?: boolean): Permission[]
getUserRoles(userAddress: string, space: Space | undefined): Role[]

// (utils/channelPermissions.ts)
createChannelPermissionChecker(context: PermissionContext): ChannelPermissionChecker
  // checker has 5 methods (verified): .canDeleteMessage(msg), .canPinMessage(msg), .canPostMessage(), .canKickUser(), .canMuteUser()
canManageReadOnlyChannel(userAddress: string, _isSpaceOwner: boolean, space: Space | undefined, channel: Channel | undefined): boolean
hasChannelPermission(userAddress, permission, space, isSpaceOwner, channel?, message?): boolean
```

Permission flags (parity OK on both apps): `'message:delete' | 'message:pin' | 'mention:everyone' | 'user:mute'` (`types/space.ts:14`). Kick is owner-only at the protocol level (no flag) on both.

---

## Tasks (do in order; each independently shippable but bundle the PR if small)

### 0.1 — Read-side hook rewire (fixes 26c)

This IS the existing task [`quorum-shared-migration/2026-05-29-mobile-adopt-shared-permission-helpers.md`](../quorum-shared-migration/.archived/2026-05-29-mobile-adopt-shared-permission-helpers.md) — do it first; everything below depends on having a correct `useHasPermission`.

- File: `hooks/chat/useRoleManagement.ts`
  - `useHasPermission` (line 56), `useUserPermissions` (line 78), `useUserRoles` (line 102) — currently inline `role.members.includes(...) && role.permissions.includes(...)` (lines 67, 89, 110).
  - Refactor to delegate to shared `hasPermission` / `getUserPermissions` / `getUserRoles`, passing a `{ roles }`-shaped space (shared only reads `space.roles`).
  - **Do NOT pass `isSpaceOwner` or add a `useIsSpaceOwner` helper.** Space owners have no implicit permissions except kick (which is protocol-level, not role-based). Other clients cannot verify owner identity, so owner status cannot grant permissions that other clients need to enforce. The `isSpaceOwner` short-circuit in the shared helpers is a bug, not a feature — do not adopt it. Always pass `false` (or omit, if the parameter is optional) for `isSpaceOwner` when calling shared helpers from mobile. Owners must assign themselves an explicit role like any other member.
- See that task file for the full skeleton + static-analysis gates (`grep -rn "role.members.includes" hooks/` must return zero).

### 0.2 — ~~Enforce `@everyone` at compose + send (fixes 26a)~~ → **DEFERRED TO WAVE 1**

> **Second-pass decision (2026-06-12): moved out of Wave 0.** There is nothing concrete to enforce on mobile today. Verified state of mobile's mention pipeline:
> - `services/space/spaceMessageService.ts` hardcodes `mentions: { memberIds: [], roleIds: [], channelIds: [] }` on **all 4 send paths** (lines 285/402/562/630). `extractMentionsFromText` is **never called** anywhere in mobile.
> - The `everyone` flag is **never set** — not even `everyone:false`. An `@everyone` typed by a user goes out as plain text with no metadata, so it does not notify the space the way desktop's does.
> - Mobile's autocomplete (`MessageInput.tsx`) has **no `@everyone` entry** to hide, and `MentionableText.tsx` has no `@everyone` render branch.
>
> So "enforce `@everyone`" in Wave 0 would be gating a code path that doesn't exist. The correct home is **Wave 1 (mentions, done right)**, where `extractMentionsFromText` gets wired on the send path and the `everyone:true` flag actually gets produced — *that* is the point to gate it on `hasPermission(..., 'mention:everyone', ...) || isSpaceOwner`.
>
> **Desktop references (for Wave 1):** compose gate `quorum-desktop/src/components/space/Channel.tsx:1128-1136` (`canUseEveryone`), send re-check `MessageService.ts:4626-4631`. Both verified to exist.

### 0.3 — ~~Enforce `user:mute` (fixes 26b)~~ → **DROPPED — based on a wrong premise**

> **Second-pass decision (2026-06-12): do NOT gate mobile's mute.** The task assumed mobile's mute is the same action as desktop's `user:mute` and just lacks the permission check. It is NOT. They are two different features that share a name:
>
> | | Desktop `user:mute` | Mobile mute (`useUserMuting.ts`) |
> |---|---|---|
> | What it does | **Broadcast moderation** — mutes a user for the *whole space* | **Personal hide** — hides messages only in *your own* client |
> | Wire | Sends a signed `MuteMessage`; every client applies it (after validating the sender's `user:mute` role on receipt — `MessageService.ts:1838-1898`) | MMKV-local, keyed `muted:<yourOwnAddress>:<spaceId>`; **never broadcast**, no receive handler |
> | Why a permission exists | It affects everyone → needs a moderation role | It affects only you |
>
> Mobile's mute (verified `hooks/chat/useUserMuting.ts`) is `loadMutedUsers(user.address, spaceId)` — a per-viewer hide, equivalent to muting a notification or scrolling past someone. **Gating a personal view-preference on a moderation role would be the wrong abstraction** (an owner could withhold the role to stop members filtering their own feed). So mobile's mute is **correctly ungated** — no change.
>
> **Also:** the mute *button* isn't even wired today — `onMuteUser` / `onToggleMuteUser` are never passed by any caller (`UserProfileModal` in `[channelId].tsx`, `SpaceSettingsModal` in `[id]/index.tsx`), so only the message-*filtering* half of `useUserMuting` is live. Nothing to gate.
>
> **The REAL mute gap (separate, deferred — NOT a Wave 0 permission item):** mobile has **no receive handler for incoming `mute` `MuteMessage`** (`WebSocketContext.tsx` has zero `mute` handling). A user muted by a moderator on desktop is still fully visible on mobile. Closing that is a **feature-port** (receive + validate sender `user:mute` role + apply broadcast mutes locally + drop muted users' messages), mirroring the receive-side validation we added for delete. Logged in the cross-repo follow-ups, not here.

### 0.4 — Enforce read-only channels (fixes 27)

- Desktop reference: `quorum-desktop/src/components/space/Channel.tsx:67-96` (`canPostInReadOnlyChannel`) → `canPost` → `<MessageComposer disabled>` lock banner at `1730-1738`; also suppresses typing broadcasts + shows a lock channel-icon.
- Mobile (ENFORCE — the urgent half):
  - `app/(tabs)/spaces/[id]/[channelId].tsx` — **the screen does NOT currently expose a `currentChannel` object.** Today [`[channelId].tsx:144-148`](../../app/(tabs)/spaces/[id]/[channelId].tsx) does `channelsData.find(c => c.channelId === channelId)` purely to read `channelName` and **discards** the `Channel`. First lift that `find` into a memoized `currentChannel` (so `isReadOnly`/`managerRoleIds` are available), then compute `canPost = canManageReadOnlyChannel(user.address, isSpaceOwner, spaceData, currentChannel)` (shared helper handles the `isReadOnly` + `managerRoleIds` logic). Pass `canPost` + `currentChannel?.isReadOnly` down.
    - *(Alternative considered: `createChannelPermissionChecker({...}).canPostMessage()` returns the same answer for read-only. Prefer the standalone `canManageReadOnlyChannel` — it's the narrowest dependency and matches the gap's intent.)*
  - `components/Chat/SpaceChatArea.tsx` — render `<MessageInput ... disabled={!canPost} />` (the `disabled` prop already exists: `MessageInput.tsx:32`, gates `editable` at line 811; it also gates `canSend` at line 271). Add a locked-composer banner (lock icon + "You cannot post in this channel") when `!canPost && currentChannel?.isReadOnly`.
- Mobile (SET — second half, optional in Wave 0, ~1-2 days): add an `isReadOnly` Switch + `managerRoleIds` multi-picker to the channel editor in `components/SpaceSettingsModal.tsx` (verified: zero `isReadOnly`/`managerRoleIds` references there today). The hook layer already persists both fields — `useChannelManagement.ts` `isReadOnly` at lines 40/80/131/159, `managerRoleIds` on the immediately following lines 41/81/132/160 (params interfaces + channel-object literals); the editor just doesn't surface them. Desktop reference: `ChannelEditorModal.tsx:158-211` (verified).

---

## Out of scope for Wave 0 (record, don't do here)

- **Cross-platform mute (the real mute gap).** Mobile's mute is a personal local hide and is correctly ungated (see dropped 0.3). The genuine gap is that mobile doesn't RECEIVE desktop's broadcast mutes — a feature-port (receive + validate sender `user:mute` role + apply + drop muted users' messages). Separate, deferred; flag to lead dev, don't bundle.
- **`@everyone` enforcement (26a)** — moved to Wave 1 (see 0.2 above). Nothing to enforce until the mention pipeline produces an `everyone:true` flag.
- **Full mention send-metadata** (`extractMentionsFromText` on send, `@<address>` wire-format alignment, autocomplete roles/@everyone). That's **Wave 1** and needs a `quorum-shared` change + publish. Wave 0 only does the read-only enforcement gate (mute dropped, @everyone deferred), not the mention pipeline rewrite.
- **Channel mentions (`#channel`).** Unprivileged on both platforms (no `mention:channel` permission exists in shared/desktop/mobile), so they are correctly out of scope for a permission task. BUT note for Wave 1: mobile's `#channel` is also broken cross-platform — mobile composes/renders bare `#channelName` while desktop uses `#<channelId>`, and mobile never populates `mentions.channelIds`. Same wire-format mismatch as user mentions; fix it in the Wave 1 mentions cluster, not here.
- **Mutation helpers** (`toggleRolePermission`/`setRolePermissions`) — separate task `2026-05-30-mobile-adopt-shared-role-mutation-helpers.md`.

---

## Static-analysis verification gates

- [ ] `yarn tsc --noEmit` passes
- [ ] `yarn lint` passes
- [ ] `grep -rn "role.members.includes" hooks/` → zero (0.1 done)
- [ ] `grep -rn "createChannelPermissionChecker\|canManageReadOnlyChannel\|hasPermission" --include=*.ts --include=*.tsx hooks/ components/ app/` shows mobile now imports the shared helpers (0.3/0.4 done)
- [ ] `<MessageInput` in `SpaceChatArea.tsx` now receives a `disabled` derived from `canPost` (0.4)

## Runtime test requirements (required — behavior changes)

1. **Owner** of a space: owner-only/role actions appear; can post in read-only channels they manage. *(`@everyone` is Wave 1.)*
2. **Non-owner with a role** granting `message:pin`/`user:mute`: those actions available, others gated.
3. **Non-owner without the role**: cannot mute, composer is locked in a read-only channel (banner shown), can post normally in a regular channel.
4. **Read-only channel synced from desktop**: a non-manager mobile user sees the locked composer, NOT a live input. A manager can post.
5. Switch identities mid-session if possible: gates update.

## Pre-filled mobile PR description

```markdown
## What
Route mobile permission checks through `@quilibrium/quorum-shared` instead of local reimplementations,
closing three enforcement gaps: `user:mute`, read-only-channel posting, and the
owner-permission masking footgun. (`@everyone` enforcement is deferred to Wave 1 — mobile's mention
pipeline sends no metadata today, so there is nothing to gate yet.)

## Cross-repo
- quorum-shared: ✅ no change — helpers verified present in installed `2.1.0-26` dist, runtime + types
  (`hasPermission`, `createChannelPermissionChecker`, `canManageReadOnlyChannel`). No version bump.
- quorum-desktop: not affected (already uses these helpers).
- quorum-mobile: THIS PR.

## Why
Mobile duplicated a partial copy of permission logic and never enforced `user:mute` or read-only
channels. Desktop enforces both; mobile silently allowed them. This is a correctness/access-control fix.

## Behavior change (intentional)
- Non-privileged members can no longer mute others or post in read-only channels.
- Owners now correctly see owner-derived permissions from the permission hooks.

## Verification
- [ ] tsc + lint clean
- [ ] `grep -rn "role.members.includes" hooks/` → zero
- [ ] Manual QA per the task's runtime matrix (owner / role-holder / non-member / read-only channel)
```

## Desktop-side bookkeeping reminder

Mobile's `.agents/` is gitignored. After creating this file, add a row to the desktop tracker
`../quorum-desktop\.agents\tasks\quorum-shared-migration\mobile-tasks-pending.md`
(Category `feature-port`, or `convergence` for the mute piece) so it has GitHub visibility, and
mark candidates.md rows 26a-c/27 as 🚧 task-dropped.

*Last updated: 2026-06-12 — second-pass verification: all claims confirmed against live source; 0.2 (@everyone/26a) deferred to Wave 1 (mobile mention pipeline sends no metadata, nothing to enforce); 0.4 corrected (no `currentChannel` exposed today); channel-mentions scope clarified (unprivileged, belongs to Wave 1 wire-format fix).*
