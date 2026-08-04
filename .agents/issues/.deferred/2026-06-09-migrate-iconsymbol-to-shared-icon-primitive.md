---
type: task
title: "Migrate mobile IconSymbol to shared Icon primitive"
status: deferred
created: 2026-06-09
updated: 2026-06-20
priority: low
related-bug: .agents/issues/.done/2026-06-09-iconsymbol-throws-on-tabler-icon-names-from-desktop.md
related-pr-mobile: feat/migrate-iconsymbol-to-shared-icon (Phase 1, shipped)
related-pr-shared: feat/icon-mapping-additions-for-mobile-migration (shipped in quorum-shared)
scope: ~121 files / ~768 occurrences use IconSymbol (re-counted 2026-06-12, up from 118/752 on 2026-06-10); Phase 1 fixed the bug without touching call sites; the remaining migration is now folded into the skins-to-desktop effort (work happens in quorum-shared, not a mobile wrapper)
---

> ## ⛔ DECISION (2026-06-14) — DO NOT build the Phase 2a mobile `Icon` wrapper. Don't re-open this.
>
> Re-confirmed by the user 2026-06-14 after a fresh evaluation: **"I don't want to build anything
> that is too temporary."** The Phase 2a wrapper (`components/ui/Icon.tsx` + turning `IconSymbol`
> into a deprecated alias) is **guaranteed throwaway** — once skins port to desktop, the
> skin-substitution branch moves _into_ shared's `Icon.native.tsx` and the mobile wrapper is
> deleted. It also has **low marginal value today** because icons already work fine via the Phase 1
> shim (the crash is fixed; rendering is correct).
>
> **Current plan of record: do nothing on mobile.** Leave the Phase 1 shim
> (`components/ui/IconSymbol.tsx`) exactly as-is — it is the working state. The remaining migration
> happens **once, coherently, in `quorum-shared`** as part of the skins-to-desktop effort (Phase 4),
> NOT as a mobile half-step. See the 2026-06-12 re-scope note directly below for the mechanics.
>
> If a future session is tempted to pick up "Icon Phase 2a" from a stale RECAP entry: **stop.** The
> only thing that would revive mobile-side icon work is the skins-to-desktop port reaching its
> Phase 4 — at which point the work is in shared, not here. The Phase 2a/2b sections lower in this
> file are **retained for history only.**

> ## ✅ MOSTLY RESOLVED (verified 2026-08-03) — 23 of the 24 blanks are fixed. Remainder split out.
>
> The registry has grown from 209 to 278 imports and now carries `IconRobot`, `IconLeaf`,
> `IconPalette`, `IconHeadset` and 19 more of the names listed below. **Only `IconMoodHappy`
> is still missing.** A second, related gap was found at the same time: `'headphones'` still
> has no filled variant, so it ignores the picker's Filled tab.
>
> Both remainders now live in
> **[.open/2026-08-03-icon-registry-residual-gaps-mood-happy-and-headphones-filled.md](../.open/2026-08-03-icon-registry-residual-gaps-mood-happy-and-headphones-filled.md)**,
> so this deferred file no longer carries live work. The original report is kept below as history.
>
> ## 🐞 ORIGINAL REGRESSION REPORT (2026-06-20) — registry gap blanks 24 picker icons
>
> **This is independent of the deferred migration above. Do not let "do nothing on mobile" make you
> skip it — it's a small standalone bug fix, not the wrapper/migration work.**
>
> Cassie's 06-19 fork roll-up (`a677033`) changed `IconSymbol.tsx` to import a **generated registry**
> (`components/ui/tablerIconRegistry.ts`, via `scripts/gen-tabler-registry.mjs`) instead of the full
> `@tabler/icons-react-native` barrel — necessary, because the barrel OOM-crashed the dev server (~6000
> icons, no dev tree-shaking). The registry deep-imports **only the icons we use** (209 currently).
>
> **The bug:** the generator only scrapes icon names that appear **literally as `IconXxx` tokens inside
> `IconSymbol.tsx`**. But the channel/group icon picker (`components/ui/ChannelIconPickerSheet.tsx`)
> renders `ICON_OPTIONS` from `@quilibrium/quorum-shared` (92 semantic names like `robot`, `leaf`,
> `palette`), and most of those reach a Tabler component via IconSymbol's **runtime PascalCase fallback**
> (`robot` → `IconRobot`), so their `IconXxx` name never appears in source → the generator misses them →
> they're absent from the registry → IconSymbol's `resolveTablerComponent` returns null → **the picker
> shows blank cells.**
>
> **Measured 2026-06-20:** of the 92 picker icons, **68 render, 24 are blank.** All 24 Tabler components
> exist in the installed package — they're just not in the registry. The missing 24:
> `ai, badge, book, briefcase, bug, device-floppy, file-code, folder, headset, leaf, mood-happy, moon,
palette, paw, plane, robot, seedling, square, stack, sun, sword, target, tools, tree`
> (each → `Icon<PascalCase>`, all confirmed present in `@tabler/icons-react-native`).
>
> **Why this is "patch up for now," not the migration:** the proper end-state (call sites on shared's
> `<Icon>`, which imports its own complete Tabler set) eliminates the registry entirely — but that's the
> deferred skins-to-desktop Phase 4 work. Until then the registry must simply **contain every icon the
> picker can offer**. See the patch plan section "Registry-gap patch (2026-06-20)" at the bottom of this
> file. Fix is ~1 small change + a regenerate; no migration, no call-site sweep.

