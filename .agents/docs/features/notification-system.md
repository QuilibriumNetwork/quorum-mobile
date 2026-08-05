---
type: doc
title: Mobile Notification System (in-app unified panel)
status: current
created: 2026-06-23
related_docs:
  - ../2026-06-23-notification-system-mobile-vs-desktop.md
  - ./dm-mute-behavior-and-pattern.md
purpose: >
  Reference spec for mobile's in-app unified notification panel. Written so the
  desktop team can build an equivalent unified/global panel (desktop currently
  has only a per-space panel). Focused on the IN-APP inbox + its data model;
  native OS push is summarized as context, not the subject.
---

# Mobile Notification System (in-app unified panel)

## TL;DR

Mobile has a **global, in-app Notifications tab** — one inbox across all spaces,
split into two sections:

1. **Quorum** — `@you`, `@everyone`, `@role`, and replies to
   your messages, from any space channel (incl. threads).
2. **Farcaster** — likes/recasts/mentions/replies/follows/mini-app frames (only
   when a Farcaster account is connected).

It is a **superset of desktop's notification panel**, which is per-space and
Quorum-only. This doc is the reference for porting the global panel to desktop.

Key properties:
- **Global**, not per-space. Each Quorum row shows a `Space › #channel` breadcrumb
  so the origin is still clear.
- **Persistent history.** Rows stay until the user taps "Clear all" (or the
  200-entry cap rolls the oldest off). Opening the panel does NOT remove rows.
- **Two-level read-state.** Opening the tab clears the bell badge; opening a
  channel clears that channel's bubble. Decoupled (the researched Discord/Slack
  model).
- **Per-space type settings.** The user chooses which of you/everyone/roles/reply
  notify them, per space, synced cross-device.

---

## 1. Sources & data flow

```
Space message arrives (WebSocket, live + catch-up paths)
   → logMentionOrReply(spaceMessage, ctx)            [services/notifications/logMentionOrReply.ts]
       → classify(): reply? @you? @everyone? @role?   (gated by per-space settings + mute)
       → appendMentionReplyLog(entry)                 [services/notifications/mentionReplyLog.ts]
            (MMKV, bounded 200, deduped by message id)
   → useMentionReplyLog() / useChannelMentionUnread() re-render

Quorum DM arrives (same two WebSocket paths)
   → logDirectMessage(ctx)                            [same file]
       → gated on DM mute + never our own self-sync echo
       → appendMentionReplyLog({ kind: 'dm', … })      (keyed PER CONVERSATION)

Farcaster feed (official + haatz), polled
   → useFarcasterNotifications + useHaatzNotifications → blended/deduped

useUnifiedNotifications()                              [hooks/useUnifiedNotifications.ts]
   → quorumItems + farcasterFeedItems (each newest-first) + merged items (for badge)

Notifications tab                                      [app/(tabs)/profile/index.tsx]
   → SectionList: "Quorum" + "Farcaster"
   → filter pills (All / Quorum / Farcaster) when both present
```

**Critical design point for the desktop port:** mobile detects mentions/replies
at the WebSocket receive point using the SAME shared util desktop uses
(`isMentionedWithSettings` from `@quilibrium/quorum-shared`), then PERSISTS a row.
Desktop today derives mentions live from its message store per-space; to go
global it would either (a) adopt a persisted log like this, or (b) query unread
mentions across ALL spaces (not just the open one). The persisted-log approach is
what makes mobile's global panel cheap and offline-resilient.

## 2. The mention/reply log (the Quorum data model)

File: `services/notifications/mentionReplyLog.ts` (MMKV id `quorum-mention-reply-log`).

A **discriminated union**, because a DM has no space or channel and the
per-channel read-state machinery has to skip those entries — the compiler is
what says so, rather than optional fields and a convention (`isSpaceMention`
narrows).

```ts
type MentionReplyKind =
  | 'mention-you' | 'mention-everyone' | 'mention-roles' | 'reply'  // space
  | 'dm';                                                           // Quorum DM

interface MentionReplyEntryBase {
  id: string;
  senderId: string;
  senderName?: string;     // resolved name OR short-address fallback
  senderDisplayName?: string; // RESOLVED name only (no hash) — drives the row's author prefix
  preview: MessagePreview; // typed { kind, text } — no emoji; renderer prepends an icon
  createdAt: number;       // ms; sort + read-state comparisons
}

interface SpaceMentionEntry extends MentionReplyEntryBase {
  kind: 'mention-you' | 'mention-everyone' | 'mention-roles' | 'reply';
  id: string;              // dedup key: `${spaceId}:${channelId}:${messageId}` — PER MESSAGE
  spaceId: string;
  spaceName?: string;      // shown loud as the row's lead
  channelId: string;
  channelName?: string;    // breadcrumb (muted)
  threadId?: string;       // → "#channel › Thread"
}

interface DmEntry extends MentionReplyEntryBase {
  kind: 'dm';
  id: string;              // dedup key: `dm:${conversationId}` — PER CONVERSATION
  conversationId: string;
}

type MentionReplyEntry = SpaceMentionEntry | DmEntry;
```

