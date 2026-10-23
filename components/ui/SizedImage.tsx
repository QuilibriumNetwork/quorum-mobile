/**
 * SizedImage — a remote picture shown at a known width.
 *
 * It asks the host for a copy at that width where the host can make one (see
 * `utils/imageVariants`), and shows the original if that copy fails. It is
 * expo-image, not React Native's `Image`, for the disk cache: RN's keeps
 * pictures in memory only, so one evicted under memory pressure, and every one
 * after a relaunch, was downloaded again.
 *
 * For a person's photo use `CachedAvatar`, which does the same and falls back
 * to initials.
 */
import React, { useCallback, useState } from 'react';
import { Image, type ImageErrorEventData, type ImageProps } from 'expo-image';
import { sizedImageUrl } from '@/utils/imageVariants';

type SizedImageProps = Omit<ImageProps, 'source'> & {
  uri: string;
  /** The width it's shown at, in points. */
  displayWidth: number;
  /** Ask for a still frame of an animated image (icons, avatars). */
  stillFrame?: boolean;
};

export function SizedImage({ uri, displayWidth, stillFrame, recyclingKey, onError, ...rest }: SizedImageProps) {
  // The URL whose sized copy failed, so a recycled cell showing another
  // picture asks for that one's sized copy again.
  const [originalFor, setOriginalFor] = useState<string | null>(null);
  const sizedUri = sizedImageUrl(uri, displayWidth, { stillFrame });
  const displayUri = originalFor === uri ? uri : sizedUri;

  const handleError = useCallback(
    (event: ImageErrorEventData) => {
      if (displayUri !== uri) setOriginalFor(uri);
      onError?.(event);
    },
    [displayUri, uri, onError],
  );

  return (
    <Image
      {...rest}
      source={{ uri: displayUri }}
      // Rebind cleanly when a recycled list cell moves to another picture (see
      // AutoHeightImage for the animated-GIF crash this avoids).
      recyclingKey={recyclingKey ?? uri}
      onError={handleError}
    />
  );
}

export default SizedImage;
