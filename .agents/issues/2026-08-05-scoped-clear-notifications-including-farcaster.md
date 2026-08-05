---
type: task
title: "Scoped 'Clear' in the Notifications tab, including Farcaster rows (which today survive 'Clear all')"
status: in-progress
created: 2026-08-05
updated: 2026-08-05
priority: medium
branch: feat/scoped-clear-notifications
area: notifications / farcaster feed / notifications tab UI
runtime_test: required
related:
  - "docs/features/notification-system.md"
  - "issues/.open/2026-06-23-dms-in-global-notification-panel.md"
  - "issues/.done/2026-06-13-destructive-operations-confirmation-standard.md"
---

# Scoped "Clear" in the Notifications tab, including Farcaster

## Status

In progress on `feat/scoped-clear-notifications`. Slices A–D implemented; 404
tests pass (26 new), typecheck at baseline (11 pre-existing errors, none in
changed files). Not yet runtime-verified against §8, and not yet independently
code-reviewed.

**Correction to §4.1 during implementation (2026-08-05).** The background-ping
log is NOT all Quorum. It is written from two call sites for two different
products:

- `BackgroundMessageService.checkFarcasterDirectCasts` (~L125) — **Farcaster**
  direct casts ("New Messages" / "You have a new direct message")
- the background Quorum WebSocket path (~L239) — **Quorum** messages
  ("New Message" / "You have new messages waiting")

Both land in one log with no source field, so the original code (all under
Farcaster) mislabeled the Quorum half, and the first cut of this branch (all
under Quorum) mislabeled the Farcaster half — a straight swap of one error for
another, caught on device from a screenshot.

Fixed by adding `origin: 'quorum' | 'farcaster'` to `MessageNotificationData`,
set at both call sites, with a `fc-`/`bg-` messageId-prefix fallback for entries
already persisted. Consequences that fell out of it, both covered by tests:

- the badge double-counted, because a Farcaster direct-cast ping is a chat row
  that renders in the Farcaster section — summing the two SECTION arrays counts
  it twice. Unread is now counted over `chatItems` + `farcasterOnly`.
- `clearNotificationLog()` wipes the whole shared log, so a scoped clear needed
  `clearNotificationLogByOrigin(origin)` to avoid "Clear Quorum" deleting
  Farcaster pings.

## 1. What we want

The Notifications tab already has filter pills (`All` / `Quorum` / `Farcaster`).
Make the header's clear action follow the active filter:

| Filter | Clears |
|---|---|
| All | everything shown |
| Quorum | Quorum rows only |
| Farcaster | Farcaster rows only |

…and make the confirmation dialog say which of the three it is doing.

## 2. Can Farcaster notifications be cleared at all? (the feasibility check)

**Not on the server. Yes on the device, via a dismissal watermark.**

### 2.1 Why there is no server-side clear

Farcaster rows are not stored on device. They are two live remote feeds,
re-polled every 60s and rendered straight from the React Query cache:

- official — `farcaster.xyz/~api/v1/notifications-for-tab`
  (`hooks/useFarcasterNotifications.ts:50-54`)
- haatz — `haatz.quilibrium.com/v2/farcaster/notifications`
  (`services/farcaster/haatzNotifications.ts:145-167`)

The only Farcaster write endpoint the app has is
`PUT ~api/v2/mark-all-notifications-read` (`services/farcasterClient.ts:1224`),
which flips **read state**, not list membership. We already call it on every tab
open (`app/(tabs)/profile/index.tsx:117`) and the rows still show, because the
fetch passes `tab=none` and gets everything back regardless of read state.

- **READ (code, cited above):** certain.
- **INFERRED:** no delete/dismiss endpoint appears to exist. `~api` is
  Farcaster's private web API, so absence cannot be proven; the documented
  surfaces (mini-app notification API, Neynar) have no per-notification delete
  either.

**The decisive argument is haatz, not the missing endpoint.** haatz mirrors
protocol-level hub events — a like, a reply, a follow are records on the
network. There is nothing there to delete. So even a perfect farcaster.xyz
delete could not cover both sources. **Local dismissal is the only design that
can work**, and this conclusion does not depend on the inference above.

### 2.2 The bug this also fixes

Today's dialog claims *"This permanently removes every notification shown
here. This cannot be undone."* but `handleClearAll`
(`app/(tabs)/profile/index.tsx:281-298`) only calls `clearMentionReplyLog()` +
`clearNotificationLog()`. **Every Farcaster row survives and stays on screen.**

A user with Farcaster connected taps "Clear all" today and watches the list not
empty. This task is a bug fix wearing a feature's clothes.

## 3. Design: a dismissal watermark, not a dismissed-id set

Store one number, `farcasterClearedBefore` (ms epoch), and drop Farcaster items
whose `timestamp <= clearedBefore`.

