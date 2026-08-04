---
type: task
title: "Quorum mentions/replies inbox on mobile (notification screen parity with desktop)"
status: done
created: 2026-06-23
urgency: medium
shared_change: none
version_bump: none
runtime_test: required (on-device, see checklist)
related_doc: .agents/docs/2026-06-23-notification-system-mobile-vs-desktop.md
supersedes: .agents/issues/.done/2026-06-16-inbox-message-previews-use-icons-not-emoji.md
---

# Quorum mentions/replies inbox on mobile

## Status

2026-06-23) — branch feat/quorum-mentions-replies-inbox; typecheck+lint clean, code-reviewed, security-review false-positive cleared, on-device verified (replies/mentions/toggle-off); ready to merge


> **AS-BUILT record.** This documents what actually shipped on branch
> `feat/quorum-mentions-replies-inbox` (5 commits), not just the plan. Deviations
> from the original plan are called out inline as **[deviation]**.

## Goal (achieved)

The mobile **Notifications tab** now has a real Quorum-chat inbox — mentions
(`@you`, `@everyone`, role pings), replies, and thread mentions — shown as a
**separate section** above the existing Farcaster feed. End state is a superset
of desktop's notification panel.

## Decisions locked (user, 2026-06-23) — all honored

- **Global inbox** + space/channel breadcrumb per row.
- **Two sections** (Quorum + Farcaster), each newest-first, not interleaved.
- **Two-level read-state model** (researched: Slack/Discord/Apple HIG/NN-g/etc.).
- **Emoji previews fixed app-wide** (typed `messagePreview` + `IconSymbol`).
- Desktop alignment to this model is a separate, later task.

## Commits (in order)

1. `refactor: typed message previews with icons instead of emoji` (Phase 0)
2. `feat(notifications): persist mentions/replies to an inbox log` (Phase 1)
3. `feat(notifications): show Quorum mentions/replies as a section in the inbox` (Phase 2)
4. `feat(notifications): two-level read-state for mentions/replies` (Phase 3)
5. `fix(notifications): address code-review findings`

---

## What shipped, by area

### Phase 0 — Typed message previews (app-wide)

`utils/messagePreview.ts` now returns `MessagePreview = { kind, text }` (no emoji
in `text`). New helpers:
- `previewKindIcon(kind): IconSymbolName | undefined` — maps a kind to an
  **IconSymbol** SF-symbol-style name (NOT a raw Tabler name — IconSymbol owns
  the Tabler mapping). Verified names: image→`photo`, video→`video`,
  sticker→`sparkles`, reaction→`face.smiling`, call→`phone`,
  missed-call→`phone.down`, video-call→`video`, join→`person.badge.plus`,
  leave→`person`, kick→`xmark.circle`, update-profile→`pencil`,
  remove-message→`trash`. **[deviation]** original plan guessed raw Tabler names
  (`photo`, `mood-smile`, …); those don't exist as IconSymbol keys — corrected to
  the SF-symbol keys IconSymbol actually maps.
- `coerceMessagePreview(value)` — upgrades legacy stored values (emoji string,
  raw content object, or already-typed) to `MessagePreview` on read. Hardened
  (review fix) to keep `kind` when a stored typed preview has its `text` key
  absent (JSON.stringify drops `undefined`).
- **`call-event` folded into the single util** — previously two inline DM
  `getMessagePreview` helpers in WebSocketContext handled call/missed-call with
  emoji; both deleted, util now emits `call`/`missed-call`/`video-call` kinds.

Storage shapes updated to carry the typed preview + read-coercion:
- `SpaceActivity.preview: MessagePreview` (`hooks/chat/useSpaceActivity.ts`,
  coerces legacy on read in `loadActivity`).
- `Conversation.lastMessagePreview: MessagePreview | string`
  (`hooks/chat/useConversations.ts` — union kept because the Farcaster DM path
  still sets a plain string; renderers coerce).

Render sites updated to show `IconSymbol` + text:
- `components/Chat/DirectMessagesList.tsx` (DM list rows).
- `app/(tabs)/messages/index.tsx` (unified inbox rows; added `subtitleIcon`).
- Outbound DM embed send `hooks/chat/useSendDirectEmbedMessage.ts` now writes a
  typed `{kind,text}` preview (review fix — was still writing `📷 Image`).

