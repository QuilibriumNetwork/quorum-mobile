---
type: bug
title: "Notification previews are stored unencrypted on device, and the generic message rows are neither precise nor tappable"
status: open
priority: high
created: 2026-08-05
area: notifications / at-rest encryption / background message service
runtime_test: required
related:
  - "issues/2026-08-05-scoped-clear-notifications-including-farcaster.md"
  - "issues/.open/2026-06-23-dms-in-global-notification-panel.md"
  - "docs/features/notification-system.md"
---

# Notification previews sit in plaintext, and the generic rows go nowhere

Two problems found together while scoping the scoped-clear work. They are filed
together because the fix for the second (make rows precise) makes the first
(previews stored in the clear) materially worse, so they have to be decided as
one.

## 1. The privacy problem — this is the blocking one

**Message preview text is persisted unencrypted on device.**

- `mentionReplyLog` stores `preview: MessagePreview` — real message text from
  space mentions and replies — in `createMMKV({ id: 'quorum-mention-reply-log' })`.
- `notificationLog` stores notification `title`/`body` in
  `createMMKV({ id: 'quorum-notifications' })`.
- **No MMKV store in this app passes an `encryptionKey`.** All 20+ `createMMKV`
  call sites pass `{ id }` only. Verified 2026-08-05 by grep across
  `services/`, `hooks/`, `context/`.
- The installed `react-native-mmkv` **does** support `encryptionKey`
  (`lib/specs/MMKVFactory.nitro.d.ts:52`). This is a gap, not a limitation.

**Why this is inconsistent with the app's own threat model.** Message bodies
live in SQLCipher-encrypted SQLite, keyed by HKDF from the user's Ed448 private
key (`services/storage/messagesDb.ts`). The app therefore explicitly does NOT
rely on OS sandboxing to protect message content — it layers app-level
encryption on top. Storing the same content as plaintext previews next to it
contradicts that decision.

**Exposure, stated accurately (do not overstate this, but do not undersell it):**

- MMKV files live in app-private storage. On a **non-rooted, passcode-locked**
  device, other apps cannot read them, and the OS encrypts at rest while locked
  (Android FBE / iOS Data Protection).
- They ARE readable given: root/jailbreak, forensic extraction, a device handed
  over unlocked, or any process running as the app.
- `android:allowBackup="true"` (`android/app/src/main/AndroidManifest.xml:24`)
  makes MMKV contents eligible for Android's cloud backup, i.e. preview text can
  leave the device. Modern Android encrypts that backup with the device PIN, but
  for an app whose premise is E2E this deserves an explicit decision rather than
  an inherited default.

**This is pre-existing and it is ours.** Space-mention previews already ship this
way today — it is not introduced by any current branch, and it was implemented on
this side rather than by the lead dev, so it has not had the lead dev's review.

### Options

1. **Encrypt the notification MMKV stores** with a key derived the same way
   `messagesDb` derives its cipher key. Matches the existing posture, costs the
   user nothing, needs no setting, and is strictly better than a toggle because
   it does not make privacy opt-in.
2. **Privacy toggle** ("rich notifications" on/off). Considered and NOT
   recommended as the primary fix: it complicates the surface, and its default
   value is either insecure or useless.
3. **Store no preview text** — keep rows structural (who + where, no content).
   Safe, but throws away the feature.

**Recommendation: option 1**, with option 3 as the fallback for any context where
the key genuinely is not available.

**The open engineering question for option 1:** is the derived key reachable
where the log is WRITTEN? `logMentionOrReply` runs on the WebSocket receive path
(app foregrounded, key loaded — fine). The background task at
`BackgroundMessageService.ts:239` explicitly does not have keys, which is why it
can only emit ciphertext-free generic text. Encrypting the store is only viable
if reads/writes on every path can obtain the key. **Resolve this before
committing to the approach.**

## 2. The generic rows are neither precise nor tappable

The "New Messages / You have a new direct message" rows in the panel:

**They do nothing when tapped.** `checkFarcasterDirectCasts` writes
`data: { type: 'message', messageId: 'fc-…' }` with no `conversationId`
(`BackgroundMessageService.ts:125-131`). `handlePress` routes on either
`spaceId + channelId` or `conversationId` (`app/(tabs)/profile/index.tsx`), so
with neither it matches no branch and silently returns. Same for the Quorum
`bg-` ping.

