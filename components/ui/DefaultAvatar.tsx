/**
 * DefaultAvatar — the avatar for a PERSON who has no profile photo.
 *
 * Renders deterministic initials on a colour derived from their display name,
 * via the shared `AvatarInitials` renderer. Deterministic matters: the same
 * person keeps the same colour everywhere in the app and on desktop, so the
 * avatar carries a little identity of its own rather than being decoration.
 *
 * Initials come ONLY from the resolved name being shown as the label right
 * beside this avatar — never from the address. An address-derived initial
 * ("Q" from `Qm7f3a…`) belongs to nobody and disagrees with whatever name the
 * label actually shows. When there is no resolved name, `AvatarInitials`
 * renders its neutral "?" glyph rather than guessing from the address.
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
  /** The name already resolved (and shown) for this member. No fallback to
   *  an address happens here — pass the exact string being displayed as the
   *  label, or leave it undefined for the neutral placeholder. */
  resolvedName?: string;
  /** Unused by this component — no fallback derives from it. Kept so call
   *  sites that already have an address (for other reasons, e.g. keying a
   *  list row) don't need to strip it just to satisfy this prop list. */
  address?: string;
  size: number;
  style?: StyleProp<ViewStyle>;
}

export function DefaultAvatar({ resolvedName, size, style }: DefaultAvatarProps) {
  // No address fallback. Initials from `Qm7f3a…` are a letter belonging to
  // nobody, rendered beside a label showing the member's real name. When
  // there is no name, a neutral placeholder is honest and initials are not.
  // The `.q` is stripped because getInitials splits on non-letters and would
  // otherwise make two initials out of one name.
  const name = (resolvedName ?? '').replace(/\.q$/i, '').trim();
  return <AvatarInitials name={name} size={size} style={style} />;
}

export default DefaultAvatar;
