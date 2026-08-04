---
type: task
title: "Share the emoji-picker data layer across desktop + mobile (mobile keeps native emoji)"
status: open
created: 2026-06-19
priority: medium
scope: cross-repo (quorum-shared + quorum-desktop + quorum-mobile)
needs: lead-dev decision (see "Question for the lead")
related-docs:
  - ../../../quorum-desktop/.agents/docs/features/messages/custom-emoji-picker.md
  - ../../../quorum-desktop/.agents/reports/.archived/emoji-picker-library-comparison_2026-02-24.md
---

# Share the emoji-picker data layer across desktop + mobile

## TL;DR

Desktop and mobile both have **custom, from-scratch** emoji pickers (no third-party
picker lib on either side — desktop dropped `emoji-picker-react` on 2026-04-14). But
they were built to very different standards, and they share **zero** code today.

The valuable half of desktop's picker — the **data layer** — is pure, DOM-free
TypeScript. It can move into `quorum-shared` and be consumed by both apps. **Mobile
keeps rendering native OS emoji** (no Twemoji, no sprite sheet, no image assets); only
the *data* (which emoji exist, their order, categories, search terms) is shared.

This retires mobile's two hand-maintained lists and gives it the full emoji set +
complete search coverage + (optionally) skin tones, for free.

## Why now / what's wrong with mobile today

Mobile's picker (`components/Chat/EmojiPicker.tsx` + `data/emojiData.ts`) is the less
mature implementation:

- **Hardcoded ~700 emoji.** `EMOJI_CATEGORIES` in `EmojiPicker.tsx` is a hand-typed
  array of ~700 emoji. Desktop drives ~1,900 from the `emoji-datasource-twitter` JSON.
- **Two parallel hand-maintained lists that drift.** The shown set
  (`EMOJI_CATEGORIES`) and the searchable set (`EMOJI_KEYWORDS`, ~370 entries in
  `data/emojiData.ts`) are maintained by hand and are already out of sync:
  - Many grid emoji (most flags, lots of objects) have **no keywords**, so they're
    invisible to search.
  - `EMOJI_KEYWORDS` lists emoji (`🌙 ☀️ 🌈` …) that aren't in any category array, so
    those keywords match nothing.
- **No virtualization.** The grid is a `ScrollView` + `.map()` of live
  `TouchableOpacity` nodes — every emoji in the category is a mounted node. This is the
  likely root of the deferred emoji-panel open-lag
  (`.agents/issues/.done/2026-06-16-emoji-panel-open-lag.md`).
- **No skin tones.**

## The clean architectural seam

Desktop's picker already splits cleanly into a **data layer** (shareable) and a
**render layer** (web-only). Only the data layer moves.

| Layer | Files (desktop) | Shareable? |
|---|---|---|
| **Data** | `src/components/emoji-picker/emojiData.ts`, the data-only parts of `types.ts` | **Yes — pure TS, no DOM, no RN** |
| **Render** | `EmojiSprite.tsx`, `EmojiPicker.tsx`, `EmojiPicker.scss` (CSS `background-position`, `react-virtuoso`, `<div>`) | **No — web-only, stays on desktop** |

```
quorum-shared  (new: src/emoji/)
  ├─ emojiData.ts   ← buildEmojiIndex, buildRowData, buildSearchRows, searchEmojis,
  │                    unifiedToEmoji   (lifted from desktop — already DOM-free)
  └─ types.ts       ← EmojiItem, VirtualRow, CustomEmoji, EMOJI_CATEGORIES
        │              + per-category metadata { id, canonicalName, iconName }
        │              (NOT SPRITE_SHEET — web render concern; category icons come from
        │               the shared Icon primitive, not emoji glyphs — see below)
        │
        ├───────────────────────────────┬───────────────────────────────
        ▼                               ▼
  desktop EmojiPicker.tsx         mobile EmojiPicker.tsx
  renders VirtualRow[] via        renders the SAME VirtualRow[] via
  react-virtuoso + CSS sprite     FlashList + <Text>{unifiedToEmoji(item.unified)}</Text>
  (Twemoji images)                (NATIVE emoji — the glyph from the OS font)
  + Tabler category strip         + Tabler category strip
    (shared <Icon>)                 (shared <Icon>, above the search field)
```

