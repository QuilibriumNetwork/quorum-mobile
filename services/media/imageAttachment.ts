/**
 * Image Attachment Service
 *
 * Handles picking, processing, and preparing images for message attachments.
 * Mirrors desktop behavior:
 * - Compress large images (max 1200x1200)
 * - Compress to 1MB or less for E2EE chats/spaces
 * - Generate thumbnails for large images (>300px)
 * - Handle GIFs with static thumbnails for large files
 * - Convert to base64 data URLs for transmission
 */

// The unscoped 'expo-file-system' import resolves to the new File-
// based API in expo-file-system >= 18.x and prints
// "Method readAsStringAsync imported from 'expo-file-system' is
// deprecated" at runtime. The /legacy entrypoint exposes the
// stable callable API (downloadAsync / readAsStringAsync /
// deleteAsync) without the warning. saveToLibrary.ts already uses
// /legacy — keep this consistent.
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

// Configuration matching desktop behavior
const IMAGE_CONFIG = {
  maxWidth: 1200,
  maxHeight: 1200,
  quality: 0.8,
  thumbnailMaxSize: 300,
  thumbnailThreshold: 300, // Generate thumbnail if image > 300px
  maxFileSizeMB: 25,
  maxGifSizeMB: 2,
  targetFileSizeBytes: 1024 * 1024, // 1MB target for E2EE chats
};

export interface ProcessedAttachment {
  /** Discriminator. Defaults to "image" when missing for backward
   *  compatibility with callers that only handle images. */
  kind?: 'image' | 'video';
  /** Base64 data URL (image only). */
  imageUrl: string;
  /** Base64 data URL thumbnail (for large images). */
  thumbnailUrl?: string;
  /** Local file URI for the thumbnail (video). Composers render this as
   *  the preview; the chat encryption paths only use imageUrl, so this
   *  stays undefined for images. */
  thumbnailLocalUri?: string;
  width: number;
  height: number;
  /** Video duration in ms — preserved for the upload service so it can
   *  validate length limits before kicking off the TUS upload. */
  durationMs?: number;
  isLargeGif?: boolean;
  mimeType: string;
  localUri: string;
}

export interface AttachmentPickerResult {
  success: boolean;
  attachment?: ProcessedAttachment;
  error?: string;
  cancelled?: boolean;
}

/**
 * Request permissions and pick an image from library or camera
 */
export async function pickImage(
  source: 'library' | 'camera' = 'library'
): Promise<AttachmentPickerResult> {
  try {
    // Request permissions
    if (source === 'camera') {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        return { success: false, error: 'Camera permission denied' };
      }
    } else {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        return { success: false, error: 'Photo library permission denied' };
      }
    }

    // Launch picker with base64 output
    const result = await (source === 'camera'
      ? ImagePicker.launchCameraAsync({
          mediaTypes: ['images'],
          quality: IMAGE_CONFIG.quality,
          base64: true,
          exif: false,
        })
      : ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          quality: IMAGE_CONFIG.quality,
          base64: true,
          exif: false,
        }));

    if (result.canceled || !result.assets?.[0]) {
      return { success: false, cancelled: true };
    }

    const asset = result.assets[0];
    return processImageAsset(asset);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to pick image',
    };
  }
}

/**
 * Compress an image to target file size using iterative quality reduction
 * Returns the compressed image URI and base64 data
 */
async function compressImageToTargetSize(
  uri: string,
  width: number,
  height: number,
  targetBytes: number
): Promise<{ uri: string; base64: string; width: number; height: number } | null> {
  // First, resize if dimensions exceed max
  let currentWidth = width;
  let currentHeight = height;

  if (width > IMAGE_CONFIG.maxWidth || height > IMAGE_CONFIG.maxHeight) {
    const scale = Math.min(
      IMAGE_CONFIG.maxWidth / width,
      IMAGE_CONFIG.maxHeight / height
    );
    currentWidth = Math.round(width * scale);
    currentHeight = Math.round(height * scale);
  }

  // Try different quality levels, starting high and decreasing
  const qualityLevels = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2];

  for (const quality of qualityLevels) {
    try {
      const actions: ImageManipulator.Action[] = [];

      // Add resize action if needed
      if (currentWidth !== width || currentHeight !== height) {
        actions.push({ resize: { width: currentWidth, height: currentHeight } });
      }

      const result = await ImageManipulator.manipulateAsync(
        uri,
        actions,
        {
          compress: quality,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        }
      );

      if (!result.base64) continue;

      // Check file size (base64 is ~33% larger than binary)
      const estimatedBytes = Math.ceil(result.base64.length * 0.75);

      if (estimatedBytes <= targetBytes) {
        return {
          uri: result.uri,
          base64: result.base64,
          width: result.width,
          height: result.height,
        };
      }

      // If still too large at this quality, try reducing dimensions too
      if (quality <= 0.5 && estimatedBytes > targetBytes * 1.5) {
        currentWidth = Math.round(currentWidth * 0.8);
        currentHeight = Math.round(currentHeight * 0.8);
      }
    } catch {
      // Image manipulation can fail at this quality/size — try next level
    }
  }

  // Last resort: aggressive resize
  try {
    const scale = Math.sqrt(targetBytes / (width * height * 3)); // rough estimate
    const finalWidth = Math.max(100, Math.round(width * scale * 0.5));
    const finalHeight = Math.max(100, Math.round(height * scale * 0.5));

    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: finalWidth, height: finalHeight } }],
      {
        compress: 0.2,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true,
      }
    );

    if (result.base64) {
      return {
        uri: result.uri,
        base64: result.base64,
        width: result.width,
        height: result.height,
      };
    }
  } catch {
    // Aggressive resize also failed — return null below
  }

  return null;
}

