import { useTheme } from '@/theme';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Must match AppTabBar constants
const PRIMARY_ROW_HEIGHT = 54;
const BOTTOM_MARGIN = 12;
// How tall the gradient fade is above the pill
const GRADIENT_HEIGHT = 48;

/**
 * Subtle bottom-fade overlay that sits behind the floating tab bar pill.
 * Starts transparent at the top and fades to the screen background color
 * at the bottom, giving a visual cue that list content continues below.
 */
export function TabBarGradient() {
  const { isDark } = useTheme();
  const insets = useSafeAreaInsets();

  // Sit just above the safe-area / nav-bar zone so we never paint over the
  // Android system nav buttons. Android handles the nav-bar background itself;
  // content scrolls under it naturally. Our job is only to fade the list
  // content as it approaches the pill from above.
  const bottomEdge = insets.bottom + BOTTOM_MARGIN;
  const totalHeight = PRIMARY_ROW_HEIGHT + GRADIENT_HEIGHT;

  const solid = isDark ? '#000000' : '#ffffff';
  const clear = isDark ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0)';

  return (
    <View
      style={[styles.container, { bottom: bottomEdge, height: totalHeight }]}
      pointerEvents="none"
    >
      <LinearGradient
        // Transparent at top → solid at bottom (pill level).
        colors={[clear, solid]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
});
