---
type: task
title: "Split profile header (unmerged Quorum + Farcaster) has no visible edit affordance"
status: open
created: 2026-06-16
urgency: low (usability; functionality works)
shared_change: none
version_bump: none
runtime_test: required
found_by: user testing, 2026-06-16
---

# Split profile header has no visible "edit" cue

NOte; we shodul also add the quorum icon and the farcatser icon instead fo using generic icons in the 2 cards

## Symptom (observed in app, 2026-06-16)

A test user with **both a Quorum profile and a Farcaster profile that are NOT
merged** opens their own profile. There is no obvious way to edit the profile —
no Edit button, no pencil. Editing actually works: you tap one of the two
profile cards in the header (Quorum side / Farcaster side) and the editor opens.
But nothing on screen signals that the cards are tappable, so the edit entry
point is effectively hidden.

This came up while testing the profile-validation PR (#105): the user went
looking for a display-name field, found none, because in this split-profile
route the only way to reach the name/bio editor is the un-cued card tap.

## Root cause (verified in source)

`components/UnifiedProfileHeader.tsx`:

- **Merged header** (`MergedHeader`, ~line 65) and **Quorum-only header**
  (`QuorumOnlyHeader`, ~line 115): the avatar carries a visible **pencil badge**
  (`<IconSymbol name="pencil" .../>`) — a clear edit affordance.
- **Split mode** (`QuorumCard` ~line 158 + the Farcaster card ~line 195): each
  card is a full-card `<TouchableOpacity onPress={onEdit}>` — but has **NO pencil
  badge and no other visible edit cue**. The tap target exists; the signifier
  doesn't.

So the affordance is present in the merged/Quorum-only layouts and *missing only
in split mode* — an inconsistency, not a total gap.

`components/UnifiedProfileScreen.tsx` `handleEditRequest` (~line 97) confirms the
intended flow: no Farcaster → edit Quorum; merged → edit both; split → open a
target picker. The per-side card taps (`onEditQuorum` / `onEditFarcaster`) are
the split-mode entry points that lack a cue.

## What to do (pick the lightest that reads as obviously editable)

Make the split-mode cards visibly editable, consistent with the merged/Quorum-only
headers:

1. **Add the same pencil badge** to each split-mode card avatar (`QuorumCard` and
   the Farcaster card in `UnifiedProfileHeader.tsx`), reusing the existing
   `mergedAvatarWrap` + pencil pattern (~lines 65–74 / 115–124). Lowest-effort,
   most consistent. (Per the no-emoji-in-UI rule, keep using the `IconSymbol`
   pencil, not an emoji.)
2. Optionally also surface an explicit "Edit" affordance (e.g. a small Edit
   button / pencil in the screen header for the active segment) so it's reachable
   without knowing the card is tappable.

Keep merged + Quorum-only as-is (they already have the badge).

## Acceptance criteria

- [ ] In split mode (unmerged Quorum + Farcaster), each profile card shows a
      visible edit affordance (pencil badge) matching the merged/Quorum-only look.
- [ ] Tapping it still opens the correct editor (`onEditQuorum` / `onEditFarcaster`).
- [ ] Merged and Quorum-only headers are unchanged.

## Runtime test (required — UI)

- Account with unmerged Quorum + Farcaster → both cards show a pencil; tapping
  each opens the right-scoped editor.
- Account with merged profile → unchanged (pencil still on the merged avatar).
- Quorum-only account → unchanged.

---
*Created: 2026-06-16 — found during PR #105 testing. Split-mode profile cards are
tappable to edit but carry no visible cue, unlike the merged/Quorum-only headers
which have a pencil badge.*
