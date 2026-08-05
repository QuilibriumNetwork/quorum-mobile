---
type: task
title: "Every in-app notification says who and what, and goes somewhere when tapped"
status: in-progress
priority: medium
created: 2026-08-05
updated: 2026-08-05
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

## Status

All four slices are built on `feat/rich-in-app-notifications`, one commit each.
**Not yet verified on device** — the "Verify" checklist at the bottom is
untouched, and it is what decides whether this is done. Automated coverage is
listed per slice below; none of it can prove the on-device half.

| Slice | Commit | Automated coverage |
|---|---|---|
| 1 — a "New Messages" row goes somewhere | `2e4667a` | `__tests__/farcasterBackgroundPings.test.ts` (10) |
| 2 — that row says who and what | `863b960` | `__tests__/notificationPartition.test.ts` (+7) |
| 3 — Quorum DMs appear in the panel | `8365d4b` | `__tests__/logDirectMessage.test.ts` (9), partition (+8) |
| 4 — delete the row you actually meant | `9b0b9a4` | `__tests__/mentionReplyLog.test.ts` (7) |

455 tests pass; typecheck is clean apart from 11 errors that predate the branch
(`app/explore.tsx`, `services/calling/*`). Every new test was checked by
mutating the code it covers and confirming it goes red — except the two noted
inline in `mentionReplyLog.test.ts`, which are documented as type guards rather
than behavioral assertions rather than left looking stronger than they are.

### What the slices did, where they differed from the plan

- **Slice 1** pings **per conversation** rather than raising one aggregate, since
  a `conversationId` is the thing that makes a row tappable and the aggregate has
  no single conversation to name. Capped at 5 per run — past that it collapses
  into one generic digest, so a quiet week does not arrive as twenty banners. A
  stable `logId` keys the in-app row to the conversation so repeat background
  runs refresh one row instead of stacking identical ones.
  - Two follow-ons fell out of having the id: Farcaster's own per-conversation
    mute can now be honored, and the per-DM mute gate inside
    `showMessageNotification` can finally see the conversation.
  - Taps that resolve to nothing now land on the inbox instead of being
    swallowed, on the OS handler as well as the panel.
- **Slice 2** is render-time enrichment exactly as specified — nothing extra is
  persisted. The "two payloads" is the OS banner keeping its stored generic copy
  while the in-app row is rebuilt by joining `conversationId` against the live
  conversation list, falling back to the generic copy on every miss. Only the
  panel mounts that query; the badge counts rows and does not care what they say.
- **Slice 3** made `MentionReplyEntry` a discriminated union rather than adding
  optional fields, so the compiler flags every place that assumed a space and a
  channel. Two things it caught that would otherwise have shipped silently:
  - the self-sync rewrite repoints `conversationId` at the RECIPIENT for our own
    messages echoed from another device, so the sender address at that point is
    not the sender — both call sites use the true sender instead;
  - the tab badge read the mention log directly, so a DM muted *after* it was
    logged bumped a badge for a row the panel was hiding. Badge arithmetic moved
    into `partitionNotifications` behind the same mute filter, replacing
    `getQuorumTabUnreadCount` with `getQuorumTabSeenAt`.
- **Slice 4** as specified. Trash on every row we own; Farcaster rows still have
  none, since that feed is the server's and has no per-item dismiss.

### Deliberately not done

- **Superseding a generic ping with the precise row that catches up.** The plan
  says a precise row *can* supersede it, and the Verify list does not test it.
  Both rows currently coexist. Doing it means deleting a `bg-` ping on DM
  catch-up, and a `bg-` ping may equally have been raised for a space message —
  so the delete would sometimes remove a row nothing replaced. Left alone rather
  than shipping a silent-deletion heuristic.

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

Each ends in something observable by tapping the app. **Start at slice 1** and
ship in order.

Each slice is independently shippable, but the order carries one real dependency:
slice 2 builds the OS-banner / in-app payload split, and slice 3 plus the separate
native-push issue both consume it. Slices 1 and 4 have no dependencies and could
move if something blocks.

