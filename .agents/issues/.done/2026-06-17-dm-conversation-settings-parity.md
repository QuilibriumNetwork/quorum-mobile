---
type: task
title: "DM conversation settings parity — UMBRELLA RETIRED (all pieces shipped or re-homed 2026-06-25)"
status: done
created: 2026-06-17
updated: 2026-06-25
source: port-to-mobile candidates #35
priority: medium
effort: closed — see the per-piece tasks
---

# DM conversation settings parity

> **UMBRELLA RETIRED 2026-06-25.** This task tracked five DM-settings pieces at
> different readiness. They are now all either shipped or extracted to focused
> tasks, so the umbrella is closed and moved to `.done/`. Where each piece lives:
>
> | Piece | Now |
> |---|---|
> | Mute (cross-device sync + UI) | ✅ SHIPPED (PR #124, master) |
> | Native background mute suppression | ✅ SHIPPED 2026-06-25 — `2026-06-21-dm-mute-suppress-native-notifications.md` (`.done/`) |
> | Save Edit History (behavior + toggle) | ✅ SHIPPED 2026-06-25 — `2026-06-21-dm-save-edit-history-honor-flag.md` (`.done/`) |
> | "Always sign messages" (signing) | → `2026-06-25-port-message-signing-controls.md` (feature port) |
> | Delete conversation Part 1 + Part 2 | → `2026-06-25-dm-delete-conversation-signal-and-self-sync.md` (Part 1 ready, Part 2 blocked) |
> | Delivery + Read receipts | → `2026-06-25-dm-receipt-toggles.md` (blocked on #9) |
>
> The full reasoning below is kept for history. Act from the per-piece tasks
> above, not this file.

## Problem

`components/Chat/DMSettingsSheet.tsx` exists and opens from the DM header gear
(`app/(tabs)/messages/dm/[id].tsx`). Each toggle renders **only if its callback
prop is passed**, and `[id].tsx` currently passes only the values
(`isRepudiable`, `saveEditHistory`), not the handlers. Net effect today: only
"Fix Encryption" + "Delete Conversation" render. Desktop's
`ConversationSettingsModal` exposes more (always-sign, mute, edit-history, +
receipts).

## Status after deep dive (2026-06-21)

umbrella closed 2026-06-25; every sub-piece is shipped or extracted to its own task (see redirect below)

The original "wire 3 callbacks, ~2h" framing was wrong. The deep dive split this
into pieces with very different readiness. **Only mute is cleanly buildable
now.** See `.agents/reports/2026-06-21-dm-delete-semantics-desktop-vs-mobile.md`
for the delete/repudiable analysis.

| Piece | State | Action |
|---|---|---|
| Delete conversation | Part 1 ready; Part 2 BLOCKED | Local delete works (`storage.deleteConversation`). Part 1 (counterparty `delete-conversation` session-reset signal) uses only published shared types → ready to build. Part 2 (self-device sync) needs the net-new `delete-conversation-self` wire type → BLOCKED (verified 2026-06-25: absent from published shared -33, local shared source -34, desktop, and mobile). See "Delete conversation — approved scope" below. |
| **Mute** | ✅ **SHIPPED** (PR #124, merged to master) | Config-backed cross-device sync + long-press settings sheet + foreground notif suppression + attention-feed/badge exclusion + bell-off row badge. See "Mute — final shipped state" below. |
| **Native background mute suppression** | ✅ **SHIPPED 2026-06-25** (branch `feat/dm-mute-native-suppress-and-edit-history`) | `type:'inbox'` DM-mute gate added in `pushReceivedTask.ts`. Closes the background/killed-app banner gap. Was tracked in `2026-06-21-dm-mute-suppress-native-notifications.md` (now done). |
| **Save Edit History** | ✅ **SHIPPED 2026-06-25** (same branch) | Edit path now honors the flag (default false, clears `edits` when off) across DM hook + space hook + both space `edit-message` receive blocks; toggle surfaced in the sheet. Was `2026-06-21-dm-save-edit-history-honor-flag.md` (now done). |
| Signing ("Always sign messages") | **Spun out 2026-06-25** | Lead-dev (2026-06-25) confirmed desktop's "Always sign messages" pattern. NOT a label change: desktop's toggle gates the send path (`effectiveSkip`) + pairs with a per-message composer lock button — mobile has neither (always signs, no button). Feature port tracked in `2026-06-25-port-message-signing-controls.md`. Toggle held out of the shipped sheet. |
| Delivery/Read receipts | Blocked on #9 | Needs the mobile receipt pipeline first. No placeholder UI. |

> **Why this task stays open (2026-06-25):** mute, native-suppression, and
> Save-Edit-History all shipped. What remains: the **signing** port (own task),
> **delete-conversation Part 2** (blocked on a new shared wire type), and
> **receipts** (blocked on #9). Close this task only when those land or are
> re-homed. Behavior + pattern for mute is documented in
> `.agents/docs/features/dm-mute-behavior-and-pattern.md` (template for channel mute).

---

## Phase B — add DM mute (BUILDABLE NOW)

Mute a DM conversation and have it muted on **all your devices**, matching
desktop.

### Decision: follow the BOOKMARK pattern, not the profile-field pattern

Mobile has a known weak spot: synced config fields are written OUT and saved to
local MMKV on the receiving device, but are often never read BACK into the
in-memory `user` object (the bridge that broke `primaryUsername` /
`isProfilePublic` — see `2026-06-10-primary-username-sync-and-publish.md` and the
memory `config-to-user-readback-bridge-missing`).

Two patterns exist for synced settings:
- **Profile-field pattern** — value must travel through the `user` object. This
  is the one with the broken read-back bridge. AVOID.
- **Bookmark pattern** — value lives in `UserConfig` and the feature reads it
  **straight from config** (via `getLocalUserConfig` / the config service),
  skipping the `user` object. Bookmarks already sync cross-device this way and
  work. COPY THIS.

**Mute = copy how bookmarks work.** Desktop already stores mute in
`UserConfig.mutedConversations` (cross-device sync). The shared `UserConfig` type
already has `mutedConversations?: string[]`.

### Current mobile state

`hooks/chat/useDMMute.ts` exists but stores mute in a **device-local** MMKV store
(`dm-muted`) — it does NOT sync across devices, and it is NOT wired into the
settings sheet. This is the thing to replace.

### How the sync works (so MMKV's role is clear)

```
Your phone:   change mute → save to MMKV (local config) → upload to hub
Hub (cloud):  holds encrypted UserConfig blob
Other phone:  download from hub → save to MMKV → mute hook reads from MMKV
```
MMKV is just each device's local copy of the config. The bookmark pattern reads
mute **directly out of the MMKV config** on the receiving device — sidestepping
the `user`-object bridge that broke before.

### Steps

1. **Rewrite `useDMMute`** to read `mutedConversations` from the config in MMKV
   (via the config service / `getLocalUserConfig`, mirroring `useBookmarks`),
   NOT from the `user` object and NOT from the standalone `dm-muted` store.
2. **On toggle**: update the `mutedConversations` array and persist via
   `saveConfig` — which serializes the whole `UserConfig` and syncs outbound for
   free when `allowSync` is on.
3. **Safety — preserve the field on inbound read-back.** In
   `services/config/configService.ts` `getConfig` (~line 393-403), the
   decrypted-config save spreads `decryptedConfig` but ALSO explicitly re-lists
   `bookmarks`/`name`/`profile_image`/`bio`/`isProfilePublic`. Add
   `mutedConversations` to that explicit list so an incoming config can't
   silently drop it (the exact failure mode that hit `primaryUsername`).
4. **Wire into the sheet**: add a "Mute conversation" toggle to `DMSettingsSheet`
   driven by `isMuted(conversationId)` / `toggleMute(conversationId)`. Desktop
   sublabel for reference: "When muted, new messages won't show unread
   indicators or notifications."
5. **Migration**: one-time read the old `dm-muted` store and fold any existing
   muted ids into `mutedConversations` (or just drop the old store — low stakes).
6. **Caveat to document in-code**: like every config field, mute only syncs when
   `allowSync` is on. With sync off it stays device-local — consistent with
   bookmarks, not a special case.

### What "muted" must actually suppress (convention check — verified)

Checked against WhatsApp / Telegram / Slack / iMessage / Discord AND desktop
Quorum (`DirectMessageContact.tsx`). The universal split:

| Signal | Muted behavior |
|---|---|
| Push notification / sound / banner | **OFF** |
| Aggregate badge (bell / app icon / tab count) | **EXCLUDE muted** |
| Per-row unread dot | **KEEP** (muting ≠ marking read; optionally dim the row) |

Desktop renders the unread dot and the bell-off badge as **independent** `&&`
conditions — the dot stays when muted. Desktop also invalidates its unread-count
query on toggle so the aggregate badge updates immediately. Do NOT remove the
per-row unread indicator for muted DMs — that diverges from every app + desktop.

### Mute — final shipped state (branch `dm-mute-sync-across-devices`)

- **Storage/sync:** `UserConfig.mutedConversations`, bookmark pattern (read back
  from MMKV config, not via `user`); preserved on inbound `getConfig`.
- **Shared in-memory state:** module-level store + `useSyncExternalStore` in
  `useDMMute` — all consumers update live on toggle; sync-load on render, reset
  on logout.
- **Foreground notifications:** `showMessageNotification` bails for muted DMs via
  `isConversationMutedForCurrentUser` (resolves the user from MMKV `auth:user`,
  so it works outside React).
- **Attention feed (Notifications list):** `useUnifiedNotifications` filters muted
  DMs OUT of `items`.
- **Aggregate bell/tab badge:** `unreadCount` derives from the already-filtered
  `items`, so it inherits the exclusion (reactive — recomputes on toggle).
- **Messages list:** bell-off badge on muted rows; per-row unread dot KEPT
  (muting ≠ read), per the convention above.
- **Long-press a row** → opens the settings sheet with recipient pfp + name +
  truncated address.
- **Reviewed:** `/code-review high` run; confirmed bugs fixed (logout-stale-set
  reset, and the bell-badge-lag below).

### Known caveats / follow-ups

1. **Native background notification suppression — SPUN OUT (not in this branch).**
   When a push wakes the app in the background, the `type:'inbox'` DM path renders
   a generic banner without checking DM mute. Viable fix (resolve
   `inbox_address → conversationId` via `getConversationInboxKeypairByAddress` in
   `pushReceivedTask`) is tracked in
   `2026-06-21-dm-mute-suppress-native-notifications.md`. The silent wake-push
   itself can't be stopped server-side (E2E). Foreground IS suppressed.
2. **Bell-badge lag — FIXED.** The original `[items]`-only memo wouldn't recompute
   on toggle. Fixed in review: `items` now filters muted DMs and depends on
   `mutedConversations`, and `unreadCount` derives from `items` — both update
   immediately on toggle.

### Mute files to touch

- `hooks/chat/useDMMute.ts` — config-backed (bookmark pattern) + module-level
  shared store via `useSyncExternalStore` (so all consumers update live)
- `services/config/configService.ts` — preserve `mutedConversations` on
  `getConfig`; `getLocalMutedConversations` / `setMutedConversations` /
  `isConversationMutedForCurrentUser` helpers
- `components/Chat/DMSettingsSheet.tsx` + `app/(tabs)/messages/dm/[id].tsx` —
  mute toggle + long-press-from-list opens the sheet with pfp/name/address
- `app/(tabs)/messages/index.tsx` — bell-off badge on muted rows
- `services/notifications/NotificationService.ts` — suppress muted-DM notifs
- `hooks/useUnifiedNotifications.ts` — exclude muted DMs from the bell badge

---

## Delete conversation — approved scope (lead-dev 2026-06-24)

The lead dev approved two things, which are **two separate builds**:

> "Delete conversation: I lean toward aligning mobile to desktop … Also: I'd like
> conversation-delete to sync to my own other devices too: but that's net-new on
> both platforms."

### Part 1 — encryption-reset signal to the counterparty (align to desktop)

Today mobile's `handleDeleteConversation` (`app/(tabs)/messages/dm/[id].tsx:223`)
does a pure-local `storage.deleteConversation(conversationId)`. Desktop also
deletes locally, but FIRST sends a `{ type:'delete-conversation' }` control
message to the counterparty; on receive the counterparty does NOT delete
anything — it only **resets its encryption session** (`deleteEncryptionStates` +
`deleteInboxMessages`) so the next message re-handshakes
(`MessageService.ts` send ~5606, receive ~2775).

Mobile parity:
- **Send:** in `handleDeleteConversation`, before the local delete, enqueue a
  `delete-conversation` control message to `recipientAddress`, mirroring the
  `remove-message` send plumbing from #36 (same encrypt+seal+`enqueueOutbound`
  path). `DeleteConversationMessage` (`{ senderId, type:'delete-conversation' }`)
  already exists in installed shared (`message.d.ts:101`) — no shared work.
- **Receive:** add a `delete-conversation` branch to `applyDMGroupResults`
  (alongside the new `remove-message` branch). It must **only tear down the
  encryption session** for that conversation (the mobile analogue of
  `deleteEncryptionStates` / `deleteInboxMessages` — likely
  `encryptionStateStorage` clear for the `conversationId` + conversation-inbox
  cleanup). It must **NOT** delete the conversation or its messages. Verify the
  exact mobile teardown calls against `encryptionStateStorage` before writing.
- **Verify:** delete the conversation on A → B keeps history but the next message
  from either side cleanly re-handshakes (no decrypt failure / stuck session).

> ⚠️ Receive side is crypto-pipeline teardown — net-new and the riskiest piece
> here. Static-verify the teardown calls and runtime-verify the re-handshake
> before shipping. Do NOT speculatively guess the encryption-state API.

### Part 2 — conversation-delete sync to your OWN other devices (NET-NEW, both platforms)

Neither desktop nor mobile does this today. Desktop's `delete-conversation` goes
to the counterparty ONLY and just resets their session; it is NOT a fan-out to
your own inboxes and does NOT delete on receive. So Part 1's signal can't be
reused — building self-sync needs a **new** wire message:

- A new self-targeted control message (e.g. `delete-conversation-self`) sent to
  your OWN device inboxes, and
- a receive handler on each of your devices that deletes the WHOLE conversation
  locally (messages + conversation row), distinct from Part 1's session-only
  teardown.

This is **net-new on BOTH platforms** and introduces a new wire type both apps
must agree on byte-for-byte. `delete-conversation-self` is a genuinely new wire/
protocol message — **NOT** an additive config field, so the mobile-first untyped
shortcut (`(config as any).X`) does NOT apply here. It is a real shared-publish
blocker.

> **Blocker re-verified 2026-06-25.** Grepped every message-type literal in:
> published shared `2.1.0-33` (`node_modules/.../dist/types/message.d.ts`), the
> local shared SOURCE at `2.1.0-34` (`quorum-shared/src/types/message.ts`, the
> link target desktop builds against — ahead of published), desktop `src/`, and
> mobile. Result: only `delete-conversation` exists everywhere; **no
> `delete-conversation-self` anywhere.** The existing `delete-conversation` can't
> be repurposed — it targets the counterparty and resets the encryption session
> on receive (does NOT delete), the opposite of what self-sync needs. So the
> blocker is genuine: the wire type does not exist and we can't publish shared
> ourselves (lead-gated). Mobile is the last platform in the chain.

**Canonical shared-publish order (lead-dev confirmed 2026-06-24) — follow this:**

1. **quorum-shared** — add the `delete-conversation-self` type, prepare for
   publishing.
2. **quorum-shared publish** — get it into a published version.
3. **quorum-desktop** — implement send + per-device delete-on-receive, plugging
   into the new shared type.
4. **(shared already published)** — mobile bumps to the published shared version.
5. **quorum-mobile** — implement send + per-device delete-on-receive last, once
   the type is published and desktop has proven the flow.

So Part 2 is **desktop-first** in implementation, but the true step 0 is
quorum-shared. Mobile is the LAST platform, gated on the shared publish. This is
the same blocker class flagged in the memory `untyped-config-cast-deblocks-
shared-publish`: additive config fields can ship mobile-first untyped, but a new
wire type both apps must agree on cannot.

> **NOT being built today (lead-dev, 2026-06-24).** Part 2 is recorded as a gated
> follow-up only. Open sub-decision still pending: confirm the exact
> `delete-conversation-self` type name/shape before opening the shared PR.

> **Recommendation:** ship #36 (message-delete) and Part 1 (session-reset signal)
> first — both use only the already-published `RemoveMessage` /
> `DeleteConversationMessage` types, so no shared work is needed. Treat Part 2 as
> a separate dated task gated on the shared publish; spin it into its own file
> when work actually starts.

---

## Blocked / deferred pieces (do NOT build until cleared)

### Repudiable / "Always sign messages" toggle — ANSWERED, SPUN OUT (2026-06-25)

Q4 resolved: lead-dev confirmed use desktop's "Always sign messages" pattern
everywhere. This turned out NOT to be a label flip — desktop's toggle is a real
send-path feature (`effectiveSkip = nonRepudiable ? false : skipSigning`) paired
with a per-message composer lock button, and mobile has neither (always signs
unconditionally, no lock button). So it's a feature port, tracked in
**`2026-06-25-port-message-signing-controls.md`**. The signing toggle was
deliberately held OUT of the 2026-06-25 mute/edit-history branch; do not surface
it until that task makes the send path honor the flag.

### Save Edit History — DONE (2026-06-25)

Shipped on branch `feat/dm-mute-native-suppress-and-edit-history`. The edit path
now honors the flag (default false, matching desktop — clears `edits` to `[]`
when off) across `useEditDirectMessage.ts`, `useEditSpaceMessage.ts`, AND both
space `edit-message` receive blocks in `WebSocketContext.tsx`. The "Save Edit
History" toggle is surfaced in `DMSettingsSheet.tsx` (default off) and persisted
from `[id].tsx`. See `2026-06-21-dm-save-edit-history-honor-flag.md` (now done).

### Delivery + read receipt toggles — BLOCKED on #9

Per-conversation receipt overrides only make sense once the mobile receipt
pipeline exists. Shared is NOT the blocker (all receipt types/`ReceiptService`/
per-conversation `deliveryReceipts`/`readReceipts` shipped in `-31`); the gate is
building #9's pipeline. No placeholder receipt UI before then.

---

## Notes

- Keep the "Fix Encryption" toggle mobile has but desktop lacks — don't remove it.
- Pairs with #36 (delete-own-message) — now APPROVED; ship #36 + conversation
  Part 1 together (both use already-published shared types), Part 2 as follow-up.
- Ship mute on its own branch/PR; the remaining blocked pieces follow when cleared.

## Source

`quorum-desktop/.agents/tasks/port-to-mobile/candidates.md` row 35.

*Last updated: 2026-06-25*