/**
 * Process an image asset into a ProcessedAttachment
 */
async function processImageAsset(
  asset: ImagePicker.ImagePickerAsset
): Promise<AttachmentPickerResult> {
  try {
    const { uri, width, height, mimeType, fileSize } = asset;
    const mime = mimeType || 'image/jpeg';
    const isGif = mime === 'image/gif';
    const currentFileSize = fileSize || 0;

    // For GIFs, we don't compress (would lose animation)
    if (isGif) {
      const fileSizeMB = currentFileSize / (1024 * 1024);
      if (fileSizeMB > IMAGE_CONFIG.maxGifSizeMB) {
        return {
          success: false,
          error: `GIF too large (max ${IMAGE_CONFIG.maxGifSizeMB}MB)`,
        };
      }

      // Read GIF as base64
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: 'base64',
      });

      const imageUrl = `data:${mime};base64,${base64}`;
      const isLargeGif = fileSizeMB > 0.5;

      return {
        success: true,
        attachment: {
          imageUrl,
          thumbnailUrl: imageUrl,
          width,
          height,
          isLargeGif,
          mimeType: mime,
          localUri: uri,
        },
      };
    }

    // For non-GIF images, compress to target size (1MB)
    let finalUri = uri;
    let finalBase64 = asset.base64;
    let finalWidth = width;
    let finalHeight = height;
    let finalMime = mime;

    // Check if compression is needed
    if (currentFileSize > IMAGE_CONFIG.targetFileSizeBytes) {
      const compressed = await compressImageToTargetSize(
        uri,
        width,
        height,
        IMAGE_CONFIG.targetFileSizeBytes
      );

      if (!compressed) {
        return {
          success: false,
          error: 'Failed to compress image to acceptable size',
        };
      }

      finalUri = compressed.uri;
      finalBase64 = compressed.base64;
      finalWidth = compressed.width;
      finalHeight = compressed.height;
      finalMime = 'image/jpeg'; // Compressed images are always JPEG
    } else if (!finalBase64) {
      // Read file as base64 if not already available
      finalBase64 = await FileSystem.readAsStringAsync(uri, {
        encoding: 'base64',
      });
    }

    if (!finalBase64) {
      return {
        success: false,
        error: 'Failed to read image data',
      };
    }

    // Determine if we need a thumbnail
    const needsThumbnail =
      finalWidth > IMAGE_CONFIG.thumbnailThreshold ||
      finalHeight > IMAGE_CONFIG.thumbnailThreshold;

    // Create base64 data URL
    const imageUrl = `data:${finalMime};base64,${finalBase64}`;

    // Generate thumbnail if needed
    let thumbnailUrl: string | undefined;
    if (needsThumbnail) {
      try {
        const thumbScale = Math.min(
          IMAGE_CONFIG.thumbnailMaxSize / finalWidth,
          IMAGE_CONFIG.thumbnailMaxSize / finalHeight
        );
        const thumbWidth = Math.round(finalWidth * thumbScale);
        const thumbHeight = Math.round(finalHeight * thumbScale);

        const thumbResult = await ImageManipulator.manipulateAsync(
          finalUri,
          [{ resize: { width: thumbWidth, height: thumbHeight } }],
          {
            compress: 0.7,
            format: ImageManipulator.SaveFormat.JPEG,
            base64: true,
          }
        );

        if (thumbResult.base64) {
          thumbnailUrl = `data:image/jpeg;base64,${thumbResult.base64}`;
        }
      } catch (error) {
        // Fall back to using the main image as thumbnail
        thumbnailUrl = imageUrl;
      }
    }

    return {
      success: true,
      attachment: {
        imageUrl,
        thumbnailUrl,
        width: finalWidth,
        height: finalHeight,
        isLargeGif: false,
        mimeType: finalMime,
        localUri: finalUri,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to process image',
    };
  }
}

/**
 * Show action sheet to choose image source (library by default)
 */
