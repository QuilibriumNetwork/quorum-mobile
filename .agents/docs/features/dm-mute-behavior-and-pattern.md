---
type: doc
title: "DM mute — behavior spec + implementation pattern (reuse for channel/space mute)"
created: 2026-06-21
status: current
applies-to: DM mute (shipped); template for channel mute + any future mute
---

# DM mute: what we show, what we don't, and how it's built

This is the canonical reference for how "mute a conversation" behaves and is
implemented on mobile. It was written for DM mute but is intended as the
**pattern to copy** when implementing channel mute, space mute refinements, or
any future per-target mute. Follow the same decision table and the same layering.

---

## 1. The core principle

**Mute = "stop pinging me", NOT "mark as read" and NOT "hide".**

Three signals are treated independently:

| Signal | Meaning | Muted behavior |
|---|---|---|
| **Notification** (push / sound / banner / native OS) | "interrupt me now" | **SUPPRESS** |
| **Aggregate unread badge** (bell badge, app-icon badge, tab count) | "how many things want my attention" | **EXCLUDE muted** |
| **Attention feed** (in-app Notifications list) | "what's new for me" | **EXCLUDE muted** |
| **Per-row unread indicator** (dot / bold on the conversation row) | "this thread has unread content" | **KEEP** (muting ≠ read) |

This split is the universal convention (WhatsApp, Telegram, Slack, iMessage,
Discord) and matches desktop Quorum. The key subtlety: **muting does not mark
anything read.** The conversation still shows it has unread content on its row;
the user just isn't actively pinged and it doesn't inflate attention counters.

---

## 2. The decision table — WHERE we show / don't show

| Surface | Muted conversation shown? | Why |
|---|---|---|
| **Push notification (foreground)** | NO | Don't interrupt |
| **Native OS notification (background/killed)** | NO* | Don't interrupt (*see native-notif task — partial; E2E limits) |
| **Bell / notification-center badge count** | NO (excluded from count) | Not demanding attention |
| **App-icon / tab unread badge** | NO (excluded) | Same |
| **In-app Notifications list (attention feed)** | NO (filtered out) | It's an attention feed, not an audit log |
| **Conversation row in the messages list** | YES — row stays, unread dot stays | Muting ≠ hiding ≠ read; still reachable |
| **A bell-off badge on the row's avatar** | YES (added) | Signals *why* it's quiet |
| **The conversation itself when opened** | YES — fully normal | Mute only affects surfacing, not content |

`*` Native background notification suppression is a separate follow-up
(`2026-06-21-dm-mute-suppress-native-notifications.md`). Foreground + in-app are
done.

**Rule of thumb:** muted content disappears from every "attention" surface
(push, badges, notification feed) but stays fully present on every "browse"
surface (the conversation list, the thread itself), with a small bell-off badge
marking it.

---

## 3. WHERE the state lives (storage + sync)

**Store mute in `UserConfig` so it syncs across devices** — follow the **bookmark
pattern**, NOT the profile-field pattern.

- DM mute → `UserConfig.mutedConversations: string[]`.
- Channel/space mute → already partly in `UserConfig.notificationSettings` /
  `mutedChannels` (desktop) — keep new mute state on `UserConfig` likewise.

**Why the bookmark pattern (critical):** mobile has a known broken
"config → in-memory `user` object" read-back bridge (it silently dropped
`primaryUsername` / `isProfilePublic`; see memory
`config-to-user-readback-bridge-missing`). So:

- ✅ **Bookmark pattern** — value lives in `UserConfig`, read STRAIGHT BACK from
  the local MMKV config (`getLocalUserConfig` / a config-service helper),
  bypassing the `user` object. Bookmarks + now DM mute work this way.
- ❌ **Profile-field pattern** — value must travel through the `user` object.
  This is the broken bridge. AVOID for any synced setting.

**Outbound sync is free:** `saveConfig` serializes the whole `UserConfig` to the
hub (encrypted, signed) when `allowSync` is on. Putting the field on
`UserConfig` is all that's needed — no new sync transport.

**Inbound safety step (do not skip):** in `configService.getConfig`, the
decrypted-config save explicitly re-lists certain fields
(`bookmarks`/`name`/`profile_image`/`bio`/`isProfilePublic`/`mutedConversations`)
on top of the `...decryptedConfig` spread. **Add your new mute field to that
explicit list** so an incoming config can't silently drop it — the exact failure
mode that hit `primaryUsername`.

**Caveat (consistent, not special):** mute only syncs when `allowSync` is on;
with sync off it stays device-local. Same as every config field.

---

## 4. HOW the in-memory state is shared (the React shape)

**One module-level store + `useSyncExternalStore`, NOT per-hook `useState`.**

The first DM-mute attempt used per-hook `useState` + `useEffect`. Bug: each
`useDMMute()` call had its own copy, so muting on the DM screen didn't update the
messages-list badge until a remount. Fix (reference: `hooks/chat/useDMMute.ts`):