- **Bounded** at 200 entries (oldest roll off). **Deduped by `id`** so a message
  seen on both the live and catch-up WS paths yields ONE row.
- **The two kinds key differently, on purpose.** A space mention is per MESSAGE
  (each mention is its own event worth its own row). A DM is per CONVERSATION,
  so an active chat refreshes one row instead of burying the panel under one
  row per message — the same unit the Messages tab and the Farcaster
  direct-cast pings use.
- `senderDisplayName` is set only when a real display name resolves, so unsynced
  senders don't surface a raw `Qm…` hash in the row.
- `preview` uses the typed `messagePreview` (`utils/messagePreview.ts`): media/
  events become `{kind,text}` (e.g. `{kind:'image',text:'Image'}`) and the UI
  prepends an IconSymbol — no emoji in the data.

## 3. Detection & gating — `logMentionOrReply`

One helper, called from BOTH WebSocket receive paths (live ~`WebSocketContext.tsx`
L2300, catch-up ~L3585) so they can't drift. `classify(message, ctx)`:

1. Skip own messages (`sender === me`).
2. Read the user's per-space enabled types (`getLocalNotificationTypes`).
3. **Reply** wins over mention (one entry per message, matches desktop): if
   `replyMetadata.parentAuthor === me` AND `reply` is enabled → `'reply'`.
4. **Mention type** via `isMentionedWithSettings` PER TYPE (you > everyone > role),
   each gated by the enabled set. NOTE: we deliberately use
   `isMentionedWithSettings`, NOT `getMentionType` — the latter ignores role
   mentions and doesn't gate `@everyone` on the sender's `mention:everyone`
   permission.
5. Mute gate: the whole call is wrapped by `notifyForBadge`
   (`shouldNotifyForContext` — global/space/channel mute), same gate as the badge.

If the user is viewing that channel when the mention lands, the entry is still
logged but immediately marked read (active-channel suppression → no bubble bump).

## 4. Two-level read-state (the UX model — researched)

Researched against Slack, Discord, Apple HIG, NN/g, PatternFly, etc. (see the
comparison doc). Two decoupled levels:

- **Level 1 — bell/tab badge.** Clears when the user OPENS the Notifications tab
  (`markQuorumTabSeen` / `getQuorumTabSeenAt`, a single `quorumLastSeenAt`). The
  count itself is computed in `partitionNotifications`, over the same
  mute-filtered rows the panel renders — a badge counting a row the panel hides
  is a number the user cannot clear by opening the tab.
  Purpose: "you have something to look at" → fulfilled on open.
- **Level 2 — per-space/channel bubble.** Clears only when the user opens that
  CHANNEL (`markChannelMentionsRead` on channel mount; per-channel
  `lastReadTimestamp`). A row is unread iff `createdAt > channel watermark`.

Why both: opening the panel does NOT wipe the per-space bubbles (no lost signal),
and the two sections obey ONE uniform rule — Farcaster items are terminal (no
in-app destination) so they have no Level 2; Quorum items keep a per-channel
bubble until visited. **Rows are never deleted by reading** — only "Clear all"
deletes them.

**DM rows take Level 1 but deliberately have NO Level 2.** The conversation's
own `lastReadTimestamp` (`hooks/chat/useConversations.ts`) already answers "is
this DM unread", and it is what the Messages tab uses. A second watermark here
would be two sources of truth for one fact: read the DM in Messages and the
panel row would still look unread, or the reverse. The two-level model exists
because a space mention needs a per-channel bubble that survives until you visit
that channel; a DM has no equivalent second level, because the conversation IS
the destination.

## 5. Per-space notification-type settings

The user picks which types notify, per space — synced cross-device.
- Store: `getLocalNotificationTypes` / `setNotificationTypes`
  (`services/config/configService.ts`), backed by
  `UserConfig.notificationSettings[spaceId].enabledNotificationTypes`
  (`SpaceNotificationTypeId[]` — the SAME field desktop uses; rides the untyped
  config blob). Default = all four enabled.
