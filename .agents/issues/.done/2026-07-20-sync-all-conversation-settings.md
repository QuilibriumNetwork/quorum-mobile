---
type: task
title: "Sync per-conversation DM settings across a user's devices (mobile half)"
status: done
created: 2026-07-20
priority: medium
platforms: quorum-shared + quorum-desktop + quorum-mobile
supersedes/absorbs: 2026-06-25-dm-receipt-toggles.md (per-conversation receipt overrides fold in here)
related:
  - quorum-desktop/.agents/tasks/2026-07-20-sync-per-conversation-dm-settings-cross-repo.md (CROSS-REPO SOURCE OF TRUTH — desktop + shared already done there; keep this file in sync with it)
  - 2026-07-19-dm-receipt-pipeline-and-global-toggles.md (global receipt toggles — shipped; the per-conversation override was built then reverted to land here as one coherent feature)
  - .agents/docs/features/dm-mute-behavior-and-pattern.md (the proven UserConfig-map sync pattern to copy)
---

# Sync per-conversation DM settings across devices (mobile half)

> **This is the mobile-side execution doc.** The full cross-repo design, the shared
> work, and the completed desktop implementation live in the desktop task
> (`quorum-desktop/.agents/tasks/2026-07-20-sync-per-conversation-dm-settings-cross-repo.md`),
> which is the source of truth and is more up to date. This file mirrors its
> locked decisions and carries the mobile checklist. If the two ever disagree,
> the desktop task wins.

## Problem

Some per-conversation DM settings are **device-local** on both apps: a setting a
user changes on their phone is invisible on their desktop (and on a second
device). The state, verified against the real code on 2026-07-20:

| Setting | Mobile storage | Mobile syncs? | Desktop storage | Desktop syncs? |
|---|---|---|---|---|
| DM **mute** | `UserConfig.mutedConversations` | ✅ **yes** | `UserConfig.mutedConversations` | ✅ **yes** |
| DM **favorite** | **local MMKV `dm-favorites` set** | ❌ **NO** | `UserConfig.favoriteDMs` | ✅ yes |
| **Save Edit History** | local `Conversation.saveEditHistory` | ❌ no | local `Conversation.saveEditHistory` | ❌ no |
| **Always sign** (`isRepudiable`) | local `Conversation.isRepudiable` | ❌ no | local `Conversation.isRepudiable` | ❌ no |
| **Receipt override** (delivery/read) | (built + reverted; not present today) | ❌ no | local `Conversation.deliveryReceipts` / `.readReceipts` | ❌ no |

> **Correction (code-verified 2026-07-21).** Both task files previously claimed
> mobile **favorites** already syncs. It does NOT. `hooks/chat/useDMFavorites.ts`
> stores favorites in a device-local MMKV set (`createMMKV({ id: 'dm-favorites' })`,
> line 12) and never touches `UserConfig`. Desktop favorites DOES sync via
> `UserConfig.favoriteDMs` (`useDMFavorites.ts:55`), so this is a mobile-only gap
> and a desktop-parity item. This also means the desktop cross-repo task's
> "mute and favorites already synced on BOTH" is wrong for mobile favorites —
> flag it there too.

So on mobile only **DM mute** is already synced (`hooks/chat/useDMMute.ts`, the
reference bookmark-pattern implementation). Everything else per-conversation is
device-local: favorites (MMKV), plus the three edit-history / signing / receipt
overrides on the local `Conversation` record.

## Goal

**All per-conversation DM settings sync across a user's devices** (and
interoperate desktop ↔ mobile) via the already-synced, encrypted `UserConfig`
blob — one mechanism, not a per-setting bolt-on. Two distinct pieces of mobile work:

1. **The `conversationSettings` map** — bring these three into sync:
   `saveEditHistory`, `isRepudiable`, and the `deliveryReceipts` / `readReceipts`
   override (the map + shared helpers already exist; see below).
