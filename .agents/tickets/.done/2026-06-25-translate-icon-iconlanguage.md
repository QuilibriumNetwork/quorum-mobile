---
type: task
title: "Swap Translate action icon to IconLanguage (add to quorum-shared first, then mobile)"
status: done
created: 2026-06-25
source: MessageActionSheet UI pass (2026-06-25)
priority: low
effort: tiny (one icon mapping entry in shared, one icon name swap in mobile)
---

> **DONE — verified in code 2026-08-03.** All three steps landed and nobody closed the file. quorum-shared `2.1.0-39` maps `language: "IconLanguage"`; mobile `IconSymbol.tsx:167` has `'language': tabler('IconLanguage')`; and `MessageActionSheet.tsx:280` renders `<ActionRow icon="language" label="Translate" />`. The "blocked on a future shared publish" note below is stale — RECAP.md already recorded the unblock on 2026-07-27.


# Translate action → IconLanguage

The message action sheet's **Translate** row currently uses `globe`
(`IconWorld`). Lead wants the Tabler **`IconLanguage`** glyph instead.

> **⚠️ "after 2.1.0-34" was a MISLABEL (corrected 2026-07-16).** An earlier note said
> "swap to IconLanguage after quorum-shared -34". That assumed `IconLanguage` would
> land in the `2.1.0-34` publish — it did NOT. Verified 2026-07-16 against the real
> shared repo: `IconLanguage` appears NOWHERE in `quorum-shared/src`, shared's HEAD is
> `397d252` and its `package.json` version is exactly `2.1.0-34` (HEAD == published,
> nothing newer pending). `2.1.0-34` unblocked image-config / message-preprocessing /
> date-formatters — all UNRELATED symbols. This icon was wrongly lumped under the same
> gate. It is blocked on a **future, not-yet-existing** shared publish.
>
> **Why shared-first (not mobile-local), decided with user 2026-07-16:** mobile *could*
> technically add `'language': tabler('IconLanguage')` to its own `IconSymbol.tsx`
> `SF_TO_TABLER` map and regen `tablerIconRegistry.ts` (the icon renders app-chrome via
> mobile's own map — `IconLanguage` IS in mobile's `@tabler/icons-react-native` dep).
> But we keep the shared-first discipline so **desktop and mobile show the same glyph**
> and the change lives in one source of truth. Do NOT lead from mobile here.

`IconLanguage` is NOT in quorum-shared's icon mapping today. Shared has only
`globe → IconWorld`, `globe-search → IconWorldSearch`, `world-map → IconWorldMap`
(`quorum-shared/src/primitives/Icon/iconMapping.ts:260-262`), and mobile's
`IconSymbol` mirrors that. So this needs a new wire-agnostic icon name.

## Steps (canonical order: shared first)

1. **quorum-shared** — add a mapping entry in
   `src/primitives/Icon/iconMapping.ts` (e.g. `language: 'IconLanguage'`).
   Commit directly to shared main (lead's call, 2026-06-25) and publish.
2. **quorum-mobile** — add the same name to `components/ui/IconSymbol.tsx`
   (`'language': tabler('IconLanguage')`) and change the Translate row in
   `components/Chat/MessageActionSheet.tsx` from `icon="globe"` to
   `icon="language"`.

Until shared publishes, mobile keeps `globe` for Translate — shipped that way in
the `feat/dm-mute-native-suppress-and-edit-history` branch on purpose (don't
block the branch on a shared publish).

## Unblocked 2026-07-27

Mobile bumped `@quilibrium/quorum-shared` to `2.1.0-37`; verified
`language: 'IconLanguage'` is present in the installed
`src/primitives/Icon/iconMapping.ts` (and reachable from the built dist). Step 1
(shared) is done. Only step 2 remains: mobile's `IconSymbol.tsx` `SF_TO_TABLER`
map + the `MessageActionSheet.tsx` icon-name swap.

*Last updated: 2026-07-27 — confirmed IconLanguage present in published 2.1.0-37; task unblocked, only the mobile-side icon swap (step 2) remains.*
