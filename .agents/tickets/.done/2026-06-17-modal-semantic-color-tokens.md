---
type: task
title: "Modal semantic color tokens + contrast regression fix"
status: done
created: 2026-06-17
---

# Modal semantic color tokens + contrast regression fix

**Status:** Not started — audit complete, ready to implement on a fresh branch.
**Type:** `style:` (UI/visual polish — color contrast + theme-token plumbing).
**Do NOT implement on `feat/segmented-pills-primitive`.** Start a clean branch off `master`.

---

## Why

Commit `2ee35d8` ("User profile modal improvements", #91, 2026-06-14) raised the bottom-sheet
modal background in `components/shared/BaseModal.tsx:193` from `theme.colors.background`
(near-black `#100f11` in dark) to `theme.colors.surface1` (`#241f27` dark / `#f6f6f9` light), so
modals read as floating panels instead of blending into the backdrop. The palette in
`theme/colors.ts` did NOT change — only which token the sheet points at.

Side effect: elements **inside** modals (cancel/secondary buttons, field/input borders, dividers,
option cards) were tuned to look right against the OLD near-black background. On the lighter
`surface1` they lose contrast. The same commit already fixed ONE instance of this (the add-role
pill border: `surface4` → `border`/`surface6`) and its message documents the rule:

> "surface4 (a surface tone) as its border color ... washes out against the lighter modal surface.
> Switch to the border token (surface6), which is meant for borders."

This task applies that fix everywhere else, AND adds role-named semantic tokens so the regression
can't recur (mirrors the desktop app's approach — see below).

User's framing: "we created semantic classes named after the element they color (modal background,
modal field border) so when we change a color we change the semantic class and everything follows."
On mobile there are no CSS classes; the `theme.colors.*` token object IS the semantic layer. The gap
is that today's tokens are scale-based (`surface1..10`) and components pick greys by eye. We add
role-based tokens on top.

---

## Two layers

### Layer 1 — Add semantic tokens (the structural fix)

Add role-named tokens to the `colors` object in `theme/themes.ts`, mapping to surface steps via the
existing `pick()`/`surf()` helpers so they stay skin- and light/dark-aware. **Mirror desktop names
verbatim** (decision: "Match desktop naming").

Desktop defines these as CSS custom properties in
`quorum-desktop/src/styles/_colors.scss`, aliased to Tailwind in `quorum-desktop/tailwind.config.js`.
Desktop naming convention: `--color-{property}-{element}[-{state}]` (`bg`/`border`/`text`/`field`).
Field tokens intentionally namespace under `field` (`--color-field-bg`, not `--color-bg-field`).

| Mobile token (proposed) | Desktop source token | → surface step | Dark hex | Light hex | Element |
|---|---|---|---|---|---|
| `bgModal` | `--color-bg-modal` | `surface2` | `#2c252e` | `#eeeef3` | Modal/sheet background |
| `bgModalSidebar` | `--color-bg-modal-sidebar` | `surface1` | `#241f27` | `#f6f6f9` | Lighter sidebar panel in complex modals |
| `fieldBg` | `--color-field-bg` | `surface0` | `#1d1a21` | `#fafafd`* | Field/input fill (default) |
| `fieldBgFocus` | `--color-field-bg-focus` | `surface1` | `#241f27` | `#f6f6f9` | Field fill on focus |
| `fieldBorder` | `--color-field-border` | `surface5` | `#443b49` | `#d5d5db` | Field/input border (default) |
| `fieldBorderHover` | `--color-field-border-hover` | `surface6` | `#584d5e` | `#cdccd3` | Field border hover |
| `fieldBorderFocus` | `--color-field-border-focus` | `accent` | accent | accent | Field border focus |
| `borderDefault` | `--color-border-default` | `surface5` | `#443b49` | `#d5d5db` | Default dividers/borders |
| `borderSubtle` | `--color-border-subtle` | `surface4` | `#3a313f` | `#dedee3` | Subtle edge |
| `borderStrong` | `--color-border-strong` | `surface6` | `#584d5e` | `#cdccd3` | Strong border (modal section headers) |

\* Mobile light `surface0` = `#fefeff` (desktop uses `#fafafd` for `--surface-0`). Minor palette
drift between repos — keep mobile's own surface values, only mirror the NAMES and the
step-to-role mapping.

Notes / decisions to make during implementation:
- Mobile already exposes a `border` token (= `surface6`) in `themes.ts`. Desktop's
  `--color-border-default` maps to `surface5`, `--color-border-strong` to `surface6`. Reconcile:
  either keep mobile's existing `border` (surface6) as the canonical "strong" border and add
  `borderDefault` (surface5) / `borderSubtle` (surface4), OR realign. **Recommend: keep `border`
  as-is to avoid churning existing call sites, add the new named tokens alongside.**
