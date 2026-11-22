---
status: open
type: task
created: 2026-07-16
---

# QNS as a Standalone, Skin-Independent Screen

## Summary

Move the Quilibrium Name Service (QNS / QNames) experience out of the Premium tab
inside `ProfileModal` and onto its own full-screen expo-router route. The Premium
tab keeps only the Quorum Apex card plus a QNS-branded banner that navigates to the
new screen. The new screen adopts the **QNS brand identity** (purple → pink gradients,
the `@` motif) and is **skin-independent**: it always renders in QNS colors regardless
of the active Quorum skin, tracking only the light/dark base.

## Motivation

The Premium tab currently bundles six unrelated jobs into one long modal scroll:
Apex subscription, username claiming, owned-name management, a full marketplace,
auctions, and offers. This:

- Overloads a single settings tab and buries the marketplace.
- Gives the QNS product no room for its own identity — it reads as "just another
  settings section" in generic Quorum-blue.
- Doesn't scale for power users who own hundreds of names.

QNS/QNames is effectively its own product surface. Giving it a dedicated, branded
screen is a deliberate context shift ("you've entered the naming marketplace"),
the same way an embedded miniapp or a wallet-connect flow is allowed to look like
itself.

## Decisions (locked during brainstorming)

1. **Full QNS brand** on the new screen (not accents-on-Quorum, not stay-Quorum).
2. **Skin override**: the screen ignores the active skin's accent, geometry, fonts,
   and surfaces. It follows **only** the light/dark base — if the active skin is a
   light theme, use QNS light; if dark, QNS dark.
3. **Navigation model B**: a horizontally-scrollable tab strip is the primary IA;
   each tab is a full screen.
4. **Tab set (site vocabulary, Offers kept, Transactions deferred):**
   `Register · Marketplace · Auctions · My Names · Offers`.
5. **Boundary**: everything QNS-related moves off the Premium tab. Only the Apex
   card stays. The invite-code redemption moves to the Register tab.
6. **My Names is its own tab/screen** with its own scroll + filter, because owned-name
   counts range from 2 to hundreds.
7. **Sequencing**: structure first, re-skin the existing marketplace surfaces after
   (see Build Sequence).
