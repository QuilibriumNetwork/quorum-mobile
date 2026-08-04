---
type: task
title: "Channel icon picker polish — filled→outline rendering, washed-out color swatches, icon-set revision"
status: open
created: 2026-06-26
branch: fix/channel-icon-picker-polish
---

# Channel icon picker polish

Three distinct problems surfaced while testing `ChannelIconPickerSheet.tsx`
(opened from Space Settings → channel/group icon). Tracked together; fixes split
by where they live.

## 1. "Filled" tab renders some icons as OUTLINE (mobile bug)

**Where:** mobile `components/ui/IconSymbol.tsx` resolver — NOT shared.
Shared's `FILLED_ICONS` (in `quorum-shared/src/primitives/Icon/pickerVocabulary.ts`)
correctly lists icons that DO have a `*Filled` form in Tabler. The bug is mobile
failing to resolve the filled component.

EXACT causes found (mobile `components/ui/IconSymbol.tsx` + `tablerIconRegistry.ts`):
1. `'lock': tabler('IconLock')` — missing `.filled` arg → fix to
   `tabler('IconLock', 'IconLockFilled')`. (Added on the signing branch.)
2. `'flask': tabler('IconFlask')` — same → `tabler('IconFlask', 'IconFlaskFilled')`.
3. `IconHeadphonesFilled` NOT imported in `tablerIconRegistry.ts` → `headset`
   (→ IconHeadphones) can't find its filled form. Add the import/export.

Resolution order in IconSymbol: step-1 `SF_TO_TABLER[name]` (returns base when
`.filled` absent), else step-2 `Icon${pascalCase(name)}` + `${...}Filled` from the
registry. So an SF entry without `.filled` SHADOWS a registry filled that exists.

NOT a shared bug — shared's `FILLED_ICONS` is correct (every listed `*Filled`
physically exists in Tabler, verified). Desktop's web `Icon` resolves these fine
via `iconMapping.ts` + `${base}Filled`.

**Fix:** the 3 items above. Then re-audit all `FILLED_ICONS` names through mobile's
resolver to catch any other SF entry missing `.filled` or registry gap.

## 2. Color swatches render washed-out / pale (NEEDS LIVE DIAGNOSIS)

**Where:** unknown yet. NOT the shared data — `ICON_COLORS` hexes are vivid and
correct (`blue #3b82f6`, `red #ef4444`, etc.) and `getIconColorHex` returns them
straight. The swatch is `backgroundColor: hex` with NO opacity/overlay in
`ChannelIconPickerSheet.tsx`. Yet on-device the swatches look like pale pastels.

Prime suspect: the **active skin** tinting `SkinTouchable`, or a render quirk.
Diagnose on-device before changing anything. Do NOT change the shared hexes.

## 3. Icon SET needs revision (SHARED — lead's call)

**Where:** `quorum-shared/src/primitives/Icon/pickerVocabulary.ts` → `ICON_OPTIONS`
(+ `FILLED_ICONS`). Affects desktop too. Follow shared→desktop→mobile order.
This is curation/design — draft a proposal, don't unilaterally edit shared.

Confirmed by user: **desktop has the same icon-SET issues** (the set is shared, so
both apps show them). Fix belongs in shared, follows shared→desktop→mobile.

**IMPORTANT — mobile consumption:** mobile pins shared as an npm version; it only
sees these set changes after shared is **published + mobile bumps the version**.
Desktop (links shared locally) sees them immediately. So the set fixes auto-apply
on mobile ONLY after the bump — no mobile code change needed for the set itself.

### Consolidated change list (shared `pickerVocabulary.ts` + `iconMapping.ts`)

All derived from user screenshots/flags 2026-06-26:

1. **SWAP `hand-peace` → `IconHandLoveYou`.** Currently mis-mapped and inconsistent
   across apps: shared `iconMapping.ts:129` `'hand-peace': 'IconHandStop'` (a STOP
   hand); mobile `IconSymbol.tsx:334` `'hand-peace': tabler('IconHandTwoFingers')`.
   Neither is the intended friendly/love hand. **Keep the stored key `hand-peace`**
   (don't orphan saved channels), just repoint the mapping to `IconHandLoveYou` in
   BOTH shared `iconMapping.ts` and mobile `IconSymbol.tsx`. (`IconHandLoveYou` has
   NO filled variant — fine, hand-peace isn't in FILLED_ICONS. Verify desktop's
   Tabler version has IconHandLoveYou before landing the shared change.)
2. **REMOVE one of the duplicate smiles.** `smile` (cat "Fun") and `mood-happy`
   (cat "Mood") render as two near-identical grinning faces side by side. Drop one
   from `ICON_OPTIONS` (and from `FILLED_ICONS` if the dropped one is listed).
   Recommend keeping `smile`, dropping `mood-happy` (or per design preference).
3. **`stack` was a MOBILE bug, not a set change.** Shared already maps
   `stack: 'IconStack2'` (correct). Mobile had NO `'stack'` entry, so it fell
   through to `IconStack` (single layer) instead of `IconStack2` (layers).
   FIXED on this branch: added `'stack': tabler('IconStack2','IconStack2Filled')`.

### ADD new icons (user request 2026-06-26 — "add a few more")
For each: need semantic name + Tabler component. Add to shared `ICON_OPTIONS`
(+ `FILLED_ICONS` if it has a filled form) and `iconMapping.ts`; ensure mobile's
`IconSymbol`/registry can render the name (registry import + mapping if step-2's
`Icon${PascalCase(name)}` doesn't already match). PENDING the user's list.

(Re-confirm exact set with the user before the shared PR; add any further flags.)

### NOT a set change (mobile rendering — already handled on this branch)
- lock / calendar / flask appearing OUTLINE in the Filled tab = mobile resolver bug.
  Fixed `'lock'` and `'flask'` SF_TO_TABLER entries to include `.filled`. (calendar-alt
  already had it; verify on-device which, if any, still render outline.)

## Order of work
1. Fix #1 (filled→outline) — mobile-only, do now.
2. Diagnose #2 (swatches) on-device.
3. Draft #3 (icon-set revision) as a proposal for the lead; don't edit shared directly.

*Last updated: 2026-06-26*
