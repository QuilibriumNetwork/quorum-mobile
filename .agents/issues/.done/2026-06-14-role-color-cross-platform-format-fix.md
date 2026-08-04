---
type: task
title: "Roles adopt the shared icon-color vocabulary (fixes desktop CSS-var color that mobile can't render)"
status: done
created: 2026-06-14
urgency: Tier 2 — user-visible (invisible role pills on mobile) + log-spam; root cause is a wire-data-format divergence in a shared field
shared_change: required (extend the shared icon-color vocabulary; add role-color helpers)
version_bump: required (mobile bumps to consume; this also entangles with the pending 2.1.0-30 publish)
runtime_test: required
spans_repos:
  - quorum-shared (root: extend the existing ICON_COLORS vocabulary; expose a role-color default/resolver)
  - quorum-desktop (stop writing the CSS-var string; store a named token; render via the resolver; optional picker)
  - quorum-mobile (store named token from the shared palette; resolve on render; unify the two pill styles)
source_investigation: 2026-06-14 two Explore passes across all three repos (findings inline)
related:
  - 2026-06-14-role-assignment-ui-unreachable-missing-roles-prop.md (the assignment-UI wiring fix that surfaced this)
  - port-to-mobile/candidates.md row 31 (the icon-picker vocabulary this builds on — shared PR #39)
supersedes_approach: "the earlier draft of this file proposed a standalone resolveRoleColor() mapping css-var→hex. REPLACED: roles should adopt the SAME named-token + getColorHex pattern the shipped icon/folder picker already uses, not a role-specific resolver. One vocabulary for icons, folders, and roles."
---

# Roles adopt the shared icon-color vocabulary

## Decision (user, 2026-06-14)

**Extend the shared icon-color palette to a fuller set and reuse it for roles AND icons** — one cross-platform color vocabulary for icons, folders, and roles. Roles switch to the SAME named-token-stored + resolve-to-hex-at-render pattern the icon/folder picker already ships. This is the "one source of truth" path; it also fixes the bug as a side effect.

## The bug in one paragraph

A space Role's `color` is part of the synced manifest. **Desktop hardcodes every new role's color to the literal string `'rgb(var(--success))'`** (a web CSS variable) and broadcasts it raw (`quorum-desktop/src/hooks/business/spaces/useRoleManagement.ts:51`). The browser resolves CSS vars at paint; **React Native has no CSS-var pass**, so mobile feeds `"rgb(var(--success))"` into `backgroundColor`/`color`/`borderColor`, producing **invisible role pills** + repeated `WARN "rgb(var(--success))" is not a valid color or brush`. Mobile-created roles store proper hex and are fine. One-directional desktop→mobile data-format bug. (Confirmed on device: a desktop-assigned `admin` role's pill was invisible because `role.color === "rgb(var(--success))"`.)

## Why the named-token pattern is the right fix (not a css-var→hex resolver)

The icon/folder picker (shared PR #39) ALREADY solved this exact class of problem, the right way:
- **Stored value** = a named token (`'blue' | 'green' | …`) — portable, theme-agnostic, tiny on the wire.
- **Rendered value** = `getIconColorHex(token)` → `#rrggbb`, React-Native-safe on both platforms.

Roles instead store a **raw color string** (mobile hex / desktop broken css-var). Adopting the icon pattern (a) fixes the format bug structurally, (b) unifies the app's whole color story (icons + folders + roles draw from one vocabulary), (c) reuses shipped, tested shared code instead of a role-only shim.

## Evidence (verified 2026-06-14)

**Shared already ships the canonical palette** — `quorum-shared/src/primitives/Icon/pickerVocabulary.ts`:
- `ICON_COLORS` (line 238): 8 entries (`default` + blue/purple/fuchsia/green/orange/yellow/red), each `{ value, label, class, hex }`. The `hex` is portable `#rrggbb`. JSDoc explicitly says the palette is "shared so desktop and mobile draw from one source of truth."
- `FOLDER_COLORS` (line 250): same 8 names, dimmed hex variants.
- `IconColor` type (line 18): named union `'default'|'blue'|...|'red'`.
- Helpers exported: `getIconColorHex(token)`, `getFolderColorHex(token, isDark)`, `getIconColorClass(token)`. Re-exported through `src/primitives/index.ts`.
- Desktop already consumes all of this (icon + folder pickers delegate 100% to shared — `IconPicker/types.ts:6-15`; folder render `FolderButton.tsx:37` uses `getFolderColorHex`).

**`Role.color` has no contract** — `quorum-shared/src/types/space.ts:16-24`, bare `string`.

**Desktop role color** — hardcoded `'rgb(var(--success))'`, no picker, never updated, stored raw into the `JSON.stringify`'d manifest (`SpaceService.ts:511`). Renders on desktop only because the browser resolves the var; several desktop sites even hardcode `rgb(var(--success))` in CSS and ignore `role.color` entirely (`Account.tsx`, `UserProfile.scss`).

**Mobile role color** — own 16-hex `ROLE_COLORS` (`SpaceSettingsModal.tsx:106-111`), `getRandomColor()` picks one at create. **6 of its 7 core hues exactly match `ICON_COLORS`** (`#ef4444 #f97316 #22c55e #8b5cf6 #d946ef #3b82f6`); yellow differs (`#f59e0b/#eab308` vs `#ca8a04`); plus 10 extra hues (teal/sky/cyan/indigo/violet/pink/lime/rose…). Mobile renders pills in two places that BOTH break on a non-hex color and both lean entirely on `role.color` for legibility (the styling weakness the user hit): `UserProfileModal.tsx` (bordered pill) + `SpaceSettingsModal.tsx` members list (`role.color + '20'` fill, ~1753).

**No migration precedent** in any repo; the bad css-var value is already in persisted + broadcast manifests, so mobile must tolerate it regardless of the desktop fix.

## Plan (shared → desktop → mobile; implement nothing until reviewed)

### Phase A — quorum-shared (extend the vocabulary; add role helpers)

A1. **Extend the palette to a role-appropriate size.** In `pickerVocabulary.ts`, grow the canonical color set to a fuller list (reconcile mobile's 16 with the existing 7 — they already share 6 hues at identical hex). Decide whether to:
   - (a) grow `ICON_COLORS` itself (icons + folders + roles all gain the larger set), or
   - (b) add a superset `APP_COLORS`/`PALETTE` that `ICON_COLORS` is a subset of.
   Recommend (a) if the extra hues are acceptable on icons too (they are all portable hex); it's the truest "one palette." Resolve the yellow discrepancy deliberately (`#ca8a04` is a poor badge bg — prefer `#eab308`). Keep the `{ value, label, class, hex }` shape; `class` (Tailwind) stays web-only and ignored by RN.

A2. **Role helpers.** Add `getRoleColorHex(token)` (or reuse `getIconColorHex` if roles share the exact set) + `getDefaultRoleColor()` (deterministic-from-roleId so a new role gets a stable, distinct color without a picker — avoids the "all desktop roles identical green" wart while keeping the value synced). Export from the primitives barrel.

A3. **Document the contract.** JSDoc on `Role.color`: stores a palette TOKEN (not a raw color, never a CSS var); render via the resolver. Optionally tighten the type later (keep `string` for wire-compat now; a token union is a follow-up).

A4. **Legacy tolerance in the resolver.** `getRoleColorHex` must accept (i) a known token → hex, (ii) an already-valid hex (mobile legacy) → passthrough, (iii) the known `rgb(var(--success))` legacy string → its hex (green), (iv) anything else → `getDefaultRoleColor`. Reuse `hexToRgb` plumbing but GUARD it (it throws on non-hex). This is what makes already-broadcast desktop roles render correctly forever.

A5. Add vitest (none exist for this area): token→hex, hex passthrough, css-var legacy→green, garbage→default, undefined→default. `lint && typecheck && test:run`, build. **Coordinate the publish with the pending `2.1.0-30`** (this likely rides that publish — confirm with Cassie; mobile is pinned `2.1.0-29`).

### Phase B — quorum-desktop (store a token; render via resolver; optional picker)

B1. **Stop emitting the css-var.** `useRoleManagement.ts:51` — set `color` to a palette token (or `getDefaultRoleColor(roleId)`), not `'rgb(var(--success))'`. Additive shared consumption via `link:`, visible immediately.
B2. **Render through the resolver.** Wrap the role-color reads that actually use the field (`Roles.tsx:114`, `MentionDropdown.tsx:219`) in `getRoleColorHex()`. Legacy roles then render identically.
B3. **Optional (lead decision): add a role color-picker** reusing the shared palette swatches — closes the "every desktop role is the same green / no chooser" gap. Real feature, flag don't assume.
B4. Desktop tsc + check: new role gets a token→hex; synced mobile role renders; legacy `rgb(var(--success))` role still renders green.

### Phase C — quorum-mobile (token on write, resolve on render, unify pills)

C1. **Write a token, not raw hex.** Replace `ROLE_COLORS`/`getRandomColor()` usage in role create/edit with the shared palette + `getDefaultRoleColor()` (or a swatch picker if B3 lands). Drop the local 16-hex list in favor of the shared vocabulary.
C2. **Resolve on render, single chokepoint.** Map `role.color` through `getRoleColorHex()` where roles surface for display — ideally in `useRoles` (`hooks/chat/useRoleManagement.ts:42-52`) so every consumer is safe. Covers legacy + new.
C3. **Unify + fix the pill styling (the user's actual complaint).** Extract ONE mobile `RolePill` used by both `UserProfileModal.tsx` and `SpaceSettingsModal.tsx` members list, with an always-legible treatment that reads against the skin's drawer/surface bg (tinted fill + solid dot/border in the resolved color + text at a guaranteed-contrast token — NOT raw `role.color` for text if that's what washed out). Verify against the actual drawer background that failed.
C4. **Bump shared** to the published version. `yarn install`. tsc/lint clean + runtime QA: desktop-assigned role shows a visible, legible pill in BOTH the profile panel and members list; zero `not a valid color` warnings; mobile-created roles unchanged.

## Open decisions for the lead

1. **Palette extension (A1):** grow `ICON_COLORS` in place (icons get more colors too) vs a superset constant. (User leaning: one extended palette.)
2. **Yellow value:** `#ca8a04` → `#eab308`? (badge-legibility.)
3. **Default-color choice (A2):** deterministic-from-roleId (stable + distinct, no picker) vs require a picker.
4. **Desktop role picker (B3):** in scope now or separate feature task?
5. **Publish coupling:** does this ride `2.1.0-30`, or its own tag? (Cassie / npm.)

## Acceptance criteria

- [ ] Shared exposes ONE extended color vocabulary reused by icons/folders/roles + `getRoleColorHex`/`getDefaultRoleColor`, with tests (token / hex / css-var legacy / garbage / undefined).
- [ ] `Role.color` documented as a palette token; resolver tolerates all legacy forms.
- [ ] Desktop stops writing `rgb(var(--success))`; renders roles via the resolver.
- [ ] Mobile stores a token, resolves on render; desktop-assigned roles show a visible, legible pill in BOTH the profile panel and the members list; no `not a valid color` warnings.
- [ ] Both mobile pills share ONE legible style that reads against the drawer/surface bg.
- [ ] tsc + lint clean in all touched repos; mobile bumped to the publishing shared version.

## Notes

- Pairs with `2026-06-14-role-assignment-ui-unreachable-missing-roles-prop.md` (already staged on branch `fix/show-role-assignment-in-user-profile`) — that wiring fix is what made the invisible pill visible-as-a-gap. The pure pill-styling slice of C3 could ship with that branch as an interim visual fix even before the shared work, IF a temporary local resolve is acceptable — but the user chose NO mobile stopgap, so hold C3 for the full cross-repo change.
- Same bug CLASS as the channel-icon vocabulary mismatch (candidates.md row 31): a manifest field whose VALUE format differs per platform. The lesson — "synced manifest fields need platform-portable value contracts; prefer named-token + resolver over raw platform-native values" — is worth a line to the lead.

## Resolution (2026-06-15)

All three repos implemented; only the mobile PR/merge remains (intentionally held until consumers adopt `2.1.0-30`).

- **quorum-shared** — PR #42 ("Add role color palette and resolver; extend icon-color vocabulary"), on master, **published as `2.1.0-30`**. `getRoleColorHex` / `getDefaultRoleColor` + extended palette + `roleUtils.test.ts` (token→hex, hex passthrough, legacy css-var tolerance, etc.). `Role.color` documented as a token in `src/types/space.ts`.
- **quorum-desktop** — PR #204 ("Bring desktop roles to parity with shared color tokens and uniqueness"), on master. Stops emitting `rgb(var(--success))`; renders via the resolver.
- **quorum-mobile** — branch `feat/role-color-resolver-and-pill` (commit `fc629d6`, pushed to remote, **no PR yet**). `useRoles` resolves `role.color` via `getRoleColorHex`; new roles get `getDefaultRoleColor(roleId)`; dropped the local `ROLE_COLORS`/`getRandomColor` palette; unified the `UserProfileModal` + members-list pill (tinted fill + color dot). Also added role tag/name uniqueness and a remove-role confirmation. `package.json` stays pinned at `2.1.0-29` per the commit message — **bump to `2.1.0-30` + open/merge the PR now that shared is published** (matches the local-shared-dev merge rule).

Remaining: bump mobile to `2.1.0-30`, open the PR, runtime-QA the cross-platform pill, then merge.

---
*Created: 2026-06-14*
*Last updated: 2026-06-15*
