---
type: task
title: "Profile-screen-rework — deferred cleanup (non-blocking)"
status: done
created: 2026-06-21
---

# Profile-screen-rework — deferred cleanup (non-blocking)

Two low-priority items from the pre-ship integration review (2026-06-21) that we
deliberately did NOT fix, to avoid churn right before shipping. Neither is a live
bug.

## 1. Orphaned inline-edit code in ProfileModal (dead under hideHeader)

`components/ProfileModal.tsx` still carries the old inline-edit flow:
- state: `isEditing`, `editDisplayName`, `editBio`, `nameError`, `bioError`,
  `isSaving` (~lines 441-446)
- handlers: `handleSaveProfile`, `handleCancelEdit`
- the `ProfileTabSection` profile-header block with the avatar `onPickImage`
  camera button (~lines 4017-4030), gated by `{!hideHeader && ...}`
- `handlePickImage` (Quorum-only avatar update + space/DM broadcast)

These are unreachable in the current app because `ProfileModal` is always
embedded with `hideHeader={true}` (and `hideTabBar={true}`) by
`UnifiedProfileScreen`. The only edit entry now is the header pencil →
`UnifiedProfileEditModal`. So this is inert dead code, not a behavior bug.

Originally flagged as a "two avatar surfaces behave differently" inconsistency,
but verified the second surface (`ProfileTabSection` header avatar) never renders
under `hideHeader=true`. Confirmed dead, not live.

**If cleaning up later:** remove the inline-edit state/handlers + the
`!hideHeader` ProfileTabSection header block, OR (safer) leave until ProfileModal
is refactored, since it's a 4000-line file and the dead code is harmless.

## 2. Merge cache invalidation skipped on Farcaster push failure

In `reconcileMergedProfiles` (`UnifiedProfileScreen.tsx`), if the Farcaster API
push fails, the `catch` shows a toast and `return`s BEFORE the
`invalidateQueries(['farcaster-profile', fid])` at the end. Harmless (FC data
didn't actually change on failure, so nothing to refresh), but if we ever want
the post-merge My Casts refresh to also run on partial failure, move the
invalidate into a `finally` or before the early returns.

---
*Created: 2026-06-21*