> **2026-06-12 re-scope (design session) — the mobile wrapper is dropped; the real work moves to quorum-shared.**
> Supersedes the 2026-06-10 wrapper plan below. Two realizations:
>
> 1. **Shared's `Icon` primitive is already platform-split** — `Icon.native.tsx` (mobile, RN/`react-native-svg`)
>    and `Icon.web.tsx` (desktop). The bundler picks the right one per platform. So skin substitution can live
>    _inside_ `Icon.native.tsx` as another branch (it already special-cases `customIcons`/`isCustomIcon`) and
>    desktop's `Icon.web.tsx` never sees it. The earlier claim that "shared's `Icon` has no skin path so we need
>    a mobile wrapper" was **half-wrong**: shared _can_ host a mobile-only skin branch cleanly via the `.native`
>    file. The only real cost is a shared **republish + dep bump**, plus plumbing `activeSkin` into shared's
>    theme context (shared's `Icon.native.tsx` calls shared's own `useTheme()`, which has no skin field today).
> 2. **Skins-to-desktop is confident now**, which makes the mobile wrapper **guaranteed throwaway** — it would
>    be built now and deleted at the skins-port Phase 4. Given that, and given **icons already work via the
>    Phase 1 shim** (the crash is fixed, rendering is fine), building the wrapper as a half-step has **low
>    marginal value**. Decision (user, 2026-06-12): **do NOT build the wrapper. Leave the Phase 1 shim as-is.**
>    The full migration is done once, coherently, as part of the skins-to-desktop work in `quorum-shared`.
>
> **New plan of record:**
>
> - **Now:** nothing. The Phase 1 shim (`components/ui/IconSymbol.tsx`) stays. It is the working state.
> - **At skins-to-desktop (quorum-shared Phase 4, see [`2026-06-11-skins-deep-dive.md`](../../../../quorum-desktop/.agents/issues/port-from-mobile/2026-06-11-skins-deep-dive.md) §7):**
>   add the skin-substitution branch to shared's `Icon.native.tsx`, plumb `activeSkin` through shared's theme
>   context, republish + bump mobile's dep, then sweep mobile call sites onto shared's `<Icon>` with semantic
>   names and delete the shim. The skin-icon vocabulary decision (SF vs semantic keys — "Open design point"
>   below) is resolved as part of that same effort.
> - The Phase 2a/2b wrapper plan below is **retained for history only** — it is no longer the chosen path.
>
> ---
>
> **2026-06-10 re-scope (design session) — SUPERSEDED by the 2026-06-12 note above.** Two things changed the plan:
>
> 1. **Dep prerequisite is met.** `@quilibrium/quorum-shared@2.1.0-26` is installed
>    (package.json pinned). All 55 Phase 1.5 semantic icon names are confirmed present
>    in `node_modules/@quilibrium/quorum-shared/src/primitives/Icon/iconMapping.ts`.
>    The original blocker for Phase 2 is gone.
> 2. **But the end-state changed.** Phase 2 as originally written ("delete the shim,
>    use bare shared `<Icon>` everywhere") would **silently drop mobile's skin icon
>    overrides** — shared's `Icon` has no skin-substitution path, and the shim's
>    `activeSkin.icons[name]` branch is the only thing rendering user-uploaded skin
>    glyphs. So the new target is a **thin mobile `Icon` wrapper** that keeps the skin
>    check and delegates rendering to shared's `Icon`. See "Phase 2 (revised)" below.
>
> **Why a wrapper, not bare shared `Icon`:** skins-on-desktop (desktop candidate
> #27) is now
> **committed in direction** (scope decided 2026-06-11, deep-dive done, Phase 0-1 task
> drafted — see [`2026-06-11-skins-deep-dive.md`](../../../../quorum-desktop/.agents/issues/port-from-mobile/2026-06-11-skins-deep-dive.md));
> still not the top priority, but no longer 50-50. The wrapper is the correct architecture
> in **both** branches of that decision: if skins never reach desktop, the wrapper is the
> permanent home for mobile-only icon-skinning; if skins move to shared (the committed
> direction), the skin branch folds into shared's `Icon` and the wrapper collapses to a
> re-export. The deep-dive confirms exactly this: it calls mobile's wrapper the "temporary
> fix" that its **Phase 4** (icon substitution) will let mobile delete. The wrapper does not
> bet on the skins decision — and the now-committed decision selects its second branch.
>
> **Theme note (still true):** shared's `Icon.native.tsx` calls `useTheme()` from
> quorum-shared's _own_ theme context, but that context has a baked-in default
> (light/blue), so it does NOT require mounting shared's `ThemeProvider`. Mobile keeps
> its own `CustomThemeProvider` from `@/theme`. Every mobile call site passes an explicit
> `color`, so shared's theme default is never the color source — no provider wiring needed.
> (We explicitly considered swapping mobile onto shared's `ThemeProvider` and rejected it:
> mobile's provider is a superset running the entire ~2000-LOC skin engine — fonts,
> geometry, skin-reactive stylesheets, live preview — consumed by 158 files. Shared's
> provider is a flat `{ colors, getColor }`. Swapping would delete the skin feature and
> rewrite 158 call sites. Out of scope, and a regression, not an upgrade.)

# Migrate mobile `IconSymbol` to shared `Icon` primitive

> **Generalized 2026-06-28 — this task is the precedent for a broader pattern.** A design discussion
> concluded the same "do it once in shared at skins-port Phase 4, no temporary mobile wrappers"
> approach applies to **all** mobile UI primitives (Button, Modal, Input, …), not just Icon. The
> gating dependency it shares with this task — _"plumb `activeSkin` into shared's theme context"_ —
> is the unowned **shared skin-runtime** layer. See
> `../reports/2026-06-28-shared-primitives-on-mobile-analysis.md` (analysis + decision direction) and
> `2026-06-28-ui-button-consistency-audit-and-sweep.md` (the decoupled first step that does NOT wait
> on any of this). The desktop skins-port task now carries a matching "Downstream dependency" note.

## Why

Bug [`2026-06-09-iconsymbol-throws-on-tabler-icon-names-from-desktop`](../.done/2026-06-09-iconsymbol-throws-on-tabler-icon-names-from-desktop.md): mobile threw on any icon name not in its hand-maintained SF-Symbol → Material-Icons MAPPING. Desktop manifests carry Tabler names (`users`, `bell`, `flame`) that mobile never knew about, so every space/channel/group created on desktop with a non-trivial icon crashed the surrounding render tree on mobile.

Long-term: mobile and desktop need to share a single icon vocabulary. `@quilibrium/quorum-shared` already ships a cross-platform `Icon` primitive backed by Tabler — desktop uses it, mobile didn't.

## Phase 1 — done in this session (2026-06-09)

**Replaced the IconSymbol internals with a Tabler-direct shim** in [components/ui/IconSymbol.tsx](../../components/ui/IconSymbol.tsx).

- Function signature preserved: all 121 call sites continue to import `IconSymbol` and pass the same legacy SF Symbol names. No call-site changes.
- Internally, `IconSymbol` now renders Tabler icons directly via `@tabler/icons-react-native` on every platform (iOS, Android, web).
- The SF_TO_TABLER table covers every legacy SF Symbol name used in the codebase (~180 entries).
- Names not in the table fall through to a dynamic Tabler lookup: e.g. desktop sends `"users"` → shim PascalCases it to `IconUsers` → renders. The original bug scenario now resolves to a real Tabler icon, not blank space.
- `.fill` suffix → renders `*Filled` Tabler variant when one exists, falls back to outline otherwise.
- Unknown names log a warning once (`__DEV__` only) and return null. No more throwing.
- Skin-icon override path preserved (used by user-uploaded PNG/JPEG glyphs).
- `components/ui/IconSymbol.ios.tsx` deleted — Tabler renders cross-platform, no reason for iOS to diverge.

**Why "Tabler-direct" rather than going through the shared `Icon` primitive in this PR:** the published `@quilibrium/quorum-shared@2.1.0-20` (currently consumed by mobile) doesn't yet have all the semantic icon entries we need. Adding them upstream (see "Phase 1.5" below) requires a republish + dep bump, which is a separate sequencing concern. Bypassing shared's mapping layer and going straight to Tabler means the shim works _today_ and is robust to the shared dep version drift.

**Verification (Phase 1):**

- `npx tsc --noEmit --jsx react-jsx --skipLibCheck`: no new type errors introduced (107 pre-existing errors on master, 107 on this branch — identical).
- Bug repro: desktop-picked Tabler icons (`users`, `bell`, `flame`) now render correctly via dynamic Tabler lookup.
- Add-channel flow no longer crashes regardless of which icon a desktop user picked.

**Visual regression scope:** every icon in the mobile app now renders in Tabler style (outlined, geometric, 2px stroke) instead of the previous Material Icons (filled, rounded) or iOS SF Symbols (Apple house style). This is the _intended_ outcome — cross-platform consistency with desktop — but it's a sweeping visual change and should be reviewed by LaMat / the team before merging the mobile PR. Headline surfaces to eyeball: tab bar, chat header, wallet, profile, settings.

## Phase 1.5 — companion PR on quorum-shared (this session)

Branch: `feat/icon-mapping-additions-for-mobile-migration` in `quorum-shared`.

Added ~55 new semantic icon entries to `src/primitives/Icon/types.ts` and `src/primitives/Icon/iconMapping.ts` to cover everything mobile needs. New names include: `flag, file, brush, shield-lock, hand-stop, circle-plus, bolt, server, camera, stack, cash, circle-x, building-bank, shield-x, phone, phone-off, video-off, circle-arrow-{up,down,left,right}, arrows-exchange, player-play, player-pause, map-pin, file-text, undo, wifi-off, link-plus, sparkles, arrow-up-right, arrow-down-left, arrow-down-right, scan, user-circle, user-exclamation, arrow-forward-up, ticket, thumb-up, thumb-down, credit-card, arrows-up-down, chart-bar, microphone-off, camera-rotate, minimize, maximize, broadcast, mail-opened, face-id, hammer, qrcode, building-store, tag-off, trophy, currency-bitcoin`.

This unlocks Phase 2: once shared is republished and mobile bumps the dep, call sites can use semantic names directly (`<Icon name="users" />`) and the shim becomes redundant.

## Phase 2 (revised) — mobile `Icon` wrapper, then a deferred call-site sweep — ⚠️ SUPERSEDED 2026-06-12

> **This entire Phase 2 (revised) plan is retained for history only.** Per the 2026-06-12 re-scope note at
> the top of the file, the mobile wrapper is **not** being built — the skin branch will live in shared's
> `Icon.native.tsx` as part of the skins-to-desktop effort, and mobile will consume shared's `<Icon>` directly.
> Read the top note for the current plan of record. The text below describes the rejected wrapper approach.

The original Phase 2 ("delete shim, use bare shared `Icon`") is **superseded**. New plan splits
into a safe architectural step (2a) and a deferred runtime-risky step (2b), so the architecture
can land without the 118-file sweep.

**End-state target:** a mobile-local `Icon` wrapper owns the skin-substitution branch and delegates
all real rendering to shared's `Icon`. Call sites use semantic names. The shim and its SF→Tabler
table are gone.

```tsx
// components/ui/Icon.tsx (mobile) — the wrapper, sketch
import { Icon as SharedIcon } from "@quilibrium/quorum-shared";
import { useThemeOptional } from "@/theme";
import { Image } from "react-native";

export function Icon({
  name,
  size = 24,
  color,
  variant,
  style,
}: {
  name: string; // semantic name, e.g. "users"
  size?: number; // shared also accepts 'xs'|'sm'|... ; mobile passes numbers
  color: string;
  variant?: "outline" | "filled";
  style?: any;
}) {
  // Skin override — the ONE thing shared's Icon can't do. Keep it here.
  const skinIcon = useThemeOptional()?.activeSkin?.icons?.[name];
  if (skinIcon) {
    return (
      <Image
        source={{ uri: skinIcon.image }}
        style={[
          { width: size, height: size },
          skinIcon.tint === false ? null : { tintColor: color },
          style,
        ]}
        resizeMode="contain"
      />
    );
  }
  return (
    <SharedIcon
      name={name}
      size={size}
      color={color}
      variant={variant}
      style={style}
    />
  );
}
```

Shared `Icon` API (verified against `2.1.0-26`, 2026-06-12): `{ name: IconName; size?: IconSize ('xs'|'sm'|'md'|'lg'|'xl'|'2xl'..'5xl'| number); color?: string; variant?: 'outline'|'filled'; style?; onClick? }`. `Icon` is a **root named export** — `import { Icon } from '@quilibrium/quorum-shared'` resolves (via `primitives/index.ts:18` → `src/index.ts:41`). Desktop uses the same import.

> **⚠️ Implementation gotcha found 2026-06-12 — `name` is typed `IconName` (a strict union), not `string`.** The wrapper sketch above types its `name` prop as `string` and passes it straight to `<SharedIcon name={name} />`. That is a **TS type error** (`string` is not assignable to `IconName`). The shim avoids this only because it goes to Tabler directly and never touches shared's typed surface. Two clean fixes, both shipped by shared itself — the primitives barrel **also exports `isValidIconName` and `iconNames`** (`primitives/index.ts:18`):
>
> - **Guard + fall-through:** `if (isValidIconName(name)) return <SharedIcon name={name} ... />;` then handle the (rare) unknown name explicitly (render null / warn), mirroring the shim's current soft-fail. Recommended — it's type-safe _and_ preserves the "don't crash on an unknown desktop name" property that was the whole point of Phase 1.
> - **Cast:** `<SharedIcon name={name as IconName} ... />` — one line, but throws away the safety net; an unmapped name reaches shared's `Icon`, which logs a warning and renders nothing. Acceptable but strictly worse than the guard.
>   Either way, the wrapper's public `name` prop staying `string` is correct (call sites pass arbitrary names); the type-narrowing happens _inside_ the wrapper at the `SharedIcon` boundary.

### Phase 2a — land the wrapper + alias (SAFE, statically verifiable, can ship anytime)

No call-site edits, no visual change, no runtime-test session required.

1. Add `components/ui/Icon.tsx` (the wrapper above).
2. Turn `components/ui/IconSymbol.tsx` into a **deprecated alias** that re-exports the wrapper and
   keeps the SF→Tabler table _only_ as an internal name-translation shim for the still-unmigrated
   call sites (legacy SF name in → semantic name → wrapper). i.e. the wrapper is the new core; the
   old shim becomes a compatibility skin over it. All 118 files keep compiling unchanged.
3. `npx tsc --noEmit --jsx react-jsx --skipLibCheck` — confirm no new errors vs master.

Outcome: the architecture is in place. Mobile owns icon-skinning in one small wrapper; shared owns
cross-platform rendering. The risky sweep is now decoupled and optional.

### Phase 2b — call-site sweep to semantic names (DEFERRED — runtime-test session)

This is the part the migration workflow defers (118 files / 752 occurrences = max visual-regression

- runtime-test surface; mobile isn't run in normal sessions — see
  [`quorum-shared-migration/README.md`](../.done/2026-06-21-mute-and-block-overhaul/README.md)).

**⛔ Gated on one open design decision (see "Open design point" below): the skin-icon vocabulary.**
Resolve that first, because it determines what `name` the wrapper looks up in `activeSkin.icons`.

When a mobile-test session is available:

1. Group call sites by feature area (wallet, chat, spaces, social-feed, onboarding, qns, settings…)
   — one PR per area, ~10-20 files each. Use the SF→Tabler table (now living in the deprecated
   `IconSymbol` alias) as the SF→semantic cheat-sheet: each Tabler component name maps 1-to-1 to a
   semantic name via shared's `iconMapping.ts`.
2. Per area: swap `import { IconSymbol } from '@/components/ui/IconSymbol'` →
   `import { Icon } from '@/components/ui/Icon'`; rewrite `<IconSymbol name="person.2.fill" />` →
   `<Icon name="users" variant="filled" />`. Visual-review against screenshots before merge.
3. When all 118 files are migrated: delete `components/ui/IconSymbol.tsx`. Audit
   `components/ui/IconPicker.tsx` — its `ICON_OPTIONS` still uses SF names; align with desktop's
   vocabulary so both platforms offer the same pick set.

### Open design point (gates Phase 2b, decided "later") — skin-icon vocabulary

`SkinIcons` is `Record<string, SkinIcon>` ([theme/skins/types.ts:71](../../theme/skins/types.ts#L71))
— **NOTE (2026-06-12):** the key type was widened from `IconSymbolName` to `string` since this task
was written, so there is **no longer a compile-time link** forcing SF-named keys. But the field's
intent is unchanged (its doc comment still reads "Map of IconSymbol name → substitute image") and
**published skin manifests in the gallery are still keyed by legacy SF names** (`"person.2.fill"`),
so the vocabulary mismatch below is still real at runtime — the type just no longer flags it for you.
Once call sites pass **semantic names** (`"users"`), the wrapper's `activeSkin.icons[name]` lookup
would query `"users"` and miss a skin's `"person.2.fill"` entry. Options (decide when we actually do 2b):

- **(a) Map semantic→SF inside the wrapper** — keep a small internal table so skin lookups still hit
  existing SF-keyed manifests. Preserves all published skins unchanged; keeps a (smaller) table alive.
- **(b) Migrate skin manifests to semantic keys** — cleanest end-state, but needs a back-compat /
  migration path for any skins already published to the gallery keyed by SF names.

This does **not** affect Phase 2a (the alias keeps SF names end-to-end). It only gates 2b.

## Out of scope

- The desktop icon vocabulary or `quorum-shared`'s `iconMapping.ts` design. We extended the map but didn't restructure it.
- Migrating away from the legacy "icon name is a hard-coded string" pattern in space/channel manifests. That's a much bigger sync-layer change.
- **Swapping mobile onto shared's `ThemeProvider`.** Considered and rejected this session — see the 2026-06-10 re-scope note at the top. Mobile's provider is a superset (skin engine, fonts, geometry, 158 consumers); shared's is a flat colors object. Not interchangeable.
- **Moving icon-skinning into shared.** That only makes sense if/when skins port to desktop (candidate #27). The wrapper is designed so this becomes a trivial later step, but it is not this task.

## Relationship to the skins→desktop port (desktop candidate #27)

- Desktop has **no** skin engine. Skins are a mobile-only feature; porting them to desktop is tracked as candidate **#27** in `quorum-desktop/.agents/tasks/port-from-mobile/candidates.md`. As of **2026-06-11 the direction is committed** (full parity incl. geometry, app-wide; deep-dive done; Phase 0-1 implementation task drafted) — still not the top priority, but no longer "50-50 whether it ships."
- This task does **not** depend on #27, and the timelines are independent. The Phase 2a wrapper is correct whether or not skins port. The relationship is now confirmed by the desktop deep-dive ([`2026-06-11-skins-deep-dive.md`](../../../../quorum-desktop/.agents/issues/port-from-mobile/2026-06-11-skins-deep-dive.md) §7): **when** #27 reaches its **Phase 4** (icon substitution), the substitution layer moves into shared's `Icon`, and mobile's wrapper collapses to a re-export. The deep-dive explicitly names mobile's wrapper the "temporary fix" and states the mobile crash is "already resolved," so icon convergence is a **bonus for #27, not a blocker** for it.
- A reciprocal pointer lives under #27 / in the deep-dive (§7, "Icon-substitution / shared `Icon` tie-in") so the skins-port session knows to rework shared's `Icon` to be skin-aware at Phase 4.

## Pointers

- Shim source (current core): `components/ui/IconSymbol.tsx`
- Planned wrapper: `components/ui/Icon.tsx` (Phase 2a — not yet created)
- Tabler RN library: `node_modules/@tabler/icons-react-native/`
- Shared `Icon` primitive: `node_modules/@quilibrium/quorum-shared/src/primitives/Icon/` (Icon.native.tsx + iconMapping.ts + types.ts)
- Skin icon type: [theme/skins/types.ts:65-71](../../theme/skins/types.ts#L65-L71) (`SkinIcon`, `SkinIcons` — type is now `Record<string, SkinIcon>`; keys are still SF names in practice / published manifests)
- Shared icon-name helpers (use these in the wrapper): `isValidIconName`, `iconNames` — exported from the shared root via `node_modules/@quilibrium/quorum-shared/src/primitives/index.ts:18`
- Mobile theme provider (NOT shared's): [theme/ThemeProvider.tsx](../../theme/ThemeProvider.tsx)
- Desktop icon vocabulary: `quorum-desktop/src/components/space/IconPicker/types.ts`
- Desktop skins candidate: `quorum-desktop/.agents/tasks/port-from-mobile/candidates.md` (#27)
- Call-site survey: `rg "IconSymbol" --type ts --type tsx -l` → **~121 files / ~768 occurrences** (re-counted 2026-06-12; was 118/752 on 2026-06-10 — the codebase grew). Count excluding the shim itself and `.agents/` docs: 121 files.

## Registry-gap patch (2026-06-20) — make the registry cover the whole picker vocabulary

**Goal:** every icon the channel/group picker can offer must render. Fix the 24 blanks (and prevent
recurrence) WITHOUT doing the migration. The registry generator must learn about the picker vocabulary,
not just the `IconXxx` tokens hard-coded in `IconSymbol.tsx`.

**Root cause recap:** `scripts/gen-tabler-registry.mjs` builds the registry by regexing `IconSymbol.tsx`
for `\bIcon[A-Za-z0-9]+\b`. The picker's icons arrive as **semantic names** (`robot`, `leaf`) resolved
to `Icon<PascalCase>` at runtime, so they never appear as `IconXxx` in source → never enter the registry.

**Options (pick at implementation time — recommend A):**

- **A. Teach the generator the picker vocabulary (recommended; durable).** In `gen-tabler-registry.mjs`,
  in addition to scraping `IconSymbol.tsx`, import/resolve shared's `ICON_OPTIONS`
  (`@quilibrium/quorum-shared` → `pickerVocabulary.ts`), run each `name` through the SAME resolution
  IconSymbol uses (the picker-vocabulary `tabler()` map entries, else `Icon`+PascalCase), and add every
  resolved base **and its `…Filled` variant** to the registry set. Then regenerate. This makes "the
  picker can offer it" automatically imply "the registry contains it" — so future additions to shared's
  vocabulary can't silently blank again. (Reading shared in a plain Node script may hit the same
  ESM-exports issue seen 2026-06-20 — read `pickerVocabulary.ts` source directly, or add a tiny export,
  rather than `require('@quilibrium/quorum-shared')`.)
  - Also fold in the **filled** forms: the picker's "Filled" tab renders `FILLED_ICONS` names in their
    filled variant; those `…Filled` components must be in the registry too. Verify none of those are
    missing as part of the same pass.

- **B. Add the 24 names as explicit entries in `IconSymbol.tsx`'s SF_TO_TABLER picker-vocabulary block,
  then regenerate.** Smaller change, but it's manual and will drift again the next time shared's
  `ICON_OPTIONS` grows. Acceptable as a stopgap; A is the real fix.

- **C. Hardcode the 24 imports into the registry by hand.** Rejected — the registry header says "GENERATED,
  do not edit by hand," and it'd be silently clobbered on the next `npm run gen:icons`.

**Steps (when implementing — no code yet, this is the plan):**

1. [ ] Decide A vs B (recommend A).
2. [ ] Implement the generator change (A) or the SF_TO_TABLER additions (B).
3. [ ] `npm run gen:icons` → confirm the 24 names' components now appear in `tablerIconRegistry.ts`,
       and that the registry count grew by ~24 (+ any filled variants).
4. [ ] Re-run the gap check (the 2026-06-20 analysis script): picker MISSING count must be **0**.
5. [ ] Sanity TS check: `npx tsc --noEmit --jsx react-jsx --skipLibCheck` — no new errors vs master.
6. [ ] Visual verify in the picker (release or debug): open the channel icon picker, scroll the grid,
       confirm no blank cells in BOTH the outline and filled tabs. (Mobile run needed — schedule with a
       dev-test session; the gap check in step 4 is the static proxy.)

**Scope guard:** this touches only `gen-tabler-registry.mjs` (option A) or `IconSymbol.tsx`'s table
(option B) + the regenerated `tablerIconRegistry.ts`. It does NOT touch call sites, does NOT build the
wrapper, does NOT start the migration. One small fix branch, on its own (it's a visible user-facing bug,
worth being revertable in isolation per the batch-fixes rule).

---

_Last updated: 2026-06-20 — logged a NEW regression from Cassie's 06-19 roll-up: the generated Tabler registry omits 24 of the 92 picker icons (they reach Tabler via IconSymbol's runtime PascalCase fallback, which the generator's source-scrape can't see), so those picker cells render blank. Added a top "NEW REGRESSION" banner + a standalone "Registry-gap patch" plan (recommend: teach the generator the shared picker vocabulary). This is a small standalone fix, NOT the deferred migration. No code changed this session._

_Previously 2026-06-14 — user re-confirmed the Phase 2a wrapper is REJECTED (don't build temporary scaffolding); added a hard "do not re-open" decision banner at the top, set status to `phase-2a-wrapper-REJECTED`, dropped priority to low. No code change. Plan of record stays: do nothing on mobile; the migration happens in `quorum-shared` at skins-to-desktop Phase 4._

_Previously 2026-06-12 — re-scoped: dropped the mobile `Icon` wrapper (Phase 2a/2b) as throwaway given skins-to-desktop is confident; the remaining migration now happens in `quorum-shared` (skin branch into `Icon.native.tsx` + call-site sweep + shim delete) as part of the skins-to-desktop Phase 4. Phase 1 shim stays as-is for now. Earlier same-day edits: verified against `@quilibrium/quorum-shared@2.1.0-26`, refreshed counts (~121/768), recorded `SkinIcons` key-type widening to `string`, noted the `IconName`-vs-`string` gotcha + `isValidIconName`, updated skins direction "50-50" → "committed". Correction logged: shared's platform-split (`Icon.native.tsx`/`Icon.web.tsx`) means a mobile-only skin branch can live in shared cleanly — the earlier "no skin path in shared" framing was half-wrong._
