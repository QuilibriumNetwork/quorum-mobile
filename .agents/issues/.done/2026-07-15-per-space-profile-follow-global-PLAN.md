---
type: task
title: "Implementation plan — per-space profile 'follow global vs override' (two-state)"
status: done
created: 2026-07-15
---

# Implementation plan — per-space profile "follow global vs override" (two-state)

**Created:** 2026-07-15
**Design doc:** `2026-07-15-per-space-profile-empty-follows-global-design.md` (read first — the
FINALIZED two-state model).
**Repos:** quorum-mobile + quorum-desktop. Likely NO shared publish required (see step 0).
**Sequencing rule (REVISED 2026-07-15):** render-fallback FIRST, then STOP-STAMPING-GLOBAL
(send/broadcast side), then editor + save. Original plan put broadcast last, but the chosen
representation is **present = override, absent = follow global** (no explicit flag) — and the editor
can only reliably detect "is there an override?" once the send side stops writing the global value
as a fake per-space field. So the send-side change moves BEFORE the editor. Render-fallback still
ships and is verified FIRST so receivers never render blank when a field arrives absent.

**Representation decision (FINAL):** a per-space field with a non-empty value = OVERRIDE; empty/absent
= FOLLOW GLOBAL. No new storage or wire flag — the present/absent distinction already carries it.
Legacy rows that hold stamped global values self-heal on next edit; optional one-time cleanup later.

**Revised order:** Step 1 (render fallback) → Step 4a (stop stamping global on SEND, both apps) →
Step 2 (editor override detection) → Step 3 (save writes override-or-absent) → Step 4b (verify the
all-spaces rebroadcast also omits, cross-device).

## Model recap (two states, all 3 fields identically)

- **follow global** = per-space field ABSENT (`undefined` / omitted). Space uses current global value.
- **override** = per-space field has a value. Replaces global.
- No per-space "explicit blank". "No avatar/name/bio" only exists globally.

Effective value = `override ?? global ?? placeholder`.

---

## Step 0 — Wire/type reconciliation (do first, informs everything)

**Findings (verified 2026-07-15):**
- Storage `SpaceMember/UserProfile.profile_image?` is OPTIONAL → storage can represent absent vs
  value. ✅ No storage type change.
- Wire `UpdateProfileMessage.userIcon: string` is REQUIRED (not optional), but code already omits it
  at runtime via spread (`...(userIcon !== undefined ? { userIcon } : {})`). So omission works
  despite the type. `displayName?` / `bio?` are already optional.
- → **No shared publish needed to proceed** (precedent: [[untyped-config-cast-deblocks-shared-publish]]).
  File an ADDITIVE shared PR to make `userIcon?` optional, in parallel; swap to typed on next bump.

**Reconcile with the shipped avatar three-state work:** that work used per-space `''` = "explicit
clear that wins". Under this model there is NO per-space blank. Decision for implementation:
- **omitted / absent** = follow global (the ONLY non-override state).
- **value** = override.
- Per-space `''` should be treated as = absent = follow global (NOT a distinct blank). Where the
  avatar work made `''` win over the global fallback, that per-space behavior is REMOVED; empty
  per-space avatar now follows global. (Global-level `''` = a genuinely cleared global avatar still
  matters and is unaffected.)

**Acceptance:** written note in both repos' code where `''` vs undefined is interpreted, confirming
per-space `''`→follow-global.

---

## Step 1 — Render fallback for OTHER members (both apps) [LOW RISK]

Goal: when a member's per-space field is absent, render their global (public-profile) value.

### Desktop — `useMembersWithPublicProfileFallback.ts`
Current (verified): name `local?.displayName || pub.display_name` (✅ empty→global), bio
`local?.bio || pub.bio` (✅), avatar `local?.userIcon !== undefined ? local.userIcon : pub...`
(❌ empty '' does NOT fall back — leftover from three-state avatar work).
- **Change:** make avatar fall back on empty too, consistent with name/bio:
  `local?.userIcon || pub.profile_image || undefined` (truthy — absent AND '' both follow global).
- Verify `resolveSpaceMemberName` still behaves (it compares roster vs global; with follow-global it
  can simplify but leaving it is safe).

### Mobile — `hooks/useMembersWithPublicProfileFallback.ts`
Current: `pickField` timestamp-gated; when local is newer, `localVal !== undefined ? localVal : pub`
(❌ empty '' wins). When public newer: `pub || local` (✅).
- **Change:** `pickField` should let empty follow global in BOTH branches:
  `chatIsNewer ? (localVal || pubVal || '') : (pubVal || localVal || '')`. (Revert the
  `!== undefined` avatar-clear tweak — same reasoning as desktop.)

**Test (both apps):** a member with no per-space override + a public profile → renders their global
name/avatar/bio in the space. A member WITH an override → renders the override.

**Acceptance:** other members render correctly for both override and follow-global; no regression to
QNS name display.

