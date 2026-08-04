---
type: task
title: "Nav bar redesign — avatar in bar, second row of extras, header cleanup"
status: done
created: 2026-06-18
priority: medium
effort: medium
---

# Nav bar redesign

## Problem / motivation

The current bottom tab bar has 5 icon-only tabs: Spaces, Messages, Feed, Wallet, Notifications. A circular user avatar (`HeaderAvatar`) lives in the **top-left corner of every main screen header**, which wastes header real-estate and fragments the account entry point.

The screenshot from the design session shows the new target: a **two-row expandable bottom bar**. Row 1 is the persistent icon row (now includes the avatar). Row 2 slides up on demand and exposes secondary destinations.

---

## Design decisions (locked 2026-06-18)

1. **Avatar moves into the tab bar** — the circular profile picture / initials button becomes the leftmost icon in the bottom bar's persistent row. It navigates to `/account` as before.
2. **Headers drop the avatar** — wherever `<HeaderAvatar />` was the left slot, that slot is removed and the screen title (text) shifts from center-aligned to left-aligned.
3. **Second row ("extras")** — the expandable row contains: Wallet, Bookmarks, Discover, MiniApps, QNS. The "…" (three-dot) icon in the persistent row toggles this row open/closed.
4. **Icon order — persistent row (left → right):**
   - Avatar (profile picture / initials)
   - Spaces (`person.3`)
   - Messages (`message`)
   - Feed (`globe`)
   - Notifications (bell, with unread dot)
   - "More" toggle (`ellipsis` / `...`, opens second row)
5. **Icon order — second row (left → right):**
   - Wallet (`wallet.pass`)
   - Bookmarks (`bookmark`)
   - Discover (`safari` or `compass`)
   - MiniApps (`square.grid.2x2` or similar)
   - QNS (`at` — placeholder until custom icon ships)
6. **Wallet removed from the persistent row** — it moves to the second row.
7. **"More" toggle** — a three-dot icon at the right end of the persistent row. Tapping it animates the second row in/out (slide up + fade). Tapping it again, or tapping any item in the second row, closes the row.

---

## Current structure (reference)

Persistent row today (5 tabs, no avatar):
```
Spaces | Messages | Feed | Wallet | Notifications
```

Target persistent row (6 items including avatar + more toggle):
```
[Avatar] | Spaces | Messages | Feed | Notifications | [...]
```

Target second row (5 items, hidden by default):
```
Wallet | Bookmarks | Discover | MiniApps | QNS(@)
```

---

## Implementation sketch

### 1. Custom tab bar component (`components/ui/AppTabBar.tsx`)

The default Expo Router `<Tabs>` tab bar cannot render two rows or a non-tab "avatar" button. Replace it with a **fully custom tab bar**:

- Renders a `position: absolute` container at the bottom of the screen.
- Inner structure:
  - `PrimaryRow` — avatar button + the 4 persistent tab icons + more-toggle button. Height = current `TAB_BAR_CONTENT_HEIGHT (50)` + `insets.bottom`.
  - `SecondaryRow` — the 5 extras. Shown/hidden via `Animated.View` (slide + fade). Height = same 50pt icon row.
- Keep `TabBarBackground` (BlurView) behind both rows.
- Keep `HapticTab` haptic feedback on every press.
- Expose height via a new `useAppTabBarHeight()` hook (or extend the existing `useBottomTabBarHeight()` usage) so screens that pad themselves (composer chrome, etc.) can react to the variable height (open vs. closed second row).

### 2. Expo Router wiring

In `app/(tabs)/_layout.tsx`:
- Add `tabBar` prop to `<Tabs>` pointing to `AppTabBar`.
- Remove `Wallet` tab from the visible set (keep the route — just don't render it as a primary tab; it's reached via the second row button).
- `Account` stays `href: null`; the avatar button in the custom bar calls `router.push('/account')` directly.

### 3. Header cleanup

Remove `<HeaderAvatar />` from every screen it currently appears in. Change title alignment from `center` to `left` (or remove explicit centering):

- `app/(tabs)/spaces/index.tsx` — remove HeaderAvatar from left slot, left-align title
- `app/(tabs)/messages/index.tsx` — same
- `app/(tabs)/profile/index.tsx` — same
- `app/(tabs)/wallet/index.tsx` — same
- `components/SocialFeedModal.tsx` — same for the two `isRouteMode` header instances

### 4. `HeaderAvatar` component

Either delete the component entirely (if no other usages) or keep it for non-tab screens that still legitimately need it. Check usages first.

### 5. Second-row navigation targets

These are **not** Expo Router tabs — they are imperative `router.push()` calls from the second-row buttons. Each icon needs a label underneath (the second row shows icon + label, matching the screenshot). Destinations:
- Wallet → `/wallet` (existing route)
- Bookmarks → **disabled** (feature not yet migrated from desktop; render as grayed-out button with no `onPress`)
- Discover → `/discover` (existing route)
- MiniApps → `/miniapps` (existing route — confirm exact path)
- QNS → `/qns` (existing route — use `at` icon as placeholder until custom icon ships)

For destinations that don't yet exist as routes, the button should be present but either disabled or navigate to a placeholder. Confirm which routes exist before implementing.

### 6. Animation

Second row toggle:
- `useAnimatedValue` or `useSharedValue` (Reanimated) for `extraRowHeight` (0 → 50).
- Animate `height` + `opacity` together on open/close.
- The tab bar's reported height (used by content padding) must update in sync so the list/scroll content doesn't jump.

---

## Files to touch

- `app/(tabs)/_layout.tsx` — add `tabBar` prop, remove Wallet from primary tabs
- `components/ui/AppTabBar.tsx` (new) — fully custom two-row tab bar
- `components/HeaderAvatar.tsx` — review; delete or keep for non-tab screens
- `app/(tabs)/spaces/index.tsx` — remove HeaderAvatar, left-align title
- `app/(tabs)/messages/index.tsx` — same
- `app/(tabs)/profile/index.tsx` — same
- `app/(tabs)/wallet/index.tsx` — same
- `components/SocialFeedModal.tsx` — same (isRouteMode header instances)
- `hooks/useBottomTabBarHeight.ts` (or equivalent) — expose variable height for open second row

---

## Resolved design decisions (2026-06-18)

1. **Second-row routes** — Discover, MiniApps, QNS all exist as routes. Bookmarks has NO route (feature not migrated from desktop). Bookmarks button is rendered as a **disabled/grayed-out button** so users can see it's coming but cannot tap it. No placeholder screen needed.
2. **Second row closes on any tap** — tapping any item in the second row (including Bookmarks if we ever enable it) closes the row after navigating. Also closes when tapping the `...` toggle again.
3. **Emoji panel** — no change needed; existing hide-tab-bar logic is fine as-is.
4. **No swipe gesture** — the second row has no swipe open/close. It is toggled exclusively by the `...` button. No gesture conflict concern.

---

## Notes

- `HeaderAvatar` is in 5 locations; all must be cleaned up or the avatar will appear twice (bar + header).
- The `account` tab route remains `href: null` — the avatar button is the sole entry point.
- QNS icon is `at` placeholder. When the custom icon ships, swap `IconSymbol` name only.
- Second-row labels (Wallet, Discover, etc.) match the screenshot and are needed for discoverability — don't make it icon-only.
- This task is self-contained; no dependency on the space folders pill bar task.

*Last updated: 2026-06-18 — open questions resolved: bookmarks disabled (not migrated), second row closes on tap, no swipe gesture, emoji panel unchanged.*
