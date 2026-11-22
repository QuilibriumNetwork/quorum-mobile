---
type: task
status: done
title: "Shared pill/segmented menu primitive + UX fixes (in modals)"
created: 2026-06-17
updated: 2026-06-17
---

# Shared pill/segmented menu primitive + UX fixes

> **Dormant migration note (2026-06-17):** `CreateProposalSheet` (Protocol/Client scope + category/area pill rows) was migrated to `SegmentedPills`, but `GovernanceView` — the only component that renders it — is **never mounted anywhere** (`<GovernanceView` has zero render sites; `SocialFeedModal` imports it but never uses it). So the migrated pills are correct but currently **unreachable in the running app**. Left in place: ready if governance UI is ever wired in. Not a bug introduced here — the dead-code path predates this work.

## Goal

Build a **shared pill/segmented selector component** and migrate the hand-rolled pill rows in the modals onto it, fixing three problems in one place:

1. **Active pill has no visible background.** On most skins the active background (`surface1`) is too close in lightness to the inactive (`surface3`) and the modal surface, so the selected pill reads as invisible. Active pills should get a **dimmed accent background** — the `accentSoft` token (12% accent) already exists in the theme for exactly this.
2. **Tapping a pill in a scrollable row doesn't bring it into view.** None of the scrollable pill rows auto-scroll. The tapped pill should **scroll toward centre** so the selection visibly lands.
3. **Three inconsistent active-pill styles coexist with no shared component.** Surface-swap (invisible), tinted-accent (via inline `+ '20'` hacks), and solid-fill. Converge the genuine pills on one tinted-accent standard.

## Decision: build it as a component

**Yes — a shared component is the right move.** Confirmed with the user. Two scopes were considered:

### Where it lives (decided)