- Cancel/secondary buttons: desktop uses CSS classes (`.btn-subtle` = `surface7`, `.btn-secondary`
  = accent-tint @ 0.3), NOT a `--color-*` var, so there's no name to mirror. For mobile, add an
  explicit `bgButtonSubtle` token (suggest `surface4` — see Layer 2 for why surface3 is too shallow)
  rather than leaving cancel buttons to pick a grey by eye. This is a mobile-only addition; document
  it as such.
- Update the `createTheme` return type (the inline `colors: {...}` type literal in `themes.ts`,
  ~lines 29-54) to include the new token names so TS autocompletes them.

### Layer 2 — Migrate broken in-modal elements onto the right tokens (the bug fix)

Audit results below. **22 files affected.** Two fix categories:

**Mechanical** (border = a fill tone → use `border`/`surface6`; no design judgment):
- `ReportModal.tsx:245,254` — `borderColor: surface3` → `border`
- `ComposeChannelPickerModal.tsx:184` — `borderColor: surface3` → `border`
- `CreateSpaceSheet.tsx:293,319,345,383,406,415` — `borderColor: surface3` → `border`
- `UnifiedProfileEditModal.tsx:363` — `borderColor: surface3` → `border`
- `HypersnapSignerPromptModal.tsx:113` — `borderColor: surface3` → `border`
- `SpaceSettingsModal.tsx:2650` — divider `backgroundColor: surface4` → `border`
- `SpaceSettingsModal.tsx:2743,2771` — `borderColor/borderTopColor: surface4/surface5` → `border`
- All QNS modal inputs that have NO `borderColor` — add `borderColor: border`

**Judgment call** (choose the right surface STEP — depends on card vs button vs field):
- Cancel/secondary button `backgroundColor: surface3 → surface4` (one step up; verify label text
  still contrasts — `textMain` on `surface4` is fine).
- `UnifiedProfileEditModal.tsx:387` — secondary button `surface2 → surface3`/`surface4`.
- `SpaceSettingsModal.tsx:2514` — bordeless input container `surface3 → surface4`.
- `SpaceSettingsModal.tsx:1512,1536` — Account-tab bare inputs: raise bg to `surface3` AND add
  `borderColor: border` (biggest miss — surface2 input on surface1 sheet, no border).
- `WalletModal.tsx` / `SendModal.tsx` info-card bg (`surface2`, no border) — high-stakes UX;
  ADD `borderColor: border` rather than raising bg, to keep the card-lighter-than-border hierarchy.
- `ProfileModal.tsx:3021` — QNS search widget (`surface2` row + `surface3` button); raise both one step.

Once Layer 1 tokens exist, prefer migrating these call sites to the NAMED tokens
(`fieldBorder`, `bgButtonSubtle`, etc.) rather than to raw `surface6` — that's the whole point of
the structural fix.

---

## Full audit table (read-only; line numbers as of 2026-06-17)

