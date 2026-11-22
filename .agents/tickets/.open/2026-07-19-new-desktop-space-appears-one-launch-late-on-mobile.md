---
type: bug
title: "New space created on another device appears one app-launch late on mobile"
status: open
created: 2026-07-19
severity: low
platforms: quorum-mobile
---

# New synced space is invisible until the next app launch

Extracted from the signing-key/multi-device hunt tracker (was "M3").

## Symptom

Create a space on desktop → open mobile → the space is NOT there. Kill + reopen
mobile a second time → it appears. Confirmed 2026-07-19 (space seen only on the
2nd open; `getConfig` logged `local == remote` on the 2nd open, i.e. the 1st
open had already adopted + synced it in the background).

Not the timestamp-deadlock case (`KEEPING LOCAL` never logged) — that branch
did not fire.

## Cause

The space sync in `getConfig` (`services/config/configService.ts`) is deferred
via `InteractionManager.runAfterInteractions` and fire-and-forget, so the space
is written to storage AFTER the spaces list has already rendered → invisible
until the next launch reloads it from storage.

## Fix

Invalidate / refetch the spaces query after `syncSpacesFromConfig` completes so
a newly-synced space appears without a manual restart. Confusing for real users
("I made a space on desktop, it's not on my phone").

## Related
- Hunt tracker (archived): `.agents/reports/.done/2026-07-19-signing-key-multidevice-hunt-tracker.md`.

*Last updated: 2026-07-20*
