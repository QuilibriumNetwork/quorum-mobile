---
type: bug
title: "Config sync is add-only — a space deleted on one device never disappears on the other"
status: open
created: 2026-07-19
severity: high
platforms: quorum-mobile (+ likely quorum-desktop mirror)
---

# Config sync never removes deleted spaces (add-only)

> 🧭 **Start at the umbrella task:**
> `quorum-desktop/.agents/tasks/2026-07-31-spaces-list-cross-device-sync.md` is the single
> entry point for Spaces-list cross-device sync across both repos. It carries the verified
> per-pair state matrix and the ordering constraint for the fixes.
>
> It lives in **quorum-desktop** deliberately: this repo's `.agents/` is gitignored, so
> anything filed here is invisible to the rest of the team. The findings below are
> restated in the index for that reason — if you edit them here, mirror them there.

Extracted from the signing-key/multi-device hunt tracker (was "M2").

## Symptom

A space deleted on desktop still shows on mobile (and vice versa). Observed
2026-07-19 during multi-device testing.

## Cause

`syncSpacesFromConfig` (mobile `services/config/spaceSyncService.ts`) only
ADDS/heals spaces present in the config blob — there is no reconciliation that
REMOVES a local space when it drops out of the config's `spaceIds`. Desktop has
the same add-only shape (`ConfigService.ts` `if (!existingSpace)`), confirmed
during the hunt. Compounded while config uploads were failing (evals-bloat 400,
see the config-400 lesson) — deletions may not have published at all.

## Second cause — mobile delete/leave never PUBLISH (write side), confirmed 2026-07-21

The add-only reconciliation above is the RECEIVE side. On mobile there is also a
WRITE-side gap that makes the mobile→desktop ("vice versa") direction doubly
broken: **a space delete/leave on mobile is never written back to the synced
config, and never notified to the hub — so there is nothing for another device
(or another member) to react to.**

Asymmetry that proves it:
- **Create/join DO publish:** `services/space/spaceService.ts:404-407` writes
  `spaceIds: [...config.spaceIds, spaceAddress]` then `saveConfig(updatedConfig)`
  → the new space rides the synced `UserConfig` blob to other devices.
- **Delete/leave do NOT publish:** `useDeleteSpace` / `useLeaveSpace`
  (`hooks/chat/useSpaceSettings.ts:107-157`) only mutate **local MMKV**
  (`spaceStorage.deleteSpace`, `services/config/spaceStorage.ts:83` — removes the
  local key + local `spaceIds` list). They call **no `saveConfig`**, add **no
  `deletedSpaceIds` tombstone**, and send **no hub leave**. `useLeaveSpace` is an
  explicit stub: `// TODO: Send leave message to space before deleting`.

Consequences:
1. **Cross-device:** the deletion never reaches the synced `UserConfig`, so the
   other device has nothing to reconcile — independent of, and upstream of, the
   add-only receive bug. (Desktop, by contrast, DOES write `userConfig.spaceIds`
   + `saveConfig` in `SpaceService.deleteSpace`.)
2. **Cross-member:** no hub 'leave' envelope / `postHubDelete` is sent, so other
   members never learn the user left (desktop sends both).

This is the write half of "delete/leave should sync to all devices"; the
tombstone reconciliation below is the read half. Both are needed.

### Third cause — the kicked handler writes to an orphaned store, confirmed 2026-07-31

Delete/leave are not the only write-side gap. The kicked handler
(`context/WebSocketContext.tsx:1215-1221`) *does* try to remove the space from
the config — `adapter.getUserConfig(ownAddress)`, filter `spaceIds`,
`adapter.saveUserConfig(updatedConfig)` — but it goes through `mmkvAdapter`,
which reads/writes key `userConfig:${address}` in the MMKV instance
`createMMKV({ id: 'quorum-cache' })` (`services/storage/mmkvAdapter.ts:31,198-205`,
`services/offline/storage.ts:8`).

`configService`'s own store is a **different MMKV database with a different key
prefix**: `createMMKV({ id: 'quorum-config' })`, key `user_config:${address}`
(`services/config/configService.ts:42,47`). `getLocalUserConfig` /
`saveLocalUserConfig` never touch the `quorum-cache` copy, and a repo-wide grep
finds no other caller of `adapter.getUserConfig` / `adapter.saveUserConfig` — so
nothing ever writes that key. On a device's first kick `adapter.getUserConfig`
returns `undefined` and the whole `if (userConfig) {...}` block is skipped.

So being kicked has the same outcome as leaving: the id stays in the real
`config.spaceIds` with its keys deleted. Fixing the write side must cover this
path too, and should route through `configService` rather than the adapter.

### Ordering constraint — write side MUST land before any refuse-to-publish

Desktop now refuses to publish a Space list narrowed by incomplete local storage
(`quorum-desktop` `ConfigService.saveConfig`), which is what stops one device's
half-synced state from emptying every other device's nav.

**That guard cannot be ported here until the write side above is fixed.** It was
tried on 2026-07-31 and reverted the same day. Because no mobile path prunes
`config.spaceIds`, a left/deleted/kicked Space keeps its id forever with its keys
gone, so the narrowing always drops something, so the guard would hold every
publish — permanently. The device would silently stop syncing *any* config change
(settings, mutes, bookmarks, profile) with no retry and no recovery. The old
add-only code at least self-healed that by pruning and publishing.

What did ship on mobile (`fix/config-save-filter-wipes-local-spaces`) is only the
unconditionally-safe half: the narrowing now builds a separate `uploadConfig`
instead of rewriting `config`, so `saveLocalUserConfig` at the end of `saveConfig`
can no longer delete Spaces from this device's own stored list. Publishing
behaviour is unchanged, with a warning when the published list is shorter than
the one held.

Order: (1) write side prunes `config.spaceIds` on delete/leave/kick →
(2) tombstones + reconciliation → (3) port desktop's refuse-to-publish guard.

## Fix (contract both platforms must share — do NOT reinvent)

Do NOT reconcile "absent from config" directly (it fights the existing
Restore-Spaces recovery tool, which re-adds DB-not-in-config spaces, and risks
wiping spaces during a partial/failed config fetch). Instead mirror the
existing `deletedBookmarkIds` / `deletedUserNoteAddresses` tombstone pattern:
add synced `deletedSpaceIds` tombstones; reconciliation purges ONLY tombstoned
ids. Safe against partial/failed fetches. Desktop agent wrote the design task
(`quorum-desktop/.agents/tasks/2026-07-19-space-deletion-ghost-cleanup.md`);
mobile mirrors that contract. Also make space delete instant+offline via the
action queue (delete-space is currently not queued on either platform).

Write side (the second and third causes above) — `useDeleteSpace` /
`useLeaveSpace`, **and the kicked handler**, must, in addition to the local MMKV
wipe (the kicked handler must also stop writing through `mmkvAdapter`, which
targets a different store entirely):
1. Write the deletion into the synced config: remove the id from
   `config.spaceIds`, add it to `config.deletedSpaceIds` (tombstone), then
   `saveConfig(updatedConfig)` — mirroring the create/join write at
   `spaceService.ts:404-407`. This is what makes it reach the other device.
2. Send the hub 'leave' notify (implement the `useLeaveSpace` TODO / mirror
   desktop `SpaceService.deleteSpace`'s leave envelope + `postHubDelete`) so
   other members learn the user left. Best routed through the same durable
   queue once delete-space is queued.

## Related
- Hunt tracker (archived): `.agents/reports/.done/2026-07-19-signing-key-multidevice-hunt-tracker.md`.
- Config-400 / evals-bloat context that masked deletions.

*Last updated: 2026-07-31*
