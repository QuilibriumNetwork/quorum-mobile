---
type: bug
title: "Mobile publishes a narrowed Space list, emptying the Spaces sidebar on every other device"
status: done
priority: high
created: 2026-08-04
updated: 2026-08-04
severity: destructive and silent — every other device loses its entire Spaces sidebar; recoverable only by the user finding a button in desktop Settings
area: config sync / saveConfig publish path
repos: quorum-mobile (cause), quorum-desktop (victim)
---

# Mobile publishes a narrowed Space list, emptying every desktop sidebar

## Status

**Done — verified on a device 2026-08-04.** Took three PRs, because the first
two were shipped on reasoning and the device falsified both.

| PR | squash | what |
|---|---|---|
| #228 | `35b3fc8` | Hold the upload rather than publish a narrowed Space list; keep the incoming timestamp while holding. |
| #229 | `93f9172` | Carry previously-synced Space keys forward, and stop a save erasing this device's record of them. |

### Why #228 alone was wrong

The guard was all-or-nothing: one unkeyable Space held the *entire* publish,
including settings. The issue described that as a rare dead end. On this device
it was the steady state, and the phone silently stopped syncing anything:

```
[ConfigSync] NOT publishing — would upload 0/3 Spaces
```

Then #229's first attempt failed too, because `saveConfig` had always assigned
`config.spaceKeys = <what it could rebuild locally>` and persisted that object —
so the keys it wanted to carry had already been erased:

```
keyed locally 0, carried forward 0 of 0 previously-synced
```

Both were caught by a log line, neither by re-reading the code.

### The verification that closed it

```
16:50:43  pull: TOOK REMOTE ts=1785855016221 (local was 1785853929177)
16:50:49  carrying 3 previously-synced Space key(s) …
16:51:05  published ts=1785855049277 bytes=1788340
16:51:07  server read-back CONFIRMS ts=1785855049277
```

Desktop confirmed intact afterwards: all Spaces present in the sidebar, and the
User Settings display-name field carrying the name set on mobile.

Recovering this device needed one desktop-side config change first, to put a
newer timestamp — and full `spaceKeys` — on the server. A device already wedged
cannot heal itself: the held save keeps its timestamp equal to the server's, so
every pull reports `UP TO DATE` and never re-stores. See §9.

### Left open

- **Why this device keys 0 of 3 Spaces at all** — the root cause under all of it.
  `2026-08-04-mobile-cannot-key-any-space-it-imported-from-the-config-blob.md`.
