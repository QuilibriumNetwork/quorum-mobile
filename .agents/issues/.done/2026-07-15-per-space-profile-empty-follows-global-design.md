---
type: task
title: "Per-space profile: 'empty = follow global' — one model, both apps"
status: done
created: 2026-07-15
---

# Per-space profile: "empty = follow global" — one model, both apps

**Created:** 2026-07-15
**Status:** design agreed (model = empty per-space field means "use my current global value").
Cross-repo (mobile + desktop). Supersedes the ad-hoc per-field fixes from earlier 2026-07-15
(avatar three-state, Space Settings reactivity) which fixed symptoms of this root cause.
**No confirmed quorum-shared change yet** — TBD in step 1.

## The decision (FINALIZED 2026-07-15 — TWO states, not three)

A per-space profile field (display name, avatar, bio) is an OPTIONAL override with exactly TWO
states:
- **follow global** (default) = use my current global value, dynamically (change the global later,
  the space follows). This is the ABSENT / not-overridden state.
- **override** = a deliberate per-space value that REPLACES the global one.

**There is NO per-space "explicitly blank" state.** In a space you can only REPLACE your
name/avatar/bio, never SUBTRACT it. "No avatar/name/bio at all" lives ONLY at the global level —
clear it globally and that absence flows into every non-overridden space via follow-global.

