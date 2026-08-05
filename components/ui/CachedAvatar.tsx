/**
 * CachedAvatar — the avatar for photos inside LISTS. A drop-in replacement for
 * `Image` that adds disk caching, so a feed does not refetch every face each
 * time it is scrolled back into view.
 *
 * Two things it does that a bare `Image` does not, both of which matter only in
 * a recycled list and are easy to lose in a refactor:
 *
 * - **`recyclingKey`** ties the underlying view to the source, so a reused row
 *   rebinds to a fresh avatar instead of retaining the previous one. Without
 *   it an animated avatar can be used after its decoded backing store is purged
 *   under memory pressure — a crash, not a glitch.
 * - **`fallbackName`** swaps in `DefaultAvatar` (initials) when the photo is
 *   missing or fails, because expo-image cannot render a React node on error
 *   the way a web `<img>` can, so the failure has to be tracked in state.
 *
 * See the header of `Avatar.tsx` for which of the five avatar components to
 * reach for.
 */

import React, { useState } from 'react';
import { Image, ImageStyle } from 'expo-image';
import { StyleProp, ImageSourcePropType, StyleSheet } from 'react-native';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';

interface CachedAvatarProps {
  source: ImageSourcePropType | { uri: string } | null | undefined;
  style?: StyleProp<ImageStyle>;
  fallback?: ImageSourcePropType;
  /**
   * When set, a missing or failed photo falls back to initials (DefaultAvatar)
   * derived from this name instead of the static `fallback` image — so a row
   * shows "AR" for "Ada Rivera" rather than the generic blue logo, which is
   * identical for everyone and therefore tells the reader nothing.
   */
  fallbackName?: string;
}

// Default fallback avatar
const DEFAULT_FALLBACK = require('@/assets/images/quorum-symbol-bg-blue.png');

/**
 * CachedAvatar uses expo-image with disk caching for profile pictures.
 * This prevents reloading avatars every time the feed is viewed.
 *
 * expo-image (unlike web <img>) can't render a React node on load error, so
 * when an initials fallback is requested we track the error in state and swap
 * in DefaultAvatar on failure.
 */
export function CachedAvatar({ source, style, fallback = DEFAULT_FALLBACK, fallbackName }: CachedAvatarProps) {
  const [imageError, setImageError] = useState(false);

  // Handle null/undefined source or empty uri
  const hasValidSource = source &&
    (typeof source === 'number' || // require() returns number
     (typeof source === 'object' && 'uri' in source && source.uri));

  const useInitialsFallback = fallbackName !== undefined;

  // No usable photo (or it failed to load) and an initials fallback is wanted:
  // render DefaultAvatar sized to the style's width/height.
  if (useInitialsFallback && (!hasValidSource || imageError)) {
    const flat = StyleSheet.flatten(style) ?? {};
    const size = (typeof flat.width === 'number' ? flat.width : undefined)
      ?? (typeof flat.height === 'number' ? flat.height : undefined)
      ?? 40;
    return <DefaultAvatar displayName={fallbackName} size={size} style={flat} />;
  }

  // Key the underlying view to the source so a recycled FlashList row rebinds
  // to a fresh avatar instead of retaining the previous (possibly animated)
  // image. Avoids a use-after-free when an animated avatar's decoded backing
  // store is purged under memory pressure — see AutoHeightImage for the crash.
  const recyclingKey =
    typeof source === 'object' && source && 'uri' in source ? source.uri : undefined;

  return (
    <Image
      source={hasValidSource ? source : fallback}
      style={style}
      cachePolicy="disk"
      transition={useInitialsFallback ? 0 : 100}
      contentFit="cover"
      recyclingKey={recyclingKey}
      onError={useInitialsFallback ? () => setImageError(true) : undefined}
    />
  );
}

export default CachedAvatar;
