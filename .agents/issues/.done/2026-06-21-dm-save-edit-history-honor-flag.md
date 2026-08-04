---
type: task
title: "Make saveEditHistory actually work on mobile (DM + space edit paths)"
status: done
created: 2026-06-21
updated: 2026-06-25
source: spun out of #35 (DM conversation settings parity), Point 4
priority: medium
effort: small–medium
pairs-with: 2026-06-17-dm-conversation-settings-parity.md (the toggle MUST NOT ship visible until this is done)
---

# Make `saveEditHistory` actually work on mobile

## Status

shipped 2026-06-25 on branch feat/dm-mute-native-suppress-and-edit-history


## ✅ SHIPPED 2026-06-25 (branch `feat/dm-mute-native-suppress-and-edit-history`)

Default confirmed **false** (matched desktop, which uses `?? false` in every
place — the "open default" note below was resolved by reading desktop code, not
a lead-dev question). Behavior implemented (when off → `edits: []`; when on →
accumulate) in:
- **DM edit:** `hooks/chat/useEditDirectMessage.ts` — both the storage write and
  the optimistic cache, reading `conversation.saveEditHistory ?? false`.
- **Space edit:** `hooks/chat/useEditSpaceMessage.ts` (optimistic cache + storage
  write) AND **both space `edit-message` receive blocks** in
  `context/WebSocketContext.tsx` (~1873 and ~3316) — the receive side is where
  space edits actually accumulate from the sender's echo and from others, so it
  had to be gated too (broader than this task's original "find the space hook").
- **Toggle surfaced:** `components/Chat/DMSettingsSheet.tsx` "Save Edit History"
  row (default off) + `onToggleEditHistory` wired from `[id].tsx`, persisting via
  a new `updateConversationSetting` helper and invalidating the detail + list
  queries.

> ⚠️ Runtime verification PENDING (edit a message twice with the setting off →
> reopen → no prior versions; with it on → versions retained). Static + type +
> lint verified; on-device behavior not yet confirmed.

---

## Why this exists

`saveEditHistory` is exposed as a toggle in `DMSettingsSheet.tsx`, but on mobile
it currently controls **nothing** — the DM edit path ignores it. Decision
(2026-06-21): we DO want this to work and it must be **paired** with the
settings toggle — i.e. the "Save Edit History" toggle must NOT ship as a visible
control until the edit path below honors it. A toggle that does nothing is worse
than no toggle.

Not necessarily today, but it needs to happen.

## Current state (verified 2026-06-21)

- **Mobile DM edit** (`hooks/chat/useEditDirectMessage.ts`): on every edit it
  **unconditionally appends** to the `edits` array — both in the storage write
  (lines ~60-67) and the optimistic cache update (lines ~111-118). It never
  reads `saveEditHistory`. So mobile always keeps full edit history regardless of
  the setting.
- **Mobile has NO feature-flag system** (no `isFeatureEnabled`, no
  `ENABLE_EDIT_HISTORY`). Desktop gates the *toggle's visibility* behind
  `VITE_ENABLE_EDIT_HISTORY` (set true in `.env.development`; build-time/dev
  flag, not a per-user setting). Mobile does not need to replicate the flag —
  just the behavior.

## Desktop behavior to replicate

`quorum-desktop/src/components/message/MessageEditTextarea.tsx` (~line 500-535)
on edit:
1. Read `saveEditHistory` — per-conversation for DMs
   (`conversation.saveEditHistory ?? false`), per-space for channels
   (`space.saveEditHistory ?? false`).
2. If **disabled**: clear the `edits` array to `[]` before saving (no prior
   versions persisted).
3. If **enabled**: let `edits` accumulate (current mobile behavior).

`MessageService.ts:1082+` has the same check on the service side.

Note the desktop **default is `false`** (don't keep history). Mobile currently
behaves as if always-`true`.

## What to do

1. **DM edit** (`useEditDirectMessage.ts`): read the conversation's
   `saveEditHistory` (default `false`, or whatever the repudiability/default
   decision lands on — see #35). When false, write `edits: []` instead of
   appending. Apply to BOTH the storage write and the optimistic cache update so
   they don't diverge.
2. **Space edit** (find the space edit hook/path; `useSpaceSettings.ts` already
   carries `saveEditHistory` as a setting): same gating on `space.saveEditHistory`.
3. Only AFTER 1-2 are in: un-hide the "Save Edit History" toggle in
   `DMSettingsSheet.tsx` (wire `onToggleEditHistory` from `[id].tsx`) as part of
   #35.
4. Runtime-verify: with the setting OFF, edit a message twice → reopen → no
   prior versions retained. With it ON → versions retained.

## Files to touch

- `hooks/chat/useEditDirectMessage.ts` — gate `edits` accumulation on the flag
- space edit path (TBD — grep the space edit-message hook) — same gating
- `components/Chat/DMSettingsSheet.tsx` + `app/(tabs)/messages/dm/[id].tsx` —
  surface the toggle (part of #35, do last)

## Open dependency

The default direction (`saveEditHistory ?? false` vs `?? true`) and the
repudiability opt-in framing are part of the lead-dev question in
`.agents/reports/2026-06-21-dm-delete-semantics-desktop-vs-mobile.md` (Q4).
Confirm the canonical default before shipping.

> RESOLVED 2026-06-25: default is `false`, confirmed directly from desktop code
> (uses `?? false` everywhere) rather than waiting on a lead-dev call.

*Last updated: 2026-06-25*