- A module-level `mutedSet: Set<string>`, `loadedForAddress`, and a `listeners`
  set with `subscribe` / `getSnapshot` / `emit`.
- `useDMMute()` reads via `useSyncExternalStore(subscribe, getSnapshot)` so EVERY
  consumer (sheet, list, row, notification hook) updates the instant mute
  toggles.
- **Load synchronously on first sight of the address** (in render — reading an
  external store during render is supported) so the first paint has the correct
  set (no one-frame flash). Guard with `loadedForAddress` (idempotent).
- **Reset on logout in an effect** (`if (!address) resetForLogout()`): clears the
  set and `loadedForAddress`. Without this the module-level set outlives the
  session (no JS reload on sign-out), so a same-address re-login after a config
  wipe would show stale mutes.
- On toggle: build a NEW `Set` reference, `emit()`, then
  `void persist...(address, [...next])` (best-effort; local write first so it
  survives a failed sync).

**Reactivity rule:** anything that filters by mute (the messages-list memo, the
notifications hook) must depend on the muted set / a callback keyed on it, so it
recomputes on toggle. `isMuted` is a `useCallback` keyed on `mutedConversations`,
so depending on `isMuted` alone re-runs a memo — don't ALSO add
`mutedConversations` (redundant).

---

## 5. WHERE the suppression is enforced (the layers)

Four enforcement points. Channel mute already covers some of these via
`notificationPrefs` + `shouldNotifyForContext`; DM mute had to add the DM-specific
ones. When adding a new mute, wire all the relevant layers:

1. **Foreground notification gate** — `NotificationService.showMessageNotification`
   checks the target against the muted set (via
   `isConversationMutedForCurrentUser`, a config-service helper that resolves the
   current user from MMKV `auth:user` — usable outside React). Returns early if
   muted.
2. **Native/background notification gate** —
   `pushReceivedTask.ts` already gates global + per-space + per-channel mute
   before rendering. DM mute's background gate is a follow-up (resolve
   `inbox_address → conversationId` via
   `encryptionStateStorage.getConversationInboxKeypairByAddress`, then check the
   muted list). **Channel mute is ALREADY enforced here** — use it as the model.
3. **Attention feed (Notifications list)** — `useUnifiedNotifications` filters
   muted items OUT of `items` (depends on `mutedConversations`).
4. **Aggregate badge** — `unreadCount` derives from the already-filtered `items`,
   so it inherits the exclusion (no separate check needed).

**Layering note:** the React paths (3, 4) read the in-memory shared set (reactive,
cheap). The non-React paths (1, 2 — background tasks, no `useAuth`) read MMKV via
`isConversationMutedForCurrentUser`. Keep that division: React → shared store;
background → MMKV helper.

---

## 6. What we DON'T do (and why)

- **Don't mark muted threads read.** The per-row unread dot stays.
- **Don't remove the muted conversation from the messages list.** Mute ≠ archive.
- **Don't try to suppress the silent wake-push at the server for DMs.** E2E means
  the server can't decrypt to know the conversation; per-DM muting is
  necessarily client-side. (Per-space/hub mute CAN be server-side via
  `muted_hubs` because hubs aren't encrypted — that's why channel/space mute has
  a server-side `pushPrefsSync` path and DM mute doesn't.)
- **Don't route synced mute through the `user` object.** Broken bridge.

---

## 7. Checklist for implementing a NEW mute (e.g. channel mute parity)

- [ ] State on `UserConfig` (sync), read back via the bookmark pattern (not `user`).
- [ ] Add the field to `getConfig`'s explicit inbound preservation list.
- [ ] Module-level shared store + `useSyncExternalStore`; sync-load on render,
      reset on logout.
- [ ] A `isXMutedForCurrentUser(...)` config-service helper for non-React paths.
- [ ] Foreground notif gate (`showMessageNotification` / `shouldNotifyForContext`).
- [ ] Background notif gate (`pushReceivedTask`) — channel mute already here.
- [ ] Filter muted out of the attention feed (`useUnifiedNotifications` items).
- [ ] Badge inherits from filtered items (don't double-filter).
- [ ] KEEP the per-row unread indicator; ADD a bell-off badge on the row.
- [ ] Settings toggle = a `Switch` inside the settings sheet; context-menu entry
      (if any) = a tappable Mute/Unmute row (desktop split).
- [ ] Verify reactivity: toggling updates list + badge immediately (shared store).

## Related

- Implementation: `hooks/chat/useDMMute.ts`, `services/config/configService.ts`,
  `services/notifications/NotificationService.ts`,
  `hooks/useUnifiedNotifications.ts`, `components/Chat/DMSettingsSheet.tsx`,
  `app/(tabs)/messages/index.tsx`.
- Follow-up: `.agents/issues/.done/2026-06-21-dm-mute-suppress-native-notifications.md`.
- Settings parity context: `.agents/issues/.done/2026-06-17-dm-conversation-settings-parity.md`.
- Storage-pattern background: memory `config-to-user-readback-bridge-missing`.

*Last updated: 2026-06-21*
