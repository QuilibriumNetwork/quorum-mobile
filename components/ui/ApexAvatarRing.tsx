/**
 * ApexAvatarRing - Metallic gold ring drawn around an avatar for active
 * Quorum Apex subscribers, plus the shared Apex brand color tokens and the
 * <ApexIcon /> mark used in the Apex card / subscribe modal.
 *
 * Pure layout component (no hooks) so it can wrap avatars inside large
 * recycled lists (feed rows, chat messages) without any per-row cost. The
 * caller decides `active` — typically via useApexStatusForFids /
 * useApexStatusForAddresses membership computed once at the list level.
 *
 * When active, the ring is drawn *outside* the avatar (gradient border + small
 * gap) while the component's layout footprint stays exactly `size` x `size`, so
 * rows with and without the ring align identically. When inactive the
 * children render untouched (or in a plain View when a wrapper `style`
 * such as a margin is supplied).
 */

import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Image, View, type ImageStyle, type StyleProp, type ViewStyle } from 'react-native';

/**
 * Apex brand colors, derived from the metallic Apex mark (a gold star whose
 * gradient runs bright amber → deep orange, top to bottom).
 *
 * - APEX_GOLD: the single flat accent used for card borders, buttons, selected
 *   states and text highlights across the Apex card and subscribe modal. A
 *   midpoint of the two gradient tones so it reads as "metallic gold".
 * - APEX_GOLD_LIGHT / APEX_GOLD_DARK: the gradient endpoints, used for the
 *   avatar ring so it matches the metallic look of the mark itself.
 */
export const APEX_GOLD = '#E8A100';
export const APEX_GOLD_LIGHT = '#FFC400';
export const APEX_GOLD_DARK = '#E08600';

const RING_WIDTH = 2;

interface ApexAvatarRingProps {
  /** Whether the gold ring is shown. */
  active: boolean;
  /** The avatar's rendered size (width/height) in px. */
  size: number;
  /** Optional wrapper style (e.g. margins the avatar style used to carry). */
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

export function ApexAvatarRing({ active, size, style, children }: ApexAvatarRingProps) {
  if (!active) {
    return style ? <View style={style}>{children}</View> : <>{children}</>;
  }

  // The gradient ring is a circle RING_WIDTH larger than the avatar on each
  // side, with the avatar centered on top. Because avatars are circular and
  // the gradient is fully clipped to a circle, only the RING_WIDTH band shows
  // around the image — a clean metallic ring that needs no knowledge of the
  // (varied) background behind it. Centering the ring inside a size x size
  // outer view keeps the layout footprint exactly `size`, so rows with and
  // without the ring align identically.
  const ringSize = size + 2 * RING_WIDTH;

  return (
    <View
      style={[
        { width: size, height: size, alignItems: 'center', justifyContent: 'center' },
        style,
      ]}
    >
      <LinearGradient
        colors={[APEX_GOLD_LIGHT, APEX_GOLD_DARK]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{
          width: ringSize,
          height: ringSize,
          borderRadius: ringSize / 2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {children}
      </LinearGradient>
    </View>
  );
}

/**
 * ApexIcon — the metallic Apex mark (gold star). Replaces the old generic
 * crown glyph wherever Apex is branded (Apex card header, subscribe modal
 * title). Renders the raster mark at the requested size; the metallic gradient
 * lives in the PNG itself, so no `color` prop is needed.
 */
export function ApexIcon({ size = 20, style }: { size?: number; style?: StyleProp<ImageStyle> }) {
  return (
    <Image
      source={require('@/assets/images/apex-metallic.png')}
      style={[{ width: size, height: size }, style]}
      resizeMode="contain"
      accessibilityLabel="Quorum Apex"
    />
  );
}
