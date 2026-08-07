---
type: bug
title: "Mobile re-publishes bookmark avatars into the config blob"
status: done
priority: medium
created: 2026-08-07
updated: 2026-08-07
severity: the config blob is the cross-device sync payload for everything; if it stops uploading, every setting on that device stops syncing, silently
area: config sync / bookmarks / payload size
related:
  - "quorum-desktop .agents/issues/2026-08-05-bookmarks-are-75-percent-of-the-config-blob.md"
  - "quorum-desktop .agents/issues/port-to-mobile/candidates.md (#39)"
  - ".agents/issues/.open/2026-06-22-userconfig-blob-not-live-synced-cross-device-master.md"
---

# Mobile re-publishes bookmark avatars into the config blob

## Status

**2026-08-07 — SHIPPED in PR #242** (`fix: mobile no longer re-publishes
bookmark avatars into the config blob`). This is the mobile half of the desktop
fix that shipped in desktop PR #314 with shared PR #75 (`2.1.0-40`). It was
blocked on that shared version reaching npm; mobile took the pin in `eb069a3`,
which unblocked it.

What landed: bookmarks are stripped of `cachedPreview.senderIcon` on both read
and write of the MMKV bookmark store, which between them are the only two
access points — so the upload, the stored config copy and the remote merge are
all covered. Plus an `Array.isArray` guard on the parsed store, because
stripping maps over that value and `saveConfig` reads it outside its try/catch.

Desktop's issue listed this as the first of two things it left open. The other,
§4.3's pre-flight blob size guard, has its own issue on desktop and is not
touched here. Desktop's issue also has its own residual measurement to take, so
it stays open on that side.

Closed as `done`: this issue's scope was the mobile strip, it is shipped, and
the verification below was run in the session that shipped it. The two
follow-ups named at the bottom are separate pieces of work, not remainders of
this one.

## What was wrong

`cachedPreview.senderIcon` is a full base64 avatar embedded in **every**
bookmark rather than referenced once. Measured on a real desktop account
2026-08-05: 18 bookmarks carried 619.8 KB of avatar, which was 94% of all
bookmark data and 69% of an 873 KB config blob, against a ~1 MB working ceiling.

Mobile never wrote that field itself, but it **adopts bookmarks from desktop
and publishes the same blob**, so a phone paired with a pre-fix desktop would
read the fat bookmarks off its own MMKV store and upload them again. Desktop's
strip on adopt would then throw them away, and the phone would put them back on
its next save. Two devices, neither converging.

The config blob is the only cross-device transport for every synced setting —
the Spaces list, notification settings, mutes, device names, per-conversation DM
settings, the global profile — and it fails quietly. A device that cannot
publish keeps working, looks correct locally, and just stops telling any other
device anything.

## What shipped

| Layer | File | Change |
|---|---|---|
| Sync OUT | `services/config/configService.ts` → `getLocalBookmarks` | strips on read, so the upload (`saveConfig`), the stored config copy (`getConfig`) and the local side of the remote merge are all thin regardless of what is on disk |
| Sync IN | `services/config/configService.ts` → `saveLocalBookmarks` | strips on write, so a fat bookmark adopted from an older client never lands on disk |
| Robustness | same, `getLocalBookmarks` | `Array.isArray` guard on the parsed store — see below |

Both use `stripBookmarkSenderIcons` from `@quilibrium/quorum-shared` 2.1.0-40.
Between them they are the **only** read and write points for the MMKV bookmark
store, which is what makes the coverage provable rather than a survey of call
sites.

The two halves are deliberately independent: either alone keeps the blob thin,
which is why the migration needs no coordination between devices.

### The `Array.isArray` guard is not incidental

`getLocalBookmarks` used to return whatever `JSON.parse` produced. Stripping
maps over that value, so a store holding valid JSON that is not an array
(corruption, or a future writer bug) would throw from a getter that never threw
before — and `saveConfig` calls it **outside** its try/catch, so a single bad
value would stop that device saving its config at all. Two tests pin it.

### Deliberately NOT done: the local sweep

Desktop reclaims its IndexedDB copy with a one-shot sweep mounted in the layout.
The mobile equivalent is a write inside `getLocalBookmarks`, and it was written,
tested and then removed.

Reason: it is the only line in this change that can **lose** a bookmark —
`saveLocalBookmarks` truncates to `MAX_BOOKMARKS` — and bookmarks are invisible
on mobile (see below), so nobody would see it happen. The account would simply
find them missing on desktop.

It costs nothing to skip. Every write path already strips the whole array, so
MMKV reclaims the bytes on the first write of any kind: adopting a config blob
that has bookmarks calls `saveLocalBookmarks`, which happens on the first
successful pull for exactly the accounts that have anything to reclaim. Adding
or removing a bookmark does the same. A test pins that a write reclaims the
entire stored list, not just the row being written.

## Verification

| | |
|---|---|
| ✅ **MEASURED** | 15 new tests in `__tests__/bookmarkSenderIconStrip.test.ts`. Full suite 623/623 across 51 files, 0 lint errors and 0 tsc errors in the changed files (the repo's 11 pre-existing tsc errors are in `webrtc-manager`, `farcaster-link` and `app/explore.tsx`, none touched here) |
| ✅ **MEASURED** | the assertion is made against the **decrypted uploaded payload** — the test derives the same config key and decrypts what `postUserSettings` was called with, then searches the whole blob string. Not a field check on an intermediate object |
| ✅ **MEASURED** | every group was confirmed able to FAIL by neutering the code under it: read-side strip removed → 4 red; write-side strip removed → 3 red; `Array.isArray` guard removed → 2 red |
| ✅ **MEASURED** | control arm: a bookmark with no `senderIcon` comes back deep-equal to what went in, and reading never writes |
| ⚠️ **READ, not measured** | the inbound adopt path. `getConfig` merges the remote bookmarks and hands the result to `saveLocalBookmarks` (`configService.ts`), which is measured to strip — but `getConfig` itself cannot run under jest: it verifies the blob signature through a dynamic `import()` of the native crypto module, which Node refuses inside jest's CJS VM. The tests cover that boundary through `addBookmark`, which reaches the identical function |

## Blast radius, since bookmarks are invisible here

`setBookmarksPanelVisible(true)` appears **nowhere** in this repo (grep, and the
state is only ever set back to `false` by the panel's own `onClose`), so
`BookmarksPanel` never renders. A user can bookmark a message and it syncs, but
cannot see their bookmarks on mobile. That gap is desktop candidate **#39** and
is not fixed here.

It does mean this change has **no visible behaviour attached to it**: nothing on
mobile reads `senderIcon`, and the panel never showed an avatar even when it
could be reached. What it can affect is the bookmark list that syncs to desktop,
which is why the sweep was dropped and the array guard added.

## Follow-ups

- **Candidate #39's other half** — give `BookmarksPanel` an entry point. Both
  call sites already pass all five props, so the missing piece is an affordance,
  not a feature. 🔴 Whoever adds an avatar there must read desktop's resolution
  ladder first: a DM conversation record carries the **counterpart's** identity,
  so reading `conversation.icon` without checking who sent the message renders
  your own name beside the other person's face. Desktop shipped that bug and
  caught it in review.
- **The pre-flight size guard** is still open on desktop
  (`.open/2026-08-05-config-upload-has-no-size-guard-and-fails-silently-on-mobile.md`)
  and applies to mobile too. This fix only buys headroom.

---

*Last updated: 2026-08-07*
