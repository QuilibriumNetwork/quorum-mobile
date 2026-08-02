import React, { useCallback, useMemo, useState } from 'react';
import { Image as ExpoImage, type ImageLoadEventData } from 'expo-image';
import type { ImageStyle, StyleProp } from 'react-native';

/**
 * Natural pixel size per sticker URL, so a FlashList cell that scrolls away and
 * comes back doesn't flash at the placeholder size again. Stickers are a small
 * per-space set (not user media), so this stays tiny without eviction.
 */
const naturalSizeCache = new Map<string, { width: number; height: number }>();

/** Shown until the image reports its size — the old fixed sticker box. */
const PLACEHOLDER_SIZE = 128;

interface StickerImageProps {
  uri: string;
  /** Width of the message column; a sticker never exceeds it. */
  maxWidth: number;
  /** Ceiling for tall stickers, so one can't fill the whole viewport. */
  maxHeight?: number;
  style?: StyleProp<ImageStyle>;
}

/**
 * StickerImage — a sticker at its own size, capped to the message column.
 *
 * Stickers used to render in a fixed 128×128 box with `contain`, which shrank
 * every sticker to a thumbnail and letterboxed non-square ones inside the
 * square. Uploads keep 512px on the longest axis (see services/media/
 * customAssets), so there was detail being thrown away.
 *
 * Sizing now follows the chat-image treatment — fill the column, cap the height
 * — with one difference: a sticker is never scaled UP past its own pixel size.
 * A small sticker is usually small on purpose, and stretching a 64px one across
 * the screen would only render it blurry.
 *
 * Size comes from the load event rather than `Image.getSize` because stickers
 * arrive as base64 data URLs, which the image is decoding anyway.
 */
export const StickerImage = React.memo(function StickerImage({
  uri,
  maxWidth,
  maxHeight = 400,
  style,
}: StickerImageProps) {
  const [natural, setNatural] = useState(() => naturalSizeCache.get(uri));

  const handleLoad = useCallback(
    (event: ImageLoadEventData) => {
      const { width, height } = event.source ?? {};
      if (!width || !height) return;
      const size = { width, height };
      naturalSizeCache.set(uri, size);
      setNatural(size);
    },
    [uri]
  );

  const size = useMemo(() => {
    const cached = natural ?? naturalSizeCache.get(uri);
    if (!cached) return { width: PLACEHOLDER_SIZE, height: PLACEHOLDER_SIZE };
    // `1` is the clamp that keeps a small sticker at its own size.
    const scale = Math.min(maxWidth / cached.width, maxHeight / cached.height, 1);
    return { width: cached.width * scale, height: cached.height * scale };
  }, [natural, uri, maxWidth, maxHeight]);

  return (
    <ExpoImage
      source={{ uri }}
      style={[style, size]}
      contentFit="contain"
      onLoad={handleLoad}
      // Stickers may be GIFs. See AutoHeightImage for why a recycled cell
      // rebinding an animated source without this can segfault.
      recyclingKey={uri}
    />
  );
});

export default StickerImage;
