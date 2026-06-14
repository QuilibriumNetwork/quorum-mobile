/**
 * SpaceIcon — fallback space avatar shown when a space has no uploaded icon.
 *
 * The space-side counterpart to DefaultAvatar: same initials + gradient
 * renderer (AvatarInitials), fed by the space name so the monogram is
 * recognizable ("Q" for "Quorum") and color-consistent everywhere a space
 * appears (spaces list, discover, invite card, apex modal).
 *
 * Consolidates the monograms that were previously done three different ways
 * (space-address into DefaultAvatar, and inline `space.name.charAt(0)`).
 */

import React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import { AvatarInitials } from '@/components/ui/AvatarInitials';

interface SpaceIconProps {
  /** The space's display name. Drives the monogram initials + color. */
  name?: string;
  size: number;
  style?: StyleProp<ViewStyle>;
}

export function SpaceIcon({ name, size, style }: SpaceIconProps) {
  return <AvatarInitials name={name || ''} size={size} style={style} />;
}

export default SpaceIcon;
