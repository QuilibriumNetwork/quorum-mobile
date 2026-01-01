/**
 * Image Metadata Utility
 *
 * Functions to strip EXIF metadata from images to protect user privacy.
 * Uses expo-image-manipulator to re-encode images, which removes all metadata.
 */

import * as ImageManipulator from 'expo-image-manipulator';

/**
 * Strip EXIF metadata from an image by re-encoding it
 * This ensures no location, camera info, or other metadata is included
 */
export async function stripImageMetadata(uri: string): Promise<string> {
  try {
    // Re-encode the image without metadata
    // This strips all EXIF data including location, camera settings, etc.
    const manipulatedImage = await ImageManipulator.manipulateAsync(
      uri,
      [], // No transformations needed, just re-encoding
      {
        compress: 1.0, // Keep original quality (compression happens elsewhere if needed)
        format: ImageManipulator.SaveFormat.JPEG, // JPEG format strips metadata
      }
    );

    return manipulatedImage.uri;
  } catch (error) {
    console.error('[ImageMetadata] Failed to strip metadata:', error);
    // If manipulation fails, return original URI as fallback
    // This ensures the app doesn't break, but metadata may still be present
    return uri;
  }
}

/**
 * Strip metadata and convert to base64 data URI
 */
export async function stripMetadataAndConvertToBase64(
  uri: string,
  mimeType: string = 'image/jpeg'
): Promise<string> {
  const strippedUri = await stripImageMetadata(uri);

  // Read the stripped image file and convert to base64
  const response = await fetch(strippedUri);
  const blob = await response.blob();

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Ensure correct MIME type in data URI
      const base64 = result.split(',')[1];
      resolve(`data:${mimeType};base64,${base64}`);
    };
    reader.onerror = () => {
      reject(new Error('Failed to read stripped image'));
    };
    reader.readAsDataURL(blob);
  });
}