2. **Favorites parity (separate, simpler)** — move mobile favorites off the local
   MMKV set onto `UserConfig.favoriteDMs` (already typed in shared `2.1.0-36`,
   already synced on desktop) so favorites sync too. This is NOT part of the
   `conversationSettings` map — favorites stays a sibling array, exactly like mute.

**Mute is already done on mobile — leave it exactly where it is.** Do NOT fold
mute OR favorites into the new map (migrating to a new shape is risk with no user
benefit); favorites moves from local-MMKV to the existing sibling `favoriteDMs`
array, matching mute's carrier and desktop's key.

## Design: a synced map on `UserConfig`, keyed by conversationId

Pattern already proven by DM mute and DM favorites. The type + read/write/merge
helpers live in **quorum-shared** so both apps share byte-identical semantics.

```ts
// quorum-shared UserConfig (additive, all fields optional) — ALREADY SHIPPED in shared #63/#65
conversationSettings?: {
  [conversationId: string]: {
    saveEditHistory?: boolean;
    isRepudiable?: boolean;
    deliveryReceipts?: boolean;   // per-conversation receipt override
    readReceipts?: boolean;       // absent field = inherit the global/default
    updatedAt?: number;           // per-ENTRY last-write-wins merge key (REQUIRED)
  };
};
```

Shared helpers (published): `getConversationSetting`, `setConversationSetting`,
`mergeConversationSettings`, and the `ConversationSettingOverrides` type.

- **Read model:** effective value = per-conversation field `??` global setting
  (receipts) / `??` default (edit-history=false, sign=on). Absent = inherit.
- **Write path:** the existing `saveConfig` flow. No new sync transport — putting
  the fields on `UserConfig` is all that's needed. Same freshness as every config
  field: the other device refreshes on restart/login/config-pull, NOT live
  (see the config-blob-syncs-only-on-restart note).

### Merge strategy — LOCKED: per-entry last-write-wins

Decided in the desktop task and already implemented in shared
(`mergeConversationSettings`): per-CONVERSATION-entry last-write-wins keyed by a
per-entry `updatedAt`, matching the `userNotes` convention.

- Every write bumps that conversation's `updatedAt`; merge keeps the entry with
  the higher `updatedAt` (missing = 0; tie → keep local). Strict `>` LWW.
- An unrelated config save on another device no longer clobbers a *different*
  conversation's edit (the failure of coarse whole-blob LWW).
- **Reset-to-global keeps an empty-but-timestamped entry** (`{ updatedAt }`) as
  its own tombstone; a newer empty entry beats an older non-empty one, so resets
  propagate without a separate deletion array.
- Migration writes use a low `updatedAt` (desktop uses `1`) so any genuine edit
  always wins.

## Status of the other repos (from the desktop task)

- **quorum-shared:** ✅ DONE — PRs #63 + #65 merged to master (type +
  `ConversationSettingOverrides` + the three helpers + 18 tests, exported from the
  package root). ✅ **Published as `2.1.0-37`** (2026-07-27) — mobile bumped its
  pin same day and verified `getConversationSetting`/`setConversationSetting`/
  `mergeConversationSettings`/`favoriteDMs` are all present in the installed
  `dist/index.native.js`. The typed-use blocker is gone; untyped-cast fallback
  is no longer needed.
- **quorum-desktop:** ✅ implemented on branch `feat/sync-conversation-settings`
  (unmerged; built against locally-linked shared — must not ship until shared
  publishes). Full file-by-file changes in the desktop task's Progress section.

## Mobile implementation — DONE 2026-07-27

Built on `@quilibrium/quorum-shared@2.1.0-37` using the typed helpers directly.

### Two corrections to the checklist below, found against the real code

