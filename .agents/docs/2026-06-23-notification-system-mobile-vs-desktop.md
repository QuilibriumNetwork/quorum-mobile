# Notification system: mobile vs desktop — deep dive + alignment plan

> **STATUS (2026-06-23): historical.** This was the pre-implementation ANALYSIS +
> alignment plan. The plan has since been built and shipped on branch
> `feat/quorum-mentions-replies-inbox`. For the CURRENT, as-built description of
> mobile's notification system, see **[features/notification-system.md](./features/notification-system.md)**.
> This doc is kept for the rationale (why the apps diverged, the researched
> read-state model, the desktop-alignment reasoning) — the "Mobile has no Quorum
> inbox" framing below describes the BEFORE state, not today.

> Analysis only (when written). Compares the **in-app notification screen**
> on Quorum Mobile against Quorum Desktop's in-app notification panel, explains
> why they diverged, and proposes how to align them.

## TL;DR

The two apps' notification screens are **architecturally different products**:

- **Desktop** has a **per-space mentions + replies inbox**, derived **live** from
  the local message store. It is Quorum-chat only (no Farcaster). Bell icon in
  the channel header opens it; it lists every unread mention/reply/thread-mention
  across all channels in the current space, with sender, channel breadcrumb, and
  message text.
- **Mobile** has a **global "Notifications" tab** that is **Farcaster-first**: it
  merges the Farcaster activity feed (likes, recasts, mentions, replies, follows,
  mini-app frames) with a thin local log of **generic OS push notifications**
  ("You have new messages waiting"). It has **no** Quorum mentions/replies inbox.

The crucial finding: **mobile already runs the exact same mention/reply detection
as desktop** (`isMentionedWithSettings` from quorum-shared, at the WebSocket
receive point, with the full message in hand) — but it throws the message away
and keeps only a per-channel integer counter for the channel-row badge. The data
needed to build a desktop-parity inbox is computed and discarded today.

---

## Desktop: how the in-app notification panel works

| Aspect | Detail |
|---|---|
| Component | `src/components/notifications/NotificationPanel.tsx`, rows in `NotificationItem.tsx` |
| Mount / open | Bell icon in the channel header (`Channel.tsx` ~L1500); `DropdownPanel` anchored to it |
| Scope | **Per space**, all channels in that space (`channelIds = space.groups.flatMap(...)`). No global cross-space inbox. |
| Types shown | `mention-you`, `mention-everyone`, `mention-roles`, and `reply` (reply to a message you authored). Thread mentions/replies get a `#channel › Thread` breadcrumb. |
| **NOT** shown | reactions, DMs (shown via NavRail dot instead), space invites, channel-mentions, **Farcaster** |
| Data source | **No persisted log.** Derived live at query time: `getUnreadMentions()` + `getUnreadReplies()` cursor over the IndexedDB messages store, filtered by `isMentionedWithSettings()`. React Query, 30s stale. |
| Entry shape | `MentionNotification { message, channelId, channelName, mentionType }` and `ReplyNotification { message, channelId, channelName, type:'reply' }` |
| Mention detection | `extractMentionsFromText()` writes `message.mentions.{memberIds, roleIds, everyone, channelIds}` at send time; `isMentionedWithSettings()` decides if it's "for me" given my roles + the space's notification settings |
| Read state | **Per-channel `lastReadTimestamp`** in the `conversations` IndexedDB table (+ `thread_read_times` store for threads). A message is unread if `createdDate > lastReadTimestamp`. **Local-only**, not synced. |
| Notification settings | Which types are enabled per space lives in `UserConfig.notificationSettings` and **does** sync cross-device (encrypted blob). Read state does **not** sync. |
| Badges | unread **dots** (any new message) on channel/DM rows; numbered **mention+reply bubbles** on channel rows + space sidebar + folders. Muted channels/spaces excluded. Bell icon has no numeric badge. |

---

## Mobile: how the Notifications tab works

Screen: `app/(tabs)/profile/index.tsx` (despite the path, this is the
**Notifications tab** — `NotificationsScreen`). Data: `hooks/useUnifiedNotifications.ts`.

It merges **two** sources, sorts newest-first, dedups within Farcaster:

### Source 1 — Farcaster (the dominant one)
- `useFarcasterNotifications` (official farcaster.xyz feed, bearer token) +
  `useHaatzNotifications` (auth-free supplement), blended + deduped.
- Types: like / recast / mention / reply / quote / follow / mini-app frame.
- Rich rows: actor avatar, "X and N others liked your cast", cast snippet,
  deep-link to the cast (feed tab) or mini-app overlay.
- Read state: server `isUnread` flag + a local `lastSeen` MMKV timestamp.

