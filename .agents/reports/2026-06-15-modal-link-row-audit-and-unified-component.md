# Modal link-row audit + unified component proposal

**Date:** 2026-06-15
**Status:** Proposal — awaiting decision before implementation
**Scope:** quorum-mobile (build target) + quorum-desktop mobile drawers (inspiration)

## Problem

Across mobile modals/drawers/sheets we render the same conceptual UI dozens of
times: a tappable row with an **icon on the left** and a **label on the right**
(menu options, action sheets, settings rows, share targets). Every surface
styles it slightly differently. The result is visible inconsistency: icons jump
between 18/20/22px, labels between 14/15/16/17px, gaps between 10/12/14px,
dividers present in some sheets and absent in others, some flat and some
grouped. There is no single component that owns this pattern, and there is no
support for **grouping** links into labeled sections (useful for sheets with
many options).

## Audit — quorum-mobile (current state)

**10 distinct bespoke implementations** of the icon-left + label-right row.
Only **1** is a reusable component (`shared/ActionSheet`), used by ~4 sites.
The other 6 surfaces reimplement the row inline.

| # | Pattern | File | Icon | Gap | Label | V-pad | H-pad | Divider | Trailing | Sections | Reusable |
|---|---------|------|------|-----|-------|-------|-------|---------|----------|----------|----------|
| A | MessageActionSheet | `Chat/MessageActionSheet.tsx` | 20 | 12 | 16 reg | 14 | 20 | 1px inset mH:16 | – | flat | no |
| B | ShareActionSheet | `SocialFeedModal.tsx` (inline) | **22** | marginLeft:16 | 16 **w:500** | 14 | 20 | **none** | – | flat | no |
| C | UserProfileModal actionRow | `UserProfileModal.tsx` | 20 | 12 | 16 reg | 14 | **0** (inherited) | 1px full-width | – | flat | no |
| D | DMSettingsSheet | `Chat/DMSettingsSheet.tsx` | 20 | 12 | 16 + sub-12 | 14 | 20 | 1px full-width | – | flat (**centered dialog**) | no |
| E | **shared ActionSheet** | `shared/ActionSheet.tsx` | 20 | **14** | **17** body | 14 | **16** | hairline border, surface4, **card** | – | flat | **YES** |
| F | ShareInviteSheet | `ShareInviteSheet.tsx` | avatar | 12 | **15** w:600 + sub | **10** | 4 | none | **send icon** | flat | no |
| G | ShareToChatModal | `SocialFeedModal.tsx` (inline) | 20/avatar | 12 | **15** w:500 + sub | **12** | 16 | none | **chevron** | **uppercase headers** | no |
| H | ProfileModal settingRow | `ProfileModal.tsx` | **none** | – | **14** med + sub | 12 | 0 | border on row | **chevron** | sectioned | no |
| I | ProfileModal actionButton | `ProfileModal.tsx` | 20 | marginLeft:12 | **14** med | uniform **16** | 16 | none (card gap) | chevron (some) | sectioned | no |
| J | WalletModal settingsRow | `WalletModal.tsx` | **18** | 10 | **14** reg | 12 | 14 | none | **toggle** | single | no |

### Axes of inconsistency (the concrete divergences)