1. **Item 8 (favorites) is DROPPED — mobile has no favorites feature.**
   `hooks/chat/useDMFavorites.ts` is exported from the `hooks/chat` barrel and
   **called by nothing**; `components/Chat/DirectMessagesList.tsx` (the only
   component with favorite props) is exported from its barrel and **never
   rendered**. Both are dead code. There is no favorites UI to bring to parity,
   so `UserConfig.favoriteDMs` was deliberately left untouched. The cross-repo
   task's "mobile favorites is a parity gap" is wrong — it's not a gap, it's an
   unbuilt feature. Whoever builds mobile favorites should put it on
   `UserConfig.favoriteDMs` from day one.
2. **Item 3 (per-conversation receipt override UI) was already shipped.**
   `DMSettingsSheet.tsx` already had the delivery + read rows with effective
   `override ?? global` display and the inline "Reset to global" links. It only
   needed repointing at the synced map, not rebuilding.

### Migration decision: fold in AND strip the legacy fields

Desktop folds legacy values into the map and leaves the local `Conversation`
fields in place, dual-reading them for one release. Mobile goes one step further
and **deletes** the four legacy fields from the local record after folding them
in. Reason: left in place, a stale local value **shadows a reset made on another
device** — a reset writes an empty-but-timestamped entry, which reads as "no
override", so the dual-read falls through to the stale local field and the two
devices disagree forever. Stripping closes that hole. The dual-read is still in
place at every read site to cover the window before the sweep runs (and if it
fails, since it retries on next launch).

### Files touched (mobile)

- `services/config/configService.ts` — per-entry LWW merge of
  `conversationSettings` in `getConfig` (via shared `mergeConversationSettings`,
  local vs remote); `conversationSettings` added to the explicit inbound
  preservation list; new helpers `getLocalConversationSettings`,
  `getLocalConversationSetting`, `getConversationSettingForCurrentUser`,
  `setLocalConversationSetting`, `setLocalConversationSettings` (mute's bookmark
  pattern: write to config, persist locally first, best-effort outbound sync).
- `services/config/index.ts` — export the new helpers.
- `hooks/chat/useDMConversationSettings.ts` **(new)** — module-level store +
  `useSyncExternalStore` (copied from `useDMMute` so every consumer sees a toggle
  immediately), overrides-only write guard, cached `globalNonRepudiable`, and the
  one-time migration sweep (fold at `updatedAt = 1`, then strip legacy fields;
  MMKV flag `dm-conv-settings/migrated:v1:<address>`, retries on failure).
- `app/(tabs)/messages/dm/[id].tsx` — `updateConversationSetting` (local
  `storage.saveConversation`) replaced by overrides-only `saveOverrides` calls;
  effective dual-reads feed the settings sheet; `conversationForChat` hands the
  chat area the **effective** `isRepudiable` so the composer lock and send path
  follow a change made on another device.
- `hooks/chat/useEditDirectMessage.ts` — dual-read `saveEditHistory` at both
  sites (mutation write + optimistic `onMutate`).
- `context/WebSocketContext.tsx` — the receive-path readers: `isReceiptEnabled`
  (the single centralized receipt gate, mobile's equivalent of desktop's two
  intercept sites) and both DM received-edit `saveEditHistory` reads.

### Behaviour note: signing now follows the global preference

Mobile previously defaulted "always sign" to ON regardless of config. The
effective value is now `override ?? legacy ?? !(config.nonRepudiable ?? true)`,
matching desktop. Default config has `nonRepudiable: true`, so nothing changes
for existing users — but a global set on desktop now carries to mobile.

### Code review (3 parallel reviewers: sync semantics, site completeness, data safety)

**The desktop-class bug did NOT reproduce.** Both DM received-edit branches
dual-read, all three `handleDmReceipt` call sites funnel through the single
`isReceiptEnabled` gate (no second receipt gate exists), and no surviving writer
of the legacy fields remains — conversation-creation paths never set them, and
the spread-forward writes only carry through what is already on the record.

Fixed in response to review:

1. **Migration was not crash-safe.** It stripped each conversation's legacy
   fields per iteration but persisted the folded map only after the whole loop,
   so an ordinary app kill mid-sweep lost those settings permanently (a stripped
   record folds to nothing on retry). Now three phases: collect → persist the
   map → strip. An interruption now leaves values safe in the config and merely
   defers cleanup to the retry.
2. **Migration could clobber a concurrent edit.** Its final write replaced the
   whole map from a start-of-sweep snapshot. `setLocalConversationSettings` now
   MERGES via `mergeConversationSettings`, so a toggle made mid-sweep (real
   `updatedAt`) beats the migration's seeded entries (`updatedAt = 1`).
3. **`getConfig`'s merge used a stale snapshot.** `localConfig` is read at
   :322, before the `await verifyConfigSignature` at :343, and the result is
   written with a wholesale `saveLocalUserConfig`. The merge now re-reads the
   local side at write time, closing that window.
4. **The sweep ignored session identity.** Its completion wrote the module store
   unconditionally, so a sign-out plus a different sign-in mid-sweep would leave
   user A's entries in the store user B is reading (in-memory only; storage was
   always correctly per-address). Now guarded on `loadedForAddress`.
5. **Phase 3 wrote back stale conversation objects** (introduced by the phase
   reorder, since phase 2 contains a network POST). It now re-reads each record
   before stripping, so a message arriving mid-sweep is not reverted.
6. **The migration only ran if the user opened a specific DM chat** — the hook
   had one call site. `useDMConversationSettingsLoader` is now also mounted on
   the conversation list, matching where `useDMMute` loads.
7. **The 1000-conversation scan cap set the migration flag regardless**, leaving
   older conversations unmigrated with no retry path. Removed — `getConversations`
   parses the whole list before slicing, so the bound bought nothing.
8. **Stale query cache could shadow a cross-device reset.** The sweep now
   invalidates the conversation list + detail queries after stripping.
9. **Silent catches.** The two new persistence wrappers and the optimistic write
   now log, matching this file's "config-sync failure must be LOUD" principle.

### Known limitations (accepted, not fixed here)

- **`getConfig`'s early-return branches skip the merge.** When the remote
  timestamp is older than or equal to local, `getConfig` returns local without
  decrypting the remote blob, so a remote entry can be missed. This is the
  pre-existing whole-blob gate that governs every config field (mute, bookmarks,
  notification settings) — fixing it for this field alone would be inconsistent
  and touching the gate is out of scope. The per-entry guarantee therefore holds
  on the "remote strictly newer + signature valid + decrypt succeeds" path.
- **No outbound coalescing.** Each toggle independently encrypts, signs and
  POSTs, so two rapid toggles can land out of order at the server and briefly
  regress the blob for OTHER devices (self-heals on the next save; the editing
  device is always correct since each write re-reads storage). Desktop dedups via
  its action queue; mobile's mute has this same characteristic, so this matches
  the platform's existing pattern rather than introducing a new gap.
- **Not live within a session.** The module store loads once per address, so a
  change synced from another device mid-session shows after restart. Identical to
  DM mute's documented behaviour and to the config blob's freshness model.

### Verification

Typecheck: 18 errors on the branch, matching `master` after the `randomBytes`
fix landed — zero introduced. Lint: 0 errors; 0 warnings in the new hook, the
edit hook, the config index, and the DM screen.

**Device-verified 2026-07-27: the receipt-override round trip syncs.** Changing
a per-conversation receipt setting on mobile published and was confirmed present
on the server, then read and displayed on desktop:

```
[ConversationSettings] write QmYVtoS6E7… patch={} → entry={"updatedAt":…,"deliveryReceipts":false,"readReceipts":false}
[ConfigSync] published ts=1785150183968 bytes=1458504 conversationSettings=2
[ConfigSync] server read-back CONFIRMS ts=1785150183968
```

That exercises the whole spine: write → overrides-only patch → publish →
server round trip → desktop pull → merge → display.