### Source 2 — "chat" notification log (thin)
- `services/notifications/notificationLog.ts` — MMKV, max 200 entries,
  `{ id, title, body, data, createdAt }`.
- **Fed only by `showMessageNotification`**, which is **only called from
  `BackgroundMessageService`** (background fetch, ~every N min).
- Background fetch can't decrypt, so the entries are **generic**:
  - Farcaster DMs → `"New Messages" / "You have a new direct message"`
  - Quorum inbox traffic → `"New Message" / "You have new messages waiting"`
- No spaceId/channelId for Quorum messages (only `messageId: bg-<ts>`), so most
  chat entries **don't even deep-link** to a channel.

### What mobile does NOT have
- No Quorum **mentions** inbox. No **replies** inbox. No `@everyone`/role inbox.
- No per-notification record of who mentioned you, in which channel, with what text.
- The "chat" half of the feed is just "something arrived while you were away."

---

## Where the divergence actually is

Mobile **does** detect mentions and replies — identically to desktop — it just
doesn't keep them. In `context/WebSocketContext.tsx` (both the live path ~L2274
and the catch-up path ~L3590), on every received space message:

```ts
// reply to my message?
if (notifyForBadge && spaceMessage.replyMetadata?.parentAuthor === me && sender !== me)
  incrementReplyCount(me, `${spaceId}:${channelId}`);

// mention of me? (same shared util desktop uses)
if (notifyForBadge && sender !== me && isMentionedWithSettings(spaceMessage, {
      userAddress: me,
      enabledTypes: ['mention-you','mention-everyone','mention-roles'],
      userRoles: getUserRoles(me, space).map(r => r.roleId),
      space,
    }))
  incrementMentionCount(me, `${spaceId}:${channelId}`);
```

`incrementMentionCount` / `incrementReplyCount` (in `useMentionTracking.ts` /
`useReplyTracking.ts`) store **only** `Record<channelKey, number>` in MMKV. The
full `spaceMessage` — sender, text, timestamp, reply metadata, thread id — is in
scope at that exact point and discarded.

So mobile already has **parity on badges** (channel-row count = mentions +
replies, matching desktop's combined bubble) but **zero parity on the inbox**.

### Mobile is also missing
- A per-space (or global) **bell/inbox panel** like desktop's. Mobile's
  Notifications tab is global and Farcaster-shaped, not a Quorum chat inbox.
- Per-channel `lastReadTimestamp` read-state model. Mobile clears badges by
  channel-counter reset on view, not by a read timestamp, so it can't compute
  "unread vs read" for individual historical mentions.

---

## Why they diverged (best read of the history)

1. Mobile's notification screen was **built around Farcaster** first (the social
   feed is a first-class mobile surface). The local log was added to also surface
   background-fetch pings, not to be a chat inbox.
