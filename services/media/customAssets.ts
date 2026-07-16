/**
 * Custom Assets Service
 *
 * Handles picking and processing images for custom emojis and stickers.
 * Matches desktop behavior for image sizing constraints.
 * Images are automatically resized:
 * - Emojis: 128px on longest axis
 * - Stickers: 512px on longest axis
 */

import { FILE_SIZE_LIMITS, IMAGE_CONFIGS } from '@quilibrium/quorum-shared';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';

// Numeric limits sourced from the shared IMAGE_CONFIGS single source of truth
// (kills cross-platform drift). Mobile keeps its aspect-preserving longest-axis
// resize (it does NOT adopt shared's square cropToFit for emoji/sticker) — only
// the max-bound number comes from shared.
const EMOJI_CONFIG = {
  maxInputSizeMB: FILE_SIZE_LIMITS.MAX_EMOJI_INPUT_SIZE / (1024 * 1024), // 5MB
  quality: IMAGE_CONFIGS.emoji.quality, // 0.8
  maxGifSizeKB: FILE_SIZE_LIMITS.MAX_EMOJI_GIF_SIZE / 1024, // 100KB
  maxSize: IMAGE_CONFIGS.emoji.maxWidth, // 128px on longest axis
};

const STICKER_CONFIG = {
  maxInputSizeMB: FILE_SIZE_LIMITS.MAX_INPUT_SIZE / (1024 * 1024), // 25MB
  quality: IMAGE_CONFIGS.sticker.quality, // 0.8
  maxGifSizeKB: FILE_SIZE_LIMITS.MAX_STICKER_GIF_SIZE / 1024, // 750KB
  maxSize: IMAGE_CONFIGS.sticker.maxWidth, // 512px on longest axis
};

export interface ProcessedAsset {
  id: string;
  name: string;
  imgUrl: string; // Base64 data URL
}

export interface AssetPickerResult {
  success: boolean;
  asset?: ProcessedAsset;
  error?: string;
  cancelled?: boolean;
}

/**
 * Sanitize asset name to match desktop behavior
 * - lowercase
 * - alphanumeric and underscore only
 * - max 32 characters
 */
function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[^.]+$/, '') // Remove file extension
    .replace(/[^a-z0-9_]/g, '_') // Replace non-alphanumeric with underscore
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, '') // Remove leading/trailing underscores
    .substring(0, 32) || 'custom';
}

/**
 * Generate a unique ID for the asset
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Resize an image to fit within maxSize on the longest axis
 * Preserves aspect ratio and returns base64 data URL
 */
async function resizeImage(
  uri: string,
  width: number,
  height: number,
  maxSize: number,
  quality: number
): Promise<{ base64: string; width: number; height: number } | null> {
  try {
    // Determine if resizing is needed
    const longestAxis = Math.max(width, height);
    if (longestAxis <= maxSize) {
      // No resize needed, return null to indicate use original
      return null;
    }

    // Calculate new dimensions maintaining aspect ratio
    let newWidth: number;
    let newHeight: number;
    if (width >= height) {
      newWidth = maxSize;
      newHeight = Math.round((height / width) * maxSize);
    } else {
      newHeight = maxSize;
      newWidth = Math.round((width / height) * maxSize);
    }

    // Perform the resize
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: newWidth, height: newHeight } }],
      { compress: quality, format: ImageManipulator.SaveFormat.PNG, base64: true }
    );

    if (!result.base64) {
      return null;
    }

    return {
      base64: result.base64,
      width: result.width,
      height: result.height,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Pick and process an emoji image
 * - Max input 5MB
 * - Returns base64 data URL
 * - Allows square cropping via allowsEditing
 */
export async function pickEmoji(): Promise<AssetPickerResult> {
  try {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      return { success: false, error: 'Photo library permission denied' };
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: EMOJI_CONFIG.quality,
      allowsEditing: true, // Allow cropping to square
      aspect: [1, 1],
      base64: true,
      exif: false,
    });

    if (result.canceled || !result.assets?.[0]) {
      return { success: false, cancelled: true };
    }

    const asset = result.assets[0];
    return processEmojiAsset(asset);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to pick emoji',
    };
  }
}

/**
 * Pick and process a sticker image
 * - Max input 25MB
 * - Returns base64 data URL
 */