- `bytes=1788340` — a 1.79 MB config blob, near the upload ceiling (desktop #108).
- No self-heal for an already-wedged device (§9).

## §1. The ask, in one line

Port desktop's refuse-to-publish guard to mobile's `saveConfig`. The precondition
that forced its revert on 2026-07-31 has since been met, and the comment that
still justifies the revert is out of date.

## §2. What the user sees

Reported three times on 2026-08-04, all on desktop, all after an action on mobile:

| # | action on mobile | result on desktop |
|---|---|---|
| 1 | created a test Space | after refresh: the test Space showed, **every other Space gone** |
| 2 | deleted that test Space | Spaces gone again |
| 3 | changed the username — no Space operation at all | Spaces gone again |

Every time, Settings → Restore Spaces brought them all back, because the Space
rows never left desktop's IndexedDB.

**All three are one event: mobile called `saveConfig`.** Reproduction 3 is the
decisive one. It touches nothing about Spaces, so no Space operation can be the
trigger — it is the publish path itself.

## §3. Mechanism

1. Any mobile `saveConfig` rebuilds the published blob narrowed to Spaces this
   device can currently key — `services/config/configService.ts:615-645`.
   Username changes, mutes, bookmarks and settings all route through here.
2. Mobile **warns and publishes anyway** (`:666-671`) with a fresh
   `ts = Date.now()` (`:591`), so its blob wins on timestamp.
3. `collectSpaceKeysForSync` (`:507-546`) drops a Space if it is missing from
   `getAllSpaces()`, has no keys, **or has no encryption state** for
   `spaceId/spaceId`.
4. `syncSpaceFromConfig` saves keys first (`services/config/spaceSyncService.ts:129-141`)
   but writes `saveSpace` and `saveEncryptionState` only *after* two network
   round-trips (`fetchSpace`, `getSpaceManifest`) that each `return false` on
   failure (`:145-160`), walking Spaces sequentially with a **1-second delay
   each** (`:312-327`). A Space that failed, or that sync has not reached yet,
   is unkeyable and gets dropped from the publish.
5. Desktop takes remote on a newer timestamp and applies it **verbatim**
   (`quorum-desktop/src/services/ConfigService.ts:374-384`). Its sidebar renders
   from `config.items` (`useNavItems.ts:49-53`), so the nav empties.

Desktop refuses to publish a narrowed list in exactly this situation
(`ConfigService.ts:512-529`). Mobile does not. That asymmetry is the bug.

## §4. Why the guard was reverted, and why that no longer holds

`3a03b6f` reverted the guard on 2026-07-31. The reasoning, still recorded in the
comment at `configService.ts:655-665`, was that no mobile removal path took a
Space out of `config.spaceIds` — delete/leave only cleared `spaceStorage` and the
kicked handler wrote through `mmkvAdapter`, a different MMKV instance and key
prefix. A left Space therefore kept its id with its keys gone, permanently
unkeyable, so the guard would have held **every** publish forever.

That was correct then. It is stale now: `df6b198` added `removeSpaceFromConfig`,
and it is wired into all three paths —

- `hooks/chat/useSpaceSettings.ts:133` (delete)
- `hooks/chat/useSpaceSettings.ts:188` (leave)
- `context/WebSocketContext.tsx:1443` (kicked)

The ordering constraint stated in the umbrella task (write side → guard) is
therefore satisfied. **Update that comment as part of the fix** — left in place
it will justify reverting the guard a second time.

## §5. Known cost of the guard, stated up front

A Space that can never be keyed on a device — a bloated encryption state
(quorum-desktop #108), or one never synced there — would stop that device
publishing **any** config change (settings, mutes, bookmarks, profile) until it
syncs or is removed. Nothing retries a held save; it depends on a later
`saveConfig` from some unrelated action.

This is the accepted limitation desktop has carried since #282. It fails safe
(stale settings) rather than destructive (every device loses its sidebar), and
the warning makes it visible instead of silent. Tombstones remove the dead end
later by making such a Space explicitly deletable.

## §6. Not the whole fix

This stops mobile being the destructive publisher. It does not make the lists
converge — desktop → mobile removal still cannot reach mobile's screen, because
mobile's list reads local storage and ignores the config. That is Slice 2
(`deletedSpaceIds` tombstones) in the umbrella, and it needs the lead dev's
sign-off on the wire change.

## §7. How to verify

- Unit: `__tests__/configSpaceListPublish.test.ts` already covers the publish
  and narrowing logic. Add a case asserting no POST when narrowing would drop a
  Space the caller still wanted, mirroring
  `quorum-desktop/src/dev/tests/services/ConfigService.unit.test.tsx` §5.
  Revert the guard and confirm it goes red.
- Two-device: repeat reproduction 3 — change the username on mobile, confirm the
  desktop sidebar is untouched.
- Desktop now instruments the receive side. After any mobile action, read
  `JSON.parse(localStorage.getItem('quorum:diag:configSpaceShrink'))` in the
  desktop console. Empty is the pass condition; a `stillInDb > 0` entry is this
  bug still firing.

## §8. Related

- `quorum-desktop/.agents/issues/.open/2026-07-31-spaces-list-cross-device-sync.md`
  — the umbrella; §2b holds the three reproductions above. **Read it first.**
- `quorum-desktop/.agents/issues/.open/2026-01-09-config-sync-space-loss-race-condition.md`
  — the original data-loss race.
- `.agents/issues/2026-08-04-logger-is-a-no-op-in-production-and-debug-is-dead-in-dev.md`
  — **fixed on mobile by #227**, merged 2026-08-04. `logger.warn` now survives a
  release bundle here, so the `[ConfigSync] NOT publishing` warning this guard
  emits is visible to real users. That fix was mobile-only (a policy installed
  at mobile's entry point), so desktop's logger is still a no-op in production,
  which is why the desktop instrument uses `console.warn` instead.

## §9. No self-heal for an already-wedged device

A device that already erased its `spaceKeys` cannot recover on its own. The held
save keeps its local timestamp equal to the server's, so `getConfig` reports
`UP TO DATE` and never re-stores the blob that carries the keys. It needs some
*other* device to publish a newer config first.

That was one desktop settings change here, with someone watching adb. A real user
has neither. The fix would be a local repair on the `UP TO DATE` path: if the
stored config lists Spaces it holds no keys for, and the remote blob carries
them, merge them in locally — no publish, no timestamp change, purely additive.

Deliberately **not** shipped on 2026-08-04. Two changes to this sync path had
already been falsified that day, and adding a third unmeasured one would have
repeated the mistake. File it, measure it, then ship it.

---

*Last updated: 2026-08-04*