### Phase 1 — Persisted mention/reply log

- `services/notifications/mentionReplyLog.ts` — MMKV log (id
  `quorum-mention-reply-log`), `MentionReplyEntry { id, kind, spaceId, channelId,
  channelName?, threadId?, senderId, senderName?, preview, createdAt }`,
  `MAX_ENTRIES=200`, listener/emit, dedup by `id =
  ${spaceId}:${channelId}:${messageId}`.
- `services/notifications/logMentionOrReply.ts` — single async helper called from
  BOTH WS receive paths (live `WebSocketContext` ~L2300, catch-up ~L3590) so they
  can't drift. `classify()`:
  - reply: `replyMetadata.parentAuthor === me` (wins over mention — one entry per
    message, matches desktop).
  - mention type via **`isMentionedWithSettings` per-type** (mention-you /
    -everyone / -roles), priority you > everyone > role.
  - **[deviation]** original plan said use shared `getMentionType` for the label.
    Rejected after reading the shared dist: `getMentionType` does NOT handle role
    mentions and does NOT gate `@everyone` on the sender's `mention:everyone`
    permission. `isMentionedWithSettings` does both and is the exact predicate the
    old badge used, so the inbox and badge stay consistent.
  - self-message excluded; mute gate via `ctx.notifyForBadge`
    (`shouldNotifyForContext`), same as the old counters.

### Phase 2 — Two-section Notifications tab

- `hooks/useUnifiedNotifications.ts`: added `source: 'quorum'`,
  `quorumToUnified` (title per kind, `#channel › Thread` breadcrumb + preview
  body, deep-link `{type:'message', spaceId, channelId}`), and exposes
  `quorumItems` + `farcasterFeedItems` separately (plus merged `items` for the
  badge). The muted-DM filter applies only to the Farcaster feed (review fix:
  quorum entries carry no `conversationId`, so it was a no-op there).
- `app/(tabs)/profile/index.tsx`: `SectionList` with "Mentions & replies"
  (Quorum) + "Farcaster" sections; per-kind row icon (`at` / `speaker.wave.2.fill`
  @everyone / `person.2.fill` role / `arrowshape.turn.up.left.fill` reply) and a
  `Space` pill; the old "Clear chat notifications" link replaced by a secondary
  **"Mark all read"** action.

### Phase 3 — Two-level read-state

In `mentionReplyLog.ts`:
- **Level 2** (per-channel bubble): `markChannelMentionsRead(spaceId, channelId,
  at?)` (watermark, never moves backward via `Math.max`) +
  `getUnreadCountForChannel`. An entry is unread iff `createdAt > channel
  watermark`. `useChannelMentionUnread()` parses the log + read-map **once per
  mutation** into a per-channel count map for O(1) lookups (review fix — was
  re-parsing the full log per channel in the spaces-list loop).
- **Level 1** (tab badge): single `quorumLastSeenAt` (`markQuorumTabSeen` /
  `getQuorumTabUnreadCount`), set on Notifications-tab open and on "Mark all
  read". Decoupled from Level 2 — opening the tab clears the badge without
  marking channel mentions read.

Wiring:
- Channel open `app/(tabs)/spaces/[id]/[channelId].tsx` → `markChannelMentionsRead`
  (replaces the old `clearReplyCount`/`clearMentionCount`); keeps
  `setActiveChannel`/`clearActiveChannel`.
