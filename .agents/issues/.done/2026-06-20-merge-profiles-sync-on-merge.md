---
type: task
title: "Sync-on-merge for unified profiles (proposal — needs lead-dev sign-off)"
status: done
created: 2026-06-20
---

# Sync-on-merge for unified profiles (proposal — needs lead-dev sign-off)

**Status:** PROPOSED — do NOT implement until the lead dev approves. For now, merge does
NOT sync (lazy sync on edit only). This documents the plan + the UX problem it solves.
**Branch when ready:** `profile-identity-switcher` (or a follow-up).

---

## The problem (why this is needed)

Merging two profiles is currently a **display-only** flag flip (`profile.splitMode`). It
writes no data. The edit modal in merged mode (`scope='both'`) only syncs on the **next
edit**, and it seeds from the **Quorum** side.

This creates an invisible-discrepancy UX issue:

- When merged with two *different* sets of data, the merged card shows **Quorum** pfp +
  bio (Quorum-preferred). The user's **Farcaster** pfp/bio are not shown anywhere — only
  the Farcaster *username* is visible (in the Farcaster pill).
- So the user thinks "my profile is X" while Farcaster still shows a *different*, stale Y
  to the Farcaster world — and they have no way to see or know this until they happen to
  edit (which silently overwrites Farcaster with Quorum's values).

Confirmed in code:
- `services/profile/profilePrefs.ts` — `setProfileSplitMode` writes only the MMKV flag.
- `components/UnifiedProfileEditModal.tsx:62-74` — merged edit (`scope='both'`) seeds from
  Quorum (`user.displayName/bio/profileImage`), then `handleSave` writes the same values
  to BOTH via `saveQuorum` (`updateProfile`) and `saveFarcaster`
  (`updateFarcasterProfile`). So Farcaster only changes on the next edit.

## Proposed fix: reconcile field-by-field on merge

On merge, immediately reconcile each of {displayName, bio, pfp} so both systems hold the
same value, then flip the display flag. **Per-field rule (decided with user):**

- Quorum has the field (non-empty) → push Quorum's value to Farcaster.
- Quorum empty, Farcaster has it → pull Farcaster's value into Quorum (`updateProfile`).
- Both present → **Quorum wins** (primary identity).
- Both empty → nothing.

After this, the merged card (Quorum-preferred display) is actually accurate on both sides,
and the "Farcaster has hidden different data" problem disappears.

## Data sources / APIs (already exist)

- Quorum values: `user.displayName`, `user.bio`, `user.profileImage`.
- Farcaster values (live): `farcasterAuthor` from `useFarcasterProfile` —
  `farcasterAuthor.displayName`, `.profile.bio.text`, `.pfp.url`.
- Write to Farcaster: `updateFarcasterProfile(token, { displayName?, bio?, pfp? })`
  (`services/farcaster/updateProfile.ts:123`). Accepts an existing `https://` URL to keep,
  or a data/file URI to upload. Needs `farcasterAuthToken`.
- Write to Quorum: `updateProfile({ displayName?, bio?, profileImage? })` from `useAuth`.

## Where the logic goes

`UnifiedProfileScreen` is the natural owner — it already has `user`, `farcasterAuthToken`,
`farcasterAuthor`, and owns `onMergeProfiles` (currently just `() => setSplitMode(false)`).
Add `updateProfile` from `useAuth`. The merge handler becomes async: reconcile, then
`setSplitMode(false)`.

## Feasibility — VERIFIED POSSIBLE (agent trace, 2026-06-20)

| Direction | Verdict | Mechanism / caveat |
|-----------|---------|--------------------|
| Quorum → Farcaster | **FEASIBLE** | `updateFarcasterProfile(token, {displayName,bio,pfp})` (`services/farcaster/updateProfile.ts:123`). pfp data-URI auto-uploads to Cloudflare (lines 149-160). Token already destructured in UnifiedProfileScreen. Caveat: must truncate name/bio to FC byte limits (32/256, lines 137-141) with `capDisplayName`/`capBio` before pushing. |
| Farcaster → Quorum | **FEASIBLE w/ caveat** | `updateProfile({profileImage: fcPfpUrl, displayName, bio})` (`context/AuthContext.tsx`). Remote https pfp URL stores + displays + config-syncs fine (RN `<Image>` accepts it). **Caveat:** a bare `updateProfile` does NOT fire the space/DM avatar broadcast (that lives only in ProfileModal's manual picker path, ~lines 998-1036). To make peers see the pulled FC avatar immediately, either call the broadcast explicitly OR run the FC image through `compressAvatarImage` to a data URI first. Name/bio have no such issue. |

Other confirmed facts:
- `farcasterAuthor` (`useFarcasterProfile`) exposes `displayName`, `profile.bio.text`, `pfp.url`. **Async:** may be `undefined` at merge time (esp. a user with no casts — author is derived from `casts[0]`). Guard for undefined.
- `updateProfile` is NOT yet destructured in UnifiedProfileScreen — one-line add. `updateFarcasterProfile` is a standalone import.

## Edge cases to handle

1. **No Farcaster auth token** — can't write to Farcaster. Options: flip the flag anyway
   and skip the FC push (Farcaster stays stale, same as today), OR block merge with a
   "reconnect Farcaster to merge" message. Recommend: flip anyway, surface a toast that
   Farcaster couldn't be updated.
2. **pfp direction asymmetry** — Quorum→FC push of a Quorum data-URI image requires the
   upload path in `updateFarcasterProfile` (it handles data/file URIs). FC→Quorum pull is
   just a URL string into `profileImage`. Both supported; just verify the Quorum side
   accepts a remote `https://` pfp URL for the pull direction.
3. **Byte limits** — `updateFarcasterProfile` enforces `MAX_DISPLAY_NAME_BYTES` /
   `MAX_BIO_BYTES`. A Quorum value over Farcaster's cap would be rejected — surface the
   error, don't silently drop.
4. **Failure mid-reconcile** — if the FC write fails after the Quorum pull (or vice
   versa), avoid a half-synced state. Do the reads first, compute the target values, then
   write; on FC failure, still flip the flag but report which side didn't sync.
5. **Unmerge after sync** — once synced, unmerging shows two identities with identical
   values (correct, not broken). No special handling needed.
6. **Confirm copy** — if sync-on-merge ships, change the merge confirmation to: "Your
   Farcaster name, bio, and picture will be updated to match Quorum (and vice-versa for
   fields you only set on one side)."

## Acceptance (when implemented)

- Merging with differing data results in identical name/bio/pfp on both systems per the
  per-field rule.
- No-token case degrades gracefully (flag flips, clear message).
- Merged card accurately reflects both systems.
- `npx tsc --noEmit --skipLibCheck` clean (baseline 23) + lint clean.

## Current interim behavior (shipped without sync)

Merge confirmation copy now states: "You'll see and edit one profile. From now on, editing
your name, bio, or picture updates both Quorum and Farcaster at once. Until you edit, each
keeps its current values. Usernames always stay separate. You can separate them again
later." — honest about the lazy-sync behavior, but does not solve the invisible-discrepancy
(that's what this proposal fixes).

---

*Created: 2026-06-20*