**One shared categorized builder, both apps.** Both consume the same `buildRowData(...)`
(headers + emoji rows). Mobile keeps categories (Telegram-style — see Mobile interaction),
so there is **no separate flat builder**. They differ only in chrome: desktop = scroll-spy
category tabs; mobile = thin jump-strip over one continuous scroll. **What** emoji exist /
order / category / search terms is shared. **How to navigate and draw** stays per-platform.

**Native emoji on mobile is already supported by the shared code:** desktop's data
layer exports `unifiedToEmoji('1f600') → '😀'`
(`quorum-desktop/src/components/emoji-picker/emojiData.ts`). Mobile renders that string
in `<Text>`. No image assets ship to mobile.

## Question for the lead (sent on Telegram 2026-06-19 — awaiting reply)

Per Atlas §3 ("Don't decide for the lead") — the mobile picker is the lead's territory.
Asked:

1. **Was the ~700-emoji hardcoded set a deliberate design decision?** (curated subset,
   or a bundle-size choice) — or just the quickest way to ship at the time?
2. **OK to share the `emoji-datasource-twitter` dataset + picker data-logic between
   desktop and mobile** (mobile keeping native emoji, not Twemoji)?
3. Flagged the strip-script approach below (trim unused fields + optional per-app subset).

Don't start Phase 2 (mobile) until they reply. Phase 1 (shared + desktop) is additive and
safe to pursue regardless (Atlas §3), but courteous to wait for the nod on direction.

## Decision: dataset via strip script (RESOLVED — was A/B/C, now B with a filter knob)

`emoji-datasource-twitter/emoji.json` is **~1.3 MB** — but that's not because there are
~1,900 emoji, it's because each emoji carries ~25 fields the picker never uses (legacy
carrier codes `docomo`/`au`/`softbank`, `has_img_apple`/`google`/`facebook`, sprite
coords, `added_in`, `obsoletes`, …). The picker needs only ~6: `unified`, `name`,
`short_names`, `category`, `sort_order`, `skin_variations`.

**Approach: a small strip script in `quorum-shared` (build-time).** It reads the upstream
`emoji.json` (which lives in `node_modules`, **never ships**), keeps the ~6 fields for all
emoji, writes a lean JSON (~200-400 KB est.). *That* lean file is what bundles into each
app. The upstream package stays the source of truth (correct codepoints, skin-tone
variants, yearly Unicode updates); the script is our curation layer; the output is "our"
file in every way that matters (size, shape, contents) without us hand-maintaining emoji
data.

**Why not hand-author our own JSON?** Because emoji data is a moving, spec-defined target
(multi-codepoint ZWJ sequences, flags, combinatorial skin-tone variants, yearly Unicode
releases). Hand-authoring = owning all of that forever, and re-doing it every Unicode
release. That's *exactly the trap mobile is in now* (the drifting ~700 list + hand-typed
keyword map). Deriving from the package avoids the treadmill. (`emoji-datasource-twitter`
is MIT — confirm at build, but the comparison report already notes MIT, so bundling
derived data is clean.)

**Two independent knobs in the same script:**
- **Field filter (always on):** drop the ~25 unused columns → this is what makes it lean.
- **Emoji filter (optional, default = ALL):** keep every emoji, OR cut to a curated
  subset. **This is the lead's dial — now or later, zero rework.** Build Phase 1 with it
  wide open (full set); if mobile's later bundle measurement says "trim," flip the knob.
  - Can be **per-app**: ship desktop the full set, mobile a subset, from one script + one
    source of truth.
  - Preferred curation style = a **predicate** (e.g. by category, or `added_in <= Unicode
    14`) — self-maintaining, one line. Explicit allowlist is the fallback for truly
    hand-picked control.

