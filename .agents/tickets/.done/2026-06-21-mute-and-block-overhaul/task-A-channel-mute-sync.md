---
type: task
title: "Task A — Channel/Space notif-mute: make it sync cross-device"
created: 2026-06-21
status: done
build-order: 2
repos: mobile (shared `isMuted` DONE — merged, awaiting lead npm publish)
risk: medium (touches the config-sync bridge — follow the bookmark pattern exactly)
---

# Task A — Channel/Space notif-mute cross-device sync

**Goal:** mobile's per-channel and per-space notification mute must SYNC across the
user's devices (and with desktop), satisfying the "settings must sync everywhere"
requirement. Today it does NOT. This is the recurring sync problem; the fix is the
proven **bookmark pattern** (see README §2).

This is notification-mute (silence pings for yourself) — NOT moderation (Task C),
NOT personal block (Task D).

---

## The problem (current state)

Mobile stores channel/space mute in a **device-local MMKV store**
`quorum-notification-prefs` (`services/notifications/notificationPrefs.ts`), keys
`space:<id>` and `channel:<spaceId>:<channelId>`. This store:
- ✅ Gates local + background + NSE notifications (works).
- ✅ Syncs per-SPACE mutes to the SERVER via `pushPrefsSync.ts` (so the server
  drops pushes for muted hubs **for this device's token**).
- ❌ Does NOT sync to the user's OTHER devices. `pushPrefsSync` is per-token push
  filtering, not settings sync.
- ❌ Per-CHANNEL mute doesn't sync anywhere at all.

**Desktop** stores the same setting in `UserConfig.mutedChannels` /
`notificationSettings[spaceId].isMuted` — which DOES sync cross-device. So
**mobile↔desktop channel/space mute settings don't sync to each other today.**

The `UserConfig` fields ALREADY EXIST in shared (`quorum-shared/src/types/user.ts:37`:
`mutedChannels`, `notificationSettings`). Mobile just isn't using them.

> **⚠️ Verified discrepancy (2026-06-21) — read before assuming "no shared PR":**
> - **Per-CHANNEL mute** uses `UserConfig.mutedChannels[spaceId]: string[]` — this
>   field IS fully declared in shared (`user.ts:89-91`). **No shared change needed.**
> - **Per-SPACE mute**: desktop reads/writes `notificationSettings[spaceId].isMuted`
>   (`quorum-desktop/.../useChannelMute.ts:307,333,393`) — BUT the shared
>   `NotificationSettings` type is `{ enabled?, mentions?, replies?, all? }` and does
>   **NOT declare `isMuted`** (`quorum-shared/src/types/user.ts:24-29`). Desktop is
>   writing an undeclared field that survives only because the config is JSON-blobbed
>   untyped over the wire. **This is a latent shared-type gap.**
>
> **Decision for Task A — shared `isMuted` is now MERGED (`2.1.0-33`):** the typed
> field landed in shared `master` (PR #48, `51ab9b6`), so the gap above is closed at
> the source. But we can't publish to npm (lead-only), so until `2.1.0-33` is
> published + mobile's pin bumped:
> - **Mobile ships NOW, untyped:** write/read space-mute via
>   `(config as any).isMuted` on `notificationSettings[spaceId]` — the EXACT pattern
>   mobile already uses for `bio` / `isProfilePublic` / `mutedConversations`
>   (`configService.ts:402-407`). The field syncs correctly over the untyped wire
>   blob regardless of the TS type. **Not blocked on publish.**
> - **On the next mobile bump (post-publish):** replace each `as any` with the typed
>   field. Mark each cast `// TODO: type via shared NotificationSettings.isMuted once
>   2.1.0-33 published` so the cleanup is greppable.
> - (Rejected fallback: representing space-mute via the existing `enabled:false`
>   would avoid the cast but DIVERGE from desktop's `isMuted` — don't; cross-platform
>   mismatch is worse than a temporary cast.)

---

## Shared sub-task — ✅ DONE (merged in 2.1.0-33; awaiting lead npm publish)
- [x] quorum-shared: added `isMuted?: boolean` to `NotificationSettings`
      (`src/types/user.ts`). Merged PR #48 (`51ab9b6`); build green; version bumped
      `2.1.0-33` (`0ff099e`). ⏳ Lead must still `npm publish` it. **Mobile does NOT
      wait** — ships space-mute via `(config as any).isMuted` now; swaps to typed on
      the next pin bump. Per-channel `mutedChannels` was already published.

## The fix — move mute state onto `UserConfig` (bookmark pattern)

Make `UserConfig` the source of truth; keep the MMKV store as a fast local
read-through cache for the non-React notification gates (NSE/background can't read
`UserConfig` easily, so they still need a local mirror). Two-layer design:

- **Source of truth + sync:** `UserConfig.mutedChannels[spaceId]: string[]` and
  `UserConfig.notificationSettings[spaceId].isMuted: boolean`.
- **Local fast mirror for gates:** keep writing the `quorum-notification-prefs`
  MMKV keys (and the App-Group mirror for the NSE) so `shouldNotifyForContext`,
  `pushReceivedTask`, and `HubLogClassifier.swift` keep working UNCHANGED. The
  mirror is derived FROM `UserConfig`, not the other way around.

### The three mandatory bookmark-pattern steps (README §2)
- [ ] **Write to `UserConfig`** on every mute toggle (via a `configService` helper
      that updates the field + calls `saveLocalUserConfig`, and lets the existing
      `saveConfig` sync path carry it). Mirror `setMutedConversations`
      (`configService.ts:562-565`).
- [ ] **Read back from local `UserConfig`** (a `getLocalMutedChannels(spaceId)` /
      `getLocalSpaceMuted(spaceId)` helper) — NOT through the `user` object. Mirror
      `getLocalMutedConversations` (`configService.ts:552-556`).
- [ ] **Add the fields to the inbound preservation list** in
      `configService.getConfig` — the `configWithTimestamp` object at
      `configService.ts:394-408`. Add `mutedChannels` and `notificationSettings`
      to the explicit re-list (alongside `mutedConversations`) so an incoming
      config can't silently drop them.

### Keep the gates working (the mirror)
- [ ] On config load AND on every toggle, sync `UserConfig.mutedChannels` /
      `notificationSettings[*].isMuted` INTO the `quorum-notification-prefs` MMKV
      keys (+ App-Group mirror). So `notificationPrefs` getters and the
      Swift NSE keep reading the same keys they read now — no NSE change required.
- [ ] On INBOUND config sync (another device muted a channel), refresh the MMKV
      mirror so the gates immediately reflect the synced state.
- [ ] Keep `pushPrefsSync` as-is — it derives muted hubs from the MMKV mirror,
      which now follows `UserConfig`. Confirm it still fires on toggle.

### React reactivity
- [ ] The settings sheet (`SpaceSettingsModal` Account-tab toggles) must read from
      the new `UserConfig`-backed source. Consider a module-level
      `useSyncExternalStore` (like `useDMMute`) keyed on the config so toggles +
      Task B's per-row visual update instantly across surfaces.

---

## Migration (don't lose existing mutes)
- [ ] One-time migration: on first run after this lands, read existing
      `quorum-notification-prefs` keys and seed `UserConfig.mutedChannels` /
      `notificationSettings[*].isMuted` if `UserConfig` is empty for that space.
      Mirror the legacy-consume approach in `useDMMute.ts` (`consumeLegacyMuted`).
      After seeding, `UserConfig` is authoritative; MMKV becomes the derived mirror.

---

## Scope decisions
- **Storage migration IS in scope** (it's the whole point — user: "settings must
  sync, very important"). The earlier "probably not worth it" framing was wrong:
  without it, mute does not sync cross-device, which fails the requirement.
- **Notification-type selector / "@you/@everyone/roles/replies" granularity**
  (desktop's `enabledNotificationTypes`): OUT of scope for A unless the user asks.
  A is purely "make the existing binary mute sync."
- **"Hide muted channels" toggle** (`showMutedChannels`): OUT of A — that's a UX
  add; fold into Task B if wanted. A is sync only.

---

## Verification
- [ ] TS build + lint clean; grep no stray references to the old direct-MMKV writes
      from the settings UI (they now go through `configService`).
- [ ] **Runtime (Android, user-tested):** mute a channel on device → confirm it
      reaches `UserConfig` (and, if a 2nd device / desktop available, that it shows
      muted there after sync). Confirm notifications still suppress (gates intact).
- [ ] Confirm `pushPrefsSync` still posts muted hubs on a space mute.
- [ ] iOS review: NSE still reads the App-Group mirror (we didn't change the keys).

## Related
- Pattern: `hooks/chat/useDMMute.ts`, `services/config/configService.ts:552-565`,
  preservation list `configService.ts:394-408`.
- Gates we must not break: `services/notifications/notificationPrefs.ts`,
  `pushReceivedTask.ts`, `pushPrefsSync.ts`, `ios/.../HubLogClassifier.swift`.
- Desktop model: `quorum-desktop/.agents/docs/features/channel-space-mute-system.md`.
- Memory: `config-to-user-readback-bridge-missing`.

*Last updated: 2026-06-21*
