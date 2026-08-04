---
type: task
title: "Profile identity sync — analysis + corrected target design"
status: done
created: 2026-07-16
---

# Profile identity sync — analysis + corrected target design

**Created:** 2026-07-16 (REVISED same day after user corrected the public-profile role; first
version wrongly promoted the public-profile server to primary source for space rendering)
**Canonical model doc (read FIRST):**
`quorum-desktop/.agents/docs/features/identity-resolution-and-profile-sync.md` — the durable,
team-synced explanation of the three channels, the precedence ladder, and the target model.
This file is the working analysis + remaining-change list for the `follow-global-profile` branches.

## Summary of the corrected model

- **Channel C (space roster via `update-profile` messages) is how spacemates see your name.**
- **Channel B (published public profile)** is the opt-in discoverability feature for people NOT in
  a shared space, AND the carrier of the global display name + QNS `primary_username` that the
  precedence ladder falls back to.
- **Channel A (encrypted UserConfig)** syncs your profile across your own devices (restart-gated).
- **Precedence (render):** custom per-space name → QNS `.q` → global display name → address.
- **Two-state per-space model:** roster field non-empty = deliberate override; empty/absent =
  follow global. Wire: omitted = no change, `''` = clear (revert to follow-global).

## Root cause of the 2026-07-16 cross-device bug (corrected)

Two stacked causes, both channel-level:

1. **Mobile never published channel B** (`saveQuorum` had no `publishPublicProfile` call, unlike
   desktop and unlike the legacy ProfileModal). Server kept desktop's older values; anything that
   fell back to B rendered desktop's name. FIXED (`ddd9ae9`).
2. **Both apps' global-save paths still stamp channel C into every space** (desktop
   `MessageDB.updateUserProfile` all-spaces loop; mobile `saveQuorum` per-space
   `maybeSendUpdateProfileMessage` loop). So each device's global save overwrites every roster row
   with ITS current value — devices race, last save/reconnect wins, and rows stop being
   distinguishable from deliberate overrides. NOT YET FIXED — this is the main remaining change.

## Decisions locked (user, 2026-07-16)

- Global edits update every space where no override exists (follow-global model confirmed).
- DMs unchanged (global identity pushed to partners; no per-DM override concept).
- NO legacy-roster auto-migration (tiny user base; manual clear per space is fine).
- Accept `Date.now()` LWW; clock skew noted as accepted edge.

## Remaining changes — TWO-SLOT WIRE DESIGN (decided with user 2026-07-16)

A global rename must reach spacemates as a live push (works for non-public users) WITHOUT being
storable as a per-space override. So `update-profile` gets a second, clearly-labeled slot:

- **Wire (additive, optional):** `globalDisplayName?`, `globalUserIcon?`, `globalBio?` alongside
  the existing override fields (`displayName`/`userIcon`/`bio`, which keep omit/''/value
  semantics). Old clients ignore unknown fields; shared-type PR additive + parallel.
- **Roster storage:** receivers store global slots separately — mobile
  `global_display_name`/`global_profile_image`/`global_bio` + `globalProfileTimestamp`; desktop
  `global_display_name`/`global_user_icon`/`global_bio` + `globalProfileTimestamp`. TWO
  independent staleness guards (override slot keeps `profileTimestamp`) so an override message
  arriving after a newer global message isn't dropped, and vice versa.
- **Send rules:** global save → global fields ONLY (all spaces). Space editor → override fields
  ONLY (that space). On-connect rebroadcast → override-or-omit (as already implemented) PLUS
  current global fields (so members who missed the save still learn the global identity).
- **Render:** `override (non-empty) ?? newer-of(roster-global, public-profile B) ?? placeholder`.
  Desktop keeps the comparison trick as a legacy net (it neutralizes old stamped rows for free).

### Implementation slices — ALL DONE + COMMITTED 2026-07-16 (branch `follow-global-profile`)

1. ✅ Wire + receive-side. Mobile `057ef2a` (spaceMessageService send params/builder/dedup sig +
   both WebSocketContext receive paths with TWO-SLOT independent staleness guards
   profileTimestamp vs globalProfileTimestamp). Desktop `133c64f7` (shared `applyGlobalProfileSlots`
   helper wired into both receive handlers + optimistic self-apply). No behavior change (no senders).
2. ✅ Mobile global save `25a3274` (`saveQuorum` sends global* slots, writes own roster global
   slots locally per space, invalidates members cache).
3. ✅ Desktop global save `3c04b572` (`updateUserProfile` sends global* slots; optimistic self-apply
   made presence-checked so a global-only save can't wipe a real override with undefined).
4. ✅ Rebroadcasts carry current global identity. Mobile `9c21155`, desktop `db0bd922`.
5. ✅ Render merge. Mobile `ddc92a0` (fallback resolves override → roster global slot → public,
   runs for every visible member, fetch set narrowed). Desktop `5ad4fbdd` (useChannelData surfaces
   global slots; fallback precedence; resolver globalDisplayName prefers live roster slot).

Typecheck: mobile 21 (all pre-existing baseline, 0 new), desktop 0.

### STILL OWED (non-blocking)
- **Additive shared-type PR:** add optional `globalDisplayName?/globalUserIcon?/globalBio?` to
  `UpdateProfileMessage` in quorum-shared, and (mobile) the `global_*` + `globalProfileTimestamp`
  fields to `SpaceMember`. Both apps currently carry them via `as`/`as unknown as` casts (works on
  the wire; old clients ignore unknown fields). Swap casts to typed on next shared bump. Lead-gated.
- **Desktop receive has no per-slot timestamp guard** (it applies-when-present, matching its prior
  design which also lacked one for the override fields). Mobile has the two-guard model. If desktop
  ever shows an older global winning, port the guard — noted, not observed.

### Cross-device test matrix (to run — see below)
rename mobile → desktop follows live; rename desktop → mobile follows; override survives renames;
revert follows global; rapid two-device renames → latest wins; non-public user rename still reaches
spacemates.

## What already landed on the branches (keep)

- Render fallback (empty roster field → global) both apps; two-state '' semantics.
- De-stamped: on-connect/tag-rotation rebroadcasts (send override-or-omit), space creation
  (roster row = membership only), desktop editor save (change-only).
- Space editors: revert control only when an override exists, honest "Use my main avatar" copy
  (danger color on mobile).
- Mobile: publish B on global save + refresh own B cache (`ddd9ae9`, `e85e687`).
- Desktop: refresh own B cache on global save (`7404a365`).

---
*Last updated: 2026-07-16*