This resolves the earlier three-state confusion ("if empty means follow-global, how does the user
express 'blank here'?"): they don't — that intent is removed as a per-space capability because it
created an inexpressible/one-way-door UX (remove→global-reappears with no way back). Users found it
confusing; dropping it makes the model coherent.

> ⚠️ This SUPERSEDES the avatar three-state work's `''` = "explicit clear that wins" as a *per-space*
> concept. Under this model a per-space avatar is either absent (follow global) or an override; there
> is no per-space `''`-means-blank. The `''`-handling still matters at the GLOBAL level (a globally
> cleared avatar). Reconcile carefully during implementation.

### Effective-value truth table (all three fields behave identically)

| Global value | Per-space state | Space shows |
|---|---|---|
| has value | follow global (default) | the global value |
| has value | override | the override |
| empty | follow global (default) | placeholder/initials (following an empty global) |
| empty | override | the override |

### Editor UX (the "Remove" confusion, resolved)

The confusion: labeling the revert action "Remove/Delete" (a trash icon) implies subtraction, but
clicking it makes the GLOBAL avatar reappear (substitution) — a broken promise. Fix = the revert
action only EXISTS when an override exists, and is labeled by its true effect:

- **Following global (no override):** show the effective (global) value; **no revert/trash control**
  (nothing to revert). Only the "set a custom X" affordance.
- **Override set:** show the override; offer "Change" + a revert action labeled **"Use my main
  avatar"** (not "Remove"/"Delete"). Clicking it reverts to follow-global → global reappears, which
  is exactly what the label promised.

Desktop specifics (verified in `Account.tsx`): the trash button (`markForDeletion`, tooltip +
aria-label currently `"Delete this image"`) renders when `showImage`. Two changes:
1. Render the trash/revert control ONLY when a per-space OVERRIDE exists (not merely when an
   effective image is shown via follow-global). Requires distinguishing "override present" from
   "effective image present".
2. Reword the tooltip + aria-label to the follow-global-honest copy (e.g. "Use my main avatar").
Mobile: same logic in `SpaceSettingsModal` (show revert only when override exists; honest copy).

Chosen over "snapshot global at join (frozen copy)" because it makes global changes propagate,
makes reverting work, and kills the clobber/can't-clear/frozen-copy bugs.

## Root cause this replaces

BOTH apps currently **broadcast the user's GLOBAL values into every space's member row**:
- desktop all-spaces rebroadcast: `displayName = config.name ?? ''`,
  `userIcon = config.profile_image ?? UNKNOWN_USER` (`MessageService.ts:~577`).
- mobile rebroadcast: `displayName = user.displayName || user.username`, then
  `displayName || undefined` (`WebSocketContext.tsx:~4746/4784`).

Both then init the Space Settings field from `member.display_name ?? ''`
(desktop `useSpaceProfile`, mobile `SpaceSettingsModal:597`). So "unset" and "set to my global
value" are indistinguishable → can't clear, global edits don't propagate, save re-freezes the
global value (the clobber the user hit). Desktop even built `resolveSpaceMemberName` to *guess*
whether a roster name was "global echoed at join" vs deliberate — machinery this model removes.

Mobile and desktop are already CONSISTENT with each other here (same broadcast + same init), so
this is choosing one model, not reconciling two.

## Target design

### Storage / wire
- A per-space override field is stored **empty/absent** unless the user deliberately sets it.
- **Stop broadcasting the global value as a per-space override.** The rebroadcast should send an
  empty/omitted `displayName`/`userIcon`/bio when the user has no per-space override (send the
  override only when one exists). This is the load-bearing change — it's what makes "empty =
  follow global" true on the wire, not just in the editor.
  - ⚠️ This changes what OTHER clients receive. Verify the receive/render fallback (below) is in
    place on both apps BEFORE shipping the broadcast change, or other members render blank.

### Rendering OTHER members (already mostly built on desktop)
- Desktop ALREADY has the fallback: `useMembersWithPublicProfileFallback` merges each visible
  member's **public profile** (per-field: empty local → public value), surfacing `globalDisplayName`
  / global avatar / global bio. `resolveSpaceMemberName` picks per-space-override vs global.
  → With "empty = follow global", this simplifies: empty per-space field just uses the public-profile
  value. The disambiguation-by-comparison in `resolveSpaceMemberName` becomes unnecessary (empty is
  now unambiguous) but can stay as a safety net.
- Mobile has a mirror `hooks/useMembersWithPublicProfileFallback.ts` (pickField). Confirm it does the
  same empty→public fallback for name/avatar/bio.

### The OWNER's editor (Space Settings → Account, both apps)
- Field stored empty when no override. **Show the global value as a PLACEHOLDER/default hint**, not
  as a real stored value.
- Save creates an override ONLY when the field differs from the global value; leaving it at the
  global value (or clearing it) stores empty = follow global.
- Avatar preview when empty: **show the empty upload placeholder (person icon / upload slot), NOT
  initials.** (This REVERSES the mobile "initials fallback" added earlier today in fix D —
  SpaceSettingsModal — and also applies to the mobile User Settings modal. Desktop already shows the
  empty upload state; mobile should match.)

### User Settings (global) modal
- Same avatar rule: empty global avatar → empty upload placeholder, not initials (mobile change to
  match desktop).

## Work items (ordered — receive/fallback BEFORE broadcast change)

1. **Decide shared involvement.** Empty/omitted fields are already valid on the wire
   (`UpdateProfileMessage` fields are optional), so likely NO shared change — but confirm the
   receive-side treats "omitted" as "no override / follow global" consistently. (Empty-string vs
   omitted semantics were just standardized in the avatar three-state work: `undefined`=no change,
   `''`=explicit clear. Reconcile: for THIS model, "follow global" should be OMITTED, and an explicit
   `''` avatar/name = a deliberate "blank" override. Make sure editor "clear to follow global"
   sends omitted, not '' — otherwise it reads as an explicit blank.)
2. **Rendering fallback both apps** (verify/complete): empty per-space name/avatar/bio → global
   (public-profile) value for OTHER members. Desktop mostly done; verify mobile pickField.
3. **Editors both apps:** store empty unless changed-from-global; show global as placeholder; save
   creates override only on real change.
4. **Stop the global-value rebroadcast as override** (desktop `MessageService.ts:~577`, mobile
   `WebSocketContext.tsx:~4746`): send the per-space override only when it exists, else omit.
5. **Mobile avatar-empty placeholder** (reverse fix D): Space Settings + User Settings show the
   empty upload placeholder, not initials, when the avatar is empty.
6. **Migration thought:** existing member rows already contain stamped global values. After the
   broadcast change, those persist as frozen overrides until re-saved. Decide whether to actively
   clear rows that equal the sender's current global value, or let them age out. Probably let them be
   (low harm) but note it.

## Test matrix (both apps, both directions)

| Scenario | Expect |
|---|---|
| Never set per-space name → open Account editor | field empty, global name shown as placeholder |
| Set global name to X, never override in space → other members | see X (follows global) |
| Change global name X→Y later | non-overridden spaces now show Y (follows) |
| Set a per-space override → other members | see the override, not global |
| Clear a per-space override | reverts to following global (not frozen) |
| Empty per-space avatar → editor | empty upload placeholder, not initials |
| Empty per-space avatar → other members | see global avatar |

## Risk notes
- **Wire-behavior change (step 4)** is the risky one: other clients must have the fallback (step 2)
  first, or people render blank. Stage: fallback → editors → broadcast, and test each.
- Desktop→mobile delivery is currently unreliable (known issue) — will complicate cross-device
  verification; lean on mobile→desktop + desktop→desktop where possible.
- This is bigger than the shipped fixes; likely its own branch(es) + PR pair, NOT a direct-to-main.

---
*Last updated: 2026-07-15*
