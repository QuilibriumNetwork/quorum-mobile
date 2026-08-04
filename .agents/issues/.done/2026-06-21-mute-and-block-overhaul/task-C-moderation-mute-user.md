---
type: task
title: "Task C — Moderation mute-user (mobile, full desktop parity)"
created: 2026-06-21
status: done
build-order: 1 (done)
repos: mobile only (shared already complete)
risk: medium-high (receive-side validation + wire protocol)
---

# Task C — Moderation mute-user (mobile)

> ## ✅ SHIPPED (2026-06-22)
> Merged via **PR #125** (squash) to mobile `master`, carrying both this feature and
> the chat-scroll-jump fix that had blocked it. The blocker
> (chat-list-jumps-to-top-on-modal-open) was fixed via
> `patches/react-native-keyboard-controller+1.21.11.patch`.
> **NB the original root-cause theory in this file was WRONG:** it was NOT a FlashList
> `startRenderingFromBottom` re-anchor (that was falsified on-device — disabling MVCP
> still jumped). The real cause was `KeyboardChatScrollView` chasing a FOCUS-LESS
> keyboard event (`target <= 0`) that a native Modal emits on mount. Solved writeup:
> `.agents/issues/.done/2026-06-21-chat-list-jumps-to-top-on-modal-open.md`.
> **iOS verification pending** — `.agents/docs/ios-verification-checklist.md` (items 1 & 2).

