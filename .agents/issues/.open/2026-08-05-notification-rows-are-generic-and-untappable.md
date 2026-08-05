---
type: bug
title: "Background message notification rows are generic, do nothing when tapped, and carry the delete affordance the precise rows lack"
status: open
priority: medium
created: 2026-08-05
area: notifications / background message service / notifications tab UI
runtime_test: required
related:
  - "issues/.done/2026-08-05-scoped-clear-notifications-including-farcaster.md"
  - "issues/.open/2026-06-23-dms-in-global-notification-panel.md"
  - "docs/features/notification-system.md"
---

# The generic message rows go nowhere

The "New Messages / You have a new direct message" rows in the notifications tab
are interchangeable, carry no information about who wrote or what was said, and
silently do nothing when tapped.

> **Before enriching these rows, check with the operator.** There is a related
> storage-layer decision that is not tracked in this repo and that bears on how
> much of a message may be persisted. The tap fix (§1) and the trash fix (§3) are
> unaffected by it and can proceed on their own.

## 1. Tapping does nothing

`checkFarcasterDirectCasts` writes `data: { type: 'message', messageId: 'fc-…' }`
with **no `conversationId`** (`services/notifications/BackgroundMessageService.ts:125-131`).
`handlePress` routes on either `spaceId + channelId` or `conversationId`
(`app/(tabs)/profile/index.tsx`), so with neither present it matches no branch and
returns silently. The Quorum `bg-` ping has the same gap.

**The destination already exists.** `useFarcasterDirectCasts` keys conversations
as `farcaster:<conversationId>`, and `app/(tabs)/messages/dm/[id].tsx:106`
already handles that prefix. Writing
``conversationId: `farcaster:${conversation.conversationId}` `` into the ping makes
the existing routing carry the tap. No new screen, no new plumbing.

A row that does nothing when tapped is a bug on its own terms, independent of
everything else here.

## 2. The rows could be precise

That background loop already holds full `DirectCastConversation` objects
(`services/farcasterClient.ts:497-512`) carrying `viewerContext.counterParty`
(display name + pfp), `lastMessage.message`, and
`lastMessage.senderContext.displayName`. It discards all of it and emits a single
aggregate count.

Farcaster direct casts are not end-to-end encrypted — the app fetches them from
the API in plaintext — so nothing cryptographic stands in the way.

### Decision taken: rich in-app, generic on the lock screen

`showMessageNotification` writes the OS notification AND the in-app row from the
same `title`/`body` (`services/notifications/NotificationService.ts:134`), so
enriching one enriches the other. The in-app panel sits behind the app; the
lock-screen banner does not. It needs to take two payloads — a generic one for
the OS, a rich one for the in-app row. (Confirmed with the operator 2026-08-05.)

**Prefer enriching at render time over persisting.** The panel can join a stored
ping to the live conversation list (`useFarcasterDirectCasts` already fetches it)
instead of writing sender and message text into the log. Same result on screen,
nothing extra kept on disk. This is also what keeps §1's storage question from
blocking the feature.

## 3. Quorum DMs are missing from the panel entirely

No blocker for the normal case. A DM arriving while the app runs is decrypted in
`WebSocketContext` on the `decryptedMessage` path, with sender and text both in
hand — the same data that fills `lastMessagePreview` in the Messages tab. Nothing
logs it. Space messages call `logMentionOrReply` at their receive point; DMs have
no equivalent. Adding that call is the fix, already specced in
`issues/.open/2026-06-23-dms-in-global-notification-panel.md`.

The one genuinely unfixable case is app-closed: the background task at
`BackgroundMessageService.ts:239` receives `data.encrypted_content` with no keys
loaded, so it can never say more than "you have new messages". That row can be
superseded by a precise one on catch-up when the app reopens.

## 4. The per-row trash icon is on the wrong rows

`showTrash = item.source === 'chat'` puts the delete affordance only on the
generic rows, where per-row deletion is meaningless because they are all
identical, and gives the precise mention rows none. `removeMentionReplyEntry(id)`
already exists in `mentionReplyLog.ts` and is unwired. Wiring it to Quorum rows is
nearly free, but only earns its place once rows are distinguishable — which is why
it lives here rather than as its own issue.

## Scope

- **A. Make the pings tappable.** Add `conversationId` at both call sites.
  Independent of everything else; ship it on its own if nothing else moves.
- **B. Split the OS payload from the in-app payload** in
  `showMessageNotification` — generic banner, rich row.
- **C. Enrich the Farcaster direct-cast rows at render time** from the live
  conversation list.
- **D. Wire the trash icon** to Quorum mention rows.

## Verify

- Tap a Farcaster direct-cast row → lands in that conversation.
- Lock-screen banner stays generic after B, while the in-app row is rich. **Check
  both surfaces in the same run**, or the split is unproven.
- Muted DM → still no row, still no banner.
- Trash on a mention row removes that row and nothing else.

*Last updated: 2026-08-05*
