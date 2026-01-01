/**
 * Custom Assets Service
 *
 * Handles picking and processing images for custom emojis and stickers.
 * Matches desktop behavior for image sizing constraints.
 * Note: Uses ImagePicker with base64 output - no resizing on mobile
 * (picker handles compression, user should provide appropriately sized images)
 */

import * as ImagePicker from 'expo-image-picker';
import { stripImageMetadata } from '@/utils/imageMetadata';

// Configuration matching desktop behavior
const EMOJI_CONFIG = {
  maxInputSizeMB: 5,
  quality: 0.8,
  maxGifSizeKB: 100,
};

const STICKER_CONFIG = {
  maxInputSizeMB: 25,
  quality: 0.8,
  maxGifSizeKB: 750,
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
    console.error('[CustomAssets] Error picking emoji:', error);
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
    console.error('[CustomAssets] Error picking sticker:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to pick sticker',
    };
  }
}

/**
 * Process an image for use as an emoji
 */
async function processEmojiAsset(
  asset: ImagePicker.ImagePickerAsset
): Promise<AssetPickerResult> {
  try {
    const { uri, fileName, fileSize, mimeType, base64 } = asset;
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

    // For GIFs, check size constraint
    if (isGif) {
      const fileSizeKB = (fileSize || 0) / 1024;
      if (fileSizeKB > EMOJI_CONFIG.maxGifSizeKB) {
        return {
          success: false,
          error: `GIF too large (max ${EMOJI_CONFIG.maxGifSizeKB}KB)`,
        };
      }
    }

    const finalMimeType = mimeType || 'image/png';

    // Strip metadata for non-GIF images
    let processedBase64 = base64;
    if (!isGif && uri) {
      try {
        const strippedUri = await stripImageMetadata(uri);
        const response = await fetch(strippedUri);
        const blob = await response.blob();
        processedBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = reader.result as string;
            resolve(result.split(',')[1]);
          };
          reader.onerror = () => reject(new Error('Failed to read stripped image'));
          reader.readAsDataURL(blob);
        });
      } catch (stripError) {
        console.warn('[CustomAssets] Failed to strip metadata for emoji, using original:', stripError);
        processedBase64 = base64;
      }
    }

    const id = generateId();
    const name = sanitizeName(fileName || 'emoji');
    const imgUrl = `data:${finalMimeType};base64,${processedBase64}`;

    return {
      success: true,
      asset: { id, name, imgUrl },
    };
  } catch (error) {
    console.error('[CustomAssets] Error processing emoji:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to process emoji',
    };
  }
}

/**
 * Process an image for use as a sticker
 */
async function processStickerAsset(
  asset: ImagePicker.ImagePickerAsset
): Promise<AssetPickerResult> {
  try {
    const { uri, fileName, fileSize, mimeType, base64 } = asset;
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

    // For GIFs, check size constraint
    if (isGif) {
      const fileSizeKB = (fileSize || 0) / 1024;
      if (fileSizeKB > STICKER_CONFIG.maxGifSizeKB) {
        return {
          success: false,
          error: `GIF too large (max ${STICKER_CONFIG.maxGifSizeKB}KB)`,
        };
      }
    }

    const finalMimeType = mimeType || 'image/png';

    // Strip metadata for non-GIF images
    let processedBase64 = base64;
    if (!isGif && uri) {
      try {
        const strippedUri = await stripImageMetadata(uri);
        const response = await fetch(strippedUri);
        const blob = await response.blob();
        processedBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = reader.result as string;
            resolve(result.split(',')[1]);
          };
          reader.onerror = () => reject(new Error('Failed to read stripped image'));
          reader.readAsDataURL(blob);
        });
      } catch (stripError) {
        console.warn('[CustomAssets] Failed to strip metadata for sticker, using original:', stripError);
        processedBase64 = base64;
      }
    }

    const id = generateId();
    const name = sanitizeName(fileName || 'sticker');
    const imgUrl = `data:${finalMimeType};base64,${processedBase64}`;

    return {
      success: true,
      asset: { id, name, imgUrl },
    };
  } catch (error) {
    console.error('[CustomAssets] Error processing sticker:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to process sticker',
    };
  }
}
