/**
 * ListBottomFade — a soft gradient scrim for full-screen list tabs (Spaces,
 * Messages, Notifications) whose content scrolls behind the floating tab bar.
 *
 * These screens have no composer, so they don't need the full chat-style fade
 * (see ChatBottomChrome). They just want the content that scrolls into the
 * tab-bar / device-button zone to be gently dimmed rather than crisply visible.
 * This renders a short transparent→semi-opaque gradient anchored to the screen
 * bottom, sized to cover the tab bar plus the system nav-bar inset.
 *
 * Place it as the last child of the screen container (a sibling after the list)
 * so it sits above the list in z-order. It ignores touches.
 */

import { withAlpha } from '@/theme/skins/mergeSkin';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Matches PRIMARY_ROW_HEIGHT in AppTabBar.tsx.
const TAB_BAR_HEIGHT = 54;
// How opaque the scrim gets at the very bottom. Kept below 1 so content stays
// faintly visible (dimmed, not hidden) behind the device buttons.
const MAX_OPACITY = 0.85;

interface ListBottomFadeProps {
  /** Chat/screen background the scrim resolves toward (theme.colors.surface1). */
  surfaceColor: string;
}

export function ListBottomFade({ surfaceColor }: ListBottomFadeProps) {
  const insets = useSafeAreaInsets();
  const height = TAB_BAR_HEIGHT + insets.bottom;

  // withAlpha is format-agnostic (hex or rgba); falls back to the input color
  // unchanged if it can't parse, which is harmless here.
  const solid = withAlpha(surfaceColor, MAX_OPACITY);

  return (
    <LinearGradient
      colors={['transparent', solid]}
      start={{ x: 0, y: 0 }}
      end={{ x: 0, y: 1 }}
      style={[styles.fade, { height }]}
      pointerEvents="none"
    />
  );
}

const styles = StyleSheet.create({
  fade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
});
