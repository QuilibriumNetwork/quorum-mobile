import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Matches the constants in AppTabBar.tsx
const PRIMARY_ROW_HEIGHT = 54;
const BOTTOM_MARGIN = 12;
// Extra breathing room so the last item isn't flush against the pill
const EXTRA = 12;

/**
 * Returns the bottom contentContainerStyle padding that scrollable screens
 * need so their last item is reachable without being permanently hidden
 * behind the floating tab bar pill.
 *
 * Use this instead of useBottomTabBarHeight() for screens that have a list
 * scrolling to the very bottom of the device.
 */
export function useFloatingTabBarPadding(): number {
  const insets = useSafeAreaInsets();
  return PRIMARY_ROW_HEIGHT + BOTTOM_MARGIN + insets.bottom + EXTRA;
}