**Goal:** a moderator with the `user:mute` role permission can mute/unmute a user
in a space. The mute broadcasts a signed `MuteMessage`; every client validates it,
drops the muted user's incoming messages, and disables that user's composer.
**Full desktop parity** (incl. duration/expiry). This is a moderation action —
NOT the personal "Block" (that's Task D).

This is the FIRST task because it's the most self-contained: **shared already has
everything**, and mobile already has the `useUserKicking` broadcast pattern to copy.

---

## What already exists (do not rebuild)

**In quorum-shared (no shared PR needed):**
- `MuteMessage` type — `quorum-shared/src/types/message.ts:105`
  (`{ senderId, type:'mute', targetUserId, muteId, timestamp, action:'mute'|'unmute', duration? }`),
  in the `MessageContent` union, exported from root.
- `canonicalize()` mute branch — `quorum-shared/src/utils/canonicalize.ts:117`.
- `canMuteUser()` + `createChannelPermissionChecker` —
  `quorum-shared/src/utils/channelPermissions.ts:129`.
- `'user:mute'` permission token — `quorum-shared/src/types/space.ts:14`.

**On mobile (patterns to copy / extend) — ✅ refs re-verified 2026-06-21:**
- **Outbound send path (REFINED):** `sendGenericMessage` IS at
  `services/space/spaceMessageService.ts:602`, but it is **private (not exported)**.
  The public wrappers each call it — copy **`sendDeleteMessage` (lines 795-806)** as
  the exact template: add an exported `sendMuteMessage({ spaceId, channelId,
  senderAddress, content })` that builds a `MuteMessage` and calls
  `sendGenericMessage`. (NOTE: `kickUser` lives in `spaceService.ts:528` and is a
  DIFFERENT, heavier path — full crypto rekey. Mute is a plain message → follow
  `sendDeleteMessage`, NOT `kickUser`, for the SEND. Use `useUserKicking`'s hook
  shape only for the React wrapper, see below.)
- `hooks/chat/useUserKicking.ts` — the hook SHAPE to copy (state + `enqueueOutbound`
  + invalidate queries). Its name in the LOCKED scheme is `useModMuteUser` (README
  §0b). Note kick calls a rekey service; mute instead calls `sendMuteMessage` — same
  hook skeleton, different inner call.
- `components/KickUserModal.tsx` — the confirm-modal pattern. Copy for `MuteUserModal`
  (add the duration picker).
- `context/WebSocketContext.tsx` receive pipeline — ✅ verified: `remove-message`
  handler with `createChannelPermissionChecker` + `canDeleteMessage` at **live
  1926-1964** and **batch 3257-3282**; default-deny gates at **live 2100 / batch
  3366**. Mute's receive branch copies this structure, swapping `canDeleteMessage`
  → `canMuteUser`.
- **PERSISTABLE_TYPES (`components/Chat/types.ts:34-45`) — ✅ verified `'mute'` is
  NOT in it.** IMPORTANT design note from the invariant comment (types.ts:47-52):
  `remove-message` is deliberately ABSENT from the set because it's an *applied/
  consumed* control type (mutates state, mapped to a render type, consumed before
  the save path) — NOT a persisted chat message. **Mute is the same: a consumed
  control message. So do NOT add `'mute'` to PERSISTABLE_TYPES** (kick IS in the set
  because a kick renders as a system message; mute renders nothing). Handle mute like
  `remove-message`: intercept + apply in the receive branch, then drop.
- `components/UserProfileModal.tsx` — ✅ verified: action-rows area at **313-348**;
  existing viewer-side mute bell (Task D's, do NOT touch here) at **327-336**;
  `KickUserModal` wired at **351-360** gated by `canKick`.
  **⚠️ GATING (critical — don't copy kick's gate):** `canKick = isSpaceOwner &&
  spaceId && !isSelf` (line 179). Mute must NOT use `isSpaceOwner` — per the desktop
  doc + memory `space-owner-only-kick-no-implicit-permissions`, moderation mute
  requires the **`user:mute` ROLE permission** via `createChannelPermissionChecker(
  …).canMuteUser()`, with NO owner bypass (receiver can't verify owner identity).
  UserProfileModal already receives `roles` + `spaceId` props (lines 40-41) — build
  the checker from those. The mod-mute row is SEPARATE from the bell row at 327-336.

**Naming (LOCKED — see README §0b):** the moderation hook is `useModMuteUser`
(file e.g. `hooks/chat/useModMuteUser.ts`), exporting `muteUser` / `unmuteUser` /
`muting`. The words "mute" / `mutedUsers` / `isUserMuted` / `canMuteUser` belong to
THIS moderation feature. The personal hide (currently `useUserMuting`) is being
renamed to `useBlockUser` in Task D — do NOT touch or overload it here. UI label is
**"Mute" / "Unmute"** (matches desktop + the shared `MuteMessage` type).

---

## What's MISSING (this task builds it)

1. **Outbound send** — no `sendMuteMessage` in `spaceMessageService.ts`
   (`MuteMessage` isn't even imported there).
2. **Moderation hook** — no mobile hook that broadcasts a `MuteMessage` (the
   existing `useUserMuting` is MMKV-only viewer-side).
3. **Receive-side handler** — `MuteMessage` is dropped silently. `'mute'` is NOT
   in `PERSISTABLE_TYPES` (`components/Chat/types.ts:34-45`); both receive paths
   default-deny unknown types (live **2100**, batch **3366**). Must add a `'mute'`
   branch BEFORE those gates on both paths.
4. **Receive-side validation** — no `canMuteUser()` call in the receive pipeline.
5. **Muted-user storage** — mobile has no `muted_users` store / `isUserMuted` /
   `MutedUserRecord` (shared has none either; desktop keeps it in IndexedDB). Need
   a mobile-local store (MMKV) keyed `[spaceId, targetUserId]` with `expiresAt`.
6. **Message-stream drop** — muted senders' messages must be dropped at receive
   (desktop drops at `addMessage`; mobile drops in the receive pipeline before
   persist, mirroring the kick/remove handling).
7. **Composer disable** — if the CURRENT user is muted in this space, disable the
   composer with a "You are muted…" message (+ auto-re-enable on expiry).
8. **`MuteUserModal`** — duration picker (0 = forever, 1–365 days), confirm.
9. **UserProfileModal mod-mute row** — permission-gated "Mute"/"Unmute" action.

---

## Desktop reference (mirror its semantics exactly)

Desktop doc: `quorum-desktop/.agents/docs/features/mute-user-system.md`. Key
invariants to preserve (these are SECURITY properties — do not relax):

- **Client-enforced, receive-side validated.** Each client independently honors
  mute; validation happens on receive, not trust-on-send.
- **No space-owner bypass.** Owner must hold a `user:mute` role like anyone else
  (receiver can't verify owner identity — privacy). Matches mobile memory
  `space-owner-only-kick-no-implicit-permissions`.
- **Reject on receive if:** it's a DM (mute is space-only); self-mute
  (sender === target); space data unavailable (FAIL-SECURE — reject); sender lacks
  `user:mute`; duplicate `muteId` (replay protection).
- **Duration:** `0` days → `duration` undefined (forever); `1-365` → `expiresAt =
  timestamp + duration`. Expiry checked at read time; a `setTimeout` re-enables the
  composer when a timed mute lapses (JS setTimeout ~24.8d cap is acceptable).
- **Silent:** no public "X was muted" message. Muted user learns via disabled
  composer only.
- **`MuteMessage` is canonicalized + signed** identically to desktop (shared's
  `canonicalize` already covers `duration`) so cross-platform mutes verify.

---

## Implementation checklist

### Outbound
- [ ] Import `MuteMessage` in `services/space/spaceMessageService.ts`; add an
      EXPORTED `sendMuteMessage({ spaceId, channelId, targetUserId, action,
      duration? })` that builds the content (unique `muteId`, `timestamp`,
      `senderId = self`) and calls the private `sendGenericMessage` (line 602).
      **Template: copy `sendDeleteMessage` (lines 795-806)** — same wrapper shape.
- [ ] New moderation hook `hooks/chat/useModMuteUser.ts` (name LOCKED, README §0b):
      `muteUser`, `unmuteUser`, `muting` state. Optimistically write local mute
      store; broadcast; invalidate `['mutedUsers', spaceId]`. Mirror `useUserKicking`.

### Storage
- [ ] Mobile muted-user store (MMKV, e.g. `space-user-mod-mutes`), keyed
      `mute:<spaceId>:<targetUserId>`, record `{ spaceId, targetUserId, mutedAt,
      mutedBy, lastMuteId, expiresAt? }`. Helpers: `getMutedUsers(spaceId)`,
      `isUserMuted(spaceId, userId)` (incl. expiry), `setMute(...)`, `removeMute(...)`,
      `getMuteByMuteId(muteId)` (replay guard). Mirror desktop `MessageDB` methods.
- [ ] **Consider:** should this be a `useSyncExternalStore` module store (like
      `useDMMute`) so the composer + profile + list react instantly to a received
      mute? Recommended — a received mute must update UI without remount.

### Receive pipeline (`context/WebSocketContext.tsx`)
- [ ] **Do NOT add `'mute'` to PERSISTABLE_TYPES** (verified 2026-06-21). Handle it
      like `remove-message`: a consumed control message that mutates state and is NOT
      saved as a chat message. (kick IS persisted because it renders a system
      message; mute renders nothing.) Add the `'mute'` branch ALONGSIDE the
      `remove-message` branch (live **1926-1964**, batch **3257-3282**), before the
      default-deny gate (live **2100**, batch **3366**).
- [ ] **Live path** (in/near the `remove-message` branch ~1926): add a
      `contentType === 'mute'` branch — build `createChannelPermissionChecker` for
      the sender, call `canMuteUser()`; on pass, run the validation set
      (DM/self/duplicate/fail-secure), then write the mute store (or remove on
      `action:'unmute'`). Copy the exact checker construction from the
      `remove-message` block at **1953-1960**.
- [ ] **Batch path** (near **3257-3282**): same handling, copying **3274-3280**.
- [ ] **Drop muted senders' messages:** in BOTH paths, before persisting an
      incoming chat message, check `isUserMuted(spaceId, senderId)` and drop if
      muted (mirror desktop `addMessage` line ~2029-2035). Mind ordering: a mute
      arriving in the same batch should apply before sibling messages are persisted
      where feasible — match desktop's intent; document any divergence.

### Composer disable
- [ ] In the space composer (`components/Chat/MessageInput.tsx` / `SpaceChatArea`):
      if `isUserMuted(spaceId, currentUserAddress)`, disable input + show
      "You are muted…" (timed vs forever copy). Add a `setTimeout` keyed on
      `expiresAt` to re-enable on lapse (invalidate the mute store / emit).
- [ ] Reuse / add a `formatMuteRemaining(expiresAt)` helper (desktop has one in
      `utils/dateFormatting.ts`).

### UI
- [ ] `components/MuteUserModal.tsx` — copy `KickUserModal` shape; add numeric
      duration input (0-365, clamp, filter non-numeric; 0 = forever; default 1).
      Confirm → `muteUser(target, days)`. Success copy + auto-close.
- [ ] `UserProfileModal` — add a permission-gated mod-mute `ActionRow` (distinct
      from the viewer-side bell). Show only when the VIEWER has `canMuteUser()` in
      this channel and target ≠ self. Label "Mute"/"Unmute" by current state. Wire
      the modal like `KickUserModal` at 350-360. Pass `spaceId`/`channelId` so the
      permission check has channel context.
- [ ] Pass the needed props from the channel screen
      (`app/(tabs)/spaces/[id]/[channelId].tsx`) — it currently does NOT pass mute
      props to children in some paths (see Task A/B note + the explore findings).

### Verification (atlas: high mobile bar, iOS by review)
- [ ] TS build + lint + grep clean.
- [ ] **Runtime (Android, user-tested):** mute a user from another account →
      their new messages don't appear; their composer disables; unmute restores;
      timed mute auto-expires. Flag to user — this needs a real device test, do not
      claim tested.
- [ ] **iOS review pass:** `MuteUserModal` stacking over `UserProfileModal`
      (BaseModal `animationType="none"` vs `CenterModal` `"fade"` — atlas §3 native
      Modal stacking), Switch/duration-input behavior, safe-area on the modal.

---

## Open questions for the user (resolve during impl, not blocking the plan)
- Does mobile want the duration picker UI exactly like desktop (numeric 0-365), or
  a simpler "Mute / Mute 24h / Mute forever" preset set? (User chose "full desktop
  parity" → default to the numeric picker unless they say otherwise.)
- Should a received mod-mute also surface a toast/log to moderators? Desktop is
  silent; default to silent.

## Related
- Folder overview: `README.md`
- Desktop: `quorum-desktop/.agents/docs/features/mute-user-system.md`
- Pattern: `hooks/chat/useUserKicking.ts`, `components/KickUserModal.tsx`
- Memory: `space-owner-only-kick-no-implicit-permissions`,
  `role-permissions-work-assignment-ui-dark`

## Reference verification (2026-06-21 — pre-build pass, no code yet)
All key refs re-confirmed against current `master`:
- ✅ Receive pipeline: `remove-message` handler + `createChannelPermissionChecker`/
  `canDeleteMessage` at live **1926-1964** / batch **3257-3282**; default-deny at
  live **2100** / batch **3366**. Line numbers accurate.
- ✅ `PERSISTABLE_TYPES` (`components/Chat/types.ts:34-45`) lacks `'mute'`; invariant
  comment confirms control types like `remove-message` are intentionally excluded →
  **mute must NOT be added** (handle-and-drop, like remove-message).
- ✅ Outbound: `sendGenericMessage` private at `spaceMessageService.ts:602`; copy the
  exported `sendDeleteMessage` (795-806) wrapper. (`kickUser` is a separate rekey
  path in `spaceService.ts:528` — not the send template.)
- ✅ `UserProfileModal`: actions **313-348**, bell **327-336**, KickUserModal
  **351-360**. ⚠️ `canKick` uses `isSpaceOwner` (line 179) — mute must use
  `canMuteUser()` instead (no owner bypass). `roles`+`spaceId` props already present.
- ✅ Shared symbols (`MuteMessage`, `canMuteUser`, `canonicalize`) present in
  installed `2.1.0-32` — C needs no shared publish.

**Verdict:** task is accurate and build-ready. No blockers.

*Last updated: 2026-06-21 — references re-verified pre-build; refined send-path
(copy sendDeleteMessage), PERSISTABLE_TYPES (don't add mute), and gating (canMuteUser
not isSpaceOwner). No code written yet.*