export async function pickImageWithOptions(): Promise<AttachmentPickerResult> {
  // For now, default to library. Could add ActionSheet for source selection
  return pickImage('library');
}

/**
 * Pick a video OR an image. Composers that publish to Farcaster need
 * both (chat surfaces stay image-only because the encryption pipeline
 * doesn't transport video frames). Videos skip the base64 round-trip —
 * `imageUrl` is left empty and `localUri` is what the upload service
 * streams from.
 */
export async function pickMedia(
  source: 'library' | 'camera' = 'library',
): Promise<AttachmentPickerResult> {
  try {
    if (source === 'camera') {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        return { success: false, error: 'Camera permission denied' };
      }
    } else {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        return { success: false, error: 'Photo library permission denied' };
      }
    }

    const result = await (source === 'camera'
      ? ImagePicker.launchCameraAsync({
          mediaTypes: ['images', 'videos'],
          quality: IMAGE_CONFIG.quality,
          base64: false,
          exif: false,
        })
      : ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images', 'videos'],
          quality: IMAGE_CONFIG.quality,
          base64: false,
          exif: false,
        }));

    if (result.canceled || !result.assets?.[0]) {
      return { success: false, cancelled: true };
    }

    const asset = result.assets[0];
    if (asset.type === 'video') {
      return {
        success: true,
        attachment: {
          kind: 'video',
          // Chat doesn't render video, so imageUrl stays empty — the
          // type contract requires the field, so we leave it as an
          // empty string. Callers should branch on `kind` before
          // touching imageUrl.
          imageUrl: '',
          thumbnailLocalUri: asset.uri,
          width: asset.width ?? 0,
          height: asset.height ?? 0,
          durationMs: asset.duration ?? undefined,
          mimeType: asset.mimeType ?? 'video/mp4',
          localUri: asset.uri,
        },
      };
    }

    // Re-read with base64 for the image processing pipeline.
    let base64 = asset.base64;
    if (!base64) {
      base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' });
    }
    return processImageAsset({ ...asset, base64 });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to pick media',
    };
  }
}

/**
 * Compress a freshly-picked image into a profile-avatar-sized
 * base64 data URI. Enforces hard caps on dimensions AND payload
 * size so an unbounded camera capture can't blow up either:
 *   - The local profile blob stored in MMKV.
 *   - The public-profile JSON returned by /users/:address/public-profile
 *     (where the avatar lives inline). A single uncompressed phone
 *     photo at 12-50MP can easily be 5-30MB base64, which has
 *     OOM'd RN's HTTP layer (okhttp reads the full response body
 *     into one byte array before handing to JS).
 *
 * Returns `null` on irrecoverable failure; the caller should fall
 * back to leaving the avatar unchanged rather than uploading an
 * un-compressed blob.
 *
 * Defaults: 512x512 max, ~150KB JPEG. The 512px target matches
 * common avatar display sizes (we never render larger), and
 * 150KB keeps the public-profile response well under 1MB even
 * after JSON quoting overhead.
 */
export async function compressAvatarImage(
  uri: string,
  width: number,
  height: number,
  opts?: { maxDimension?: number; maxBytes?: number },
): Promise<{ dataUri: string; width: number; height: number } | null> {
  const MAX_DIM = opts?.maxDimension ?? 512;
  const MAX_BYTES = opts?.maxBytes ?? 150 * 1024;

  // Resize first so dimensions never exceed MAX_DIM. We respect
  // aspect ratio — the ProfileModal picker uses aspect [1,1] so
  // this normally becomes a square 512x512, but the helper is
  // tolerant of non-square input too.
  let targetW = width;
  let targetH = height;
  if (Math.max(width, height) > MAX_DIM) {
    const scale = MAX_DIM / Math.max(width, height);
    targetW = Math.max(1, Math.round(width * scale));
    targetH = Math.max(1, Math.round(height * scale));
  }
  const resizeAction: ImageManipulator.Action[] = (targetW !== width || targetH !== height)
    ? [{ resize: { width: targetW, height: targetH } }]
    : [];

  // Quality sweep: start high, drop until base64 size fits.
  for (const quality of [0.85, 0.7, 0.55, 0.4, 0.3, 0.2]) {
    try {
      const result = await ImageManipulator.manipulateAsync(
        uri,
        resizeAction,
        {
          compress: quality,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        },
      );
      if (!result.base64) continue;
      // Approx base64 byte count: every 4 base64 chars decode to 3
      // bytes, but we cap on the encoded length to keep arithmetic
      // simple. A 150KB binary is ~200KB base64.
      if (result.base64.length <= Math.floor(MAX_BYTES * 1.34)) {
        return {
          dataUri: `data:image/jpeg;base64,${result.base64}`,
          width: result.width,
          height: result.height,
        };
      }
    } catch {
      // Try the next quality level. If all fail, return null.
    }
  }
  return null;
}