- **Now: mobile-local primitive** in `quorum-mobile/components/ui/` — `SegmentedPills.tsx` + `hooks/useCenteredPillScroll.ts`. This is a pure-UI mobile change, safe to ship on mobile without lead-dev coordination (user's explicit call: "this is just a UI implementation, safe to do on mobile, we're confident").
- **Later (optional, not blocking): promote to `quorum-shared/src/primitives/`.** Shared HAS a real cross-platform primitives system (`Button`, `Select`, `Tooltip`, `Modal`, `Callout`, `RadioGroup`, `Switch`…), each with `BaseXProps` + `WebXProps`/`NativeXProps` and `X.web.tsx`/`X.native.tsx` split by bundler resolution, exported via `src/primitives/index.ts`. A `SegmentedControl` slots right next to `RadioGroup` (its closest analog: pick one of N options). Promotion = move the native file + add a `.web.tsx` sibling, NOT a rewrite — **so we build the mobile version to that primitive contract from day one** to keep promotion cheap.

> Why not build it directly in shared now: a shared primitive means publish shared + bump mobile (atlas §3: mobile is pinned npm, no auto-publish) AND migrating desktop's own hand-rolled pills to justify it. That's a 3-repo effort. The reported problem is 100% mobile. Build mobile-local now, promote later if desktop wants it — that promotion is the cross-repo decision worth a lead-dev heads-up, and it's not blocking today's fix.

## Component design (promotion-ready, mirrors the Button/RadioGroup primitive shape)

Follow the existing primitive conventions seen in `quorum-shared/src/primitives/Button/`:
- `props.type`-style enum dispatch via a `getXStyle()` builder.
- `useTheme()` for all colors (here: the mobile `theme.colors` from `theme/themes.ts`).
- `hapticFeedback` opt-in (Button.native uses `expo-haptics` `ImpactFeedbackStyle.Light`).
- `accessibilityRole`, `accessibilityState`, `accessibilityLabel` on each item.
- Options-array driven (like `RadioGroup` / `Select`), NOT children-only, so the data shape is portable to web.

### `useCenteredPillScroll.ts` (the behavior, fix #2)

Headless hook — any row gets centering by spreading props. Keep it separate so underline-style tabs (Profile, Governance) could adopt centering WITHOUT pill styling later.

```ts
export function useCenteredPillScroll() {
  const scrollRef = useRef<ScrollView>(null);
  const viewportW = useRef(0);
  const layouts = useRef<Record<string, { x: number; width: number }>>({});

  const scrollViewProps = {
    ref: scrollRef,
    horizontal: true as const,
    showsHorizontalScrollIndicator: false,
    onLayout: (e: LayoutChangeEvent) => { viewportW.current = e.nativeEvent.layout.width; },
  };
  const onItemLayout = (key: string) => (e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    layouts.current[key] = { x, width };
  };
  const center = (key: string) => {
    const l = layouts.current[key];
    if (!l || !scrollRef.current) return;
    const target = l.x + l.width / 2 - viewportW.current / 2;
    scrollRef.current.scrollTo({ x: Math.max(0, target), animated: true });
  };
  return { scrollViewProps, onItemLayout, center };
}
```

Notes:
- RN clamps the upper scroll bound automatically; we only clamp `>= 0`.
- Works with the inner-ScrollView layout `x` because pills are direct children of the scrolled content.

### `SegmentedPills.tsx` (the look, fixes #1 + #3)

```ts
export type PillVariant = 'tinted' | 'solid'; // tinted = accentSoft bg (default); solid = full accent fill (round icon chips)

export interface SegmentedPillItem {
  key: string;
  label?: string;
  icon?: IconSymbolName;
  accentColor?: string;          // per-item override (chain brand colors); falls back to theme accent
  imageUrl?: string;             // round image chips (feed followed-channels)
  danger?: boolean;              // red active state (Space Settings "Danger" tab)
}

export interface SegmentedPillsProps {
  items: SegmentedPillItem[];
  activeKey: string | null;      // null allowed (Reactions toggle-off)
  onChange: (key: string) => void;
  variant?: PillVariant;         // default 'tinted'
  scrollable?: boolean;          // default true; false = fixed flex row, no centering
  centerOnSelect?: boolean;      // default true when scrollable
  hapticFeedback?: boolean;      // default false
  allowDeselect?: boolean;       // Reactions: tap active → null
}
```

Active-state standard baked in (`getPillStyle`):
- **tinted (default):** active bg `theme.colors.accentSoft`, text/icon `accentColor ?? theme.colors.primary` (`theme.colors.danger` when `item.danger`). Inactive bg `surface3`, text/icon `textMuted`. Optional active `borderColor: accent` for definition on light skins (verify on `theme/skins/samples.ts` light skin, accent `#c2410c`).
- **solid:** active bg `accentColor ?? theme.colors.primary`, text/icon `surface0`. For the round feed icon chips that deliberately keep a stronger look.

Replaces every inline `primary + '20'` / `accent + '22'` / hardcoded `rgba(...)` with the token-driven standard.

## Theme tokens (already exist — `theme/themes.ts:131-134`)

```ts
accentSoft:   withAlpha(pick('accent', accent[500]), 0.12),  // 12% accent — the active-pill bg
accentSubtle: withAlpha(pick('accent', accent[500]), 0.06),  //  6% accent — press/hover
```

Both on `theme.colors`, typed at `theme/themes.ts:33-34`, re-skin correctly. Underused today.

## Migration map — files to move onto the component

### Scrollable rows (`scrollable`, default tinted, centering on)
- **`components/SpaceSettingsModal.tsx`** — tab bar, render `~2402-2437`, styles `tabActive` `~2528-2530`. **Primary case** the user is looking at: 10 tabs, scrollable, `surface1` active = invisible. icon+label items; `danger` flag on the Danger tab.
- **`components/SocialFeedModal.tsx`** — filter chips, TWO instances (`~6367-6423` full + `~6558-6593` mini). Round icon chips → `variant="solid"`. Also has followed-channel image chips in the same row (`imageUrl` items, non-selecting → keep those as plain chips or pass through). Add centering.
- **`components/WalletModal.tsx`** — chain filter pills `~575-603` (tinted; `accentColor` per chain via `getChainColor`; replaces `+ '20'`). The two switchers above (`~425-494`) are fixed 2–4 button rows → `scrollable={false}`, optional accent fix.
- **`components/Chat/ReactionDetailsModal.tsx`** — reaction pills `~125-146`. emoji+count items; `allowDeselect` (tap active → null). Already the closest to the target look.
- **`components/Chat/EmojiPicker.tsx`** — category tabs `~412-432`. icon-only, very subtle `surface3` active. Lower priority; migrate for consistency.
- **`components/wallet/SwapModal.tsx`** — chain selector `~1834-1851`, hardcoded `rgba(...)` active (weakest). Nested panel; tinted.

### Fixed rows (`scrollable={false}`, no centering, accent-bg consistency)
- **`components/SpaceModal.tsx`** — Join/Create `~207-225`, `surface1` swap → tinted.
- **`components/qns/OffersModal.tsx`** — Received/Sent `~405-430`, solid `primary` + hardcoded `#fff`. Soften to tinted for consistency (or keep `variant="solid"` if the bold look is wanted — confirm with user).

### Leave as-is (underline pattern, NOT pills)
- `components/ProfileModal.tsx` tabs (`~1578-1598`) — underline only. Correct tab pattern. Could adopt `useCenteredPillScroll` alone later if it ever scrolls; no pill styling.
- `components/SocialFeed/views/GovernanceView.tsx` sub-tabs (`~159-176`) — underline only.

## Build order — ALL DONE (awaiting device test)

1. ✅ `hooks/useCenteredPillScroll.ts` — built. Lint/type clean.
2. ✅ `components/ui/SegmentedPills.tsx` — built. tinted + solid variants; options-driven; a11y; haptics; fixed/scrollable; per-item accentColor + danger; allowReselect; leading/trailing escape hatches (custom-emoji image, count badge, color dot); emojiSize/iconSize knobs. Lint/type clean.
3. ✅ `SpaceSettingsModal` tab bar — SegmentedPills (tinted, scrollable, danger flag).
4. ✅ `WalletModal` chain pills — SegmentedPills (tinted, per-chain accentColor).
5. ✅ `ReactionDetailsModal` reaction pills — SegmentedPills (leading=custom-emoji image, count, allowReselect toggle-off).
6. ✅ `SwapModal` chain selector — SegmentedPills (leading=color dot, per-chain accentColor).
7. ✅ `SpaceModal` Join/Create — SegmentedPills (fixed row on the surface3 track).
8. ✅ `OffersModal` Received/Sent — SegmentedPills (fixed, softened solid→tinted, trailing=count badge restyled to accent).
9. ✅ `EmojiPicker` category tabs — SegmentedPills (emoji items, emojiSize=22).
10. ✅ `SocialFeedModal` filter chips (×2) — **hook-only** (kept bespoke circular/solid chips + the shared image-chip row; added center-on-tap via useCenteredPillScroll).

All dead per-modal pill `StyleSheet` entries + inline `+'20'`/`+'22'`/`rgba()` hacks removed.

**Verification:** `tsc --noEmit` → 23 pre-existing errors, 0 in touched files. `eslint` → new files clean; the only errors in touched files are pre-existing (SpaceSettings unescaped-entity JSX ×2; SocialFeed conditional useEffect — both on master).

### Branch: `feat/segmented-pills-primitive` (off master)

### Device test checklist (you, on Android) — one screen at a time:
- [ ] **Space Settings** tab bar: active tab tinted + centers on tap; Danger tab red when active.
- [ ] **Wallet** chain pills: active pill tinted in the chain's brand color; centers on tap.
- [ ] **Reactions** (long-press a reaction): active pill tinted; tap again toggles off; custom-emoji images render.
- [ ] **Swap → Add custom token** chain selector: color dot + active tint; centers.
- [ ] **Spaces → New space** Join/Create: segmented look intact on the track.
- [ ] **QNS Offers** Received/Sent: tinted active; count badge still shows + legible.
- [ ] **Emoji picker** category tabs: active tinted; emoji glyphs full-size (22).
- [ ] **Social feed** filter chips: still solid round chips; now center on tap (both full + mini views).

## Verification checklist

- [ ] Active pill clearly distinguishable on BOTH a dark and a light skin (`theme/skins/samples.ts`).
- [ ] Tapping an off-screen / edge tab in Space Settings scrolls it toward centre.
- [ ] Tapping a feed filter chip centres it.
- [ ] Danger tab keeps red active text/icon (not accent).
- [ ] Reactions pill still toggles off on second tap (`allowDeselect`).
- [ ] Chain pills keep per-chain brand color (`accentColor` override) on active.
- [ ] Fixed 2-button switchers (Wallet, Space Join/Create) unaffected by centering.
- [ ] Underline tabs (Profile, Governance) untouched.
- [ ] No new native dep; hand-rolled scroll + existing `expo-haptics` only.
- [ ] **iOS review pass** (atlas §3): pills inside `BaseModal` (`animationType="none"`) — fine; check `hitSlop` reaches 44pt on iOS; `accessibilityRole="tab"`/`"button"` correct. iOS unverified at runtime — reasoned via review.
- [ ] `npx tsc --noEmit --jsx react-jsx --skipLibCheck` + `yarn lint` clean.
- [ ] Built to the shared-primitive contract (Base/Native props shape, options-array) so a future `quorum-shared` promotion is a move-not-rewrite.

## Shipping

- Commit type `style:` (UI/visual polish), NOT `chore:`.
- ONE branch → single PR; each migration its own `style:` commit, PR body lists them (atlas §6: batch small fixes, squash-merge).
- Self-explanatory branch name, no internal jargon (e.g. `feat/segmented-pills-primitive`).
- Mobile-only: NO shared change, NO version bump this PR.
- Runtime-test on Android before `/ship-pr` (user approves the ship).
- If/when promotion to `quorum-shared` is on the table later → that's a separate cross-repo effort + a one-line Telegram heads-up to the lead (atlas §4).

*Last updated: 2026-06-17*