2. The Quorum mention/reply work on mobile came later and was scoped narrowly to
   **badge parity** (the memory note even cites desktop's "combined count for
   single badge" as the spec). Nobody wired it into the notification *screen*.
3. Desktop never integrated Farcaster into its panel, so the two screens were
   designed against different requirements and never reconciled.

---

## Alignment plan

Goal: give mobile a **Quorum mentions/replies inbox** with desktop parity, while
keeping the Farcaster feed (mobile-only value). Recommended end state: the
Notifications tab shows **both** — a Quorum-chat section (mentions, replies,
@everyone, role-pings, thread mentions) and the Farcaster section — unified and
sorted, which is a **superset** of desktop.

### Phase 1 — Persist the mentions/replies we already detect (mobile-only, no shared change)
The cheapest, highest-value step. Replace the integer-counter stores with a
**mention/reply log** that keeps enough to render a row.

- New store (MMKV), e.g. `services/notifications/mentionReplyLog.ts`:
  `{ id, kind: 'mention-you'|'mention-everyone'|'mention-roles'|'reply', spaceId,
     channelId, channelName?, threadId?, senderId, senderName?, preview, createdAt }`
- Write it from the **same two WebSocketContext branches** that already call
  `incrementMentionCount` / `incrementReplyCount` — the full `spaceMessage` is
  already there. Use `messagePreview()` + `messageSenderName()` (already imported
  in that file for `recordSpaceActivity`) to build `preview`/`senderName`.
- Keep the existing counter writes for the channel-row badge, OR derive the badge
  count from the new log (cleaner — one source of truth). Preserve the
  active-channel suppression (`getActiveChannelKey`).
- Bound the log (mirror `notificationLog`'s MAX_ENTRIES + roll-off).
- **No quorum-shared change needed** — detection (`isMentionedWithSettings`) and
  preview helpers already exist on mobile.

### Phase 2 — Surface it in the Notifications tab
- Map the new log into `UnifiedNotification` (add a `source: 'quorum'` alongside
  `'chat' | 'farcaster'`), with `link.type:'message'` carrying spaceId+channelId
  (+ threadId) so tapping deep-links to the channel — infra already exists in
  `handlePress`.
- Row text per desktop: `@you` / `@everyone` / `@role` / `replied to you`, channel
  breadcrumb, sender, preview. Reuse desktop's per-type iconography intent.
- Decide the relationship to the thin `'chat'` background-fetch log: keep it as a
  low-value fallback, or retire it for Quorum (Phase 1 gives real entries). The
  Farcaster-DM ping is still useful, so don't delete the log wholesale.

### Phase 3 — Read-state parity (optional, for "unread historical mentions")
- Today badges clear by counter reset on channel view. To match desktop's
  "unread vs read per item", adopt a per-channel `lastReadTimestamp` (write it
  where the channel screen already calls `setActiveChannel`/`clearActiveChannel`).
- An item is unread if `createdAt > lastReadTimestamp[channel]`. This also lets a
  future "mark all read" work like desktop's.
- Cross-device sync of read state is **out of scope** (desktop doesn't sync it
  either; it's local-only there too).

### Phase 4 — Per-space vs global decision (product call)
- Desktop's panel is **per-space**; mobile's tab is **global**. Global is the
  better mobile pattern (one inbox, no space context needed). Recommend: keep
  mobile **global**, but show the space/channel breadcrumb on each row so the
  user still knows where each mention came from. Optionally add a space filter
  later. **This is the main UX question to confirm with the user.**

### Explicitly out of scope / non-blockers
- No new wire/protocol types → not blocked on a quorum-shared publish. Mobile
  already carries the shared mention-detection + preview code.
- `notificationSettings.isMuted` shared-type gap (see memory) only matters if/when
  mobile adopts space-mute *sync*; it doesn't block this inbox work.

---

## Decisions (settled 2026-06-23)
1. **Global inbox** + space/channel breadcrumb per row (not per-space).
2. **Two sections** (Quorum + Farcaster), each sorted newest-first — NOT interleaved.
   `Farcaster` pill exists; add a `Space` pill.
3. **Read-state parity is in scope**, using the **two-level model** (below).
4. **Emoji previews fixed app-wide** (typed `messagePreview` + `IconSymbol`),
   superseding the 2026-06-16 emoji todo.
5. Aligning **desktop** to this (incl. read-state model + possibly a unified
   Farcaster-inclusive inbox) is a **separate, later** decision.

## Read-state: the two-level model (researched)

Researched against Slack, Discord, Apple HIG, Android, PatternFly, NN/g, IxDF,
Novu, WhatsApp (2025 "Clear Badge"). Dominant, expert-backed pattern:

- **Level 1 — Notifications tab badge:** clears when the user OPENS the tab
  (applies to both sections). "You have something to look at" → fulfilled on open.
- **Level 2 — per-space/per-channel unread bubbles:** do NOT clear on tab-open;
  clear only when the user opens that channel. Apple HIG: clear the badge when the
  *information* is read, i.e. the message, not the notification summary.

This resolves both concerns at once: opening notifications does NOT wipe the
per-space bubbles (no lost signal), and the two sections obey ONE uniform rule —
Farcaster rows simply have no Level 2 because a like/follow has no in-app
destination to "read". A secondary **"Mark all read"** action exists for a clean
slate. Full rationale + per-app evidence: see the task file.

## Key files
**Mobile**
- `app/(tabs)/profile/index.tsx` — Notifications tab UI
- `hooks/useUnifiedNotifications.ts` — merge/sort/dedup
- `services/notifications/notificationLog.ts` — thin chat log (push pings)
- `services/notifications/BackgroundMessageService.ts` — the only producer of chat-log entries
- `hooks/chat/useMentionTracking.ts`, `hooks/chat/useReplyTracking.ts` — counters (the data we should persist instead)
- `context/WebSocketContext.tsx` ~L2274 / ~L3590 — detection + discard point
- `hooks/chat/useSpaceActivity.ts` — existing precedent for a richer per-space record

**Desktop (reference)**
- `src/components/notifications/NotificationPanel.tsx`, `NotificationItem.tsx`
- `src/hooks/business/mentions/useAllMentions.ts`, `.../replies/useAllReplies.ts`
- `src/db/messages.ts` (`getUnreadMentions`, `getUnreadReplies`, `conversations.lastReadTimestamp`)
- `src/utils/mentionUtils.ts` (`extractMentionsFromText`, `isMentionedWithSettings`)

*Last updated: 2026-06-23*