| File:line | Element | Current | Problem | Suggested |
|---|---|---|---|---|
| `shared/ConfirmDialog.tsx:107` | Cancel button bg | `surface3` | 2 steps above sheet; near-invisible light | `surface4`/`bgButtonSubtle` |
| `shared/TypeToConfirmModal.tsx:208` | Cancel button bg | `surface3` | on surface1 card; tiny ΔE dark | `surface4` |
| `shared/TypeToConfirmModal.tsx:153` | Stats block bg | `surface3` | no boundary on surface1 (light) | `surface4` |
| `shared/TypeToConfirmModal.tsx:220` | Disabled confirm bg | `surface4` | washes out light | `surface5` |
| `KickUserModal.tsx:226` | Cancel button bg | `surface4` | marginal light | `surface5` |
| `KickUserModal.tsx:180` | User info card bg | `surface3` | barely distinct light | `surface4` |
| `SpaceModal.tsx:614` | Cancel button bg | `surface3` | on BaseModal surface1 | `surface4` |
| `NewConversationModal.tsx:407` | Cancel button bg | `surface3` | on surface1 sheet | `surface4` |
| `TransactionWarningModal.tsx:263` | Cancel button bg | `surface3` | wallet cancel; 1 step dark | `surface4` |
| `ReportModal.tsx:245-246` | Reason row border+bg | `surface3`/`surface2` | border == card bg step | border→`border`; bg→`surface3` |
| `ReportModal.tsx:254-260` | Free-text input border+bg | `surface3`/`surface2` | input border invisible | border→`border`; bg→`surface3` |
| `ReportModal.tsx:279` | Cancel button bg | `surface3` | on surface1 | `surface4` |
| `HypersnapSignerPromptModal.tsx:113` | Option card border | `surface3` | tap affordance vanishes light | `border` |
| `HypersnapSignerPromptModal.tsx:91,132,140` | Icon well bg | `surface2` | 1 step; cosmetic | `surface3` |
| `ComposeChannelPickerModal.tsx:184` | Search row border | `surface3` | invisible both modes | `border` |
| `ComposeChannelPickerModal.tsx:218` | Avatar placeholder bg | `surface3` | low priority | `surface4` |
| `CreateSpaceSheet.tsx:293,319,345,383,406,415` | Field borders | `surface3` | border == bg step (invisible) | `border` |
| `CreateSpaceSheet.tsx:292,318,382,405` | Field bg | `surface2` | 1 step on sheet | `surface3` |
| `UnifiedProfileEditModal.tsx:363` | Input border | `surface3` | == sheet token (invisible) | `border` |
| `UnifiedProfileEditModal.tsx:387` | Secondary button bg | `surface2` | 1 step (invisible) | `surface3`/`surface4` |
| `SpaceSettingsModal.tsx:2514` | inputContainer bg | `surface3` | no border; marginal light | `surface4` |
| `SpaceSettingsModal.tsx:2554,2595` | imagePicker / toggleRow bg | `surface3` | 2 steps | `surface4` |
| `SpaceSettingsModal.tsx:2650` | divider | `surface4` | borderline light | `border` |
| `SpaceSettingsModal.tsx:2771` | permissionCheckbox border | `surface5` | 1 step on surface4 card | `border` |
| `SpaceSettingsModal.tsx:2743` | rolePermissions header divider | `surface4` | thin separator | `border` |
| `SpaceSettingsModal.tsx:1512,1536` | Account-tab input bg | `surface2` | 1 step, no border | `surface3` + `borderColor: border` |
| `InviteModal.tsx:368,444,470` | toggle / linkContainer / actionButton bg | `surface3` | segmented control too shallow | `surface4` |
| `ProfileModal.tsx:3021,3037` | QNS search container / button | `surface2`/`surface3` | invisible row light | `surface3`/`surface4` |
| `ProfileModal.tsx:3392` | farcasterCancelButton bg | `surface3` | on surface1 | `surface4` |
| `qns/CreateAuctionModal.tsx:286,313,332,354` | input/card bg | `surface2` | no border, invisible light | add `borderColor: border` |
| `qns/MakeOfferModal.tsx:248,275,294,316` | input/card bg | `surface2` | same | add `borderColor: border` |
| `qns/BuyNameModal.tsx`, `RegisterPaymentModal.tsx`, `NameDetailModal.tsx` | input/card bg | `surface2` | same pattern (verify lines) | add `borderColor: border` |
| `WalletModal.tsx:1321,1350,1380,1642,1751,1807,1835` | info cards / asset rows | `surface2` | no border, no step light | add `borderColor: border` |
| `wallet/SendModal.tsx:852,892,908,946` | asset selector / inputs | `surface2` | no border on sheet | `surface3` or add `borderColor: border` |

### Worst 5 (user will notice most)
1. `ReportModal.tsx` — cancel + reason-row borders + free-text border all fail at once; input border literally equals its container bg.
2. `HypersnapSignerPromptModal.tsx:113` — option card border is the only tap affordance; gone in light.
3. `UnifiedProfileEditModal.tsx:363,387` — invisible input border + 1-step secondary button.
4. `CreateSpaceSheet.tsx` — every form input border invisible (same step as bg).
5. `ConfirmDialog.tsx` + `TypeToConfirmModal.tsx:208` — the app-wide Cancel button in every destructive flow; ~3% luminance delta in light (borderline WCAG fail for UI boundaries).

### Files checked, NO issue
- `shared/ActionSheet.tsx` — overrides sheet to `surface0` (darker base); fine.
- `UserProfileModal.tsx` — already uses `border` token for add-role dashed border (the original fix).
- `Chat/ChannelSettingsSheet.tsx` — `renameRow` surface2 low-severity; Switch trackColor is system-rendered.

### Needs investigation (don't guess)
- `ShareInviteSheet.tsx:287,292` — sheet bg may be `background` (near-black), not `surface1`; the
  footer `borderTopColor: surface3` might have the OPPOSITE problem (too dark). Verify the sheet bg first.
- `Chat/MessageActionSheet.tsx:327,341` — renders its OWN sheet (not BaseModal); handle uses
  `border ?? surface3`. Confirm its actual background before changing.

---

## Acceptance / verification
- [ ] New semantic tokens compile (TS) and are exposed on `theme.colors`.
- [ ] Mechanical border fixes applied; judgment-call steps chosen and applied.
- [ ] Visually verify in BOTH light and dark, on a real device/build, at minimum: ReportModal,
      ConfirmDialog/TypeToConfirmModal cancel, CreateSpaceSheet inputs, UnifiedProfileEditModal,
      a wallet modal (SendModal). Light mode is where most of these fail hardest.
- [ ] `npx tsc --noEmit` clean.

## References
- Trigger commit: `2ee35d8` (modal bg → surface1; add-role border fix is the canonical pattern).
- Modal bg site: `components/shared/BaseModal.tsx:193`.
- Token defs: `theme/themes.ts` (colors object ~L117-154; return type ~L29-54), `theme/colors.ts`.
- Desktop semantic tokens: `quorum-desktop/src/styles/_colors.scss`, `quorum-desktop/tailwind.config.js`,
  button variants in `quorum-desktop/src/components/primitives/Button/Button.scss`.

*Last updated: 2026-06-17*