1. **Icon size:** 18 / 20 / 22 — or none.
2. **Gap mechanism:** `gap:10/12/14` vs `marginLeft:12/16` (some don't even use `gap`).
3. **Label font-size:** 14 / 15 / 16 / 17.
4. **Label weight:** `fontFamily` token vs hardcoded `'500'`/`'600'` vs `medium` token.
5. **Vertical padding:** 10 / 12 / 14 / 16.
6. **Horizontal padding:** 0 / 4 / 14 / 16 / 20.
7. **Divider:** none / inset 1px / full-width 1px / hairline-on-row.
8. **Trailing:** none / chevron / send-icon / toggle.
9. **Sections:** flat vs uppercase-header vs sectionTitle-grouped.
10. **Container:** bare rows vs rounded surface2 card.
11. **Presentation:** bottom sheet vs centered dialog vs scroll list.

## Audit — quorum-desktop (the inspiration)

Desktop already solved this for its web-mobile users with **one prop-driven
primitive** plus a small **BEM class vocabulary** for grouping:

- `MobileDrawer` (`src/components/ui/MobileDrawer.tsx`) — bottom sheet shell:
  portal + backdrop, 16px top radius, slide-up 300ms, swipe-to-close (100px),
  handle bar, optional title (uppercase, 14px, letter-spacing 0.5px), optional
  `headerContent`, max-height 80vh.
- Grouping vocabulary (composed as children, CSS-driven):
  - `.mobile-drawer__section` — group wrapper, `margin-bottom: 16px`
  - `.mobile-drawer__section-title` — header: 14px / weight 500 / uppercase /
    letter-spacing 0.5px / subtle color / margin `16px 8px 8px`
  - `.mobile-drawer__action-group` — rounded card: elevated bg, radius 8px,
    margin `12px 16px`, `overflow: hidden`
  - `.mobile-drawer__action-item` — the row: `padding 12px 16px`,
    `min-height 44px`, `gap 12px`, 1px bottom border (removed on last child),
    `:active` press bg
- `MessageActionsDrawer` (`src/components/message/MessageActionsDrawer.tsx`) —
  the concrete consumer: groups of `action-item` rows, `<Icon name>` + `<span>`,
  danger row via `color: rgb(var(--danger))`.

**Reference styling numbers (desktop):** row 44px min / pad 12×16 / gap 12 /
label 14px-400 / section-title 14px-500 uppercase ls-0.5 / group radius 8 /
group margin 12×16 / divider 1px removed-on-last / active press bg.

### Takeaway

Desktop's model = **a shell + a flat list of grouped rows, grouping done by
composition, dividers between rows inside a card, section titles between cards.**
That is exactly the shape mobile's `shared/ActionSheet` already half-implements.
We don't need a new paradigm; we need to **extend the existing mobile
`ActionSheet` with sections** and adopt it everywhere.

## Proposal

### Decision: extend `shared/ActionSheet`, don't add a parallel component

`shared/ActionSheet` already nails: `BaseModal` shell (swipe + backdrop dismiss,
handle, theming, safe-area), icon+label rows, destructive variant, rounded
surface2 card, hairline dividers, run-after-close behavior, haptics. It is
missing only **sections** and a few row affordances. Building a second component
would create an 11th variant. So:

1. **Add an optional `sections` API** to `ActionSheet` alongside the existing
   flat `actions` (backward-compatible — existing 4 call sites untouched).
2. **Extract the row** into an internal `<ActionRow>` so the visual contract
   lives in exactly one place.
3. **Standardize the row tokens** (single source of truth — see below).
4. **Migrate** the 6 bespoke surfaces to it, surface by surface.

### Canonical row spec (one source of truth)

Chosen by reconciling the 10 variants toward the most common + most accessible
values, and aligning with desktop:

| Token | Value | Rationale |
|-------|-------|-----------|
| Wrapper | `SkinTouchable` TouchableOpacity, `activeOpacity 0.6` | existing convention |
| Min height | 44px | touch-target floor (matches desktop + our mobile-first rule) |
| Icon | `IconSymbol` size **20** | the modal majority (7/10) |
| Gap | **12** | desktop + mobile majority (5/10); supersedes 14 in ActionSheet |
| Label | `textStyles.body` → keep, but **document = 16** | reconcile 16↔17; pick 16 to match the modal majority |
| V padding | **14** | sheet majority |
| H padding | **16** | inside-card majority + desktop |
| Divider | hairline, `surface4`, removed on last | keep ActionSheet's card model |
| Container | `surface2`, radius 14 | keep ActionSheet |
| Destructive | icon+label `danger` | universal |
| Disabled | `textMuted`, no press | existing |

### Proposed API

```ts
export interface ActionRowItem {
  label: string;
  icon?: string;                 // IconSymbol name; omit → aligned spacer
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
  sublabel?: string;             // NEW: optional secondary line (Patterns D/F/G need it)
  trailing?: 'chevron' | React.ReactNode;  // NEW: nav rows + custom (toggle/send)
  active?: boolean;              // NEW: success-tinted state (recast/selected)
  leading?: React.ReactNode;     // NEW: avatar/SpaceIcon instead of an icon (F/G)
}

export interface ActionSheetSection {
  title?: string;                // uppercase header between cards
  items: ActionRowItem[];
}

interface ActionSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  message?: string;
  // Exactly one of these:
  actions?: ActionRowItem[];          // flat (back-compat)
  sections?: ActionSheetSection[];    // grouped
}
```

**Grouping is designed-in but optional:** pass `actions` for a flat list (no
ceremony, existing behavior) or `sections` for grouped cards with headers. A
flat list is just the single-section case internally.

### Composition model (matches desktop)

```
BaseModal (shell: swipe/backdrop dismiss, handle)
└─ optional title/message header
└─ for each section:
     ├─ optional uppercase section title
     └─ rounded surface2 card
          └─ ActionRow × n  (hairline dividers between, none on last)
```

### Surface/contrast spec (set 2026-06-15 from dark-theme review)

The three stacked surfaces were too close in tone in dark mode (default Quorum):
sheet `surface1 #241f27` ~13% L, card `surface2 #2c252e` ~16%, divider
`surface4 #3a313f` ~22% — only ~3% sheet→card, so the card didn't read as
raised. Resolved by moving the card and divider up the ramp while **keeping the
sheet at `surface1`** (darkening it would collide with the page under the 0.6
black overlay, making the sheet indistinguishable from the dimmed screen).

| Element | Token | Dark hex | Light hex |
|---------|-------|----------|-----------|
| Sheet background | `surface1` (BaseModal, unchanged) | `#241f27` | `#f6f6f9` |
| Menu/group card | `surface3` (was surface2) | `#312935` | `#e6e6eb` |
| Row divider | `surface5` (was surface4) | `#443b49` | `#d5d5db` |

Plus `paddingTop: 12` on the sheet container for breathing room below the handle
bar before the first group. All component-local — global surface tokens
untouched.

### Section header spec

14px / weight 500 / uppercase / letterSpacing 0.5 / `textMuted` /
margin top 16, sides 8, bottom 8 — ported verbatim from desktop.

## Migration map

| Surface | Current pattern | Action |
|---------|-----------------|--------|
| `shared/ActionSheet` consumers (4) | E | tokens converge (17→16, gap 14→12); no API change |
| ShareActionSheet | B | replace inline rows with `<ActionSheet actions=…>` |
| MessageActionSheet | A | replace with `<ActionSheet actions=…>` (danger rows) |
| UserProfileModal actions | C | replace with `<ActionSheet actions=…>` |
| DMSettingsSheet | D | `<ActionSheet>` with `sublabel`; keep centered? (decision below) |
| ShareToChatModal | G | `<ActionSheet sections=…>` with `leading` avatars + `sublabel` + chevron |
| ShareInviteSheet | F | `leading` avatar + `trailing` send icon |
| ProfileModal setting/action rows | H/I | **out of scope v1** — these are in-page settings cards, not sheets; revisit |
| WalletModal settingsRow | J | `trailing` custom toggle (or leave; it's a single toggle row) |

**v1 target:** the true *sheet/menu* surfaces (A, B, C, D, F, G + the 4 existing
E consumers). In-page settings rows (H, I, J) are a separate, later pass — they
live inside scrollable screens, not bottom sheets, and conflating them risks
scope creep.

## Decisions (locked 2026-06-15)

1. **Label size = 16.** Standardize on 16; the 4 existing ActionSheet consumers
   converge down from 17 (`textStyles.body`). Row label no longer uses `body`;
   it uses an explicit 16px style.
2. **DMSettingsSheet → bottom sheet.** Drop the centered dialog; present it as a
   standard `BaseModal` bottom sheet like every other sheet.
3. **Name stays `ActionSheet`.** Extend in place, no rename, no alias.
4. **v1 scope = sheets/menus only.** A, B, C, D, F, G + the 4 existing E
   consumers. In-page settings cards (H ProfileModal settingRow, I ProfileModal
   actionButton, J WalletModal settingsRow) are deferred to a later pass.
5. Trailing `chevron` default color = `textMuted`.

## Architecture (revised 2026-06-15 mid-build)

The original "swap every surface to `<ActionSheet>`" plan was too optimistic:
several surfaces can't take the bottom-sheet shell — MessageActionSheet has an
emoji quick-react strip + a confirm dialog hosted on top + guarded close;
UserProfileModal's rows are embedded inside a scrollable profile modal;
DMSettingsSheet has Switch rows + confirm-on-top; ShareToChat/ShareInvite are
embedded search/scroll lists. What they actually share is the **row visual**,
not the sheet container.

So the unifying primitive is the **row**, extracted to
`components/shared/ActionRow.tsx`:

- `ActionRow` — standalone icon/leading + label + sublabel + trailing row,
  destructive/active/disabled states, standardized tokens, no divider of its
  own. Non-interactive when `onPress` is omitted (used for Switch rows).
- `ActionRowGroup` — wraps `ActionRow` children in the rounded surface2 card and
  stamps `isLast` to drop the trailing divider on the final row.
- `ActionSheet` — refactored to compose `ActionRowGroup`/`ActionRow`; public API
  (`actions`/`sections`/`ActionRowItem`/`ActionSheetAction`) unchanged.

Embedded surfaces import `ActionRow`/`ActionRowGroup` directly and keep their own
shell, Switch rows, confirm dialogs, and guarded close.

## Build sequence

1. ✅ Refactor `shared/ActionSheet`: sections + `sublabel`/`trailing`/`leading`/
   `active`; label standardized to `callout` (16). `ActionSheetAction` aliased.
2. ✅ Extract `ActionRow` + `ActionRowGroup` primitives; `ActionSheet` composes
   them; barrel exports updated.
3. ✅ Migrate B (ShareActionSheet) → `<ActionSheet actions>`.
4. ✅ Migrate C (UserProfileModal) → `ActionRowGroup`/`ActionRow` (embedded;
   kept the profile-modal shell). Dead row styles removed.
5. ✅ Convert D (DMSettingsSheet) centered dialog → `BaseModal` bottom sheet;
   action rows + Switch rows → `ActionRow`/`ActionRowGroup`. Dead styles removed.
6. ✅ A (MessageActionSheet) — action list → `ActionRowGroup`/`ActionRow`;
   emoji quick-react strip, confirm-dialog host, and guarded close untouched.
   Dead row styles removed.
7. ✅ G (ShareToChatModal) — Spaces / DMs / Channels rows → `ActionRow` with
   `leading` (SpaceIcon/avatar), `sublabel`, `trailing` (chevron / Farcaster
   badge), grouped per section. Inline row styles replaced by `shareToChatStyles`
   helper (header + group + avatar chrome only).
8. ✅ F (ShareInviteSheet) — DM rows → `ActionRow` with `leading` CachedAvatar +
   `sublabel` address + `trailing` send-icon/spinner. Tap-guard kept via the
   hook's own `if (sendingTo) return` (no row greying). Dead styles removed.
9. ⬜ Visual check on device across all migrated surfaces (dark + light).

**v1 complete.** All sheet/menu surfaces (A, B, C, D, F, G + the 4 pre-existing
ActionSheet consumers) now render through the shared `ActionRow` primitive.

**H/I/J intentionally NOT migrated (reviewed 2026-06-15, decided to leave as-is).**
On inspection they are a *different* pattern, not the ActionRow shape:
- I (ProfileModal `actionButton`): each action is its own standalone rounded
  surface2 card (not rows-in-a-group-with-dividers); the danger variant uses a
  red-TINTED background (`danger + '20'`), font is 14/medium, and there are 6
  sites with per-site overrides. Forcing ActionRow would either redesign them
  (merge cards, lose the tint) or bloat the primitive with per-row background +
  tint + size options.
- H (ProfileModal `settingRow`): label-lead, no leading icon — ActionRow's
  icon gutter doesn't fit.
- J (WalletModal `settingsRow`): a single row with a fully custom toggle widget.
These are a separate design question ("should action-cards / settings toggles
share a look"), not duplication of the sheet row. Out of scope for this work.

*Last updated: 2026-06-15*