---

## Step 2 — Editors: effective value + honest revert (both apps) [MEDIUM]

Goal: the OWN Space Settings editor shows the effective value, distinguishes override vs
follow-global, and offers a revert action ONLY when an override exists.

Need a way to know "is there an override?" = the per-space member field is a non-empty value that
is NOT merely the global value echoed in. Cleanest: **override exists iff the stored per-space
field is a non-empty value.** (After step 3 stops stamping global values in, a stored value = a real
override. Until then, legacy rows may hold the global value; see step 4 migration note.)

### Desktop — `Account.tsx` + `useSpaceProfile.ts`
- `getProfileImageUrl`: effective = override ?? global ?? unknown-icon (already close; ensure
  "override" = per-space value present, else fall to global).
- Trash/revert button (`markForDeletion`, line ~169-182): render ONLY when a per-space OVERRIDE
  exists (not when merely following global / showing the global image).
- Reword tooltip + aria-label `"Delete this image"` → `"Use my main avatar"`.
- Same pattern for display name / bio: show global as placeholder when following; a "reset to my
  main name" affordance only when overridden. (Name field placeholder can be the global name.)

### Mobile — `SpaceSettingsModal.tsx`
- Mirror: show effective avatar (override ?? global ?? placeholder); the just-shipped empty →
  placeholder covers the "following an empty global" case. Show a revert/remove control only when an
  override exists, honest copy.
- Name/bio: placeholder = global value; revert affordance only when overridden.

**Test (both apps):** following global → shows global, no revert control; upload → creates override,
revert control appears; revert → back to following global (global reappears), control disappears.

**Acceptance:** the "remove → global reappears" confusion is gone (no misleading control in the
follow-global state); override create/revert round-trips cleanly.

---

## Step 3 — Save logic: store override only on real change (both apps) [MEDIUM]

Goal: saving the editor writes a per-space override ONLY when the user set a value different from
follow-global; reverting stores absent (follow global), not the global value copied in.

