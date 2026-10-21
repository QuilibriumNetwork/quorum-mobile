import React, { useCallback, useState } from 'react';
import { ImageStyle, StyleProp } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { Image as ExpoImage, type ImageLoadEventData } from 'expo-image';
import { SCREEN_WIDTH, imageDimensionCache } from '../utils';
import { sizedImageUrl } from '@/utils/imageVariants';

interface AutoHeightImageProps {
  uri: string;
  maxHeight: number;
  maxWidth?: number;
  style?: StyleProp<ImageStyle>;
  onPress?: () => void;
  onLongPress?: () => void;
}

/** Height ÷ width for an image not measured yet: a 4:3 landscape box. */
const DEFAULT_RATIO = 3 / 4;
/** Clamp for extreme images (10:1 panoramas, 1:3 strips), so one cast can't
 *  make a cell many screens tall. */
const MIN_RATIO = 0.1;
const MAX_RATIO = 3;

const clampRatio = (ratio: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));

/**
 * Image sized to its aspect ratio at `maxWidth`, capped at `maxHeight`.
 *
 * The ratio comes from expo-image's own load event, so the image is fetched
 * once. It used to be measured with `Image.getSize` first, a second download
 * of every image. Until it loads, the box uses the ratio cached for this URL,
 * or a 4:3 default. The ratio is worked out during render, so a recycled list
 * cell takes its new image's size at once rather than keeping the previous
 * image's height until an effect runs.
 */
export function AutoHeightImage({
  uri,
  maxHeight,
  maxWidth = SCREEN_WIDTH,
  style,
  onPress,
  onLongPress,
}: AutoHeightImageProps) {
  const [measured, setMeasured] = useState<{ uri: string; ratio: number } | null>(null);
  const ratio =
    (measured?.uri === uri ? measured.ratio : undefined) ??
    imageDimensionCache.get(uri) ??
    DEFAULT_RATIO;
  const height = Math.min(maxWidth * ratio, maxHeight);

  // A copy sized for the box, where the host can make one; the original if
  // that copy fails (see utils/imageVariants).
  const [originalFor, setOriginalFor] = useState<string | null>(null);
  const sizedUri = sizedImageUrl(uri, maxWidth);
  const displayUri = originalFor === uri ? uri : sizedUri;
  const handleError = useCallback(() => {
    if (sizedUri !== uri) setOriginalFor(uri);
  }, [sizedUri, uri]);

  const handleLoad = useCallback(
    (event: ImageLoadEventData) => {
      const { width, height: intrinsicHeight } = event.source;
      if (!(width > 0 && intrinsicHeight > 0)) return;
      const next = clampRatio(intrinsicHeight / width);
      imageDimensionCache.set(uri, next);
      setMeasured((prev) => (prev?.uri === uri && prev.ratio === next ? prev : { uri, ratio: next }));
    },
    [uri],
  );

  const imageElement = (
    <ExpoImage
      source={{ uri: displayUri }}
      style={[style, { width: maxWidth, height }]}
      contentFit="cover"
      onLoad={handleLoad}
      onError={handleError}
      // Reset the (possibly animated GIF) source cleanly when a recycled
      // FlashList cell rebinds to a new URI. Without this the underlying
      // ExpoImage view can keep a stale reference to the previous animated
      // image; under memory pressure its decoded backing store is purged
      // while a CALayer still points at the GIF's lazy data provider, and
      // the next CoreAnimation commit re-decodes from freed memory and
      // segfaults (GlobalGIFInfo::writeToStream → memmove from null).
      recyclingKey={uri}
    />
  );

  if (onPress || onLongPress) {
    return (
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={300}
      >
        {imageElement}
      </TouchableOpacity>
    );
  }

  return imageElement;
}

export default AutoHeightImage;