- `logMentionOrReply` re-marks the channel read if it's the active channel when a
  mention lands (keeps a viewed channel's mentions read).
- Spaces list `app/(tabs)/spaces/index.tsx` + space screen
  `app/(tabs)/spaces/[id]/index.tsx` derive the channel/space bubble from
  `useChannelMentionUnread` (replaces the summed integer counters).
- Tab badge `components/ui/AppTabBar.tsx` (`BellIcon`) already reads
  `unreadCount`; the hook's `unreadCount` now = `getQuorumTabUnreadCount()` +
  Farcaster/chat unread.

**Counters retired:** `hooks/chat/useMentionTracking.ts` **deleted**;
`hooks/chat/useReplyTracking.ts` stripped to just the active-channel singleton
(`setActiveChannel`/`clearActiveChannel`/`getActiveChannelKey`); the dead
`increment*`/`get*Count`/`clear*Count` exports + their `WebSocketContext` calls
and the `hooks/chat/index.ts` barrel entries removed.

---

## Code review (high effort, 7 finder angles + verify) — outcome

Fixed (commit 5): embed-send emoji preview; `coerceMessagePreview` text-absent;
`handleMarkAllRead` missing `markQuorumTabSeen`; per-channel unread O(N→1);
no-op muted-DM filter on quorum items.

Considered and intentionally NOT changed:
- **Reply+mention → one entry (kind 'reply')**: by design (desktop parity,
  one notification per message). The old counters could double-count; that's the
  behavior we deliberately replaced.
- **`appendMentionReplyLog` "race"** (two finders): REFUTED — the function is
  fully synchronous (read→build→`storage.set` with no `await` inside), so JS's
  single thread can't interleave two appends. The `await getSpaceMember` is in
  the caller, before the synchronous append.
- **`parseInt`→NaN on corrupted `quorumLastSeenAt`**: not constructible from
  normal flow (would require a corrupted/foreign MMKV value).

Known minor edge (accepted): a mention that arrives during the
`await getSpaceMember` window WHILE the user opens that same channel can be
marked read by the channel-open watermark — correct in practice (the user is
about to see it).

---

## Verification status

- `npx tsc --noEmit --skipLibCheck`: **23 errors, identical to master baseline**
  — zero new type errors from this branch.
- `npx eslint` on all touched files: **no new errors/warnings** (pre-existing
  `no-unescaped-entities` in profile/index.tsx and a few `textStyles`/`error`
  unused warnings are on master already).
- **On-device runtime test: PENDING (user will run).**

### On-device test checklist
- Two devices/accounts: A mentions B in a space → B's "Mentions & replies" row
  shows correct sender, channel, preview (icon not emoji), and kind label.
  `@everyone` + role mention render the right label/icon; reply shows "replied
  to you".
- Backfill: mention B while B's app is killed → reopen → row backfills once (no
  duplicate).
- Two-level: open the tab → tab badge clears but per-space bubbles remain. Open
  the channel → that space's bubble clears, row de-emphasizes. "Mark all read"
  clears both levels.
- Conversation list + unified inbox previews show icons, not emoji; a DM with a
  legacy emoji-string preview coerces cleanly.
- Farcaster section unchanged and works. Muted channel → no row/badge. Own
  messages never self-notify.

## Do-not-merge note
Branch uses only published shared symbols (no locally-linked unpublished shared);
safe to merge after on-device verification. No shared/version bump required.

---

## Follow-up batch (2026-06-23, same branch) — mention bugs + settings UI

User testing surfaced three gaps; all fixed (commits 6-8 on the branch).

### 1. Notification row showed literal "Space", not the space name
`MentionReplyEntry` gained `spaceName` (set from `ctx.space?.spaceName` in
logMentionOrReply); the Notifications-tab pill renders `spaceName` (capped at
120px) instead of the static "Space".