**Still unexercised:** the one-time migration sweep (needs a device that
actually has legacy settings stored), signing and edit-history specifically
(only receipts were toggled), and the receive-path gating.

### The blocker this uncovered (fixed separately, PR #184)

The first test produced `[ConfigSync] settings POST FAILED — randomBytes is not
a function`. `encryptConfig` imported `randomBytes` from
`@noble/ciphers/webcrypto.js`, but v2 moved it to `utils.js`. The old subpath
still resolves, so the binding landed as `undefined` and threw on EVERY config
write. `saveConfig` catches, logs, and still saves locally — so this device had
never published any config at all: mute, blocked users, notification mute,
bookmarks, space keys. Inbound was fine (`decryptConfig` reads the IV from the
blob), which is why desktop→mobile appeared to work while mobile→anywhere did
not. Shipped separately as PR #184 since it blocks every synced feature.

### Config-sync instrumentation (added here, worth keeping)

Debugging the above was hard because **silence was ambiguous**: a local-only
save, a skipped publish, and a successful publish the other device hadn't pulled
were indistinguishable. The repo already treats sync failure as something that
must be loud; this adds the same for success and for skips.

- Always on (dev): `NOT publishing — allowSync is off` / `no keypair` (the
  silent killers), and `published ts=… bytes=… conversationSettings=N`.
- `CONFIG_TRACE` (`__DEV__`, absent from release bundles): per-write patch and
  entry, the pull decision (`UP TO DATE` / `KEPT LOCAL` / `TOOK REMOTE` with
  remote-vs-merged counts), and a **server read-back** that re-fetches the blob
  and compares timestamps — the only check proving a write is retrievable
  rather than merely accepted.

**Privacy:** a DM conversationId is the peer's address, so a full map dump is
the user's contact list, and debug logs get pasted into issues. Addresses are
truncated to a 10-char prefix (enough to correlate lines, not to identify);
setting values are kept in full. Keys, message content, and the encrypted blob
are never logged — only the blob's byte count. The shared logger no-ops entirely
in production.

### Noted, not acted on

- **The config blob is 1.4 MB** (`bytes=1458504`). `saveConfig`'s own comment
  references an "evals-bloat size limit" behind desktop bug #108. Publishing
  fine today, but worth its own investigation — likely `spaceKeys` accumulation.
- **Desktop merges `conversationSettings` on pull but not on push**, so a
  desktop write built from a stale stored config could drop a mobile entry. In
  practice a pull precedes writes, and it is the same coarse whole-blob exposure
  every config field already has. Lead dev's call.

## Mobile checklist (as originally written)

**Prereq cleared 2026-07-27** — mobile is on `@quilibrium/quorum-shared@2.1.0-37`,
which carries #63 + #65. Use the typed helpers directly; no untyped-cast fallback
needed.

1. **Write** — `app/(tabs)/messages/dm/[id].tsx` `updateConversationSetting()`:
   write to `UserConfig.conversationSettings[conversationId]` via
   `setConversationSetting` + the existing `saveConfig` flow, instead of
   `storage.saveConversation({ ...stored, ...patch })`.
2. **Read (dual-read, mirror desktop)** — effective value =
   `getConversationSetting(config.conversationSettings, id, key) ?? legacy local Conversation field ?? global ?? default`, at EVERY site:
   - DM send path / composer signing lock (`isRepudiable`).
   - Edit hooks (`saveEditHistory`).
   - Receipt gating.
   - ⚠️ **Receive-path readers in mobile's MessageService equivalent.** This was
     the desktop miss caught in code review (3 sites: receipt-intercept ×2 +
     edit-history-on-receive, direct from the local `Conversation` record). Find
     mobile's equivalent of the `interceptControlMessages` receipt gating and the
     received-edit `saveEditHistory` check and dual-read them too. **Do NOT update
     only the modal/composer.**
