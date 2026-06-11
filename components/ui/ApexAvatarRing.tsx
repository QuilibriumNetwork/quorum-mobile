/**
 * ApexAvatarRing - Gold ring drawn around an avatar for active Quorum Apex
 * subscribers.
 *
 * Pure layout component (no hooks) so it can wrap avatars inside large
 * recycled lists (feed rows, chat messages) without any per-row cost. The
 * caller decides `active` — typically via useApexStatusForFids /
 * useApexStatusForAddresses membership computed once at the list level.
 *
 * When active, the ring is drawn *outside* the avatar (border + small gap)
 * while the component's layout footprint stays exactly `size` x `size`, so
 * rows with and without the ring align identically. When inactive the
 * children render untouched (or in a plain View when a wrapper `style`
 * such as a margin is supplied).
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

/** Apex gold — also used for the Apex card accents in ProfileModal. */
export const APEX_GOLD = '#E8B923';

const RING_WIDTH = 2;
const RING_GAP = 1.5;

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

  // Ring view is slightly larger than the avatar; centering it inside a
  // size x size outer view keeps the layout footprint unchanged while the
  // ring overflows symmetrically around the image.
  const ringSize = size + 2 * (RING_WIDTH + RING_GAP);

  return (
    <View
      style={[
        { width: size, height: size, alignItems: 'center', justifyContent: 'center' },
        style,
      ]}
    >
      <View
        style={{
          width: ringSize,
          height: ringSize,
          borderRadius: ringSize / 2,
          borderWidth: RING_WIDTH,
          borderColor: APEX_GOLD,
          padding: RING_GAP,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {children}
      </View>
    </View>
  );
}
