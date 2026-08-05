---
type: task
title: "Every in-app notification says who and what, and goes somewhere when tapped"
status: open
priority: medium
created: 2026-08-05
area: notifications / notifications tab UI / background message service
runtime_test: required
supersedes:
  - "2026-08-05-notification-rows-are-generic-and-untappable.md (absorbed and DELETED 2026-08-05 — in git history only)"
  - "2026-06-23-dms-in-global-notification-panel.md (absorbed and DELETED 2026-08-05 — in git history only)"
related:
  - "issues/.open/2026-06-23-mention-aware-native-push.md (the OS-push surface — deliberately NOT absorbed, see Scope note)"
  - "issues/.done/2026-08-05-scoped-clear-notifications-including-farcaster.md"
  - "docs/features/notification-system.md"
---

# Every in-app notification says who and what

## Goal

Stated by the operator 2026-08-05: every row in the Notifications tab should mean
something on its own and go somewhere when tapped.

- Farcaster direct-cast rows → sender + preview, tap opens the conversation
- Quorum DM rows → exist at all, with sender + preview, tap opens the DM
- Mentions/replies → already there, already precise; give them the per-row delete
  the generic rows currently monopolise

The lock-screen banner stays generic throughout. That is the whole point of the
split: the in-app panel sits behind the app, the lock screen does not.

## Why one plan

This replaces two issues that each held part of it. They overlapped on the
OS/in-app payload split, so run separately they would either build it twice or
develop a silent dependency. Both are absorbed here and deleted; git history has
them if the detail is ever wanted:

- `2026-08-05-notification-rows-are-generic-and-untappable.md`
- `2026-06-23-dms-in-global-notification-panel.md`

`2026-06-23-mention-aware-native-push.md` is **not** absorbed. It is the OS-push
surface, it is gated on a lead-dev conversation about privacy intent plus iOS NSE
build verification, and it carries NSE research that does not belong in an
executable plan. It consumes slice 2's payload split when it eventually runs.

## Slices

Each ends in something observable by tapping the app. Ship in order; each is
independently shippable.

### Slice 1 — a "New Messages" row goes somewhere

*Outcome: tap a Farcaster direct-cast row and land in that conversation.*

`checkFarcasterDirectCasts` writes `data: { type: 'message', messageId: 'fc-…' }`
with no `conversationId` (`services/notifications/BackgroundMessageService.ts:125-131`).
`handlePress` routes on `spaceId + channelId` or `conversationId`
(`app/(tabs)/profile/index.tsx`), so with neither it matches no branch and returns
silently. The Quorum `bg-` ping (~L239) has the same gap.

The destination already exists: `useFarcasterDirectCasts` keys conversations as
`farcaster:<conversationId>`, and `app/(tabs)/messages/dm/[id].tsx:106` already
handles that prefix. Write
``conversationId: `farcaster:${conversation.conversationId}` `` into the ping and
the existing routing carries the tap.

Fully independent of everything below. A row that does nothing when tapped is a
bug on its own terms.

### Slice 2 — that row says who and what

*Outcome: the row reads "Alice: see you tomorrow" in-app, while the lock-screen
banner still reads "New Messages".*

`showMessageNotification` writes the OS notification AND the in-app row from one
`title`/`body` (`services/notifications/NotificationService.ts:134`), which is
exactly why the in-app rows are generic today. Give it two payloads: a generic one
for the OS banner, a rich one for the in-app row.

**Enrich at render time, do not persist the content.** The panel can join a stored
ping to the live conversation list (`useFarcasterDirectCasts` already fetches it)
rather than writing sender and message text into the log. Same result on screen,
nothing extra kept on disk. There is a storage-layer rationale for this preference
that is tracked outside this repo — **ask the operator before choosing to persist
instead.**

The data is already in hand at the write site: that background loop holds full
`DirectCastConversation` objects (`services/farcasterClient.ts:497-512`) with
`viewerContext.counterParty` (display name + pfp), `lastMessage.message`, and
`lastMessage.senderContext.displayName`. It currently discards all of it for an
aggregate count.

This slice is where the payload split gets built, once. Slice 3 and the native-push
issue both consume it.

### Slice 3 — Quorum DMs appear in the panel

*Outcome: someone DMs you on Quorum, a row appears with their name and the message,
and tapping it opens the conversation.*

There is no blocker for the normal case. A DM arriving while the app runs is
decrypted in `WebSocketContext` on the `decryptedMessage` path (~L2681 live,
~L3695 catch-up) — sender and plaintext both in hand, the same data that fills
`lastMessagePreview` in the Messages tab. Nothing logs it. Space messages call
`logMentionOrReply` at their receive point; DMs have no equivalent. Adding that
call is the fix.

1. Extend `MentionReplyEntry` with a `dm` kind carrying
   `{ conversationId, senderId, senderDisplayName?, preview, createdAt }`. Reuse the
   typed `messagePreview`.
2. Write it from both DM receive paths, gated by DM mute
   (`isConversationMutedForCurrentUser`) — consistent with the existing muted-DM
   exclusion in the panel.
3. Route on tap to `/(tabs)/messages/dm/<conversationId>`; `handlePress` already
   has the branch.
4. Make sure the scoped clear covers the new rows (see the shipped clear work).

**Write DM rows through the mention-log path, not the background-ping path.** That
is deliberate and has a rationale tracked outside this repo; ask the operator
before changing it.

The one genuinely unfixable case stays: with the app closed, the background task
(`BackgroundMessageService.ts:239`) receives `data.encrypted_content` with no keys
loaded and can never say more than "you have new messages". A precise row can
supersede it on catch-up when the app reopens.

### Slice 4 — delete the row you actually meant

*Outcome: swipe/tap the trash on a specific mention and only that one goes.*

`showTrash = item.source === 'chat'` puts the affordance solely on the generic
rows, where deleting one of several identical rows means nothing, and gives the
precise mention rows none. `removeMentionReplyEntry(id)` already exists in
`mentionReplyLog.ts` and is unwired. Wire it to Quorum rows; reconsider whether the
generic rows still need it once slices 2-3 make everything distinguishable.

## Decisions still open

Neither blocks slice 1, and both want a look at the real screen before being
settled.

1. **Own section for DMs, or fold into the existing Quorum section?** A third
   section implies a fourth filter pill (All / Quorum / DMs / Farcaster), and pill
   width at 320px is the constraint — may need shorter labels or no fourth pill.
   Worth mocking both before choosing.
2. **Read-state model for DM rows.** Reuse the conversation's own
   `lastReadTimestamp` (simpler, already exists) or the two-level model space
   mentions use. Pick one and keep it consistent; do not run both.

## Verify

On device, and check both surfaces in the same run wherever the split is involved
— otherwise the split is unproven.

- Tap a Farcaster direct-cast row → lands in that conversation. *(slice 1)*
- The same row shows sender and message text in-app, while the lock-screen banner
  for it stays generic. *(slice 2)*
- Receive a Quorum DM with the app open → row appears with sender + preview; tap
  deep-links to the DM. *(slice 3)*
- Receive one with the app killed, then reopen → catch-up produces the row.
- Muted DM → no row and no banner, on every slice.
- Trash on a mention row removes that row and nothing else. *(slice 4)*
- Clearing still behaves per the shipped scoped-clear work, including the new rows.

*Last updated: 2026-08-05*