So this is no longer "A or B or C": **the strip script is the architecture; emoji
selection is a config knob inside it defaulting to "all."** Decision deferred at zero cost
until the lead wants to turn it.

## Mobile interaction (RESOLVED): keep categories — Tabler-icon jump-strip above search

Matches **Telegram mobile** (verified: it *does* keep a thin category strip at the top —
earlier "Discord/Telegram drop categories" was wrong). Layout, top to bottom:

- a **category strip** of **Tabler icons** (from the shared `Icon` primitive, NOT emoji
  glyphs), **above** the search field,
- a **search field**,
- **one continuous virtualized scroll** of categorized rows (the shared `buildRowData`
  output) with recents/frequent as the first category.

The strip is a **jump-strip, not tab-swap**: tapping an icon scrolls the one continuous
`FlashList` to that category's header index; you can also just keep scrolling through
everything. Active-icon highlight tracks scroll position (same idea as desktop's
`rangeChanged` scroll-spy). This **replaces today's tab-swap** (`SegmentedPills` that
*replace* the grid) — the clunky part — while keeping browse-by-category.

**Category → shared icon** (recents is its own category = clock):

| Category | `IconName` | Tabler | In shared allowlist? |
|---|---|---|---|
| Recents / Frequently used | `clock` | `IconClock` | ✅ exists |
| Smileys & Emotion | `smile` | `IconMoodSmile` | ✅ exists |
| People & Body | `user` | `IconUser` | ✅ exists |
| Animals & Nature | `paw` | `IconPaw` | ✅ exists |
| Food & Drink | `burger` | `IconBurger` | ❌ **ADD** |
| Activities | `basketball` | `IconBallBasketball` | ❌ **ADD** |
| Travel & Places | `plane` | `IconPlane` | ✅ exists |
| Objects | `bulb` | `IconBulb` | ❌ **ADD** |
| Symbols | `heart` | `IconHeart` | ✅ exists |
| Flags | `flag` | `IconFlag` | ✅ exists |

**Shared additions needed: 3 icons** — `burger`, `basketball`, `bulb` — each a one-line
add in `Icon/types.ts` (the `IconName` union) + `Icon/iconMapping.ts` (→ `IconBurger` /
`IconBallBasketball` / `IconBulb`, all real Tabler icons). Purely additive (Atlas §3),
ship-alone, slots into Phase 1. Only the **outline** variant is needed (Icon default) —
no filled-variant work.

The shared `Icon` primitive is **already cross-platform** (`Icon.web.tsx` +
`Icon.native.tsx`), so `<Icon name="paw" />` renders on both apps — the category strip is
genuinely **shared chrome**, same icons both places.

**This also upgrades desktop:** desktop currently uses **emoji glyphs as category-tab
buttons**. Switch those to the same Tabler `<Icon>` strip, so desktop and mobile show the
**same icon for the same category**. Category identity + `iconName` live in shared metadata
(one source of truth); each app just renders the strip in its own layout.

**Dependency:** this rides on the shared `Icon` primitive — see the in-flight
[IconSymbol → shared Icon migration](../.deferred/2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md).

## Migration details already surfaced (save the next session time)

- **Category metadata lives in shared.** Each category carries
  `{ id, canonicalName, iconName }` — canonical Unicode name (`'Smileys & Emotion'`, …)
  for desktop section labels, plus the `iconName` (a shared `IconName`) for the icon strip
  both apps render. Both strips are **icon-only, no tooltips** (an emoji category strip is
  self-explanatory); accessibility via `aria-label` / `accessibilityLabel` off
  `canonicalName` only. Desktop still shows `canonicalName` as the in-list **section
  headers**; mobile shows no section labels.
- **`SPRITE_SHEET` stays on desktop** — web render concern (Twemoji sprite coords). The old
  desktop `CATEGORY_ICONS` (emoji-glyph category buttons) is **replaced** by the shared
  Tabler icon strip; mobile's old emoji-char `SegmentedPills` icons are likewise replaced.
