import React, { useEffect, useRef, useState } from 'react';
import { Image as RNImage, ImageStyle, StyleProp } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { Image as ExpoImage } from 'expo-image';
import { SCREEN_WIDTH, imageDimensionCache } from '../utils';

interface AutoHeightImageProps {
  uri: string;
  maxHeight: number;
  maxWidth?: number;
  style?: StyleProp<ImageStyle>;
  onPress?: () => void;
  onLongPress?: () => void;
}

/**
 * Image component that automatically calculates height based on aspect ratio.
 * Uses cached dimensions to prevent layout shifts during scroll.
 */
export function AutoHeightImage({
  uri,
  maxHeight,
  maxWidth = SCREEN_WIDTH,
  style,
  onPress,
  onLongPress,
}: AutoHeightImageProps) {
  const cacheKey = `${uri}:${maxWidth}`;
  const cachedDimensions = imageDimensionCache.get(cacheKey);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({
    width: maxWidth,
    height: cachedDimensions ?? 250,
  });
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // Skip if already cached
    if (imageDimensionCache.has(cacheKey)) {
      const cachedHeight = imageDimensionCache.get(cacheKey)!;
      setDimensions({ width: maxWidth, height: cachedHeight });
      return;
    }

    RNImage.getSize(
      uri,
      (imgWidth, imgHeight) => {
        const aspectRatio = imgHeight / imgWidth;
        const calculatedHeight = Math.min(maxWidth * aspectRatio, maxHeight);
        imageDimensionCache.set(cacheKey, calculatedHeight);
        if (!mountedRef.current) return;
        setDimensions({ width: maxWidth, height: calculatedHeight });
      },
      () => {
        imageDimensionCache.set(cacheKey, 250);
        if (!mountedRef.current) return;
        setDimensions({ width: maxWidth, height: 250 }); // fallback
      }
    );
  }, [uri, maxHeight, maxWidth, cacheKey]);

  const imageElement = (
    <ExpoImage
      source={{ uri }}
      style={[style, { width: dimensions.width, height: dimensions.height }]}
      contentFit="cover"
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