3. **Per-conversation receipt override UI** — re-add to `DMSettingsSheet.tsx` (the
   piece built + reverted on 2026-07-19); the receipt pipeline already exists.
4. **Merge** — call shared `mergeConversationSettings(local, remote)` in mobile's
   `services/config/configService.ts` `getConfig`, beside the bookmark/mute merges.
5. **Inbound preservation (mobile-specific safety — do not skip)** — mobile has the
   known broken config→`user` read-back bridge
   (`config-to-user-readback-bridge-missing`). Use the **bookmark pattern**: read
   `conversationSettings` straight from the MMKV config, NOT the `user` object.
   Mobile's `getConfig` already spreads `...decryptedConfig` (~line 397) so the
   field survives inbound today, but still add `conversationSettings` to the
   explicit inbound preservation list next to `mutedConversations`/`bookmarks` so
   no future refactor silently drops it.
6. **Migration** — one-time sweep folding local `Conversation.{isRepudiable,
   saveEditHistory,deliveryReceipts,readReceipts}` into the map with a low
   `updatedAt` (`1`, matching desktop); dual-read the legacy fields for one release
   so a mid-migration device isn't blank.
7. Keep mute (`mutedConversations`) exactly as-is — already synced.
8. **Favorites sync (separate, self-contained — can ship independently of the map).**
   Rework `hooks/chat/useDMFavorites.ts` to read/write `UserConfig.favoriteDMs`
   (already typed in shared `2.1.0-36`) instead of the local `dm-favorites` MMKV
   store, copying the `useDMMute` bookmark pattern verbatim (module-level store +
   `useSyncExternalStore`, persist via config, read straight back from MMKV config
   — NOT via the `user` object). One-time consume-and-migrate the legacy
   `dm-favorites` set into `favoriteDMs` on first load (mirror `consumeLegacyMuted`).
   Add `favoriteDMs` to the inbound preservation list next to `mutedConversations`.
   This alone brings mobile favorites to desktop parity and needs NO shared publish.

## Interop & shipping

Shipping desktop without mobile is safe; mixed desktop ↔ mobile works. The field
is additive and mobile is forward-compatible — mobile spreads `...decryptedConfig`
on inbound and re-uploads the whole config as-is, so it round-trips
`conversationSettings` it doesn't yet understand without clobbering it. Until
mobile ships, a setting changed on desktop just won't take *effect* on mobile
(and vice-versa); no data loss. Full analysis in the desktop task's "Interop &
shipping" section.

**Ship order:** shared #63+#65 merged ✅ → publish shared to npm (lead) → merge
desktop branch → mobile: bump shared pin, implement this checklist, ship. Mobile
is last (never first for a shared-typed feature).

## What goes in quorum-shared

Already done (#63+#65). No further shared/wire change needed for the mobile half —
the transport is the existing encrypted `UserConfig` blob, additive, no new wire
message type. This is NOT the blocked-wire-type class (contrast with the separate
`delete-conversation-self` self-sync work).

## Open questions for the lead (Telegram) — FYI, not blocking

1. Merge strategy is LOCKED to per-entry LWW (already shipped in shared); flag only
   if the lead wants a different sync architecture.
2. Desktop ↔ mobile parity in one go, or mobile-first with desktop to follow?
3. Confirm mute/favorites stay as their own `UserConfig` arrays (not folded into
   the new map) — recommended, and assumed here.

## Not in scope

- DM **mute** — already synced on mobile; leave as-is. (Favorites is IN scope for
  mobile — item 8 — because mobile favorites is local-only, unlike desktop.)
- **Global** delivery/read receipt toggles + the ✓/✓✓ pipeline — shipped on both.
- `delete-conversation-self` self-sync — separate task, blocked on a new wire type.
- Space (channel) settings sync — DM per-conversation only.
- Folding mute/favorites INTO the `conversationSettings` map — no; they stay
  sibling `UserConfig` arrays (favorites just needs to reach that array on mobile).

*Last updated: 2026-07-27*
