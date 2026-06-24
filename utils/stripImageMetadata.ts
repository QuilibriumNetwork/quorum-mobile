import * as ImageManipulator from 'expo-image-manipulator';

/**
 * Strip embedded metadata (EXIF) from an image before it leaves the device.
 *
 * Photos taken on a phone carry EXIF metadata that can include GPS
 * coordinates, capture time, and the camera/device model. Uploading that
 * raw file would leak the user's location. Re-encoding the image through
 * ImageManipulator performs a decode-and-reencode, which drops every
 * metadata segment while keeping the visible pixels.
 *
 * Behaviour:
 * - GIFs are returned unchanged: re-encoding a GIF through ImageManipulator
 *   would flatten it to a single frame and lose the animation. Animated
 *   GIFs effectively never carry GPS/camera EXIF, so the privacy risk is
 *   negligible.
 * - PNG inputs are re-encoded as PNG so transparency is preserved.
 * - Everything else is re-encoded as JPEG.
 *
 * On any failure the original URI is returned, so callers never break an
 * upload just because the strip step failed.
 *
 * @param uri      Local file URI of the image to sanitise.
 * @param mimeType Optional MIME type used to pick the output format and to
 *                 detect GIFs. Falls back to a JPEG re-encode when unknown.
 * @returns A new local file URI for the metadata-free image, or the original
 *          URI when stripping is skipped or fails.
 */
export async function stripImageMetadata(uri: string, mimeType?: string): Promise<string> {
  const type = mimeType?.toLowerCase() ?? '';

  // Animated GIFs would lose their animation if re-encoded; skip them.
  if (type.includes('gif') || uri.toLowerCase().endsWith('.gif')) {
    return uri;
  }

  const isPng = type.includes('png') || uri.toLowerCase().endsWith('.png');
  const format = isPng ? ImageManipulator.SaveFormat.PNG : ImageManipulator.SaveFormat.JPEG;

  try {
    // No transform actions — an empty action list still forces a full
    // decode-and-reencode, which is what discards the metadata.
    const result = await ImageManipulator.manipulateAsync(uri, [], { format });
    return result.uri;
  } catch {
    // Never block an upload on a failed strip; fall back to the original.
    return uri;
  }
}
