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
 * **`fallbackName` is REQUIRED, and that is the point.** It used to be optional,
 * defaulting to a static Quorum logo — so omitting it produced the single worst
 * possible result: every user without a photo rendering as the same blue square.
 * 21 call sites across 17 files did omit it, most of them by being extracted out
 * of `SocialFeedModal` into their own files without the prop coming along, which
 * is a mistake no reviewer can be expected to catch by eye. Requiring it moves
 * that from a silent visual bug to a compile error, and matches desktop's
 * `UserAvatar`, whose `displayName` has always been required for the same reason.
 *
 * Pass the name ALREADY RENDERED as the label beside this avatar, so the two can
 * never disagree. `''` is legal and deliberate: it yields the neutral "?" glyph
 * for the genuinely-nameless case (see `AppTabBar`), and saying so explicitly is
 * different from forgetting to say anything.
 *
 * See the header of `Avatar.tsx` for which of the five avatar components to
 * reach for.
 */

import React, { useEffect, useState } from 'react';
import { Image, ImageStyle, type ImageProps } from 'expo-image';
import { StyleProp, ImageSourcePropType, StyleSheet } from 'react-native';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';

interface CachedAvatarProps {
  source: ImageSourcePropType | { uri: string } | null | undefined;
  style?: StyleProp<ImageStyle>;
  /**
   * A missing or failed photo falls back to initials (DefaultAvatar) derived
   * from this name — so a row shows "AR" for "Ada Rivera" rather than a generic
   * logo, which is identical for everyone and therefore tells the reader
   * nothing.
   *
   * Required. Pass the name already displayed as this avatar's label; `''` for
   * the deliberately-nameless case, which renders the neutral "?" glyph.
   */
  fallbackName: string;
  /**
   * Fade-in duration once the photo decodes. Defaults to 0.
   *
   * 0 is right for a recycled list row: cells rebind faster than a fade lasts
   * during a fast scroll, so per-cell fades compound into a shimmer across the
   * rows arriving together. Pass a value only for an avatar that mounts ONCE —
   * a profile header, an edit-screen preview — where there is no recycling and
   * a large photo appearing abruptly is the more jarring of the two.
   */
  transition?: number;
  /**
   * Defaults to `'disk'`. `'memory-disk'` additionally keeps the decoded bitmap
   * in memory, which is worth it on a long feed the user scrolls back through,
   * and not worth the memory anywhere else.
   */
  cachePolicy?: ImageProps['cachePolicy'];
}

/**
 * CachedAvatar uses expo-image with disk caching for profile pictures.
 * This prevents reloading avatars every time the feed is viewed.
 *
 * expo-image (unlike web <img>) can't render a React node on load error, so the
 * failure is tracked in state and DefaultAvatar swapped in.
 */
export function CachedAvatar({
  source,
  style,
  fallbackName,
  transition = 0,
  cachePolicy = 'disk',
}: CachedAvatarProps) {
  const [imageError, setImageError] = useState(false);

  // Handle null/undefined source or empty uri
  const hasValidSource = source &&
    (typeof source === 'number' || // require() returns number
     (typeof source === 'object' && 'uri' in source && source.uri));

  // The URI identifies WHICH photo this is, and doubles as the recycling key
  // below. Computed before the early return so the reset effect can depend on
  // it — all hooks must run unconditionally.
  const sourceUri =
    typeof source === 'object' && source && 'uri' in source ? source.uri : undefined;

  // Clear a previous failure when the photo changes, so a later valid photo
  // gets a fresh attempt.
  //
  // Load-bearing in a recycled list, which is the only place this component is
  // meant to be used: FlashList reuses one component instance across many rows,
  // so without this a single 404 latches `imageError` on that instance and every
  // subsequent person who lands in that slot renders as initials even when they
  // have a perfectly good photo. Desktop's `UserAvatar` has carried the same
  // reset since it was written; mobile's copy was missing it.
  useEffect(() => {
    setImageError(false);
  }, [sourceUri]);

  // No usable photo, or it failed to load: render DefaultAvatar sized to the
  // style's width/height.
  if (!hasValidSource || imageError) {
    const flat = StyleSheet.flatten(style) ?? {};
    const size = (typeof flat.width === 'number' ? flat.width : undefined)
      ?? (typeof flat.height === 'number' ? flat.height : undefined)
      ?? 40;
    return <DefaultAvatar resolvedName={fallbackName} size={size} style={flat} />;
  }

  return (
    <Image
      source={source}
      style={style}
      cachePolicy={cachePolicy}
      transition={transition}
      contentFit="cover"
      // Key the underlying view to the source so a recycled FlashList row
      // rebinds to a fresh avatar instead of retaining the previous (possibly
      // animated) image. Avoids a use-after-free when an animated avatar's
      // decoded backing store is purged under memory pressure — see
      // AutoHeightImage for the crash.
      recyclingKey={sourceUri}
      onError={() => setImageError(true)}
    />
  );
}

export default CachedAvatar;