- Hook: `useSpaceNotificationTypes` (`hooks/chat/useSpaceNotificationTypes.ts`,
  `useSyncExternalStore`).
- UI: "Notify me about" section in `SpaceSettingsModal` (four toggles).
- Receive wiring: `classify` reads these and skips disabled types.
- Sync timing: restart/login only (like all mobile UserConfig settings), not live.

## 6. The Notifications tab UI

File: `app/(tabs)/profile/index.tsx` (the route is `profile/` but it IS the
Notifications tab).

- **SectionList**: "Quorum" then "Farcaster" (named for the product, so the two
  headers read as a pair and match the filter pills). Empty sections
  are dropped (no lone header).
- **Filter pills** (`All / Quorum / Farcaster`, `SegmentedPills variant="solid"`)
  render ONLY when both a Quorum and a Farcaster feed exist — single-source users
  see no pills. Active filter falls back to `all` if pills disappear.
- **Quorum row layout** (location-first):
  - Lead line: **space name** (loud) + `  #channel` (muted, same line); `› Thread`
    appended for thread mentions.
  - Message line: `Author: <message text>` — author shown ONLY when
    `senderDisplayName` resolved; message in `textSubtle`, capped at 2 lines.
  - Time: relative, in `textMuted` (one notch fainter than the message → two
    contrast levels).
  - Leading icon by kind: `@you`→`at`, `@everyone`→`bullhorn`, `@role`→`shield`,
    reply→`arrowshape.turn.up.left.fill` (matches the composer + Roles tab icons).
- **Header**: "Notifications" + a top-right **"Clear all"** text button (the OTA
  update bolt that used to live here was removed — that update option already
  lives in the profile settings modal).
- **"Clear all"**: opens a `useConfirmDialog` (primary variant) warning it
  permanently removes the visible notifications; on confirm,
  `clearMentionReplyLog()` + `clearNotificationLog()` + mark-seen. It DELETES rows
  (hence "Clear all", not "Mark all read").
- Tap routing (`handlePress`): Quorum → `/spaces/{spaceId}/{channelId}`;
  Farcaster cast → feed tab; frame → mini-app overlay.

## 7. Native OS push — brief context (NOT the in-app panel)

Summarized because it's a different system from the in-app panel (and desktop's
push is Electron-different anyway). Full detail: see the research in the
comparison doc / the push code.
- Server sends **silent, content-less pushes** ("to preserve E2E"); the device
  decrypts locally and renders.
- iOS NSE (`ios/QuorumNotificationService/`) rewrites the lock-screen TITLE to the
  DM sender name or space name (from a catalog), body stays generic "New
  message". It can classify `content.type` (suppresses edit/delete/profile) but
  **does NOT label mentions** today. **The NSE is DRAFT / not verified on device.**
- Android has NO custom push handler — only Expo default + a 15-min background
  fetch showing generic "you have new messages".
- The push body is kept generic deliberately (desktop docs call it
  "privacy-conscious: never message content"). Surfacing message text is avoided.
- These OS pushes are SEPARATE from the in-app panel; a space message produces a
  native push (generic) AND, in-app, a logged mention/reply row (rich).
- **The OS banner and the in-app row are two payloads, not one.** The banner
  keeps whatever generic copy the background check raised; the in-app row for a
  Farcaster direct-cast ping is rebuilt at render time by joining the ping's
  stored `conversationId` against the live conversation list
  (`chatToUnified` + `ConversationDetail` in `partitionNotifications.ts`).
  Sender and message text are deliberately NOT persisted into the ping log —
  same row on screen, nothing extra on disk. The join falls back to the stored
  generic copy whenever it misses.

## 8. Mute architecture (four levels)

`shouldNotifyForContext` (`services/notifications/notificationPrefs.ts`) gates
both the in-app log and `showMessageNotification`:
- **Global** on/off; **per-space**; **per-channel**; **per-DM**
  (`isConversationMutedForCurrentUser`).
- Source of truth = UserConfig (syncs cross-device); mirrored to a
  `quorum-notification-prefs` MMKV (+ iOS App-Group mirror) so the native gates
  read it. Per-space mute also syncs server-side (`pushPrefsSync` `muted_hubs`);
  per-channel/per-DM are device-only (the server can't see channel/conversation
  ids inside encrypted envelopes).