**Why not a dismissed-id set** — the obvious alternative, and the wrong one here:

- haatz synthesises ids from `type:actor:castHash:timestamp`
  (`services/farcaster/haatzNotifications.ts:123`), so they are not stable.
- the official feed **aggregates** ("X and 5 others liked"), so a group's shape
  and count shift as activity accrues.
- the set grows unbounded and would need a cap, which re-introduces exactly the
  reappearance it was meant to prevent.

**Why the watermark handles aggregation correctly:** the normaliser reads
`latestTimestamp` for the group (`services/farcasterClient.ts:1286`). A cleared
like-group whose cast gets a *new* like therefore rises back above the watermark
and reappears. That is the behaviour we want, and it comes for free.

**Device-local, not synced.** Consistent with the Quorum mention log and the
chat log, which are both device-local MMKV. Not proposing UserConfig: it only
syncs on restart/login on mobile anyway.

**Pagination must be gated.** Pages arrive newest-first, so once a *fetched*
item falls at or below the watermark, everything older does too. `hasMore` must
go false at that point, or infinite scroll will keep fetching pages that are
100% filtered out and resolve to nothing.

## 4. Decisions already taken

Two forks were settled before writing this (2026-08-05):

**4.1 The background-push rows move into the Quorum section.**
`farcasterFeedItems` is currently `chatEntries + farcasterItems`
(`hooks/useUnifiedNotifications.ts:370-378`), all rendered under the header
**"Farcaster"** (`app/(tabs)/profile/index.tsx:271`). Those chat rows are local
mirrors of background push notifications for **Quorum** messages
(`services/notifications/NotificationService.ts:134`, only ever called from
`BackgroundMessageService`). So the "Farcaster" filter currently shows Quorum
message pings.

Fix: reassign them to the Quorum section and rename its header
`"Mentions & replies"` → `"Mentions & messages"`. This is a section-assignment
change only.

