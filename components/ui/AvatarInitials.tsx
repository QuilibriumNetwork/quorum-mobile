/**
 * AvatarInitials — the shared initials + gradient renderer used by both
 * DefaultAvatar (users) and SpaceIcon (spaces).
 *
 * Reproduces desktop's "Telegram-like" look 1:1: a deterministic color
 * derived from the display name, rendered as a subtle 2-stop vertical
 * gradient (lighter top → darker bottom) for depth. Unknown names ("?")
 * render on a neutral grey gradient.
 *
 * The sophistication lives in the shared pure functions
 * (getInitials / getColorFromDisplayName / lightenColor / darkenColor);
 * this component is just the React Native renderer around them.
 *
 * Reference: quorum-desktop/src/components/user/UserInitials/UserInitials.native.tsx
 */

import React, { useMemo } from 'react';
import { StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import {
  getInitials,
  getColorFromDisplayName,
  lightenColor,
  darkenColor,
} from '@quilibrium/quorum-shared';

// Unknown user/space gradient colors (matches desktop's web CSS).
const UNKNOWN_GRADIENT_LIGHT = '#9d9da3';
const UNKNOWN_GRADIENT_DARK = '#7a7a7f';

interface AvatarInitialsProps {
  /** Display name to derive initials + color from. */
  name: string;
  /** Pixel diameter. */
  size: number;
  style?: StyleProp<ViewStyle>;
}

export function AvatarInitials({ name, size, style }: AvatarInitialsProps) {
  const initials = useMemo(() => getInitials(name), [name]);

  // Unknown user/space → grey gradient (O(1) check on the computed initials).
  const isUnknown = initials === '?';

  const gradientColors = useMemo(() => {
    if (isUnknown) {
      return [UNKNOWN_GRADIENT_LIGHT, UNKNOWN_GRADIENT_DARK] as const;
    }
    const base = getColorFromDisplayName(name);
    return [lightenColor(base, 5), darkenColor(base, 10)] as const;
  }, [name, isUnknown]);

  return (
    <LinearGradient
      colors={gradientColors}
      style={[
        styles.container,
        { width: size, height: size, borderRadius: size / 2 },
        style,
      ]}
    >
      <Text style={[styles.initials, { fontSize: size * 0.4 }]}>{initials}</Text>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    color: '#ffffff',
    fontWeight: '500',
    textAlign: 'center',
  },
});

export default AvatarInitials;
