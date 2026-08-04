---
type: task
title: "Mute & Block overhaul — overview + map"
created: 2026-06-21
status: done
scope: cross-repo (mobile primary; shared additive; one desktop task)
---

# Mute & Block overhaul — overview

> **▶ CURRENT STATE (2026-06-22):** The shared type change is DONE.
> `NotificationSettings.isMuted?`, `UserConfig.blockedUsers?` (per-space), and
> `blockUtils` (`isUserBlocked` / `getBlockedUsersForSpace`) are **merged to shared
> `master`** (PR #48, `51ab9b6`) and the version is bumped to **`2.1.0-33`**
> (`0ff099e`). ⏳ **NOT published to npm yet — that's lead-only.** So mobile A/D
> consume the new fields UNTYPED via `(config as any)` until the lead publishes
> `2.1.0-33` and mobile bumps its pin, then we swap casts → typed.
>
> **ALL mobile tasks SHIPPED.** C via **PR #125** (with the chat-scroll-jump patch).
> A + B via `feat/channel-mute-sync-and-ux` (channel/space notif-mute synced + muted
> visuals + in-app bubble suppression). D via `feat/personal-block-user` (viewer-side
> hide renamed to Block, synced via `UserConfig.blockedUsers`, confirm modal, +
> "Blocked" accordion so blocked users are reachable to unblock). The only thing left
> on the whole overhaul is the lead's shared **npm publish** of `2.1.0-33`, after which
> mobile swaps the `(config as any)` casts (isMuted / blockedUsers) to the typed fields.
> **Known platform caveat:** UserConfig-blob settings (these mutes + block) only
> propagate cross-device on peer restart — see
> `.agents/issues/.open/2026-06-22-userconfig-blob-not-live-synced-cross-device-master.md`.

This folder breaks one tangled "let's check the mute feature" request into **four
separable features** plus **one desktop-side task**. Read this README first; it is
the map. Each task file is self-contained and can be implemented + verified
independently. Nothing is coded until the user signs off on this plan.

> **Why a folder, not one task:** the work spans four features and three repos,
> touches the sensitive config-sync bridge, and has real regression risk. One
> mega-task would lose context and risk bugs. Splitting keeps each piece's blast
> radius contained and shippable on its own batched branch/PR.

---

## 0. The vocabulary problem this resolves

"Mute" meant **four different things** that were conflated. They are now named
distinctly:

| Term used here | What it is | Who it affects |
|---|---|---|
| **Channel/Space mute** | Silence *notifications* from a channel or whole space, for yourself | Just you (your devices) |
| **Mute user (moderation)** | A moderator stops a *user* from posting in a space, for everyone | Everyone in the space |
| **Block user (personal)** | Hide a user's messages from *your own* stream | Just you (your devices) |
| **DM mute** | (already shipped) silence a 1:1 conversation's notifications | Just you (your devices) |

Mobile previously had a single `hooks/chat/useUserMuting.ts` that was actually a
**personal Block** (device-local viewer-side hide). Desktop's same-named
`useUserMuting` is a **moderation Mute** (role-gated broadcast). Same name,
opposite features. This overhaul untangles that: mobile gets BOTH, correctly
named, and desktop gets a task to add the personal Block it currently lacks.

---

## 0b. NAMING SCHEME (locked 2026-06-21 — use these EXACT symbols everywhere)

Naming is the #1 confusion risk here. There are FIVE per-user/per-target features
that must never blur together. Audit of the current tree found the existing
`useUserMuting` is misnamed (it's a personal hide, not a mute) and that Farcaster
already owns "block"/"mute" words via `useBlockedFids`/`useMutedFids`. Agreed scheme:

| Feature | Hook / symbols | UI label | Scope | Sync |
|---|---|---|---|---|
| **Personal block** (hide a user's msgs from MY space stream) | `useBlockUser` / `blockedUsers` / `isUserBlocked` / `toggleBlockUser` | **"Block" / "Unblock"** | personal, per-space | UserConfig.`blockedUsers` |
| **Moderation mute** (role-gated, silence user for everyone) | `useModMuteUser` / `muteUser` / `unmuteUser` / `canMuteUser` (shared) | **"Mute" / "Unmute"** | space-wide | broadcast `MuteMessage` |
| **DM mute** (DM notif silence) | `useDMMute` (UNCHANGED) | "Mute" (DM context) | personal | UserConfig.`mutedConversations` |
| **Channel/space mute** (notif silence) | (Task A helpers) `getLocalMutedChannels` etc. | "Mute" (channel context) | personal | UserConfig.`mutedChannels` / `notificationSettings.isMuted` |
| **Farcaster block/mute** (external) | `useBlockedFids` / `useMutedFids` (UNCHANGED) | Farcaster's own | feed-level | Farcaster API |

**Hard rules so the words don't collide:**
- The OLD `hooks/chat/useUserMuting.ts` is RENAMED to `useBlockUser` in Task D.
  After Task D, **no symbol named `*UserMuting` / `mutedUsers` / `isUserMuted` may
  refer to the PERSONAL hide.** Those words belong to the MODERATION feature only.
- **Farcaster vs Quorum disambiguation (Collision 2):** Farcaster's
  `useBlockedFids`/`useMutedFids` key on numeric FIDs and mirror an external list;
  the Quorum-space block keys on user addresses + spaceId and lives in UserConfig.
  They are different systems — do NOT merge or cross-import. When a name could read
  either way, prefer the explicit Quorum-side form (`isUserBlocked(address, spaceId,
  …)` takes an address + spaceId; the Farcaster form takes a `fid: number`). The
  signature difference is the guard.
- **UI labels are fixed:** personal = **Block/Unblock**; moderation = **Mute/Unmute**
  (matches desktop's moderation "Mute" + the shared `MuteMessage` wire type).

## 1. The four mobile tasks (+ one desktop)

| Task | File | What | Repos | Risk | Build order |
|---|---|---|---|---|---|
| **C** | `task-C-moderation-mute-user.md` | ✅ **SHIPPED** (PR #125, mobile `master`, 2026-06-22). Moderation mute-user (role-gated, broadcasts signed `MuteMessage`, drop sender's messages, disable composer, duration/expiry) — full desktop parity | mobile only* | Med-high | done |
| **A** | `task-A-channel-mute-sync.md` | ✅ **SHIPPED** (branch `feat/channel-mute-sync-and-ux`, 2026-06-22). Channel/space notif-mute moved mobile MMKV → `UserConfig` (synced; MMKV kept as native-gate mirror). Outbound verified; cross-device propagates on peer restart per the config-sync limitation (see master sync report). | mobile | Medium | done |
| **B** | `task-B-channel-mute-ux.md` | ✅ **SHIPPED** (same branch). Per-channel mute: name dims + bell-off (icon stays colored). Space mute: bell-off on space icon (list) + space name (header), no channel-list dimming. Plus: mute now also suppresses the in-app mention/reply bubble. | mobile only | Low | done |
| **D** | `task-D-personal-block-user.md` | ✅ **SHIPPED** (branch `feat/personal-block-user`, 2026-06-22). Renamed viewer-side hide → "Block" (`useBlockUser`), synced via `UserConfig.blockedUsers` (+ migration), confirm modal, and a "Blocked" accordion in Space Settings so blocked users are always reachable to unblock. | mobile | Medium | done |
| **DESKTOP** | `task-DESKTOP-personal-block.md` | ✅ **DONE** — lead greenlit; personal Block built + shipped on desktop (PR #207, merged to `main`). Consumes shared `blockedUsers`. | desktop | shipped | done |

`*` Task C is "mobile only" because **shared already has everything**: `MuteMessage`
type, `canMuteUser()`, `canonicalize()` for the mute branch, `'user:mute'`
permission token. Mobile just wires send + receive. See task C for exact refs.

---

## 2. THE SYNC RULE (read before A or D — this is the recurring footgun)

Every "setting that must sync across devices" on mobile MUST follow the
**bookmark pattern**, proven by DM mute (`mutedConversations`). This is the fix
for the sync problem we keep hitting. Do NOT invent a new approach.

**The pattern (canonical refs in parentheses):**

1. **State lives on `UserConfig`** — the encrypted blob `saveConfig` already
   syncs cross-device for free when `allowSync` is on. `UserConfig` is the
   canonical shared type (`quorum-shared/src/types/user.ts`); both apps import it.
2. **Read it STRAIGHT BACK from local MMKV config**, via a `configService`
   helper — NOT through the in-memory `user` object. That `user` read-back bridge
   is BROKEN (silently dropped `primaryUsername` / `isProfilePublic`; memory
   `config-to-user-readback-bridge-missing`). DM mute reads via
   `getLocalMutedConversations` (`configService.ts:552-556`).
3. **Add the field to the explicit inbound preservation list** in
   `configService.getConfig` — the `configWithTimestamp` object at
   `configService.ts:394-408` re-lists `bookmarks` / `name` / `profile_image` /
   `bio` / `isProfilePublic` / `mutedConversations` ON TOP of the
   `...decryptedConfig` spread. **A new synced field MUST be added there** or an
   incoming config can silently drop it (the exact `primaryUsername` failure).
4. **Outbound is free:** `saveConfig` serializes the whole `UserConfig`. Putting
   the field on `UserConfig` + writing it locally is all that's needed.

**Caveat (consistent, not special):** syncs only when `allowSync` is on; with
sync off it stays device-local. Same as every config field.

**Why channel/space mute does NOT sync today (the bug task A fixes):** mobile
stores it in a separate MMKV store `quorum-notification-prefs`
(`services/notifications/notificationPrefs.ts`) that NEVER touches `UserConfig`.
The `pushPrefsSync` path syncs per-space mutes to the SERVER (per-token push
filtering), but that is NOT cross-device settings sync — your other devices never
learn the choice. Desktop stores the same setting in `UserConfig.mutedChannels` /
`notificationSettings[spaceId].isMuted`. **Result: mobile↔desktop mute settings
do not sync to each other at all today.** Task A closes this by moving mobile onto
the `UserConfig` fields desktop already uses.

---

## 3. What lives in quorum-shared (the cross-repo split)

Per the atlas additive/breaking gut-check: *"if a mobile dev bumped shared right
now with no other changes, would mobile still build?"* — keep everything here
**additive** (new fields/helpers) so shared can ship alone.

**Already in shared (Task C needs NO shared PR):**
- `MuteMessage` wire type — `quorum-shared/src/types/message.ts:105`, in the
  `MessageContent` union, re-exported from root.
- `canonicalize()` mute branch — `quorum-shared/src/utils/canonicalize.ts:117`.
- `canMuteUser()` + `createChannelPermissionChecker` —
  `quorum-shared/src/utils/channelPermissions.ts:129`.
- `'user:mute'` permission token — `quorum-shared/src/types/space.ts:14`.
- `UserConfig` with `mutedChannels`, `notificationSettings`, `mutedConversations`
  — `quorum-shared/src/types/user.ts:37`. `mutedChannels` (per-channel mute) is
  fully declared — Task A needs nothing here for CHANNEL mute.

**Shared additions — ✅ DONE (merged to shared `master`, PR #48 `51ab9b6`; bumped
`2.1.0-33` `0ff099e`; ⏳ awaiting lead npm publish):**
- **`NotificationSettings.isMuted?: boolean`** (`quorum-shared/src/types/user.ts`) —
  for Task A space-mute. (Background: desktop already wrote this undeclared; we
  declared it. Per-channel `mutedChannels` was already in shared.)
- **`UserConfig.blockedUsers?: { [spaceId]: string[] }`** (per-space) — for Task D.
- **`blockUtils`** — `isUserBlocked(userAddress, spaceId, blockedUsers)` +
  `getBlockedUsersForSpace(spaceId, blockedUsers)`, exported from the utils barrel.
- Mobile uses all three UNTYPED via `(config as any)` until the lead publishes
  `2.1.0-33`; then bump mobile's pin and swap to the typed symbols.

**Stays platform-specific (never shared):** storage adapters (MMKV vs IndexedDB),
notification gates (NSE/Expo vs Electron toasts), UI components, message-stream
filter wiring, receive-pipeline integration.

**Optional shared refactor (do NOT block on it):** desktop has pure mute-resolution
helpers (`isChannelMuted`, `getMutedChannelsForSpace`, `shouldNotifyForContext`)
in its own `channelUtils.ts`. These COULD move to shared so both apps share one
implementation. Nice-to-have, not required for any task here — note it, defer it.

---

## 3b. ⚠️ THE PUBLISH CONSTRAINT (read before sequencing A or D)

**We CANNOT publish quorum-shared ourselves.** Mobile pins a shared npm version;
it only sees a shared change after the **lead dev publishes** a new version AND
mobile bumps its pin. The lead can take an unknown amount of time. (Desktop is
different — it symlinks local shared, so desktop plugs in shared changes instantly;
that asymmetry does not help mobile.)

**Consequence:** any task whose MOBILE half needs a NEW shared symbol is BLOCKED on
publish+bump. So we split such tasks: do the shared part (open the PR / land it
locally for desktop), but **the mobile plug-in waits for the published version.**

**How this hits each task:**
- **Task C** — no shared change. **NOT blocked.** Build fully now. ✅
- **Task B** — pure mobile UI. **NOT blocked.** ✅
- **Task A** — per-CHANNEL mute uses `mutedChannels` (already in published shared) →
  NOT blocked. Per-SPACE mute wants `isMuted` (not yet typed in shared). **De-block:
  mobile writes/reads `isMuted` UNTYPED via `(config as any).isMuted`** — the EXACT
  pattern mobile already uses for `bio` / `isProfilePublic` / `mutedConversations`
  (`configService.ts:402-407`). So A ships in full now; the shared `isMuted?` typing
  PR is a later cleanup, not a gate. ✅ (Shared `isMuted` is ALREADY merged in
  `2.1.0-33`; just awaiting the lead's npm publish.)
- **Task D** — needs `blockedUsers` on shared. Same de-block: mobile carries
  `blockedUsers` untyped via `(config as any).blockedUsers` and ships now; the typed
  shared field is ALREADY merged in `2.1.0-33`, awaiting the lead's publish. Tighten
  to the typed field on the next mobile bump.

**Rule of thumb (matches how we've handled this before):** never let a mobile
feature sit blocked for an indefinite shared publish when the synced field can ride
the untyped-`as any` config path that's already proven in `configService`. Type it
properly when the bump lands. Document each `as any` with a `// TODO: type via
shared isMuted/blockedUsers once published` so the cleanup is findable.

## 3c. THE OPENING MOVE — ✅ DONE (shared landed; publish clock running)

The opening move (do the shared part first so the lead's publish clock ticks in
parallel) is **complete**. ONE combined additive shared PR landed:
- `NotificationSettings.isMuted?: boolean` — Task A space-mute.
- `UserConfig.blockedUsers?: { [spaceId: string]: string[] }` — **per-space**
  (matches today's mobile behavior; confirmed + LOCKED 2026-06-21). Task D.
- `blockUtils`: `isUserBlocked(userAddress, spaceId, blockedUsers)` +
  `getBlockedUsersForSpace(spaceId, blockedUsers)`.
- **Merged** to shared `master` (PR #48, squash `51ab9b6`); build (tsup+tsc) green,
  new symbols confirmed in emitted `dist` declarations; version **bumped `2.1.0-33`**
  (`0ff099e`, pushed). Shapes are now frozen on `master` — changing one needs a new
  shared change + publish.

**⏳ Remaining shared step (lead-only):** publish `2.1.0-33` to npm. We can't.
A short nudge to the lead (atlas §4) is the only action left here.

**Now:** all mobile tasks (C, A, B, D) are ✅ SHIPPED. They consume the new fields untyped
via `(config as any)` until `2.1.0-33` is published + mobile's pin bumped, then swap each
`// TODO: …` cast to the typed symbol. That cast-swap is the only remaining mobile work,
and it's gated on the lead's publish.

## 4. Sequencing & shipping

- **Build order:** ~~C~~ ✅ (PR #125) → ~~A~~ ~~B~~ ✅ (feat/channel-mute-sync-and-ux) → ~~D~~ ✅ (feat/personal-block-user). All done. B pairs naturally with A
  (same channel-mute surface). D ships last.
- **Cross-repo rule + publish constraint (see §3b):** the shared `isMuted?` (A) and
  `blockedUsers?` (D) additions are **already merged** (PR #48, `2.1.0-33`) — they
  were typing cleanups, NOT mobile blockers. Mobile ships both features via the
  untyped `(config as any).X` path already used for `mutedConversations`, then
  tightens to the typed fields once the lead publishes `2.1.0-33`. Do NOT hold A or
  D's mobile
  work waiting for a shared publish. (Desktop, if it later consumes these, gets the
  typed field instantly via its symlink — that's a desktop convenience, not a mobile
  dependency.) C needs no shared PR at all.
- **Batching:** each task is its own well-named branch → single squash-merged PR
  (per atlas §6). A+B may ride one branch (same surface) if done together.
- **Mobile bar is high (atlas §2):** prefer statically-verifiable changes; where a
  runtime test is genuinely needed (C's receive-side drop, composer disable), flag
  it for the user to test on Android — don't claim "tested" for what wasn't run.
- **iOS review pass (atlas §3):** C touches a Modal (MuteUserModal) + composer
  disable + the UserProfileModal action area — do the iOS-stacking / Switch /
  safe-area review since only Android is runtime-tested.

---

## 5. Status

| Task | Status |
|---|---|
| Plan (this folder) | approved; shared part shipped, mobile pending |
| **Shared PR (isMuted + blockedUsers + blockUtils)** | **✅ MERGED to shared `master` (PR #48, squash `51ab9b6`); version bumped `2.1.0-32 → 2.1.0-33` (`0ff099e`, pushed). ⏳ NOT published to npm yet — lead-only. Mobile A/D consume it via untyped `(config as any)` until the lead publishes 2.1.0-33 + mobile bumps its pin, then swap casts to typed.** |
| **Lead npm publish of 2.1.0-33** | **⏳ pending — lead-only; a short nudge (atlas §4) is the only action left on the shared side** |
| C — moderation mute | ✅ **SHIPPED — PR #125 squash-merged to mobile `master` (2026-06-22)**, carrying both C and the chat-scroll-jump fix. The blocker (chat-list-jumps-to-top-on-modal-open) was fixed via `patches/react-native-keyboard-controller+1.21.11.patch` (NOT a FlashList re-anchor — that theory was falsified; root cause was KeyboardChatScrollView chasing a focus-less keyboard event on Modal mount). Solved writeup: `.agents/issues/.done/2026-06-21-chat-list-jumps-to-top-on-modal-open.md`. iOS verification pending — see `.agents/docs/ios-verification-checklist.md`. |
| A — channel-mute sync | ✅ **SHIPPED** (branch `feat/channel-mute-sync-and-ux`). Notif-mute now in synced `UserConfig` (MMKV kept as native-gate mirror); space-mute via untyped `(config as any).isMuted`. Tested green on Android. Cross-device propagates on peer restart (config-sync limitation). |
| B — channel-mute UX | ✅ **SHIPPED** (same branch). Per-channel name-dim + bell-off; space-mute bell-off on space icon + header; in-app mention/reply bubble now mute-aware. Tested green. |
| D — personal block | ✅ **SHIPPED** (branch `feat/personal-block-user`). Viewer-side hide renamed to Block (`useBlockUser`), synced via `UserConfig.blockedUsers` (untyped) + migration, confirm modal, "Blocked" accordion in Space Settings for unblock access. Tested green on Android. Mirrors desktop PR #207. |
| DESKTOP — block gap | ✅ **DONE** — lead greenlit; personal Block built + shipped on desktop (PR #207, squash-merged to `main` `0013d62e`). `hand-off` icon added to shared (`2f65021`). |

## Related
- DM-mute pattern (the template): `.agents/docs/features/dm-mute-behavior-and-pattern.md`
- Sync bridge background: memory `config-to-user-readback-bridge-missing`
- Desktop docs: `quorum-desktop/.agents/docs/features/channel-space-mute-system.md`,
  `.../mute-user-system.md`
- Atlas: `../quorum-atlas.md`

*Last updated: 2026-06-22 (D done) — TASK D SHIPPED on branch `feat/personal-block-user`
(tested green on Android), completing all mobile tasks in this overhaul. Renamed the
viewer-side hide `useUserMuting` → `useBlockUser` (config-backed `UserConfig.blockedUsers`,
synced + migrated; old hook deleted), added a `BlockUserModal` confirm sheet, relabeled
the UserProfileModal row Mute→Block, and — after device testing surfaced a reachability gap
(a blocked user vanishes and the member list is unreliable) — added a collapsible "Blocked"
accordion at the top of Space Settings → Members that reads from the synced block list so
blocked users are always reachable to unblock. Mirrors desktop PR #207. Only the lead's
`2.1.0-33` npm publish remains (to swap the `(config as any)` isMuted/blockedUsers casts to
typed). Saved a dev-unblock recipe at `.agents/scripts/dev-unblock-user.md`.*

*Previously: 2026-06-22 (latest) — TASKS A + B SHIPPED on branch
`feat/channel-mute-sync-and-ux` (tested green on Android). A: channel/space notif-mute
moved mobile MMKV → synced `UserConfig` (bookmark pattern; new `useChannelMute` reactive
store + configService helpers + notificationPrefs MMKV mirror for the native gates; space-
mute via untyped `(config as any).isMuted`). B: per-channel name-dim + bell-off (icon stays
colored), space-mute shown as bell-off on the space icon (spaces list) + space name
(header) instead of dimming the channel list, and the in-app mention/reply bubble is now
mute-aware (guarded both WebSocketContext increment paths). During testing we confirmed +
documented a platform-wide limitation: UserConfig-blob settings only propagate cross-device
on peer restart (not live) — master report
`.agents/issues/.open/2026-06-22-userconfig-blob-not-live-synced-cross-device-master.md`. Only Task
D remains.*

*Previously: 2026-06-22 (later) — TASK C SHIPPED. The chat-list-jumps-to-top-on-
modal-open blocker was fixed (`patches/react-native-keyboard-controller+1.21.11.patch`
— root cause was KeyboardChatScrollView chasing a focus-less keyboard event on native
Modal mount, NOT the FlashList re-anchor the original report claimed; that theory was
falsified on-device). PR #125 squash-merged to mobile `master`, carrying both Task C
(moderation mute) and the patch. Updated front-matter, ▶ CURRENT STATE, task table,
status table, §3c, §4 to mark C done and reset build order to A → B → D. iOS
verification for C is logged in `.agents/docs/ios-verification-checklist.md`. Remaining
shared blocker unchanged: lead has NOT published `2.1.0-33` to npm, so A/D still ride
the untyped `(config as any)` path.*

*Previously: 2026-06-22 — DESKTOP task DONE: lead greenlit desktop parity; the
personal Block-user feature was built and shipped on desktop (quorum-desktop PR
#207, squash-merged to `main` `0013d62e`), consuming the shared `blockedUsers`
field; `hand-off` icon added to shared (`2f65021`). README task table + status
table + task-DESKTOP file updated to reflect this. Mobile tasks A/C/D unchanged
(C still blocked on the chat-jump bug).*

*Previously: 2026-06-21 — (1) verification pass: confirmed shared 2.1.0-32
installed, mutedChannels declared; caught NotificationSettings.isMuted not in shared
type. (2) Locked the naming scheme (§0b): Block vs Mute, Farcaster disambiguation.
(3) Added the PUBLISH CONSTRAINT (§3b): we can't publish shared ourselves, so A & D
ship mobile NOW via untyped `(config as any).X` and the shared typing PRs are
parallel non-blocking cleanups — nothing waits on a lead publish. (4) SHARED PART
SHIPPED: combined PR #48 (isMuted + per-space blockedUsers + blockUtils) squash-
merged to shared master (`51ab9b6`), version bumped to `2.1.0-33` (`0ff099e`).
Only the lead's npm publish remains on the shared side. Status table + §3/§3b/§3c/§4
and Tasks A/D updated to past-tense the shared work. Next: build mobile Task C.*
