---
type: task
title: "Task D — Personal Block user (rename mobile's viewer-side hide + sync it)"
created: 2026-06-21
status: done
build-order: 4 (last — ships independently of the shared npm publish)
repos: mobile (shared `blockedUsers`/`blockUtils` DONE — merged, awaiting lead publish)
risk: medium (new synced field; cross-repo sequencing)
---

# Task D — Personal "Block" user

> ## ✅ IMPLEMENTED (2026-06-22, branch `feat/personal-block-user`)
> Mirrors the shipped desktop feature (see `task-DESKTOP-personal-block.md`):
> per-space, render-time reversible filter, confirm modal with the three-fact copy,
> one-tap unblock, neutral/secondary Block button. What landed:
> - `services/config/configService.ts`: `getLocalBlockedUsers` / `setBlockedUsers`
>   (untyped `(config as any).blockedUsers[spaceId]`), `blockedUsers` added to the
>   inbound preservation list.
> - `hooks/chat/useBlockUser.ts`: config-backed `useSyncExternalStore` store +
>   one-time migration from the legacy `space-user-mutes` MMKV; exposes
>   `blockedUsers` / `isUserBlocked` / `toggleBlockUser` / `filteredMessages`.
>   Old `useUserMuting.ts` DELETED; all consumers updated.
> - `components/BlockUserModal.tsx`: new confirm sheet (KickUserModal pattern;
>   handles Block + Unblock).
> - `UserProfileModal`: props renamed `onMuteUser`/`isUserMuted` →
>   `onBlockUser`/`isUserBlocked`; row relabeled Block/Unblock; opens the confirm
>   sheet. Member-list quick-action in SpaceSettingsModal re-iconed to block.
> - **Icons:** Block = `hand.raised.fill` (= desktop `hand-stop`). Unblock = `eye`
>   (TEMP — desktop uses `hand-off`, not yet in published quorum-shared; swap when
>   it lands). Block list still untyped `(config as any)` — same as channel mute;
>   swap to typed shared `blockedUsers` on the next bump.
> - **Reachability (UX, added after testing):** a blocked user vanishes from the
>   stream, and the member list is sometimes incomplete, so there was no reliable
>   way back to their profile to unblock. Fix: a **"Blocked (N)" accordion** at the
>   TOP of the Space Settings → Members tab (hand icon, collapsed by default so a
>   long block list stays compact, only shown when ≥1 user is blocked). It reads
>   from the synced block config (not the member list), so a blocked user is always
>   reachable to unblock even if absent from the member list. Block icon was REMOVED
>   from the per-member quick-action row (block/unblock lives in the profile modal +
>   this accordion only). Confirm-sheet Block button is primary; Unblock button is
>   neutral (not danger).
> Static-clean (tsc + lint). Tested green on Android. Pending iOS review.

**Goal:** mobile's existing viewer-side "mute user" (hide a user's messages from
YOUR own stream) is really a personal **Block**. Rename it to "Block" to end the
mute/block confusion, and move its state to `UserConfig.blockedUsers` so it SYNCS
across the user's devices (today it's device-local MMKV).

This is personal/viewer-side — NOT moderation (Task C). Blocking affects only what
YOU see; it does not touch the user for anyone else and needs no permission.

---

## Current state
`hooks/chat/useUserMuting.ts` (the personal one): device-local MMKV
(`space-user-mutes`, key `muted:<userAddress>:<spaceId>`), `Set<string>` of hidden
user ids per space. Filters messages in `components/Chat/SpaceChatArea.tsx:300`
via `filteredMessages`. UI: `UserProfileModal.tsx:327-336` (the bell "Mute"/"Unmute"
ActionRow). No sync.

**Decision (user):** keep the behavior (personal hide), rename to **Block**, make
it sync. Desktop has NO equivalent → separate desktop task
(`task-DESKTOP-personal-block.md`).

---

## Cross-repo: the shared field (additive — does NOT block mobile; see README §3b)

**Publish constraint:** we can't publish shared ourselves; mobile would be blocked
waiting for the lead. So mobile ships now via the untyped config path, and the
shared typing is a parallel cleanup.

- [x] **quorum-shared — ✅ DONE (merged in 2.1.0-33; awaiting lead npm publish):**
      added `blockedUsers?: { [spaceId: string]: string[] }` to `UserConfig`
      (per-space, LOCKED) + `blockUtils` helpers `isUserBlocked(userAddress, spaceId,
      blockedUsers)` and `getBlockedUsersForSpace(spaceId, blockedUsers)`. Merged
      PR #48 (`51ab9b6`), build green, version `2.1.0-33` (`0ff099e`). Desktop
      consumes the same field later (Task DESKTOP) — "define once, plug into both."
- [ ] **Mobile ships NOW, untyped:** store/read `blockedUsers` via
      `(config as any).blockedUsers`, the same proven pattern as
      `mutedConversations` (`configService.ts:402-407`). The rename + cross-device
      sync is the user value; typing is cosmetic. Swap to the typed shared field on
      the next mobile bump; mark casts `// TODO: type via shared blockedUsers once
      published`.

