---
type: task
title: "Mention-aware native push (label space pushes as mention/reply/role, no message body)"
status: open
created: 2026-06-23
urgency: low (idea — discuss with lead first)
shared_change: unknown (likely none)
version_bump: unknown
runtime_test: required (on real device)
needs_discussion: project lead — privacy intent + NSE build state
related_docs:
  - .agents/docs/2026-06-23-notification-system-mobile-vs-desktop.md
  - .agents/issues/.done/2026-06-21-dm-mute-suppress-native-notifications.md
  - ios/QuorumNotificationService/README-NSE-LINKING.md
---

# Mention-aware native push

## Idea

Today a space message produces a native (lock-screen) push titled with the SPACE
NAME and body "New message" — generic, with no indication it's a mention/reply.
Make the push say what KIND of attention it is, WITHOUT showing message content:
- "You were mentioned in <Space>"
- "Someone replied to you in <Space>"
- "A role you have was mentioned in <Space>"
- (plain message → keep generic "New message" or suppress, TBD)

Type + space only. **No message body** — that stays deliberately hidden (privacy).

## ⚠️ Discuss with the lead dev FIRST (do not build blind)

The user wants to confront the lead before implementing. Two things to settle:
1. **Privacy intent.** Research (2026-06-23) found the push body is kept generic
   as a deliberate "privacy-conscious: never message content" choice (explicit in
   desktop's `desktop-notifications.md`). Mobile frames it as an E2E consequence.
   Showing "you were mentioned" is METADATA (type + space), not content — but
   confirm the lead is OK surfacing even that on the lock screen. The lead
   reportedly framed not-decrypting as a privacy mechanism, not just technical.
2. **NSE build state.** The iOS Notification Service Extension is the only place
   that can do this, and it's currently **DRAFT / possibly not wired into the
   build** (see "Feasibility" below). Confirm it actually runs on device before
   scoping work on top of it.

## Feasibility (from the 2026-06-23 research)

GOOD NEWS — the hard part (decryption) is already done for classification:
- The iOS NSE (`ios/QuorumNotificationService/HubLogClassifier.swift`) ALREADY
  decrypts hub-log entries on device to read `content.type` + `channelId` (it
  suppresses `update-profile` / `edit-message` / `remove-message`). It fetches the
  sealed entry, unseals the hub envelope (X448+AES-GCM via the Rust FFI), and runs
  `tripleRatchetDecrypt`. So the plaintext message IS available in the NSE.
- To label a mention, the classifier would additionally parse the decrypted
  message's `mentions` (memberIds/everyone/roleIds) + `replyMetadata.parentAuthor`
  against the current user — the SAME logic `isMentionedWithSettings` /
  `logMentionOrReply.classify` already implement in JS. Port that check into the
  NSE (Swift) + the Android TS path (`services/notifications/hubLogClassifier.ts`).

CONSTRAINTS / RISKS:
- **NSE is DRAFT.** `HubLogClassifier.swift`: "written without an Xcode build
  loop; expect to iterate when wiring it into the build." `README-NSE-LINKING.md`
  documents manual Xcode steps (target, App Group entitlement, `pod install` for
  QuorumChannelFFI + MMKV) that may not be validated yet. **Verify on device
  first** (see the separate audit idea).
- **Android has NO custom push handler** — only Expo default + a 15-min
  background fetch showing generic "you have new messages". Mention-aware push on
  Android needs the TS classifier path (`pushReceivedTask.ts` →
  `hubLogClassifier.ts`) extended, and that path's real-world reliability is
  unverified.
- Ratchet-state coordination: the NSE decrypts using the App-Group MMKV mirror of
  TR state. Reading is fine; the existing classifier already does it. No NEW
  ratchet risk beyond what classification already incurs.
- The user needs `getUserRoles` for role-mention detection — confirm the space
  roles + membership are available to the NSE without the main app (catalog/MMKV).

## Rough scope (AFTER lead sign-off + NSE verified)
1. Extend `HubLogClassifier.swift` to return a mention/reply classification
   (you/everyone/role/reply/none) from the decrypted plaintext, honoring the
   user's per-space `enabledNotificationTypes` (already synced in UserConfig).
2. In `NotificationService.swift`, set the body from the classification
   ("You were mentioned in <space>" etc.) instead of generic "New message".
3. Mirror in the Android TS path (`pushReceivedTask.ts` / `hubLogClassifier.ts`).
4. Respect the same mute gates (global/space/channel) already wired.
5. Decide: do non-mention plain space messages still push (generic) or get
   suppressed when the user only wants mention pushes? (Likely a pref.)

## Verify
- On device: get mentioned in a space while app is killed → lock-screen push
  reads "You were mentioned in <Space>", NO message text. Reply / role likewise.
- A disabled type (per-space settings) produces no such push.
- Muted space/channel → no push.

*Last updated: 2026-06-23*