**The destination already exists.** `useFarcasterDirectCasts` keys conversations
as `farcaster:<conversationId>`, and `app/(tabs)/messages/dm/[id].tsx:106`
already handles that prefix. Writing
``conversationId: `farcaster:${conversation.conversationId}` `` into the ping
makes the existing routing carry the tap — no new screen.

**They could be precise.** That background loop already holds full
`DirectCastConversation` objects (`services/farcasterClient.ts:497-512`) with
`viewerContext.counterParty` (display name + pfp), `lastMessage.message` (the
text), and `lastMessage.senderContext.displayName`. It discards all of it and
emits one aggregate count. Farcaster direct casts are not E2E — the app fetches
them in plaintext from the API — so there is no crypto barrier here, only the §1
at-rest question and the OS-banner question below.

### Decision taken: rich in-app, generic on the lock screen

`showMessageNotification` currently writes the OS notification AND the in-app log
from the same `title`/`body` (`services/notifications/NotificationService.ts:134`),
so enriching one enriches the other. It needs to take two payloads: a generic one
for the OS banner, a rich one for the in-app log. (Confirmed with the operator
2026-08-05.)

## 3. Quorum DMs in the panel — the "blocker" is narrower than it looks

There is **no blocker for the foreground case.** A DM arriving while the app runs
is decrypted in `WebSocketContext` on the `decryptedMessage` path; sender and
plaintext are both in hand — the same data that fills `lastMessagePreview` in the
Messages tab. We simply never call anything to log it. Space messages call
`logMentionOrReply` at their receive point; DMs have no equivalent. Adding that
call is the whole fix, and it is already specced in
`issues/.open/2026-06-23-dms-in-global-notification-panel.md`.

The **only** thing that cannot be fixed is the app-closed case: the background
task at `BackgroundMessageService.ts:239` receives `data.encrypted_content` with
no keys loaded, so it can never say more than "you have new messages". That row
can be superseded by a precise one on catch-up when the app reopens.

So: Quorum DMs can appear with sender + preview for anything received while the
app is running or on catch-up. The generic row only covers the window when the
app was closed.

## 4. The per-row trash icon is on the wrong rows

`showTrash = item.source === 'chat'` puts the delete affordance only on the
generic rows, where per-row deletion is meaningless because they are all
identical, and gives the precise mention rows none. `removeMentionReplyEntry(id)`
already exists in `mentionReplyLog.ts` and is unwired. Wiring it to Quorum rows
is nearly free — but it only becomes worth doing once rows are distinguishable,
which is why it is filed here rather than done separately.

## Scope

Sequenced so the privacy decision gates the content work.

- **A. Resolve §1 first.** Establish whether the derived cipher key is reachable
  on every notification-log read/write path. Then either encrypt the stores or
  fall back to structural-only rows. Nothing in B/C should ship before this
  lands, because each one increases the amount of message text at rest.
  - **Do not miss `quorum-dev-notification-snapshot`** (`services/dev/notificationSnapshot.ts`).
    It holds a full second copy of both logs, preview text included, in its own
    unencrypted MMKV store. Encrypting the two primary logs while leaving it
    alone puts a plaintext copy of exactly the protected data right beside them.
    It is `__DEV__`-only so it never reaches users, but a dev device is still a
    device — either encrypt it with the same key or have it store structural
    fields only.
- **B. Make the pings tappable.** Add `conversationId` at both call sites. Small
  and independent of the content question — a row that does nothing on tap is a
  bug regardless.
- **C. Split the OS payload from the in-app payload** in
  `showMessageNotification`, then enrich the Farcaster direct-cast rows
  (sender + preview) while the OS banner stays generic.
- **D. Wire the trash icon** to Quorum mention rows.
- **E.** Revisit `android:allowBackup="true"` — decide deliberately, and exclude
  the notification stores from backup if it stays on.

## Verify

- Inspect the MMKV file on a dev device before/after the §1 fix and confirm
  preview text is not readable as plaintext in the after case. **This is the
  test that matters** — a code reading is not evidence here.
- Tap a Farcaster direct-cast row → lands in that conversation.
- Lock-screen banner stays generic after the §C split, while the in-app row is
  rich. Check both surfaces in the same run, or the split is unproven.
- Muted DM → still no row, still no banner.

*Last updated: 2026-08-05*
