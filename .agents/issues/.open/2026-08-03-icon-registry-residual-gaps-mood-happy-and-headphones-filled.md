---
type: bug
title: "Icon registry residual gaps: one blank picker cell (mood-happy) and headphones has no filled variant"
status: open
priority: low
created: 2026-08-03
severity: low (two cosmetic gaps in the channel/group icon picker — one blank cell, one icon that ignores the Filled tab)
repos: quorum-mobile only
source: split out of .deferred/2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md during the 2026-08-03 issues audit, after verifying 23 of its 24 reported blanks were already fixed
related:
  - ".deferred/2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md (parent — deferred by decision; this is the standalone remainder it warned not to skip)"
  - ".open/2026-06-26-channel-icon-picker-polish.md (defect 1 item 3 is the headphones half of this file)"
---

# Two icons left in the registry gap

The 2026-06-20 regression reported **24 blank cells** in the channel/group icon
picker, caused by `scripts/gen-tabler-registry.mjs` only scraping `IconXxx` tokens
that appear literally in `IconSymbol.tsx` — so picker options resolved through the
runtime PascalCase fallback were never emitted into the registry.

**Verified 2026-08-03: 23 of those 24 are fixed.** The registry has grown from 209
to 278 imports and now carries `IconRobot`, `IconLeaf`, `IconPalette`, `IconHeadset`
and the rest. Two gaps survive.

## 1. `mood-happy` still renders blank

`IconMoodHappy` is the one name from the original 24 that is still absent from
[tablerIconRegistry.ts](../../components/ui/tablerIconRegistry.ts).

It is a live picker option, not a dead name:

- `node_modules/@quilibrium/quorum-shared/dist/index.js:1898` lists `"mood-happy"`
  in `ICON_OPTIONS`
- `:7243` maps it to `"IconMoodHappy"`
- the component exists in the installed `@tabler/icons-react-native`

So the picker offers the cell, `resolveTablerComponent` returns null, and the cell
draws empty.

**Fix:** add the import/export to the registry (or add `'mood-happy'` to
`SF_TO_TABLER` in `IconSymbol.tsx` and regenerate, which is what keeps the
generator honest for next time).

## 2. `headphones` ignores the Filled tab

[IconSymbol.tsx:226](../../components/ui/IconSymbol.tsx#L226) is still:

```ts
'headphones': tabler('IconHeadphones'),
```

No `.filled` argument, and `IconHeadphonesFilled` appears **zero** times in the
registry. Because an `SF_TO_TABLER` entry without `.filled` **shadows** a registry
filled form that would otherwise be found by step 2 of the resolver, this icon
renders as an outline even on the Filled tab.

This is item 3 of defect 1 in
[channel-icon-picker-polish](2026-06-26-channel-icon-picker-polish.md). Its two
siblings are already fixed — `'lock'` and `'flask'` both pass filled arguments now
([IconSymbol.tsx:60](../../components/ui/IconSymbol.tsx#L60),
[:143](../../components/ui/IconSymbol.tsx#L143)). Only headphones was missed.

**Fix:** `tabler('IconHeadphones', 'IconHeadphonesFilled')` plus the registry import.

## Worth doing at the same time

The generator scraping only literal source tokens is the root cause of both, and it
will silently reopen every time a picker option is added upstream in quorum-shared.
Having `gen-tabler-registry.mjs` also read shared's `ICON_OPTIONS` would close the
class rather than the two instances. That is a slightly larger change than the two
one-liners above, so it is noted, not required.

## Not blocked by the deferred migration

The parent task is parked by an explicit decision ("do nothing on mobile" until the
skins-to-desktop Phase 4 moves icon resolution into shared). That decision does not
cover this: the registry has to contain every icon the picker can offer for as long
as the registry exists at all. Both fixes are one-liners plus a regenerate, with no
call-site sweep.

---
*Last updated: 2026-08-03*
