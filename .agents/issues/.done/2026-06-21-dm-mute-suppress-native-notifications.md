---
type: task
title: "DM mute — suppress NATIVE (OS) notifications for muted DMs in the background"
status: done
created: 2026-06-21
updated: 2026-06-25
source: follow-up from the DM-mute branch (dm-mute-sync-across-devices)
priority: medium
effort: small (reuses existing lookup; no new infrastructure)
---

# Suppress native notifications for muted DMs (background / killed app)

## Status

shipped 2026-06-25 on branch feat/dm-mute-native-suppress-and-edit-history


## ✅ SHIPPED 2026-06-25 (branch `feat/dm-mute-native-suppress-and-edit-history`)

Implemented exactly as planned below: added a `type:'inbox'` DM-mute gate in
`services/notifications/pushReceivedTask.ts`, right after the global-mute check
and alongside the existing per-space/per-channel gates. Resolves
`inbox_address → conversationId` via a lazy `require` of `encryptionStateStorage`
(mirroring NotificationService) and uses the already-exported
`isConversationMutedForCurrentUser(conversationId)` helper (cleaner than the
3-step resolve in the plan). Fails open when the inbox can't be resolved. The
honest caveats below (silent wake-push still arrives; iOS background not 100%;
generic batch banner) remain inherent and are NOT bugs to chase.

## Context

The DM-mute branch (`dm-mute-sync-across-devices`) suppresses muted-DM
notifications on the **foreground / decrypted path** (`showMessageNotification`
checks `isConversationMutedForCurrentUser`) and excludes muted DMs from the
in-app unread bubble. But when the app is **backgrounded or killed**, a muted DM
can still produce a **native OS notification** (lock-screen banner). This task
closes that.

## Why it happens (verified)

Push model is **silent/data-only pushes that wake the app to render
notifications locally** (E2E: the server can't decrypt, so it sends only generic
data — `type`, `hub_address`/`inbox_address`, `seq`):

1. Server sends silent push → OS wakes the background task
   `services/notifications/pushReceivedTask.ts`.
2. That task gates on global + per-space + per-channel mute (lines ~78-132),
   then calls `checkForNewMessages` → `showMessageNotification`, which RENDERS
   the native banner.
3. **For `type: 'inbox'` DM pushes there is NO DM-mute gate.** The push flows
   straight to `checkForNewMessages`, which posts a GENERIC "New Message" banner
   with no conversationId — so the conversationId-based mute check in
   `showMessageNotification` is never reached.

Key insight: **the native banner is rendered BY our JS in the wake-task**, not by
the server. So our mute logic CAN run in the background — we just need to gate
the `type: 'inbox'` path before it renders.

## The fix (reuses existing code)

In `pushReceivedTask.ts`, add a DM-mute gate alongside the existing space/channel
gates, for `type: 'inbox'` pushes:

1. Resolve `inbox_address → conversationId` via
   `encryptionStateStorage.getConversationInboxKeypairByAddress(inbox_address)`
   — **the exact lookup this same file already uses for deep-link routing**
   (see `NotificationService.ts` ~line 277, `case 'inbox'`). MMKV-backed, fully
   synchronous, works in the background task.
2. Resolve the current user via the existing `getCurrentUserAddress()` helper
   already in `pushReceivedTask.ts` (reads `auth:user`).
3. Check `getLocalMutedConversations(address).includes(conversationId)` (already
   exported from `@/services/config`).
4. If muted → `return` early, before `checkForNewMessages`. No native banner is
   rendered.
5. **Fail open:** if the inbox→conversationId lookup returns nothing (brand-new
   conversation, never-decrypted inbox), do NOT suppress — show the notification.

## Files

- `services/notifications/pushReceivedTask.ts` — add the `type: 'inbox'`
  DM-mute gate (mirror the existing per-space / per-channel gate structure).
- (no new exports needed: `getConversationInboxKeypairByAddress`,
  `getLocalMutedConversations`, `getCurrentUserAddress` all already exist.)

## Honest caveats (cannot be fully closed — document, don't chase)

1. **The silent wake-push still arrives.** We suppress *rendering*, not the push
   itself. Stopping it at the source needs server-side per-conversation muting,
   which is IMPOSSIBLE under E2E — the server can't decrypt to know the
   conversation. (Per-space mute IS server-side via `muted_hubs` because hubs
   aren't encrypted; per-DM can't be. Same reason per-channel mute is also
   client-side — see `notificationPrefs.ts:21`.) Minor battery/data cost only.
2. **iOS background execution isn't 100% guaranteed.** iOS usually runs the data-
   push background task, but low-power mode / throttling can occasionally skip
   it → a generic banner slips through. Android is reliable. Inherent to
   client-side rendering; can't be fully closed.
3. **Generic batch banner.** The WebSocket batch path
   (`BackgroundMessageService.ts:239`) posts a generic "New Message" with no
   conversationId. Even with this gate, if multiple DMs (some muted, some not)
   arrive in one wake, the generic banner may still fire for the non-muted ones.
   The gate above handles the single-inbox push case (the common one); the batch
   case degrades to "shows generic banner if ANY unmuted DM is present," which is
   acceptable.

## Verification

- Android, app killed: mute a DM on device A → send from device B → no native
  notification on A. Unmuted DM → notification still arrives.
- iOS, app backgrounded: same (accept occasional slip-through per caveat 2).

> ⚠️ Runtime verification of the killed-app suppression is still PENDING (needs
> two physical devices + a release build). Code is in and statically verified,
> but the background-task path can only be truly confirmed on-device.

*Last updated: 2026-06-25*