- **Custom (space) emoji** already share the same shape conceptually
  (`{id, names[], imgUrl}` desktop / `{id, name, imgUrl}` mobile via the shared `Emoji`
  type). Reconcile to one `CustomEmoji` shape in shared.
- **Frecency / recents (RESOLVED): keep storage per-platform, but fix desktop too.**
  Mobile's `hooks/useEmojiFrecency.ts` + `services/emojiFrecency` is a *cleaner*
  single-source model than desktop's (desktop has two competing localStorage schemas —
  `emoji-picker-frequently-used` vs legacy `epr_suggested` — flagged as debt in its own
  doc). Storage backends differ (localStorage vs RN async storage) so the *store* stays
  per-platform; only the ordering/`buildRowData` plumbing is shared. **Decision:** while
  we're in here, **unify desktop's two-schema mess** onto a single schema (mirroring
  mobile's single-source approach). Scope it as a small desktop-local cleanup commit in
  Phase 1, not a blocker for the shared extraction.
- **Search (RESOLVED): best-of-both.** Shared `searchEmojis` adopts **mobile's
  prefix-index UX built over the dataset's `name + short_names`** — mobile's incremental
  prefix matching *and* desktop's full-dataset coverage. Retires mobile's hand-typed
  `EMOJI_KEYWORDS` map entirely. (Categories handle browse; search handles find-by-name.)
- **Skin tones (RESOLVED: IN scope for mobile).** Once on the dataset, skin-tone variants
  are free data (`skin_variations`). Add them to mobile — genuine UX win. **Structure as
  a separate commit within Phase 2**, *after* the core rewrite lands, because it adds
  surface area (tone-picker UI + persisted tone pref + a long-press gesture that collides
  with the fragile composer/keyboard/emoji-panel gesture tangle). Keeping it a distinct
  commit means a gesture bug can be reviewed/reverted in isolation without unwinding the
  picker rewrite (Atlas §6: one branch, separate commits).

## Shipping plan (respects Atlas cross-repo rules)

Split by risk. Atlas §3: shared changes here are **purely additive** (new `src/emoji/`
exports, nobody else imports them yet) → ship shared-alone, no coordination needed.

**Phase 1 — shared + desktop (low risk, statically + runtime verifiable on the platform we know best)**
1. Create `quorum-shared/src/emoji/` (`emojiData.ts` + `types.ts` + the strip script),
   lift desktop's data layer. Strip script: field-filter always on, emoji-filter knob
   defaulting to ALL. **One categorized `buildRowData`** (headers + emoji rows) consumed
   by both apps. Add **per-category metadata** `{ id, canonicalName, iconName }`. Shared
   `searchEmojis` = mobile's prefix index over dataset `name + short_names`. Export from
   shared's `index.ts`.
2. **Add 3 category icons to the shared `Icon` primitive** — `burger` → `IconBurger`,
   `basketball` → `IconBallBasketball`, `bulb` → `IconBulb` (one line each in
   `Icon/types.ts` + `Icon/iconMapping.ts`). Purely additive. (The other 7 category icons
   already exist: clock, smile, user, paw, plane, heart, flag.)
3. `npm run build` in shared (the build IS shared's safety gate — Atlas §3). Add unit
   tests: `buildRowData` returns sane rows + the strip output has only the kept fields +
   every category `iconName` is a valid `IconName`.
4. Refactor desktop's `EmojiPicker.tsx` to import the data layer from shared. **Swap
   desktop's emoji-glyph category tabs for the shared Tabler `<Icon>` strip** (using the
   category `iconName` metadata). **Also fold in the desktop recents-schema unification**
   (single schema, retire the legacy `epr_suggested` split) as its own commit. Smoke-test
   the desktop picker — proves the shared module + icon strip work at runtime.
5. Ship shared PR first, then desktop PR (Atlas §6: shared before desktop). Bump shared
   version on the shared ship.

**Phase 2 — mobile (higher bar, gated on shared publish + mobile bump)**
6. After shared is published, bump mobile's `@quilibrium/quorum-shared` pin (currently
   `2.1.0-32`).
