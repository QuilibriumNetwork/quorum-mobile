/**
 * Image Attachment Service
 *
 * Handles picking, processing, and preparing images for message attachments.
 * Mirrors desktop behavior:
 * - Compress large images (max 1200x1200)
 * - Generate thumbnails for large images (>300px)
 * - Handle GIFs with static thumbnails for large files
 * - Convert to base64 data URLs for transmission
 */

import * as ImagePicker from 'expo-image-picker';
import { stripImageMetadata } from '@/utils/imageMetadata';

// Configuration matching desktop behavior
const IMAGE_CONFIG = {
  maxWidth: 1200,
  maxHeight: 1200,
  quality: 0.8,
  thumbnailMaxSize: 300,
  thumbnailThreshold: 300, // Generate thumbnail if image > 300px
  maxFileSizeMB: 25,
  maxGifSizeMB: 2,
};

export interface ProcessedAttachment {
  /** Full image as base64 data URL */
  imageUrl: string;
  /** Thumbnail as base64 data URL (optional, for large images) */
  thumbnailUrl?: string;
  /** Original width */
  width: number;
  /** Original height */
  height: number;
  /** Whether this is a large GIF with static thumbnail */
  isLargeGif?: boolean;
  /** MIME type */
  mimeType: string;
  /** Local URI for preview */
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
    console.error('[ImageAttachment] Error picking image:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to pick image',
    };
  }
}

/**
 * Process an image asset into a ProcessedAttachment
 * @internal - Exported for testing purposes
 */
export async function processImageAsset(
  asset: ImagePicker.ImagePickerAsset
): Promise<AttachmentPickerResult> {
  try {
    const { uri, width, height, mimeType, fileSize, base64 } = asset;
    const mime = mimeType || 'image/jpeg';
    const isGif = mime === 'image/gif';

    // For GIFs, we can't strip metadata easily (would need to re-encode as static image)
    // So we'll only strip metadata for non-GIF images
    let processedUri = uri;
    let processedBase64 = base64;

    if (!isGif && uri) {
      try {
        // Strip metadata by re-encoding the image
        processedUri = await stripImageMetadata(uri);

        // Re-read the stripped image as base64
        const response = await fetch(processedUri);
        const blob = await response.blob();
        processedBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = reader.result as string;
            const base64Data = result.split(',')[1];
            resolve(base64Data);
          };
          reader.onerror = () => reject(new Error('Failed to read stripped image'));
          reader.readAsDataURL(blob);
        });
      } catch (stripError) {
        console.warn('[ImageAttachment] Failed to strip metadata, using original:', stripError);
        // Fallback to original if stripping fails
        processedUri = uri;
        processedBase64 = base64 || '';
      }
    }

    if (!processedBase64) {
      return {
        success: false,
        error: 'Failed to read image data',
      };
    }

    // Check file size (use original fileSize for validation)
    const fileSizeMB = (fileSize || 0) / (1024 * 1024);
    const maxSize = isGif ? IMAGE_CONFIG.maxGifSizeMB : IMAGE_CONFIG.maxFileSizeMB;
    if (fileSizeMB > maxSize) {
      return {
        success: false,
        error: `Image too large (max ${maxSize}MB)`,
      };
    }

    // Determine if we need a thumbnail
    const needsThumbnail =
      width > IMAGE_CONFIG.thumbnailThreshold ||
      height > IMAGE_CONFIG.thumbnailThreshold;

    // Create base64 data URL from stripped image
    const imageUrl = `data:${mime};base64,${processedBase64}`;

    // For GIFs, check if it's large
    const isLargeGif = isGif && fileSizeMB > 0.5; // >500KB

    // For now, we use the same image as thumbnail
    // Proper thumbnailing would need expo-image-manipulator
    const thumbnailUrl = needsThumbnail ? imageUrl : undefined;

    return {
      success: true,
      attachment: {
        imageUrl,
        thumbnailUrl,
        width,
        height,
        isLargeGif,
        mimeType: mime,
        localUri: processedUri, // Use processed URI
      },
    };
  } catch (error) {
    console.error('[ImageAttachment] Error processing image:', error);
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
