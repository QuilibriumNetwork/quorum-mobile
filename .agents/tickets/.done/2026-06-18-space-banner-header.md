---
type: task
title: "Space channels screen banner header"
status: done
complexity: high
ai_generated: true
created: 2026-06-18
updated: 2026-06-18
related_issues: []
related_docs: []
related_tasks: []
---

# Space channels screen banner header

> **⚠️ AI-Generated**: May contain errors. Verify before use.

**Files**:
- `app/(tabs)/spaces/[id]/index.tsx` — major rewrite (hide Stack header, integrate SpaceBannerHeader)
- `components/SpaceBannerHeader.tsx` — new component
- `components/SpaceDescriptionSheet.tsx` — new component
- `app/(tabs)/spaces/_layout.tsx` — possibly, if header config needs moving

## What & Why

Replace the plain Stack navigator title header on the space channels screen with a full-width banner header mirroring the desktop (`quorum-desktop/src/components/space/ChannelList.tsx`) pattern. Improves visual identity of each space and makes the space feel more distinct.

## Context

- **Desktop reference**: `../quorum-desktop/src/components/space/ChannelList.tsx` + `ChannelList.scss` — banner height 132px, blur 28px, gradient `rgba(surface-00, 0.92)→transparent` over 75% height
- **Existing pattern**: `expo-linear-gradient` already used in `components/ui/Card.tsx`; `expo-blur` already used in `components/ui/TabBarBackground.ios.tsx`
- **Space fields**: `space.bannerUrl` (real banner), `space.iconUrl` (fallback blur) — both plain URL strings on the shared `Space` type
- **Android constraint**: min SDK 24 — `BlurView` RenderEffect needs API 31+, so blur fallback needs a Platform split

## Design decisions

- Stack header hidden for this screen only (`headerShown: false` in `Stack.Screen options`)
- Banner height: **140px** (slightly taller than desktop 132px to feel right on mobile)
- Banner image: `space.bannerUrl` → `<Image resizeMode="cover">` filling full width
- No-banner fallback: `space.iconUrl` rendered at 200% width, centered, with blur effect
  - iOS: `<BlurView intensity={80}>` wrapping the image
  - Android: image + stacked semi-transparent `surface1` overlay (3 layers, ~0.35 opacity each)
- Bottom gradient: `<LinearGradient>` from `surface1` (opacity 0.92) → transparent, height 75% of banner, positioned absolute bottom
- Button row at top of banner, padded by `insets.top`:
  - Left: back chevron (`chevron.left`, 20px)
  - Right: invite (`person.badge.plus`, 20px) + gear (`gearshape`, 20px)
  - Each button: frosted pill 32×32, `borderRadius: 6`, `background rgba(surface1, 0.65)`, BlurView on iOS / plain View on Android
- Space name: bottom-left of banner, on top of gradient, `textStyles.title3`, white or `textMain`
- Description trigger: small `info.circle` icon (`textMuted`, size 14) to the right of space name — taps open `SpaceDescriptionSheet`
- `SpaceDescriptionSheet`: bottom sheet showing space icon (48px) + space name (`title2`) + full description (`body`, `textMuted`). Use existing bottom sheet pattern from the project.

## Prerequisites

- [ ] Check existing bottom sheet usage in the project for the pattern to follow for `SpaceDescriptionSheet`
- [ ] Verify `expo-blur` import path used in `TabBarBackground.ios.tsx`
- [ ] Verify `expo-linear-gradient` import path used in `Card.tsx`
- [ ] Branch `feat/space-banner-header` created from `master`

## Implementation

### Phase 1: SpaceBannerHeader component

- [ ] **Create `components/SpaceBannerHeader.tsx`**
  - Props: `space` (Space), `onBack`, `onInvite`, `onSettings`, `onDescriptionPress`, `insets` (top safe area)
  - Render: banner image layer → blur fallback layer → gradient → button row → name + description trigger
  - Done when: renders correctly with and without `bannerUrl`, buttons all fire their callbacks
  - Verify: TypeScript compiles, no layout warnings

- [ ] **Implement banner image layer**
  - `space.bannerUrl` non-empty → `<Image source={{ uri }} style={absoluteFill} resizeMode="cover">`
  - Done when: image fills the 140px banner edge-to-edge

- [ ] **Implement blur fallback (no bannerUrl)**
  - iOS: `<Image>` at 200% width inside `<BlurView intensity={80} tint="dark">`
  - Android: `<Image>` at 200% width + 3× `<View>` with `backgroundColor: surface1, opacity: 0.35`
  - Done when: looks blurred/softened on both platforms without a banner

- [ ] **Implement bottom gradient**
  - `<LinearGradient colors={[surface1_92, 'transparent']} start={{ x:0, y:1 }} end={{ x:0, y:0 }}>`
  - Position absolute, bottom 0, height 75% of banner (105px)
  - Done when: gradient smoothly fades from surface1 upward

- [ ] **Implement frosted button pills**
  - Platform split: `BlurView` wrapper on iOS, plain `View` with `rgba(surface1, 0.65)` on Android
  - Back button left, invite + gear right, all padded by `insets.top`
  - Done when: buttons are legible over both light and dark banner images

- [ ] **Implement space name + description trigger**
  - Name: `textStyles.title3`, color `#fff` (always — sits on gradient/banner), `numberOfLines={1}`
  - Description icon: `info.circle`, size 14, `textMuted` color, `hitSlop={8}`, only rendered if `space.description` is non-empty
  - Done when: name truncates correctly, icon taps fire `onDescriptionPress`

### Phase 2: SpaceDescriptionSheet component

- [ ] **Create `components/SpaceDescriptionSheet.tsx`**
  - Props: `visible`, `onClose`, `space` (Space)
  - Content: space icon (48px, rounded), space name (`title2`), description (`body`, `textMuted`), close button
  - Follow existing bottom sheet pattern in the project
  - Done when: opens/closes smoothly, scrolls if description is long

### Phase 3: Wire into index.tsx

- [ ] **Hide Stack header** — `<Stack.Screen options={{ headerShown: false }} />`
  - Done when: native header no longer appears

- [ ] **Replace ScrollView header area** — render `<SpaceBannerHeader>` above the channel groups, pass all callbacks
  - Done when: banner renders, all buttons open the correct modals

- [ ] **Add SpaceDescriptionSheet** — lazy-load alongside SpaceSettingsModal and InviteModal, wire `onDescriptionPress`
  - Done when: tapping description icon opens the sheet

- [ ] **Remove now-redundant `description` Text** — the inline description below the old header is superseded
  - Done when: no duplicate description text on screen

## Verification

✅ **Banner with real bannerUrl**
   - Test: open a space that has a banner image set — image fills the header edge-to-edge
✅ **Banner fallback (no bannerUrl, has iconUrl)**
   - Test: open a space with no banner — icon appears zoomed and blurred/softened
✅ **Banner fallback (no bannerUrl, no iconUrl)**
   - Test: open a space with nothing set — gradient over a solid surface1 background, no crash
✅ **Description sheet**
   - Test: tap the info icon — sheet opens with icon, name, full description
✅ **Buttons all work**
   - Test: back navigates back, gear opens SpaceSettingsModal, invite opens InviteModal
✅ **Safe area respected**
   - Test: on a device with a notch/dynamic island — buttons are not hidden under the status bar
✅ **TypeScript compiles** — `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
✅ **No console errors on both platforms**

## Definition of Done

- [ ] All phases complete
- [ ] All verification tests pass
- [ ] No console errors on iOS and Android
- [ ] Task updated with any deviations

*Last updated: 2026-06-18*