7. **Core rewrite (commit 1):** rewrite mobile `components/Chat/EmojiPicker.tsx` to
   consume the shared categorized `buildRowData` — **Tabler category jump-strip above the
   search field** (shared `<Icon>` per category `iconName`), search field, then one
   continuous **virtualized** scroll (`FlashList` over the categorized rows) with native
   emoji via `<Text>{unifiedToEmoji(...)}</Text>`. Jump-strip scrolls to a category's
   header index; active icon tracks scroll position. **Replace the tab-swap**
   `SegmentedPills` UI. Delete the hardcoded `EMOJI_CATEGORIES` and the `EMOJI_KEYWORDS`
   map in `data/emojiData.ts`.
8. **Skin tones (commit 2, after core lands):** add the tone-picker UI + persisted tone
   preference, using the dataset's `skin_variations`. Separate commit so a gesture issue
   stays isolated (see skin-tones note above; watch the composer/keyboard/emoji-panel
   gesture tangle).
9. **Runtime test on Android** (the user tests Android-only). **iOS is review-only**
   (Atlas §3) — do an explicit iOS pass: native emoji render in `<Text>`, FlashList
   scroll perf + jump-strip scroll-to-index, keyboard/safe-area interaction with the
   composer panel (note the composer/keyboard/emoji-panel 3-owner glitch — don't change
   panel mount timing), and the skin-tone long-press gesture on iOS.
10. This also should close out / supersede the emoji-panel open-lag task
   (`.agents/issues/.done/2026-06-16-emoji-panel-open-lag.md`) — virtualization is the fix.

## What each repo gets

- **mobile:** full emoji set (or curated subset via the knob), complete search coverage,
  a cleaner **Tabler-icon category jump-strip over a continuous virtualized scroll**
  (replaces clunky tab-swap), fixes the open-lag, **skin tones**, zero hand-maintained
  emoji lists. Native emoji kept.
- **desktop:** data layer lives in shared; **category tabs upgraded from emoji glyphs to
  the shared Tabler icon strip**; **recents unified onto a single schema** (retires the
  `epr_suggested` debt) as part of this.
- **shared:** one source of truth for emoji metadata + per-category icon identity for the
  whole ecosystem; one categorized `buildRowData` both apps consume; 3 new category icons
  in the Icon primitive.

## Out of scope (explicitly)

- **Twemoji on mobile.** Not doing this — mobile keeps native OS emoji. iOS native emoji
  look great; only Android varies, and that's an accepted trade vs. shipping image
  assets to the RN bundle. (Separable future decision if ever wanted.)

## Already done ahead of this task (chrome only — issue #57)

The reaction picker's **chrome** was aligned to the composer's emoji panel in a
small UI-polish PR (branch `fix/reaction-picker-polish-dm-count-online-toggle`,
closes GitHub #57), independent of this data-layer work:

- Backdrop now fades independently while only the panel slides (was
  `animationType="slide"`, which dragged the grey backdrop up with the panel).
- Removed the two hairline divider borders (under the header, under the category
  band).
- Category strip restyled to the composer's continuous color band + floating
  active pill, using the shared `composerPanelBand` / `composerPanelBandActive`
  / `composerPillBg` tokens.

So Phase 2 here does **not** need to re-discover the styling — only the data-layer
swap (shared `buildRowData`, full dataset, delete the hardcoded `EMOJI_CATEGORIES`
+ `EMOJI_KEYWORDS`) and the virtualization + Tabler jump-strip rewrite. The
category-set divergence noted by the user (the reaction picker carries
People/Travel/Flags the composer lacks; lists differ) is intentionally left for
this task — it resolves as a side effect of moving both surfaces onto the one
shared dataset. A throwaway local `data/emojiCategories.ts` was started to unify
the two hardcoded lists, then discarded once this planned shared route was
recalled.

---

*Last updated: 2026-06-24*