### 2. @everyone and @role mentions never notified (only replies did)
Root causes (confirmed against desktop code + `.agents/docs/features/mention-notification-system.md`):
- **@everyone**: the mobile send path called `extractMentionsFromText(text, {
  spaceRoles, spaceChannels })` WITHOUT `allowEveryone`, so the shared extractor
  never set `mentions.everyone` → receivers never saw it. Fix: thread
  `allowEveryone` (computed in SpaceChatArea via `hasPermission(user.address,
  'mention:everyone', spaceData)`, mirroring the composer's autocomplete gate
  and desktop's `MessageService`) through `useSendSpaceMessage` into both
  `sendSpaceMessage` and `createOptimisticMessage`. Applied to the text-send
  path; **edit + embed-caption sends still omit it (follow-up).**
- **@role**: the composer inserted `@<roleId>` (angle-bracketed UUID), which
  matches NEITHER the shared user-mention CID regex NOR the role-tag regex
  (`/@([a-zA-Z0-9_-]+)/`), so `mentions.roleIds` stayed empty. Fix:
  `MessageInput.handleSelectRole` now inserts `@${role.roleTag}` (no brackets),
  matching desktop's composer + Decision #7 in the desktop doc.
- **@username**: VERIFIED correct in code — composer inserts `@<member.address>`
  (a valid `Qm…` CID), receive-side `fullUserAddrRef.current = user.address` is
  the same format, `isMentionedWithSettings` checks `memberIds.includes(addr)`.
  No code change; should work once tested (the user's "only replies" report was
  likely the @everyone/@role bugs above). **Confirm on device.**

### 3. Missing per-type notification settings (desktop has them)
Added the per-space choice of which types notify (you / roles / @everyone /
replies), matching desktop:
- **Store**: `getLocalNotificationTypes` / `setNotificationTypes` in
  `services/config/configService.ts`, backed by
  `UserConfig.notificationSettings[spaceId].enabledNotificationTypes` (same field
  desktop uses; rides the untyped config blob via `as any`, syncs cross-device on
  restart like the other mute settings — see [[untyped-config-cast-deblocks-shared-publish]]).
  Default = all four enabled.
- **Hook**: `hooks/chat/useSpaceNotificationTypes.ts` (useSyncExternalStore,
  reactive across UI), mirroring `useChannelMute`'s store pattern.
- **UI**: "Notify me about" section in `SpaceSettingsModal` Notifications area —
  four toggles with hints.
- **Receive wiring**: `logMentionOrReply.classify` now reads
  `getLocalNotificationTypes(me, spaceId)` and skips disabled types (reply +
  each mention type gated), so a disabled type yields no inbox entry and no badge.

### Known follow-ups (not blocking) — UPDATED: both now DONE this branch
- ~~Role-mention RENDERING~~ **DONE.** `MentionableText` now resolves `@roleTag`
  against space roles and renders it as a styled pill in the plain (non-markdown)
  path too (the markdown path already did). Same accent color, non-tappable.
- ~~@everyone in edit / embed-caption sends~~ **DONE.** `allowEveryone` threaded
  through `useEditSpaceMessage` + `useSendEmbedMessage` → both extraction sites.
- Cross-device sync of notification-type settings is restart-only (same as all
  other UserConfig settings on mobile — see [[config-blob-syncs-only-on-restart-not-live]]).

---

## FINAL STATE (shipped, ready to merge) — added 2026-06-23

This task is COMPLETE. Beyond the inbox + the follow-up batch above, the branch
also shipped a round of UI polish + two more fixes:

- **UI:** location-first Quorum rows (space bold + muted channel, author name when
  resolved, 2-line preview), shield/bullhorn/at/reply icons, All/Quorum/Farcaster
  filter pills (only when both sources present), header cleanup (removed redundant
  OTA bolt; "Clear all" moved to top-right with a confirm dialog), grouped-card
  notification settings ("Notify me about" + "Channels", desktop type order,
  outline icons, channel icon+color), and an app-wide `ActionRow` improvement
  (top-align icon on multi-line rows).
- **@everyone render gate:** `@everyone` is styled as a pill ONLY when
  `mentions.everyone` is set AND the sender holds `mention:everyone` (role-only);
  otherwise plain text. Matches the notification trust rule. (Security review
  flagged the `allowEveryone` param as a "spoofable auth bypass" — assessed as a
  FALSE POSITIVE: receiver-side `isMentionedWithSettings` already re-verifies
  sender permission, and server-side enforcement is impossible in this P2P/E2E
  blind-relay architecture. The render gate closes the one cosmetic gap.)

### On-device verification (user)
- ✅ Replies end-to-end (debug-session confirmed: detect → classify → log → panel).
- ✅ @you / @role / @everyone from the web app (receive side).
- ✅ Settings toggle-off (disable a type → it stops; re-enable → it returns).
- Remaining manual checks are low-risk (mobile-sent @everyone in edit/caption needs
  a 2nd account to observe; role pill is single-device visual).

### Spawned desktop tasks (done later on desktop)
- `quorum-desktop/.agents/tasks/.todo/2026-06-23-notification-settings-stale-read-and-clobber.md`
- `quorum-desktop/.agents/tasks/.todo/2026-06-23-everyone-pill-styling-permission-gate.md`
- (and the broader desktop unified-panel work, referencing
  `.agents/docs/features/notification-system.md`)

### Living reference
The as-built system is documented in
`.agents/docs/features/notification-system.md` (this task file is the
implementation record; that doc is the ongoing spec).

*Last updated: 2026-06-23*
