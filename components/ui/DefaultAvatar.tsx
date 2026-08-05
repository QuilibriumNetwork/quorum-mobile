/**
 * DefaultAvatar — the avatar for a PERSON who has no profile photo.
 *
 * Renders deterministic initials on a colour derived from their display name,
 * via the shared `AvatarInitials` renderer. Deterministic matters: the same
 * person keeps the same colour everywhere in the app and on desktop, so the
 * avatar carries a little identity of its own rather than being decoration.
 *
 * Prefer a real display name over an address. Initials from a name are
 * recognisable ("AR" for "Ada Rivera"); initials from an address are two
 * arbitrary characters of a hash, which is only marginally better than
 * nothing. The `address` prop exists for call sites that genuinely have no
 * name to offer.
 *
 * No network calls — colour and initials are both computed locally.
 *
 * See the header of `Avatar.tsx` for which of the five avatar components to
 * reach for.
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