**Deliberately NOT re-sectioning further.**
`issues/.open/2026-06-23-dms-in-global-notification-panel.md` already owns the
question of where message rows belong (it explicitly weighs "third section vs
fold into Quorum" and "4th filter pill vs not"). Pre-empting those decisions
here would collide with it. This change is forward-compatible: that task can
still split messages into their own section later.

**4.2 The header button label follows the filter** — `Clear all` /
`Clear Quorum` / `Clear Farcaster`. Scope is visible before the tap, so the
dialog only has to confirm rather than explain.

## 5. Scope

Vertical slices. Each ends in something observable on device.

### Slice A — Farcaster rows can be cleared and stay cleared
*Outcome: filter to Farcaster, tap clear, rows go and do not come back after the
60s poll.*

1. New `services/notifications/farcasterDismissal.ts`, MMKV id
   `quorum-farcaster-dismissal`, key `clearedBefore`. Mirror the
   listener/`emit()` pattern already in `notificationLog.ts` so consumers
   re-render on write.
   - pure: `isDismissed(timestamp, clearedBefore)`,
     `reachedWatermark(items, clearedBefore)`
   - shim: `getFarcasterClearedBefore()`, `clearFarcasterNotifications()`
     (sets `Date.now()`), `resetFarcasterDismissal()` (tests),
     `useFarcasterClearedBefore()`
2. `useUnifiedNotifications` applies the watermark to Farcaster items and gates
   `hasMore` on `reachedWatermark` over the **raw fetched** items.

### Slice B — the sections tell the truth
*Outcome: filtering to "Farcaster" shows only Farcaster; Quorum message pings
appear under the Quorum section.*

3. Move chat rows from `farcasterFeedItems` into `quorumItems`; rename the
   section header. Carry the muted-DM filter and the badge arithmetic with them
   (see §6 — this is where the silent regressions live).

### Slice C — the clear action is scoped and honest
*Outcome: the button and dialog both name what is about to be cleared, and the
dialog stops making a false promise.*

4. `handleClearAll` → `handleClear(scope)`, driven by `activeFilter`:
   - `all` → `clearMentionReplyLog()` + `clearNotificationLog()` +
     `clearFarcasterNotifications()` + `markNotificationsSeen()` +
     `markQuorumTabSeen()`
   - `quorum` → `clearMentionReplyLog()` + `clearNotificationLog()` +
     `markNotificationsSeen()` + `markQuorumTabSeen()`
   - `farcaster` → `clearFarcasterNotifications()` only
5. Label per scope. Dialog copy per scope, keeping the
   `useConfirmDialog` + `variant: 'primary'` styling the destructive-ops
   standard established:
   - all — "Clear all notifications? This removes every notification shown here."
   - quorum — "Clear Quorum notifications? Your Farcaster activity stays."
   - farcaster — "Clear Farcaster notifications? This hides them on this device.
     They stay on your Farcaster account."
6. Gate the button on the **visible scope** being non-empty, not `items.length`
   — otherwise "Clear Farcaster" is tappable with an empty Farcaster section.

### Slice D — make it testable
7. Extract the hook's body into a pure
   `partitionNotifications(quorumEntries, chatEntries, farcasterItems, { clearedBefore, mutedConversations, lastSeen })`
   returning `{ quorumItems, farcasterFeedItems, unreadCount, reachedWatermark }`.
   **The harness has no `renderHook` / testing-library** (`jest.config.js`
   matches `*.test.ts` only, and the repo pattern is pure functions with a thin
   MMKV shim — see `__tests__/dmBurstPrefs.test.ts:1-6`). Without this
   extraction none of §7 can be written.

## 6. Traps — the silent regressions

All three fail quietly. None would be caught by using the app casually.

**6.1 The muted-DM filter must follow the chat rows.** `notMutedDM` is applied
to `farcasterFeedItems` today (`hooks/useUnifiedNotifications.ts:374`). Chat
rows are the *only* rows carrying a `conversationId`, so the filter is a no-op
for everything else. Move the rows without the filter and **muted DMs silently
start appearing in the panel again.**

**6.2 The badge must keep counting chat rows.** `getQuorumTabUnreadCount()`
reads the mention log's own watermark and knows nothing about chat entries. The
`timestamp > lastSeen` fallback that counts them lives inside the reducer over
`farcasterFeedItems` (`hooks/useUnifiedNotifications.ts:397-403`). Move the rows
and leave that reducer alone, and **background pings stop bumping the tab
badge.** The new count is
`getQuorumTabUnreadCount() + chatUnread(lastSeen) + farcasterUnread(isUnread ?? lastSeen)`.

**6.3 Apply the watermark AFTER the blend, never before.**
`blendFarcasterSources` builds a key set from the official items, then keeps
only haatz items whose key is absent (`hooks/useUnifiedNotifications.ts:236-250`).
Filter the official list first and a cleared official like-group drops out of
that key set — so its per-actor haatz duplicates stop being deduped and
**resurface as fresh rows**, one per liker, for a cast the user just cleared.
Blend, then filter.

## 7. Tests

Pure-function tests against `partitionNotifications` + the dismissal helpers.
**Each must be verified to go red** by reverting the corresponding line — an
assertion that passes either way is worse than no test here.

1. watermark hides items at/below it, keeps newer ones
2. an aggregated group whose `latestTimestamp` rises above the watermark
   reappears (guards the aggregation case §3)
3. `reachedWatermark` is false when `clearedBefore === 0` (never-cleared users
   see no behaviour change — the control arm)
4. a muted-DM chat row is excluded after moving to the Quorum section (§6.1)
5. an unread chat row still counts toward the badge after the move (§6.2)
6. a cleared official like-group does not resurface as haatz per-actor likes
   (§6.3)
7. clearing Quorum leaves the watermark at 0; clearing Farcaster leaves the
   mention log intact

## 8. Verify on device

Requires a Farcaster-connected account with both sources populated.

- Pills visible → filter Farcaster → "Clear Farcaster" → Farcaster rows go,
  Quorum section untouched, badge drops by exactly the Farcaster count.
- **Wait out a full 60s poll cycle** → cleared rows do NOT return. (This is the
  test that actually proves the watermark; everything before it only proves the
  filter renders.)
- Receive a new like/reply on Farcaster → a new row DOES appear.
- Filter Quorum → "Clear Quorum" → Quorum rows *and* background pings go,
  Farcaster rows intact.
- Filter All → everything goes.
- Kill and relaunch → cleared state persists.
- **Control arm:** an account that never taps clear sees no change in list
  contents, ordering, badge count, or infinite scroll.

## 9. Notes

- **Not a desktop parity gap.** Desktop's panel is per-space and Quorum-only
  (`docs/features/notification-system.md` §9), so it has no Farcaster rows and
  cannot have this bug. Worth re-checking desktop's own "clear" copy for the
  §2.2 class of false promise before shipping, per the both-clients rule.
- **The existing mark-seen effect re-fires after a clear** (`items.length` is in
  its deps, `app/(tabs)/profile/index.tsx:110-121`). Idempotent, harmless —
  noted so it is not mistaken for a bug during review.
- **Undo is uniquely cheap for Farcaster** and deliberately out of scope: the
  source is remote, so resetting the watermark restores everything. If a toast
  system lands (`issues/.open/2026-08-01-non-destructive-alert-alert-to-toasts.md`),
  a "Clear Farcaster → Undo" toast is a few lines. Quorum clears remain genuinely
  irreversible.

*Last updated: 2026-08-05*
