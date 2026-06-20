import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Height of the tab bar's icon row (matches PRIMARY_ROW_HEIGHT in AppTabBar.tsx).
const TAB_BAR_HEIGHT = 54;
// Extra breathing room so the last item isn't flush against the bar.
const EXTRA = 24;

/**
 * Returns the bottom contentContainerStyle padding that scrollable screens
 * need so their last item is reachable without being permanently hidden
 * behind the tab bar (which sits flush to the bottom in edge-to-edge mode).
 *
 * The bar's visual footprint is TAB_BAR_HEIGHT + insets.bottom, so list
 * content must clear that plus a little breathing room.
 *
 * Use this instead of useBottomTabBarHeight() for screens that have a list
 * scrolling to the very bottom of the device.
 */
export function useFloatingTabBarPadding(): number {
  const insets = useSafeAreaInsets();
  return TAB_BAR_HEIGHT + insets.bottom + EXTRA;
}