Nothing in this plan needs a decision from the operator before it can be built —
see "Decisions taken" below. Where a slice says "ask", it means only if the stated
approach turns out to be infeasible.

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

**Enrich at render time. Do not persist the content.** Join the stored ping to the
live conversation list (`useFarcasterDirectCasts` already fetches it) rather than
writing sender and message text into the log. Same result on screen, nothing extra
kept on disk.

This is a decision, not a preference — build it this way. Its rationale is
storage-layer and is tracked outside this repo. If render-time enrichment turns
out to be genuinely infeasible, stop and ask the operator rather than falling back
to persisting.

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

**Write DM rows through the mention-log path, not the background-ping path.** This
is a decision, not a preference — its rationale is storage-layer and tracked
outside this repo. Build it this way; if it blocks, ask rather than switching to
the ping path.

The one genuinely unfixable case stays: with the app closed, the background task
(`BackgroundMessageService.ts:239`) receives `data.encrypted_content` with no keys
loaded and can never say more than "you have new messages". A precise row can
supersede it on catch-up when the app reopens.

### Slice 4 — delete the row you actually meant

*Outcome: swipe/tap the trash on a specific mention and only that one goes.*

`showTrash = item.source === 'chat'` puts the affordance solely on the generic
rows, where deleting one of several identical rows means nothing, and gives the
precise mention rows none. `removeMentionReplyEntry(id)` already exists in
`mentionReplyLog.ts` and is unwired.

**Show the trash on every row type**, not a swap. By the time this slice runs,
slices 2 and 3 have made the previously-generic rows distinguishable too, so
per-row delete is meaningful everywhere and a uniform rule beats a per-source
exception. `removeMentionReplyEntry` covers the mention and DM rows;
`removeNotificationLogEntry` already covers the pings.

## Decisions taken

Both were open when this plan was written and are now settled, so nothing here
needs a conversation before it can be built. Reasoning recorded so a later change
is an informed one rather than a re-litigation.

### 1. DMs fold into the existing Quorum section. No fourth pill.

Sections stay at two ("Quorum", "Farcaster"), pills stay at three
(All / Quorum / Farcaster).

- The sections are named for the **product**, not their contents, so the two read
  as a pair and the headers match the filter pills exactly. ("Mentions &
  messages" was the earlier name; it described contents while its sibling named a
  product, which made them look like different kinds of thing.) A Quorum DM
  belongs under "Quorum" by definition — no renaming, no argument needed.
- A fourth pill (All / Quorum / DMs / Farcaster) does not fit comfortably at
  320px. `SegmentedPills` supports `scrollable` and `wrap`, so it is technically
  possible — but a scrolling or two-line filter row for four short labels is worse
  than not needing the fourth.
- It preserves the invariant the current filter logic rests on: one pill per
  section, plus All. Adding a section without a pill, or a pill without a section,
  is where that logic starts needing special cases.
- **Reversible if it feels wrong on device.** Section building is already a mapped
  list (`sections` in `app/(tabs)/profile/index.tsx`), so splitting DMs out later
  is a small change. Ship folded, look at it, revisit only if the mixed section
  actually reads badly.

### 2. DM rows reuse the conversation's own `lastReadTimestamp`.

Do **not** give them a second watermark.

- It already exists: `Conversation` carries `lastReadTimestamp` and `unreadCount`
  (`hooks/chat/useConversations.ts:26-37`), and it is what the Messages tab
  already uses.
- A separate watermark would mean **two sources of truth for one fact** — "is this
  DM unread". Read the DM in the Messages tab and the panel row would still look
  unread, or the reverse. That drift is silent and would be reported as a
  mysterious bug months later.
- The two-level model exists for space mentions because a mention needs a
  per-channel bubble that survives until you visit that channel. DMs have no
  equivalent second level; the conversation *is* the destination.
- **Level 1 is unaffected.** The tab badge answers "have you opened the panel",
  keyed off the log's own seen mark, and stays shared across all row types.

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
