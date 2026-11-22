---
type: bug
title: "UserConfig cross-device sync is restart-gated, not live (master tracking report)"
status: open
created: 2026-06-22
---

# UserConfig cross-device sync is restart-gated, not live (master tracking report)

**Status:** 🔴 OPEN — architectural, cross-repo (mobile + desktop). Tracking/umbrella
report. Not urgent, but real and recurring; several scattered bugs are symptoms of this
one root cause. Created 2026-06-22 after deep investigation across both repos' code +
all existing sync bug reports. **Re-verified against both repos' current code
2026-07-02** — core diagnosis confirmed; one claim corrected (see the "not strictly
restart-gated" correction below) and sub-issue statuses refreshed.

**One-line:** Settings stored in the `UserConfig` blob (notification mute, DM mute,
bookmarks, profile name/image/bio, isProfilePublic, primaryUsername, mention-type
filters) are written to the server correctly, but a **running** peer device has **no
event that tells it to re-fetch them** — they only appear after the peer restarts /
re-logs-in, or stumbles into one of a few incidental UI-triggered re-pulls (desktop:
opening a DM; mobile: opening ProfileModal). Channel renames, chat messages, and
moderation mute DO propagate live, which is what makes this confusing.

---

## ▶ Why "some things sync, some don't" — the core finding

There are **two entirely separate sync transports**, and which one a piece of data uses
decides whether it propagates live:

| Transport | Carries | Inbound trigger on a running peer | Live? |
|---|---|---|---|
| **Live WebSocket hub broadcast** | channel/space manifest (names, structure, icon), chat messages (space + DM), **moderation** `MuteMessage`, read/delivery receipts (desktop) | inline WS message handler (`space-manifest` / message / `mute` branches) → `setQueryData` | ✅ instant |
| **Event-less REST pull** | the whole **`UserConfig` blob**: notification mute (`mutedChannels`, `notificationSettings[].isMuted`), DM mute (`mutedConversations`), blocked users, bookmarks, profile (`name`/`profile_image`/`bio`), `isProfilePublic`, `primaryUsername`, `enabledNotificationTypes`, `allowSync` | `getConfig()` REST GET — startup/login + a few incidental UI triggers; **no push, no poll, no focus refetch** | ❌ not live |

So the asymmetry is **structural, not a per-field bug**: config changes POST to
`/users/{address}/config` (REST) with **no WebSocket push counterpart**, and nothing
tells a running client that the blob changed. Channel-name edits feel "instant" only
because they ride the *other* transport (a live hub broadcast).

This is the umbrella behind: desktop `isProfilePublic` stale, desktop settings-modal
stale display name, mobile `primaryUsername` not appearing, and the channel/DM-mute "not
syncing" we hit building the mute feature (2026-06-22, mobile log confirmed
`allowSync=true` + `saveConfig POSTED` — the write was correct; the peer just never
re-read).

### ⚠️ Correction (2026-07-02): not strictly restart-gated — incidental re-pulls exist

The original report claimed desktop's only runtime server fetch was
`RegistrationPersister` at startup. **That was wrong even at the time** (the extra call
sites date from 2025-09/10). Both clients re-pull the config from the server whenever
certain UI paths happen to call `getConfig()`:

- **Desktop** — `ConfigService.getConfig` (`src/services/ConfigService.ts:46`) hits
  `apiClient.getUserSettings` on **every call** (`:55`), and when the remote blob is
  newer it verifies, decrypts, persists to IndexedDB **and updates the React-Query
  config cache** via `setQueryData(buildConfigKey…)` (`:359-368`, blame 2025-10-01).
  Runtime callers besides startup (`RegistrationPersister.tsx:221`):
  - `DirectMessage.tsx:167` — effect on **every DM conversation open** (signing/receipt defaults)
  - `ConversationSettingsModal.tsx:76` — on opening a conversation's settings
  - `useUserSettings.ts` — only when the query cache is empty (`~:140` short-circuits on the cached value otherwise)

  So on desktop, **opening any DM silently brings the whole config up to date, live**
  (mute states, toggles — everything `useConfig` serves). The bug presents as
  "restart-gated" in practice because none of these run while the user sits in a space
  channel or in the Settings modal, and there is still no trigger tied to *"another
  device changed something."*
