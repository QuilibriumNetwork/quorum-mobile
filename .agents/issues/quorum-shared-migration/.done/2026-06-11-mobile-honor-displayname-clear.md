---
type: task
title: "Mobile: honor empty displayName as a per-space-name clear in update-profile receiver"
status: in-progress
complexity: low
created: 2026-06-11
---

# Mobile: honor empty displayName as a per-space-name clear

## What & why

Desktop now lets a user **clear** their per-space display name (Space Settings →
Account: empty field = "use my global / QNS name in this space"). The clear is
broadcast as an `update-profile` message carrying `displayName: ''`.

Mobile's `update-profile` receiver currently **ignores** an empty displayName
(treats empty as "no change"), so a desktop user who clears their per-space name
still shows their **old** name to mobile users. Stale label, never wrong target —
graceful, but a cross-platform inconsistency.

This mirrors how `bio` already works on both platforms (empty string = deliberate
clear, via `!== undefined`). The fix brings `displayName` to the same semantics.

## Prerequisite

Bump `@quilibrium/quorum-shared` to **2.1.0-29** or later (currently pinned at
`2.1.0-26`). That version makes `UpdateProfileMessage.displayName` optional, which
is what lets the wire format express "omitted = no change" vs "empty = clear".
(Backward-compatible: a required string still satisfies an optional field, so the
bump alone changes nothing until the receiver logic below is updated.)

## The change

`context/WebSocketContext.tsx` has TWO `update-profile` handlers (the space-inbox
path and the second handler further down). Both build a `merged` member object
with the same per-field spread. Update the `displayName` guard in BOTH from a
truthy check to a presence check, matching the `bio` line right next to it:

- **Handler 1** — around `context/WebSocketContext.tsx:1893`:
  ```ts
  // before
  ...(profileContent.displayName ? { display_name: profileContent.displayName } : {}),
  // after
  ...(profileContent.displayName !== undefined ? { display_name: profileContent.displayName } : {}),
  ```
- **Handler 2** — the second `if (contentType === 'update-profile')` (around
  `context/WebSocketContext.tsx:3014`): apply the identical change to its
  displayName guard.

Leave `userIcon` on the truthy guard (icons aren't cleared via this path) and
`bio` as-is (already `!== undefined`).

> Note: the OLD comment at ~1851 ("Treat empty strings as 'no change'") was a
> deliberate guard against a sender-side partial-update mistake. That mistake is
> no longer possible: desktop's sender now OMITS displayName on a bio-only edit
> (sends it only when changed), so an empty displayName on the wire is always a
> deliberate clear. Update that comment to reflect the new presence semantics.

## Verification

- Runtime test (cross-platform): on desktop, set a per-space name, confirm mobile
  shows it; then clear it on desktop, confirm mobile reverts to the global/QNS
  name. Without the fix, mobile keeps the old name.
- Confirm a bio-only or avatar-only edit from desktop does NOT wipe the mobile-
  stored display name (the sender omits displayName, so the receiver leaves it).

## Triggered by

- quorum-shared `feat/optional-update-profile-displayname` (→ 2.1.0-29):
  `UpdateProfileMessage.displayName` made optional.
- quorum-desktop `feat/qns-username-overrides-display-name`: desktop sender omits/
  clears displayName, and its receiver (`services/MessageService.ts`) already uses
  `!== undefined` — this task brings mobile to parity.