## 9. Mobile vs desktop (for the port)

| Aspect | Mobile (this doc) | Desktop (today) |
|---|---|---|
| Panel scope | **Global** (all spaces, one tab) | **Per-space** (bell in channel header) |
| Sources | Quorum mentions/replies + Farcaster | Quorum mentions/replies only |
| DMs in panel | **Yes** — Quorum DMs (`kind: 'dm'` in the mention log) and Farcaster direct-cast pings, both under the Quorum/Farcaster section for their product | No (NavRail dot) |
| Data | Persisted MMKV log | Derived live from message store |
| Read-state | Two-level (tab badge / channel bubble) | Per-channel `lastReadTimestamp` |
| Type settings | `notificationSettings[spaceId].enabledNotificationTypes` | SAME field |

**Porting a global panel to desktop** mainly means: aggregate unread mentions/
replies across ALL spaces (not just the open one), adopt the global two-section
layout + two-level read-state, and decide whether to fold Farcaster + DMs in.
The shared detection (`isMentionedWithSettings`) and the settings field are
already common, so the core logic transfers.

## 10. Current state / open items

- Shipped (branch `feat/quorum-mentions-replies-inbox`): everything in §1–6 +8.
- Mention fixes shipped this branch:
  - `@everyone` + `@role` SEND encoding (mobile previously mis-encoded both —
    `@everyone` never set the flag; `@role` sent `@<roleId>` instead of `@roleTag`).
  - `@everyone` now also works in EDITED messages + image CAPTIONS (allowEveryone
    threaded through the edit/embed send paths), not just plain text sends.
  - Role mentions render as a styled pill in the PLAIN (non-markdown) message path
    too (`MentionableText` now resolves `@roleTag` against space roles).
  - `@everyone` pill styling is permission-gated on the RENDER side: styled only
    when `mentions.everyone` is set AND the sender holds `mention:everyone`
    (role-only, no owner bypass); otherwise plain text. Matches the notification
    trust rule. (Desktop has the same render-side gap — tasked, see below.)
- Open tasks (`.agents/tasks/.todo/`):
  - `2026-08-05-rich-in-app-notifications-plan.md` — DMs in the panel, richer rows, tappable pings.
  - `2026-06-23-mention-aware-native-push.md` — label space pushes as mention/
    reply (needs lead-dev alignment + NSE verification).
  - `2026-06-21-dm-mute-suppress-native-notifications.md` — DM mute missing from
    the background push gate.
  - (desktop) `quorum-desktop/.agents/tasks/.todo/2026-06-23-everyone-pill-styling-permission-gate.md`
    — mirror the @everyone render-side gate on desktop.
  - (desktop) `quorum-desktop/.agents/tasks/.todo/2026-06-23-notification-settings-stale-read-and-clobber.md`
    — desktop settings UI reads stale config (shows all types) + clobber-on-save.
- **Copy mirror follow-up:** the per-space type settings UI (`SpaceSettingsModal`,
  "Notify me about") was redesigned into grouped cards with type order matching
  desktop (@you, @everyone, @roles, Replies). Mobile keeps CLEARER labels
  ("Mentions of me", "Mentions of my roles", etc.) vs desktop's terse
  (`@you`/`@roles`). Desktop should be updated to the clearer wording so the two
  mirror — do this alongside the desktop unified-panel work. Desktop strings live
  in `quorum-desktop/src/components/modals/SpaceSettingsModal/Account.tsx`
  (`options` array, ~L303).

## Key files
- `services/notifications/mentionReplyLog.ts` — log + two-level read-state
- `services/notifications/logMentionOrReply.ts` — detection/classification helper
- `hooks/useUnifiedNotifications.ts` — merge + sections + badge count
- `app/(tabs)/profile/index.tsx` — the Notifications tab UI
- `hooks/chat/useSpaceNotificationTypes.ts` — per-space type settings (reactive)
- `services/config/configService.ts` — `getLocalNotificationTypes`/`setNotificationTypes`
- `utils/messagePreview.ts` — typed `{kind,text}` previews + icon mapping
- `context/WebSocketContext.tsx` — receive paths that call `logMentionOrReply`
  (space) and `logDirectMessage` (DM)
- `services/notifications/farcasterPingPlan.ts` — pure core of the background
  Farcaster direct-cast check (mute skip, watermark, per-conversation vs digest)
- `components/ui/AppTabBar.tsx` (`BellIcon`) — the tab badge

*Last updated: 2026-08-05*