- **Mobile** — `configService.getConfig` (`services/config/configService.ts:298`) also
  hits the server every call (`:310`) and persists to MMKV. Runtime callers besides
  login (`AuthContext.tsx:330`): `ProfileModal.tsx:714` and `useUserConfig.ts:61`
  (mount effect — reaches ProfileModal via `useSyncSettings`), i.e. **opening
  ProfileModal re-pulls the config**; plus `AuthContext.tsx:495` (read-merge before an
  outbound save) and onboarding (`OnboardingContext.tsx:373/527`). Caveat: this
  refreshes the MMKV config blob (so e.g. mute checks that read local config get fresh
  data), but profile fields do **not** reach the in-memory `user` — the config→`user`
  bridge runs only in the login path (see taxonomy #5).

**What genuinely doesn't exist on either client (re-verified 2026-07-02):** any
WS-driven, poll, or foreground/focus config refetch. Desktop `useConfig` is a
Suspense query over **IndexedDB only** (`buildConfigFetcher.ts`; `refetchOnMount: true`
but the fetcher never touches the network). Mobile's `AppState 'active'` listener
(`AuthContext.tsx:442-449`) only refreshes the Farcaster token. Grep for
`config-updated`/`invalidate…config` in mobile `WebSocketContext.tsx`: nothing; grep for
`listen-hub`/`log-since` in desktop `src/`: nothing (hub log not ported yet).

---

## Evidence (code, both repos — line refs re-verified 2026-07-02)

### The config WRITE works (outbound is fine)
- Mobile: `services/config/configService.ts` `saveConfig()` → `client.postUserSettings(...)`
  (REST POST). Gated by `config.allowSync` (`:481`). Encrypts the WHOLE config object, so
  any field on it (incl. `mutedChannels` / `notificationSettings`) is included. The
  inbound preservation list (`configWithTimestamp`, `configService.ts:394-415`) re-lists
  synced fields so an incoming config can't drop them (now also `blockedUsers`).
- Desktop: `src/services/ConfigService.ts` `saveConfig()` → `apiClient.postUserSettings(...)`
  (`:504`), enqueued via the action queue under `'save-user-config'`. It also writes
  IndexedDB + the query cache with an optimistic-update guard (`:521-531`, added
  2025-12-21) — the `.solved/config-save-stale-cache-allowsync.md` precedent is
  implemented.

### The config READ has no live trigger (inbound is the gap)
- **Desktop** `useConfig` (`src/hooks/queries/config/useConfig.ts` + `buildConfigFetcher.ts`)
  reads **IndexedDB only** (comment: "uses IndexedDB, not network"). Server fetches
  happen only via `ConfigService.getConfig`, whose runtime callers are startup +
  the incidental UI paths listed in the correction above. No `refetchInterval`, no
  `refetchOnWindowFocus`, no WS-driven `invalidateQueries(buildConfigKey)`.
  `useUserSettings.ts` (~`:140`) short-circuits on the cached value, so opening
  Settings doesn't force a fresh pull.
- **Mobile** `getConfig` (server fetch) callers are all startup/login/manual/UI-incidental:
  `context/AuthContext.tsx:330` (login), `:495` (read before an outbound save),
  `context/OnboardingContext.tsx:373/527`, `hooks/useUserConfig.ts:61/77`,
  `components/ProfileModal.tsx:714`. There is **no** WS / `AppState 'active'` / periodic
  refetch (the `AppState` listener at `AuthContext.tsx:442-449` only refreshes the
  Farcaster token).
- Both clients' `getConfig` short-circuit on `remote.timestamp <= local.timestamp`
  (mobile `:326-333`, desktop `ConfigService.ts:66-73`) **before** decrypting — so
  re-pulling frequently is cheap and idempotent (one small GET when nothing changed).

### The contrast that misleads — channel-name edits ARE live
- Desktop `SpaceService.submitUpdateSpace()` sends a `{ type: 'group', … space-manifest }`
  hub envelope over the WebSocket; every peer's `MessageService.handleNewMessage`
  `space-manifest` branch applies it via `setQueryData` (`MessageService.ts:~3562`).
- Mobile mirror: `spaceMessageService.sendSpaceManifestMessage()` out; inbound
  `WebSocketContext.tsx` `case 'space-manifest':` (`:1332`) applies with a staleness guard.

---

## Sub-issues / related reports (this report is the umbrella for these)

**STILL OPEN (all collapse into the live-refetch fix) — statuses re-checked 2026-07-02:**
- desktop `2026-06-13-config-not-refetched-stale-until-restart.md` — THE central desktop
  report; still open. NB it repeats the "sole caller is RegistrationPersister" claim
  corrected above — the essence (no live trigger) stands, the "only at startup" framing
  doesn't.
- mobile `2026-06-10-isprofilepublic-not-syncing-mobile-to-desktop.md` — explicitly
  re-diagnosed as caused by the desktop stale-until-refetch bug (mobile send is correct).
  Still open.
- desktop `2026-05-30-user-settings-modal-stale-display-name.md` — same class (missing
  query invalidation on a config update). Still open.
- mobile `2026-06-16-mobile-send-strips-empty-displayname-clear-not-propagated.md` —
  separate (message-broadcast path) but same "intent not propagated" family (`''` vs
  `undefined`). Still open.
- desktop `2026-01-09-config-sync-space-loss-race-condition.md` — the LWW whole-blob
  overwrite can DELETE spaces (no per-field merge except bookmarks' tombstones). Distinct,
  more dangerous failure mode of the same blob design. Still open.

**CODE-COMPLETE since this report was written (verify, then close separately):**
- mobile `2026-06-10-primary-username-not-synced-or-published.md` — was "compound:
  field not on shared `UserConfig` + bridge missing." As of 2026-07-02 the code side is
  done: shared `2.1.0-33` (installed on mobile master) types `primaryUsername`
  (`dist/index.d.ts:48`); `updateProfile` copies it into the outbound config
  (`AuthContext.tsx:510-511`); and the login read-back bridge overlays it onto `user`
  (`AuthContext.tsx:362`). Needs a cross-device test (restart the receiving device —
  see testing note below) before moving to `.solved/`.

**ALREADY SOLVED (useful precedents for the fix):**
- desktop `.solved/config-save-stale-cache-allowsync.md` — `saveConfig` must also
  `setQueryData` (DB↔React-Query cache split). Implemented (`ConfigService.ts:521-531`).
- desktop `.solved/2026-06-07-mention-type-filter-not-synced.md` — a field that bypassed
  the action queue / didn't spread existing settings was silently local-only. Precedent
  for "route every config write through the same path + spread existing fields."
- desktop `.solved/space-creation-config-save-race-condition.md` &
  `.solved/2026-04-13-profile-sync-not-triggered-after-key-import.md` — ordering/timing of
  the startup config fetch vs credential availability.

---

## The recurring failure modes (taxonomy, for whoever fixes this)

1. **No live config refetch** (THE big one) — no push, poll, or focus refetch on either
   client; only startup/login + incidental UI-triggered pulls. Root cause of most open
   items above.
2. **DB ↔ React-Query cache desync** — writing IndexedDB without updating the query cache
   serves stale data within a device (desktop). Largely solved: both `saveConfig` and the
   newer-remote branch of `getConfig` now `setQueryData`.
3. **Field excluded from the sync blob** — a field written outside the action-queue / not
   on `UserConfig` / not in the preservation list is local-only (mention-types: solved;
   primaryUsername: solved in code, pending verification).
4. **LWW whole-blob overwrite** — `saveConfig` uploads the entire blob from local state;
   anything missing locally (e.g. a space without an encryptionState row) is permanently
   deleted server-side. Only bookmarks have tombstone-merge.
5. **Config→`user` read-back bridge (mobile)** — a correctly-synced field must be
   explicitly bridged from the synced config into the in-memory `user` object.
   **Now complete for all five profile fields** (name, profile_image, bio,
   isProfilePublic, primaryUsername — `AuthContext.tsx:311-385`, with LWW vs
   `profileUpdatedAt` + a never-stamped privacy guard for `isProfilePublic`). Remaining
   gap: the bridge runs **only in the login path** — any future live-refetch trigger
   must also re-run it (or the bridging should move into `getConfig` itself), otherwise
   profile fields will refresh in MMKV but not in `user`.
6. **Send-side intent stripping** — `''` (explicit clear) coerced to `undefined` (no
   change) on the per-space profile broadcast path.

---

## The fix direction (when we tackle it)

**Primary (unblocks 1 and the "stale config" open bugs at once):** give the config a
**live refetch trigger**. The lead is bringing mobile's durable **hub log**
(`listen-hub` + `log-since` replay on reconnect/foreground — on mobile at
`WebSocketContext.tsx:~4544-4719`) to desktop. The intended vehicle: emit a lightweight
**"config changed" sentinel** over the hub log (or any WS signal); on receiving it each
client calls `getConfig()` then invalidates/updates the config query. NB: today the hub
log carries space/message data, NOT config — config lives on the REST endpoint — so this
needs either (a) a config-updated sentinel broadcast that triggers a REST re-pull, or
(b) moving config into the hub log. Neither exists yet (desktop has no hub-log code at
all as of 2026-07-02).

**Alternative sentinel transport that already exists (evaluated 2026-07-02):** both
clients already send/receive **encrypted device-to-device messages to their own other
devices** over the user-inbox transport (desktop echoes delivery/read receipts to own
devices; mobile self-syncs DMs to its own second device — see the self-sync guards at
mobile `WebSocketContext.tsx:2691/2709/3839`). A tiny "config-updated" control message
to self-devices would need **zero server changes** and, on receipt, just triggers the
same `getConfig()` + cache update. Trade-offs: inherits the known desktop↔mobile inbox
**delivery unreliability** (the 6-month infra issue), and unlike the hub log it isn't
replayed from a cursor on reconnect — a missed sentinel silently degrades to today's
behavior (fail-safe, but not durable). Fine as an opportunistic layer; the hub log
remains the durable end-state.

**Interim band-aid (cheaper than originally thought):** a foreground/focus (+
WS-reconnect) `getConfig` on both apps. On desktop this is nearly free: **all the hard
parts already exist** — `ConfigService.getConfig` fetches, timestamp-short-circuits,
verifies, persists, and updates the React-Query cache; the change is literally "call it
(throttled) on window focus / WS reconnect" (e.g. from `RegistrationPersister`). On
mobile: `AppState 'active'` → `getConfig(address)`; but ALSO factor the config→`user`
bridge out of the login path and re-run it there, or profile fields won't reach `user`
(taxonomy #5). The desktop report deliberately deferred this in favour of the hub-log
fix — decide per urgency.

**Separately (do NOT fold in):** the LWW space-loss race (#4) needs a merge/tombstone
approach for spaces like bookmarks already have — it's a data-loss bug, more dangerous
than staleness, and has its own desktop report.

---

## How to confirm a config feature is correct DESPITE this bug

Because outbound works, test cross-device config sync by **restarting the receiving
device** (or re-login), not by expecting live propagation. Two faster manual checks
discovered in the 2026-07-02 verification:
- **Desktop as receiver:** opening **any DM conversation** forces a server config
  re-pull that also refreshes the React-Query config cache — so "change on phone →
  open a DM on desktop → check the setting" works without a restart.
- **Mobile as receiver:** opening **ProfileModal** re-pulls the config into MMKV
  (enough for mute/settings checks that read local config), but profile fields on the
  in-memory `user` still need a restart/re-login (login-only bridge).

Verify the OUTBOUND write with a one-line log at the `saveConfig` call (`allowSync` true
+ POST fired) before suspecting your feature — the write is almost always fine; the gap
is the receive side.

## Key files
- Mobile config: `services/config/configService.ts` (`saveConfig` `:467+`, `getConfig`
  `:298+`, preservation list `:394-415`), `hooks/useUserConfig.ts`,
  `context/AuthContext.tsx` (`configTask` bridge `:311-385`, `updateProfile` `:482+`).
- Desktop config: `src/services/ConfigService.ts` (`getConfig` `:46+` incl. cache write
  `:359-368`; `saveConfig` `:495+` incl. guarded cache write `:521-531`),
  `src/hooks/queries/config/useConfig.ts`, `buildConfigFetcher.ts`,
  `useInvalidateConfig.ts`, `RegistrationPersister.tsx:221`,
  `useUserSettings.ts`, `DirectMessage.tsx:167`, `ConversationSettingsModal.tsx:76`.
- Live transport (for contrast): mobile `context/WebSocketContext.tsx`
  (`space-manifest` case `:1332` + hub-log `listen-hub`/`log-since` `:~4544-4719`),
  desktop `src/services/MessageService.ts` (`space-manifest` `:~3562`) + `SpaceService.ts`.
- Desktop umbrella report: `quorum-desktop/.agents/bugs/2026-06-13-config-not-refetched-stale-until-restart.md`.

*Created 2026-06-22 — consolidates the mobile channel-mute-sync finding with 11 existing
mobile+desktop bug reports and a full live-vs-restart transport taxonomy from both repos'
code. Memory: [[config-blob-syncs-only-on-restart-not-live]].*

*Last updated: 2026-07-02*