export async function pickSticker(): Promise<AssetPickerResult> {
  try {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      return { success: false, error: 'Photo library permission denied' };
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: STICKER_CONFIG.quality,
      base64: true,
      exif: false,
    });

    if (result.canceled || !result.assets?.[0]) {
      return { success: false, cancelled: true };
    }

    const asset = result.assets[0];
    return processStickerAsset(asset);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to pick sticker',
    };
  }
}

/**
 * Process an image for use as an emoji
 * Resizes to 128px max on longest axis if needed
 */
async function processEmojiAsset(
  asset: ImagePicker.ImagePickerAsset
): Promise<AssetPickerResult> {
  try {
    const { uri, width, height, fileName, fileSize, mimeType, base64 } = asset;
    const isGif = mimeType === 'image/gif';

    if (!base64) {
      return {
        success: false,
        error: 'Failed to read image data',
      };
    }

    // Check file size
    const fileSizeMB = (fileSize || 0) / (1024 * 1024);
    if (fileSizeMB > EMOJI_CONFIG.maxInputSizeMB) {
      return {
        success: false,
        error: `Image too large (max ${EMOJI_CONFIG.maxInputSizeMB}MB)`,
      };
    }

    // For GIFs, check size constraint (don't resize GIFs)
    if (isGif) {
      const fileSizeKB = (fileSize || 0) / 1024;
      if (fileSizeKB > EMOJI_CONFIG.maxGifSizeKB) {
        return {
          success: false,
          error: `GIF too large (max ${EMOJI_CONFIG.maxGifSizeKB}KB)`,
        };
      }
      // Use original GIF without resizing
      const id = generateId();
      const name = sanitizeName(fileName || 'emoji');
      const imgUrl = `data:${mimeType};base64,${base64}`;
      return { success: true, asset: { id, name, imgUrl } };
    }

    // Resize non-GIF images if larger than max size
    const resized = await resizeImage(
      uri,
      width,
      height,
      EMOJI_CONFIG.maxSize,
      EMOJI_CONFIG.quality
    );

    const id = generateId();
    const name = sanitizeName(fileName || 'emoji');

    if (resized) {
      // Use resized image
      const imgUrl = `data:image/png;base64,${resized.base64}`;
      return { success: true, asset: { id, name, imgUrl } };
    } else {
      // Use original (already within size limits)
      const finalMimeType = mimeType || 'image/png';
      const imgUrl = `data:${finalMimeType};base64,${base64}`;
      return { success: true, asset: { id, name, imgUrl } };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to process emoji',
    };
  }
}

/**
 * Process an image for use as a sticker
 * Resizes to 512px max on longest axis if needed
 */
async function processStickerAsset(
  asset: ImagePicker.ImagePickerAsset
): Promise<AssetPickerResult> {
  try {
    const { uri, width, height, fileName, fileSize, mimeType, base64 } = asset;
    const isGif = mimeType === 'image/gif';

    if (!base64) {
      return {
        success: false,
        error: 'Failed to read image data',
      };
    }

    // Check file size
    const fileSizeMB = (fileSize || 0) / (1024 * 1024);
    if (fileSizeMB > STICKER_CONFIG.maxInputSizeMB) {
      return {
        success: false,
        error: `Image too large (max ${STICKER_CONFIG.maxInputSizeMB}MB)`,
      };
    }

    // For GIFs, check size constraint (don't resize GIFs)
    if (isGif) {
      const fileSizeKB = (fileSize || 0) / 1024;
      if (fileSizeKB > STICKER_CONFIG.maxGifSizeKB) {
        return {
          success: false,
          error: `GIF too large (max ${STICKER_CONFIG.maxGifSizeKB}KB)`,
        };
      }
      // Use original GIF without resizing
      const id = generateId();
      const name = sanitizeName(fileName || 'sticker');
      const imgUrl = `data:${mimeType};base64,${base64}`;
      return { success: true, asset: { id, name, imgUrl } };
    }

    // Resize non-GIF images if larger than max size
    const resized = await resizeImage(
      uri,
      width,
      height,
      STICKER_CONFIG.maxSize,
      STICKER_CONFIG.quality
    );

    const id = generateId();
    const name = sanitizeName(fileName || 'sticker');

    if (resized) {
      // Use resized image
      const imgUrl = `data:image/png;base64,${resized.base64}`;
      return { success: true, asset: { id, name, imgUrl } };
    } else {
      // Use original (already within size limits)
      const finalMimeType = mimeType || 'image/png';
      const imgUrl = `data:${finalMimeType};base64,${base64}`;
      return { success: true, asset: { id, name, imgUrl } };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to process sticker',
    };
  }
}
