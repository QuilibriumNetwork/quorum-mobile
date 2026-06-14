/**
 * DefaultAvatar — fallback user avatar shown when there's no profile photo.
 *
 * Renders deterministic initials + gradient via the shared avatar functions
 * (see AvatarInitials). Prefers a human display name so initials are
 * recognizable ("NA" for "Niccolò Angeli"); falls back to the address only
 * when a name genuinely isn't available at the call site.
 *
 * No external API calls — color and initials are computed locally.
 */

import React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import { AvatarInitials } from '@/components/ui/AvatarInitials';

interface DefaultAvatarProps {
  /** Preferred: the user's display name. Drives recognizable initials + color. */
  displayName?: string;
  /** Fallback for call sites that only have an address. */
  address?: string;
  size: number;
  style?: StyleProp<ViewStyle>;
}

export function DefaultAvatar({ displayName, address, size, style }: DefaultAvatarProps) {
  // Prefer the display name; fall back to address so call sites not yet
  // migrated keep rendering something rather than breaking.
  const name = displayName || address || '';
  return <AvatarInitials name={name} size={size} style={style} />;
}

export default DefaultAvatar;