## Mobile changes (after shared is published + bumped)
- [ ] Rename the personal hook (names LOCKED, README §0b):
      `hooks/chat/useUserMuting.ts` → `hooks/chat/useBlockUser.ts`, exporting
      `blockedUsers`, `toggleBlockUser`, `isUserBlocked`, `filteredMessages`. Update
      the `SpaceChatArea.tsx:300` consumer and ALL imports. After this rename, NO
      symbol named `*UserMuting` / `mutedUsers` / `isUserMuted` may refer to the
      personal hide — those words are Task C's moderation feature.
- [ ] **Farcaster disambiguation (Collision 2):** do NOT touch or merge with the
      existing `hooks/useBlockedFids.ts` / `hooks/useMutedFids.ts` — those mirror
      Farcaster's external block/mute lists keyed by numeric FID. The Quorum-space
      block keys by user ADDRESS + spaceId in UserConfig. Different systems; the
      signature (`address`+`spaceId` vs `fid: number`) is the guard. Keep them
      separate; no cross-import.
- [ ] Move state from MMKV `space-user-mutes` to `UserConfig.blockedUsers` via the
      **bookmark pattern** (README §2): write through `configService`, read back via
      a `getLocalBlockedUsers(...)` helper (NOT the `user` object), and ADD
      `blockedUsers` to the inbound preservation list at `configService.ts:394-408`.
- [ ] One-time migration: seed `UserConfig.blockedUsers` from the existing
      `space-user-mutes` MMKV entries (consume-once, like `useDMMute`), so nobody
      loses their current hides.
- [ ] Module-level `useSyncExternalStore` store so a block toggles the stream
      filter instantly (the `filteredMessages` memo must recompute) — same lesson
      as `useDMMute`.

## UI relabel + confirmation modal

> **Why this is now urgent (user feedback 2026-06-21):** with Task C shipped, the
> UserProfileModal shows BOTH the personal action (still labelled "Mute" — the bell
> row) AND the moderation "Mute in Space" row. **Two rows both saying "Mute" is
> actively confusing.** Renaming the personal one to "Block" is what disambiguates
> them. The user tested the personal action and confirmed its behaviour: it hides ALL
> of the target's messages (past + new) from the SPACE stream, but ONLY for the muting
> user, and ONLY in that space — correct personal-block semantics.

- [ ] `UserProfileModal` action row: relabel "Mute"/"Unmute" → "Block"/"Unblock";
      pick a block-appropriate icon (e.g. `hand.raised` / `nosign`) distinct from
      the bell used for notification mute. Ensure it sits alongside (not replacing)
      Task C's moderation "Mute in Space" row — both can be present for a moderator.
- [ ] **Add a confirmation modal for Block (user request 2026-06-21).** Tapping
      Block should open a short confirm sheet (pattern: `KickUserModal` /
      `MuteUserModal`) explaining BRIEFLY what happens, then confirm/cancel. Copy
      must convey the three facts the user called out:
      - hides **all** of this user's messages (past and new) from your view,
      - **only for you** (other members still see them),
      - **only in this space**.
      Suggested copy: *"Block @name? You won't see any of their messages in this
      space. This only affects your view, and only in this space. You can unblock
      anytime."* Unblock can stay one-tap (or a lighter confirm). Keep it a
      `BaseModal`/`CenterModal` consistent with KickUserModal; mind the iOS modal-
      stacking note (atlas §3) since it opens over UserProfileModal.
- [ ] Audit copy everywhere the old "mute user" wording appears so the app no
      longer says "mute" for this personal-hide action.

## Verification
- [ ] Shared `npm run build` green for the (parallel, non-blocking) shared PR.
- [ ] Mobile ships independently of the shared publish (untyped path) — confirm the
      `(config as any).blockedUsers` round-trips: write on one device, read back via
      `getLocalBlockedUsers`.
- [ ] Mobile TS build + lint clean; no dangling `useUserMuting` (personal) refs.
- [ ] Runtime (Android): block a user → their messages vanish from your stream;
      unblock restores; (if 2nd device) the block syncs across devices.
- [ ] iOS review: action-row + icon render; modal stacking unaffected.

## Open questions for user
- Per-space block (current) vs global block (block once, hidden everywhere)?
  Recommend per-space to match today; easy to widen later.
- ~~Final label~~ DECIDED (2026-06-21): UI label is **"Block" / "Unblock"**; code
  symbols are `useBlockUser` / `blockedUsers` / `isUserBlocked` (README §0b).

## Related
- Folder overview: `README.md`
- Desktop gap task: `task-DESKTOP-personal-block.md`
- Pattern: `hooks/chat/useDMMute.ts`, bookmark pattern (README §2).
- Shared type: `quorum-shared/src/types/user.ts`.

*Last updated: 2026-06-21*