- Desktop `useSpaceProfile.onSave` + mobile `SpaceSettingsModal.handleSaveSpaceProfile`: already
  change-only vs baseline. Adjust so:
  - "revert to global" sends the field as OMITTED (absent), and clears the stored per-space value.
  - setting an override sends the value.
  - do NOT send the global value as a per-space field (that's the bug this whole effort removes).

**Test:** revert an override → other devices/members see you follow global again (not frozen).

**Acceptance:** no save ever writes the global value as a per-space override; revert produces
follow-global end-to-end.

---

## Step 4 — Stop broadcasting global values as per-space overrides (both apps) [HIGH RISK — LAST]

The load-bearing wire change. Do ONLY after steps 1-3 verified.

- Desktop all-spaces rebroadcast (`MessageService.ts:~577`): stop sending
  `displayName = config.name` / `userIcon = config.profile_image` as per-space overrides. Send the
  per-space OVERRIDE if one exists for that space, else OMIT the field (follow global).
- Mobile rebroadcast (`WebSocketContext.tsx:~4746/4784`): same — currently sends
  `displayName = user.displayName || user.username` to all spaces. Send per-space override or omit.
- This requires the rebroadcast to look up the per-space override per space (it currently blasts the
  global value uniformly). Confirm both rebroadcast paths have access to per-space member data.

**Migration note:** existing member rows already hold stamped global values (legacy "fake
overrides"). After this change they persist until re-saved. Options: (a) leave them (they'll look
like overrides equal to the old global — low harm, self-heals when the user edits), or (b) a
one-time pass clearing per-space fields that equal the sender's current global value. Recommend (a)
unless it visibly confuses; note and revisit.

**Test matrix (from design doc):** never-set → follows global; change global later → non-overridden
spaces follow; override → shows override; revert → follows global; empty global → placeholder.

**Acceptance:** changing the global name/avatar/bio propagates to all non-overridden spaces on other
devices/members; overrides stay put; no blank rendering.

---

## PROGRESS (2026-07-15 EOD)

Branches: BOTH repos on `follow-global-profile` (NOT pushed, NOT PR'd yet).
- ✅ **Step 1 (render fallback)** — committed. desktop `afb31b26`, mobile `b43e7ad`.
  Empty per-space name/avatar/bio → global (public-profile) value. Avatar no longer treats
  empty as a distinct blank. Mobile fetch gate widened to name-OR-avatar-missing.
- ✅ **Editor-save send-side** — committed (in desktop `afb31b26`). Desktop `useSpaceProfile.onSave`
  now omits unchanged fields (userIcon no longer re-sent unconditionally via `?? baseline`). Mobile
  `SpaceSettingsModal` was ALREADY change-only — no change needed.
- ✅ **Step 4a MOBILE done (2026-07-16)** — `context/WebSocketContext.tsx` (rebroadcast is at
  `context/` singular, NOT `contexts/`; the on-connect loop is ~line 4778, not the old 4746). The loop
  now reads the sender's own per-space member row via `adapter.getSpaceMember(spaceId, user.address)`
  and sends `member?.display_name || undefined` / `member?.profile_image || undefined` — i.e. the
  per-space OVERRIDE if non-empty, else OMIT (follow global). No longer stamps the global
  `displayName`/`userIcon` uniformly. Farcaster linkage + the DM rebroadcast (global identity, not
  per-space) intentionally unchanged. Typecheck: no NEW errors (pre-existing `4406` MessageHandler
  error confirmed on clean `b43e7ad`, unrelated). NOT yet committed — commit with the rest of the
  batch, or verify cross-device first.
  - ⚠️ CAVEAT (noted, acceptable): the effect's early-return guard still gates on GLOBAL values
    (`if (!displayName && !userIcon && !fcFid) return`). A user with NO global identity but a per-space
    override would be skipped by THIS on-connect path — but per-space overrides are broadcast by the
    SpaceSettingsModal save path anyway, and "no global identity at all" is degenerate. Left as-is;
    matches desktop's equivalent guard.
  - COMMITTED 2026-07-16 mobile `cb9085f`.
- ✅ **Step 4a DESKTOP done + COMMITTED (2026-07-16, desktop `b938a053`)** — `MessageService.ts` tag-
  rotation rebroadcast (~line 577). Now reads `this.messageDB.getSpaceMember(s.spaceId, selfAddress)`
  per space and sends `display_name` / `user_icon` (read defensively `user_icon || profile_image`) /
  `bio` per-space OVERRIDE if non-empty, else OMITs. No longer stamps `config.name` / `config.profile_image`
  / `config.bio` uniformly. Farcaster/spaceTag paths untouched. Built the message object with conditional
  spreads + `as UpdateProfileMessage` (the type's fields are required). Typecheck: 0 errors.
- ✅ **Step 2 (editor override-detection + honest revert copy) — DONE + COMMITTED both apps (2026-07-16)**.
  - Desktop `Account.tsx` (`b938a053`): the avatar revert control now renders ONLY when a per-space
    override exists (`hasFreshUpload || hasStoredOverride`, not merely `showImage`), relabeled
    `"Delete this image"` → `"Use my main avatar"`. Added `currentMember` prop (threaded through
    `SpaceSettingsModal.tsx`). `useSpaceProfile.getProfileImageUrl` collapsed from three-state '' to
    two-state (non-empty = override, '' or absent = follow global avatar).
  - Mobile `SpaceSettingsModal.tsx` (`cb9085f`): "Remove" → "Use my main avatar" (primary color, honest
    aria-label); shown only when an override exists (`spaceProfileImage` truthy). Avatar preview keeps the
    empty upload placeholder when following global (Step 5, already shipped) — intentional, matches design.
- ✅ **Step 3 (save writes override-or-absent) — VERIFIED, NO CHANGE NEEDED both apps**. Desktop
  `useSpaceProfile.onSave` and mobile `handleSaveSpaceProfile` were already change-only and already send
  an explicit `''` on a deliberate clear (revert). `''` is the CORRECT wire signal for reverting an
  EXISTING override (receivers honor `''` as clear → follow global via render fallback); OMIT is only for
  the never-set/rebroadcast case. So the plan's "revert = omit" was refined: revert of an existing override
  = send `''` (propagates the clear); never-set = omit. Refreshed a stale mobile comment that claimed the
  wire drops empty fields.
- Optional (still open, non-blocking): additive shared PR making `UpdateProfileMessage.userIcon` optional
  (currently cast `as UpdateProfileMessage` in both apps' send paths).

## ALL STEPS COMPLETE (2026-07-16). Remaining: cross-device verification + PRs (not code work).
Verify: mobile→desktop + desktop→desktop (desktop→mobile delivery known-flaky). Test matrix in design doc.
Both branches `follow-global-profile`, NOT pushed/PR'd. Mobile `.agents/` is gitignored; desktop `.agents/`
is tracked but its pending edits were left UNSTAGED (pre-existing, unrelated).

## Step 5 — DONE ✅ mobile empty-avatar placeholder (committed ff680d4, master).

---

## Risk / sequencing summary

1. Step 1 (render fallback) — low risk, ship + verify first.
2. Steps 2-3 (editor + save) — medium; user-visible, testable in-app on one device.
3. Step 4 (broadcast) — HIGH; changes cross-device wire behavior. Ship last, only after 1-3 green.
   Desktop→mobile delivery is currently flaky (known issue) — verify via mobile→desktop +
   desktop→desktop where possible.
- Branch/PR pair per repo (batch the related steps; not one giant PR). Shared type PR (userIcon?)
  additive + parallel, non-blocking.

---
*Last updated: 2026-07-16 (all steps code-complete + committed both repos)*