8. **Component approach**: build on **mobile's existing components** (`Button`, `Card`,
   `SegmentedPills`, `SkinTouchable`, `IconSymbol`, `QnsIcon`, `EmptyState`/`ErrorState`/
   `LoadingState`, `shared/BaseModal`) plus the new `useQnsBrand()` token layer. **Do NOT**
   depend on or trigger the separate quorum-shared primitive-adoption audit (mobile has
   not yet imported shared's UI primitives; deciding which to port is its own task). When
   that audit later swaps in shared `Button`/`Input`/etc., this screen swaps cleanly — the
   QNS tokens stay put. See UI Specification below.
9. **Auctions cards are compact** — same row density as Marketplace listings (one row:
   name + LIVE tag, current bid + countdown on the meta line, Bid action), not tall
   stacked cards.

## Brand Tokens (authoritative — ported from `qns-web/src/index.css`)

A new `useQnsBrand()` hook returns the palette for the current `isDark`. Values are
copied verbatim from the QNS website so the two products stay in visual lockstep.

### Core palette
| Token        | Light      | Dark       |
|--------------|------------|------------|
| brand        | `#6330CA`  | `#A073FF`  |
| accent       | `#FF056D`  | `#FF468C`  |
| page bg      | `#F0E9E4`  | `#140E22`  |
| surface      | `#F8F8F8`  | `#1A1230`  |
| surface raised | `#FFFFFF`| `#221840`  |
| surface subtle | `#F4F0F8`| `#322658`  |
| text primary | `#251542`  | `#EEE8FC`  |
| text muted   | `rgba(37,21,66,.6)` | `rgba(238,232,252,.58)` |
| border       | `rgba(37,21,66,.15)` | `rgba(180,160,230,.18)` |
| success      | `#22A941`  | `#50C841`  |
| danger       | `#E74A4A`  | `#F54B82`  |

### Signature gradient
`linear-gradient(135deg, #6330CA → #FF056D)` — used for the hero, the primary CTA
button, and the active pill. (Website hero uses purple→pink; the deeper burgundy
`#40001B` anchor is a website-homepage flourish and is optional on mobile.)

### Motif assets
- The `@` mark (already used in the current banner via `QnsIcon`).
- `qnames-logo-3d.png` (`../www-dev\public\images\snapshots\qnames-logo-3d.png`)
  is available as an optional hero decoration; not required for v1.

## Architecture

### New route
- **`app/qns.tsx`** — standalone screen, sibling to `app/settings.tsx` / `app/wallet.tsx`.
- Reached via `router.push('/qns')` from the Premium-tab banner.
- Own header, title **"Quilibrium Names"**, back navigation.
- Optional deep-link param `?tab=marketplace` (etc.) so the banner or future entry
  points can open a specific tab.

### Brand module
- **`theme/qns/brand.ts`** exporting `useQnsBrand()`.
  - Reads `isDark` from the existing `useTheme()`.
  - Returns the QNS palette for that mode and the gradient stops.
  - Consumed by all QNS-screen components instead of `theme.colors`.
- This is the override boundary: QNS components never read `theme.colors`; they read
  `useQnsBrand()`. Whatever skin is active, the QNS screen stays QNS.

### Tab strip
- Reuse the existing **`SegmentedPills`** component (`components/ui/SegmentedPills.tsx`),
  `scrollable` + `centerOnSelect`, `itemRole="tab"`.
- **Skin-override caveat**: `SegmentedPills` derives its active color from
  `theme.colors.primary` / `accentSoft` (the skin accent). For QNS we must force the
  brand color — pass `accentColor: <QNS brand>` per item, OR wrap it in a small
  `QnsTabs` component that injects the QNS gradient/brand for the active pill. This is
  the one place the skin override needs a deliberate touch.

### Screen structure
```
app/qns.tsx
  <QnsBrandScope>                     // provides useQnsBrand palette + QNS bg
    <QnsHeader title="Quilibrium Names" />
    <QnsTabs items=[Register, Marketplace, Auctions, My Names, Offers] />
    switch(activeTab):
      Register    -> <QnsRegisterTab />
      Marketplace -> <MarketplaceModal .../>  // hosted as-is in Phase 1
      Auctions    -> <AuctionsModal .../>
      My Names    -> <QnsMyNamesTab />
      Offers      -> <OffersModal .../>
```

### Tab contents

**Register** (the claim job, all in one place):
- Hero: purple→pink gradient, "Claim your @username", subtitle, `@` motif.
- Username search + availability check (existing logic from `ProfileModal`).
- Pricing tiers (≤3 / 4–5 / 6–8 / 9+ chars).
- Invite-code redemption (moved from Premium tab).
- Service health / countdown gating (moved — wraps the claim controls).
- Small "You own N names →" nudge that switches to the My Names tab.

**My Names** (own scroll, scales to hundreds):
- Filter/search box over the user's names.
- Segmented filter: All / Owned / Delegated / Listed.
- Rows with per-name actions (set primary, make resolvable, list on marketplace),
  reusing existing `ProfileModal` handlers.
- Tapping a name opens `NameDetailModal` (existing).
- Delegated names live here as a filter/section (not a separate top-level tab).

**Marketplace / Auctions / Offers**:
- Phase 1: host the existing `MarketplaceModal` / `AuctionsModal` / `OffersModal`
  bodies inside the tab, still Quorum-themed.
- Phase 2: re-skin to QNS brand.

## Premium Tab (after the change)

Ends as: **Quorum Apex card** + **QNS entry banner**. The banner is QNS-branded
(purple→pink) even inside the Quorum-themed Premium tab — a visual doorway. Tapping
it calls `router.push('/qns')`.

Everything else currently under the Premium tab (Your Names, Delegated, Browse
Marketplace / Auctions / Offers, Invite Code, health/countdown) is removed from
`ProfileModal` and lives on the QNS screen.

## What Moves Where

| Current Premium-tab element        | Destination                    |
|------------------------------------|--------------------------------|
| Apex subscription card             | **Stays** in Premium tab       |
| "Claim Your Username" banner       | Becomes the **QNS entry banner** |
| Service health / countdown gating  | QNS screen → Register tab      |
| Your Names (owned + actions)       | QNS screen → My Names tab      |
| Browse Marketplace                 | QNS screen → Marketplace tab   |
| Auctions                           | QNS screen → Auctions tab      |
| Offers                             | QNS screen → Offers tab        |
| Delegated Names                    | QNS screen → My Names (filter) |
| Invite Code redemption             | QNS screen → Register tab      |

## UI Specification

Component-first. Each element names the **mobile component** that renders it and the
**QNS token** (from `useQnsBrand()`) that replaces the skin token. Dimensions use the
existing `Skin.space()/radius()/font()/border()` scale so the screen stays skin-metric
consistent even while it overrides skin colors. All hex values are the QNS light / dark
pair from the Brand Tokens table.

### Shared design tokens (define once, reuse everywhere)

**`useQnsBrand()` returns:**
```
brand, accent, gradient:[brand, accent]     // #6330CA→#FF056D (light) / #A073FF→#FF468C (dark)
bg.page, bg.surface, bg.surfaceRaised, bg.surfaceSubtle
text.primary, text.muted, border
success, danger
```

**Reusable QNS elements (built once, used across tabs):**

| Element | Mobile component | Spec |
|---|---|---|
| **Gradient hero** | new `QnsHero` (View + `expo-linear-gradient`) | radius `Skin.radius(16)`, padding `Skin.space(16)`, gradient 135° `[brand→accent]`; title `Skin.font(20)` weight 800 `#fff`; subtitle `Skin.font(10)` `rgba(#fff,.82)`; `@` motif = `QnsIcon`/glyph at `rgba(#fff,.15)` top-right. |
| **Primary action button** | mobile `Button` `variant="primary"` `color={brand}` | Uses the built-in `color` override (designed for brand buttons). For the gradient CTA, wrap in a `QnsGradientButton` (LinearGradient behind a `Button variant="ghost"`), label `#fff`. sm/md/lg per existing Button sizes. States: default / pressed (activeOpacity .7) / disabled (opacity .6) / loading (spinner in `#fff`). |
| **Secondary / ghost button** | mobile `Button` `variant="outline"` `color={brand}` | border `1px` brand, label brand, transparent fill. Used for "Make an offer". |
| **Tab strip** | `SegmentedPills` wrapped as `QnsTabs` | `scrollable`, `centerOnSelect`, `itemRole="tab"`, `pillShape="rect"`. Active pill forced to QNS gradient/brand via per-item `accentColor={brand}` (skin-override touch — see Architecture). Inactive: `bg.surfaceSubtle` / `text.muted`. font `Skin.font(11)`. |
| **List row (name/listing)** | `SkinTouchable` + View | `bg.surface`, `1px border`, radius `Skin.radius(12)`, padding `Skin.space(10-12)`; primary text `Skin.font(13)` weight 700 `text.primary`; meta `Skin.font(9)` `text.muted`; right-aligned amount `Skin.font(12)` weight 700. Pressed: opacity .7. |
| **Search / input box** | `SkinTouchable`→`TextInput` | `bg.surface`, `1px border`, radius `Skin.radius(11)`, padding `Skin.space(10)`; placeholder `text.muted`; leading icon `IconSymbol`. |
| **Segmented filter** | `SegmentedPills` `variant="tinted"` `accentColor={brand}` | active = brand-tinted bg + brand text + brand border; inactive = `bg.surfaceSubtle` / `text.muted`. |
| **Badge / status pill** | View + Text | radius `Skin.radius(20)`, padding `Skin.space(3)/Skin.space(8)`, `Skin.font(9)` weight 600. Primary badge = brand-tint; LIVE = accent-tint; Pending = warning-tint; resolvable = success-tint. |
| **Chain badge** | View + Text | color from existing `getChainColor()` map (unchanged), `Skin.font(8)` weight 600, radius `Skin.radius(6)`. |
| **Empty / error / loading** | mobile `EmptyState` / `ErrorState` / `LoadingState` | spinner/icon tinted `brand`; otherwise default. |

### Per-screen element spec

**Register tab**
| Element | Component | Notes |
|---|---|---|
| Hero | `QnsHero` | "Claim your @username" / "Your permanent identity on Q. No renewals, yours forever." |
| Username field | search box token | leading `@` in brand; live availability check (existing logic). |
| Availability banner | View | available = success-tint bg+border+text; taken = danger-tint. `Skin.font(9-10)`. Shows price on the right. |
| Pricing tiers | 2×2 grid of `Card`-style tiles | `bg.surface`, radius `Skin.radius(8)`, `Skin.font(8-9)`; value bold `text.primary`. |
| Invite code | dashed-border box + field | `1px dashed` brand-alpha border, radius `Skin.radius(11)`; existing redeem logic. |
| "You own N names" nudge | list row token | switches active tab → My Names; chevron `IconSymbol` in brand. |

**Marketplace tab** (Phase 1 hosts existing `MarketplaceModal` as-is; Phase 2 re-skins to these tokens)
| Element | Component | Notes |
|---|---|---|
| Toolbar | search box + sort button | sort = `bg.surfaceSubtle` chip `Skin.font(9)`. |
| Listing row | list row token | name + chain badge + char count (meta); right = amount + `Buy` (gradient primary sm). Tap → Name detail. |

**Auctions tab** (compact — Decision 9)
| Element | Component | Notes |
|---|---|---|
| Filter | segmented filter | Live / Ending soon / Ended. |
| Auction row | list row token | name + `LIVE` badge (accent-tint) on top line; meta line = "Bid {amount} · {countdown}" with countdown in `accent`; right = `Bid` (gradient primary sm). Same row height as Marketplace. |

**My Names tab**
| Element | Component | Notes |
|---|---|---|
| Filter box | search box token | filters the owned list. |
| Segmented filter | segmented filter | All {count} / Owned / Delegated / Listed. |
| Name row | list row token | name + status subtitle; right = contextual mini-action (Set primary / Make resolvable / List / Edit), reusing existing `ProfileModal` handlers. Tap → Name detail. |

**Offers tab**
| Element | Component | Notes |
|---|---|---|
| Received/Sent toggle | segmented filter | 2 options. |
| Offer row | list row token | name + "Offer from @x"; amount in brand; Received rows show Accept (success-tint) / Decline (danger-tint) chips. |

**Name detail** (hosts existing `NameDetailModal`; Phase 2 re-skins)
| Element | Component | Notes |
|---|---|---|
| Hero | `QnsHero` centered | big `@name` `Skin.font(23)` weight 800; status badge below. `@` motif bottom-left. |
| Metadata rows | list row token | key (`text.muted`) / value (`text.primary`) pairs: Owner, Registered, Length, Listed price. |
| Actions | primary + ghost buttons | context-dependent: Buy (gradient primary) + Make an offer (outline); or Set primary / List when owned. |

### The skin-override rule (restated for implementers)

Every QNS-screen element reads color from `useQnsBrand()`, never from `theme.colors`.
Metrics (`Skin.space/radius/font/border`) still come from the skin so spacing feels
native. Mobile `Button` uses its `color` prop for brand fill; `SegmentedPills` uses
per-item `accentColor` for the brand active state. Result: any active skin → the QNS
screen looks identical except for light/dark base.

## Build Sequence (structure first, re-skin after)

**Phase 1 — Structure & brand shell (ships a usable, testable screen):**
1. `theme/qns/brand.ts` + `useQnsBrand()` (light/dark tokens).
2. `app/qns.tsx` route + header + `QnsTabs` (SegmentedPills wrapper, QNS-branded).
3. `QnsRegisterTab` — port claim/search/tiers/invite/health logic from `ProfileModal`,
   QNS-branded.
4. `QnsMyNamesTab` — port owned/delegated list + actions, add filter, QNS-branded.
5. Host existing `MarketplaceModal` / `AuctionsModal` / `OffersModal` inside the
   Marketplace / Auctions / Offers tabs **as-is** (still Quorum-themed).
6. Replace the Premium-tab QNS block in `ProfileModal` with the Apex card + QNS banner
   that navigates to `/qns`. Remove the moved code.

**Phase 2 — Re-skin marketplace surfaces:**
7. Re-skin `MarketplaceModal`, `AuctionsModal`, `OffersModal` (and `NameDetailModal`,
   `BuyNameModal`, etc. as needed) from `theme.colors` to `useQnsBrand()`.

Each phase-1 step produces something observable; the brand rolls in progressively in
phase 2. This keeps the work reviewable by behaviour rather than by diff.

## Non-Goals / Deferred

- **Transactions tab** — exists on the website, not ported in v1.
- **Burgundy homepage flourish** and 3D logo hero — optional polish, not required.
- No changes to QNS API/services or the underlying claim/marketplace logic — this is
  a presentation + navigation restructure. Existing hooks (`useQNSMarketplace`,
  `qnsClient`, claim handlers) are reused unchanged.

## Open Questions

- None blocking. `SegmentedPills` QNS-branding resolved: a thin `QnsTabs` wrapper passes
  per-item `accentColor={brand}` (and the gradient for the active pill). Confirm the
  gradient-active-pill rendering during implementation.
- Whether the gradient CTA is a `QnsGradientButton` wrapper vs. extending mobile `Button`
  with a gradient variant — a like-for-like implementation choice, not a design blocker.

---
*Last updated: 2026-07-16*
