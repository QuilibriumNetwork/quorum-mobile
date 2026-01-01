import { pickImage, processImageAsset } from '../imageAttachment';
import * as ImagePicker from 'expo-image-picker';
import { stripImageMetadata } from '@/utils/imageMetadata';

// Mock dependencies
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  MediaTypeOptions: {
    Images: 'images',
  },
}));
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn(),
  SaveFormat: {
    JPEG: 'jpeg',
    PNG: 'png',
  },
}));
jest.mock('@/utils/imageMetadata');

// Mock FileReader
global.FileReader = jest.fn().mockImplementation(() => ({
  readAsDataURL: jest.fn(function (this: FileReader) {
    setTimeout(() => {
      if (this.onloadend) {
        this.result = 'data:image/jpeg;base64,strippedbase64';
        this.onloadend({} as ProgressEvent<FileReader>);
      }
    }, 0);
  }),
  onloadend: null,
  result: null,
}));

// Mock fetch
global.fetch = jest.fn();

describe('imageAttachment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('processImageAsset', () => {
    it('should strip metadata from non-GIF images', async () => {
      const mockAsset = {
        uri: 'file:///path/to/image.jpg',
        width: 800,
        height: 600,
        mimeType: 'image/jpeg',
        fileSize: 500000,
        base64: 'originalbase64',
      };

      const mockStrippedUri = 'file:///path/to/stripped-image.jpg';

      (stripImageMetadata as jest.Mock).mockResolvedValue(mockStrippedUri);

      // Mock fetch for reading stripped image
      const mockBlob = new Blob(['image data']);
      (global.fetch as jest.Mock).mockResolvedValue({
        blob: jest.fn().mockResolvedValue(mockBlob),
      });

      // Mock FileReader
      const mockFileReader = {
        readAsDataURL: jest.fn(function (this: any) {
          setTimeout(() => {
            this.result = 'data:image/jpeg;base64,strippedbase64';
            if (this.onloadend) {
              this.onloadend({} as ProgressEvent<FileReader>);
            }
          }, 0);
        }),
        onloadend: null,
        result: null,
      };
      (global.FileReader as jest.Mock).mockImplementation(() => mockFileReader);

      const result = await processImageAsset(mockAsset);

      expect(stripImageMetadata).toHaveBeenCalledWith(mockAsset.uri);
      expect(result.success).toBe(true);
      if (result.attachment) {
        expect(result.attachment.imageUrl).toContain('strippedbase64');
        expect(result.attachment.localUri).toBe(mockStrippedUri);
      }
    });

    it('should not strip metadata from GIF images', async () => {
      const mockAsset = {
        uri: 'file:///path/to/image.gif',
        width: 400,
        height: 400,
        mimeType: 'image/gif',
        fileSize: 200000,
        base64: 'gifbase64',
      };

      const result = await processImageAsset(mockAsset);

      // For GIFs, stripImageMetadata should not be called
      expect(stripImageMetadata).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      if (result.attachment) {
        expect(result.attachment.imageUrl).toContain('gifbase64');
      }
    });

    it('should fallback to original image if metadata stripping fails', async () => {
      const mockAsset = {
        uri: 'file:///path/to/image.jpg',
        width: 800,
        height: 600,
        mimeType: 'image/jpeg',
        fileSize: 500000,
        base64: 'originalbase64',
      };

      // Make stripImageMetadata fail
      (stripImageMetadata as jest.Mock).mockRejectedValue(new Error('Stripping failed'));

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = await processImageAsset(mockAsset);

      expect(result.success).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to strip metadata'),
        expect.any(Error)
      );
      if (result.attachment) {
        expect(result.attachment.imageUrl).toContain('originalbase64');
      }

      consoleSpy.mockRestore();
    });
  });

  describe('pickImage', () => {
    it('should request camera permissions for camera source', async () => {
      (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValue({
        status: 'granted',
      });

      (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValue({
        canceled: true,
      });

      await pickImage('camera');

      expect(ImagePicker.requestCameraPermissionsAsync).toHaveBeenCalled();
      expect(ImagePicker.launchCameraAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: false,
        })
      );
    });

    it('should request media library permissions for library source', async () => {
      (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValue({
        status: 'granted',
      });

      (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
        canceled: true,
      });

      await pickImage('library');

      expect(ImagePicker.requestMediaLibraryPermissionsAsync).toHaveBeenCalled();
      expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: false,
        })
      );
    });

    it('should return error if permissions are denied', async () => {
      (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValue({
        status: 'denied',
      });

      const result = await pickImage('library');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Photo library permission denied');
    });
  });
});
