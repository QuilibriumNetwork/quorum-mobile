---
title: "Channel unread dot: drive from last-read vs latest-activity (desktop parity)"
type: task
status: open
created: 2026-06-18
priority: medium
effort: MED
depends_on: "Phase 4 (mention counts) shipped on feat/markdown-renderer-and-mention-autocomplete"
own_pr: true
---

# Channel unread dot — real "any unread" signal

## Why

Phase 4 added an unread dot to the channel row, but it's driven by a **proxy**:
it currently fires on the same condition as the mention/reply badge (i.e. only
when you were pinged). Desktop's dot is a separate, broader signal.

**Desktop's two channel-row signals:**
- **Badge (number)** = mentions + replies → "N things pinged you"
- **Unread dot** = ANY unread message in the channel, even with no mention →
  "there's new activity here". Desktop computes it as
  `lastReadTimestamp < latestMessageTimestamp`.

**The mobile gap:** a plain message (no mention) in a channel you're not viewing
shows a dot on desktop but **nothing on mobile**. Mobile only signals unread when
you were specifically mentioned/replied-to. (This is exactly what surfaced during
Phase 4 testing: plain messages pasted from the web app produced no mobile
indicator.)

The current proxy is flagged in code at
`app/(tabs)/spaces/[id]/index.tsx` (the `group.channels.map`, ~line 130) with a
NOTE comment pointing here.

## What's missing (investigated 2026-06-18)

Mobile has **neither** building block yet:

1. **No per-channel last-read timestamp.** `lastReadTimestamp` exists only on the
   DM `Conversation` object (DM inbox dot) — nothing equivalent for space
   channels. The `reply-tracking` / `mention-tracking` MMKV stores hold counts,
   not timestamps.
2. **No per-channel latest-message timestamp.** The shared `Channel` type has no
   `lastMessageTimestamp`. `useSpaceActivity` tracks latest activity **per space**
   (keyed by `spaceId`, carrying the `channelId` it came from) — NOT per channel,
   so it can't tell you unread state for all channels at once. The SQLite
   `messagesDb` has every message with `created_date` indexed by
   `(space_id, channel_id, created_date DESC)`, but exposes no
   `getLatestMessageTimestamp(spaceId, channelId)`.

## Chosen approach: MMKV timestamps on receive (O(1), no DB on render)

Mirror the existing `useReplyTracking` / `useSpaceActivity` patterns. Do NOT query
SQLite per channel on render — the channel-list screen polls every 2s, and a
per-channel DB query on that hot path risks the redraw/OOM churn this app is
already sensitive to (see memory: low-RAM redraw churn).

### Pieces

1. **New MMKV store** (e.g. `createMMKV({ id: 'channel-read-tracking' })`),
   keyed by `userAddress`, holding two maps of `${spaceId}:${channelId}` → number:
   - `lastRead` — when the user last opened the channel
   - `latestActivity` — newest message timestamp seen for the channel
   Plus standalone, callable-outside-React writers (like `incrementReplyCount`):
   - `recordChannelActivity(userAddress, channelKey, ts)` — only-if-newer
   - `markChannelRead(userAddress, channelKey)` — set lastRead = now
   And a `useChannelReadState()` hook exposing
   `hasUnread(spaceId, channelId): boolean` = `latestActivity > lastRead`, 2s poll.

2. **Receive path** — in `WebSocketContext.tsx`, at the two sites that already
   call `recordSpaceActivity` (live ~2201, batch ~3441), also call
   `recordChannelActivity(fullUserAddrRef.current, \`${spaceId}:${channelId}\`,
   spaceMessage.createdDate || ...)`. Skip own messages (sender === self) and skip
   when the channel is the active one (reuse `getActiveChannelKey()` from
   useReplyTracking, same suppression as counts).

3. **Channel entry** — in `app/(tabs)/spaces/[id]/[channelId].tsx`, the existing
   `useEffect` (alongside `clearReplyCount`/`clearMentionCount`/`setActiveChannel`)
   also calls `markChannelRead(...)`.

4. **Channel row** — in `app/(tabs)/spaces/[id]/index.tsx`, replace the proxy
   `badgeCount > 0` dot condition with `hasUnread(spaceId, channel.channelId)`.
   Keep the badge = mentions + replies (unchanged). Remove the NOTE comment.

5. **Space-level roll-up** (`app/(tabs)/spaces/index.tsx`) — optionally also
   reflect "any channel unread" in the space row, if desired.

### Known caveat (document in code + commit)

The MMKV-on-receive approach only tracks activity seen **while the app was running
and connected**. A channel that had unread messages before this feature shipped
(or while the app was killed) won't show a dot until the next new message arrives.
This is acceptable for v1 and matches the ephemeral spirit of the existing
count trackers. If full historical accuracy is needed later, seed `latestActivity`
from SQLite once on channel-list focus (the hybrid option below).

## Rejected / deferred alternatives

- **SQLite `MAX(created_date)` per channel on render** — accurate for history, but
  one DB query per channel on the 2s poll is a hot-path hazard (redraw/OOM churn).
  Rejected unless cached.
- **Hybrid (SQLite-seed on focus + MMKV live)** — most accurate, no per-poll DB
  hit, but more moving parts. Good upgrade path if the v1 caveat proves annoying.

## Pairs with

`lastReadTimestamp` is also the prerequisite for **scroll-to-first-unread** (#28)
and **mention viewport highlight** (#30), both deferred in the Wave 1 task. If
those get picked up, share the same per-channel last-read store.

## Files to touch

| File | Change |
|---|---|
| `hooks/chat/useChannelReadState.ts` | New: MMKV store + `recordChannelActivity` + `markChannelRead` + `useChannelReadState` |
| `hooks/chat/index.ts` | Export the new hook |
| `context/WebSocketContext.tsx` (~2201, ~3441) | Call `recordChannelActivity` next to `recordSpaceActivity` |
| `app/(tabs)/spaces/[id]/[channelId].tsx` | `markChannelRead` in the entry useEffect |
| `app/(tabs)/spaces/[id]/index.tsx` | Dot driven by `hasUnread`, not `badgeCount`; drop NOTE comment |
| `app/(tabs)/spaces/index.tsx` | (optional) space-row unread reflects any-channel-unread |

## Verification

- [ ] Plain message (no mention) sent to a channel you're not viewing → dot appears.
- [ ] Open the channel → dot clears; reopening doesn't re-show it.
- [ ] Mention still shows badge + dot together (badge = mentions+replies).
- [ ] Own messages don't self-mark unread.
- [ ] No per-render DB queries (the row computes from in-memory maps only).

---

*Last updated: 2026-06-18*
