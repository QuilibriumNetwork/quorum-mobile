import * as ImageManipulator from 'expo-image-manipulator';
import { stripImageMetadata, stripMetadataAndConvertToBase64 } from '../imageMetadata';

// Mock expo-image-manipulator
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn(),
  SaveFormat: {
    JPEG: 'jpeg',
    PNG: 'png',
  },
}));

// Mock FileReader for base64 conversion
global.FileReader = jest.fn().mockImplementation(() => ({
  readAsDataURL: jest.fn(function (this: FileReader) {
    // Simulate async read
    setTimeout(() => {
      if (this.onloadend) {
        this.result = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
        this.onloadend({} as ProgressEvent<FileReader>);
      }
    }, 0);
  }),
  onloadend: null,
  result: null,
}));

// Mock fetch for reading stripped images
global.fetch = jest.fn();

describe('imageMetadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('stripImageMetadata', () => {
    it('should strip metadata by re-encoding the image', async () => {
      const mockUri = 'file:///path/to/image.jpg';
      const mockStrippedUri = 'file:///path/to/stripped-image.jpg';

      (ImageManipulator.manipulateAsync as jest.Mock).mockResolvedValue({
        uri: mockStrippedUri,
      });

      const result = await stripImageMetadata(mockUri);

      expect(ImageManipulator.manipulateAsync).toHaveBeenCalledWith(
        mockUri,
        [], // No transformations
        {
          compress: 1.0,
          format: ImageManipulator.SaveFormat.JPEG,
        }
      );
      expect(result).toBe(mockStrippedUri);
    });

    it('should return original URI if manipulation fails', async () => {
      const mockUri = 'file:///path/to/image.jpg';
      const error = new Error('Manipulation failed');

      (ImageManipulator.manipulateAsync as jest.Mock).mockRejectedValue(error);

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await stripImageMetadata(mockUri);

      expect(result).toBe(mockUri); // Fallback to original
      expect(consoleSpy).toHaveBeenCalledWith(
        '[ImageMetadata] Failed to strip metadata:',
        error
      );

      consoleSpy.mockRestore();
    });

    it('should handle different image formats', async () => {
      const mockUri = 'file:///path/to/image.png';
      const mockStrippedUri = 'file:///path/to/stripped-image.jpg';

      (ImageManipulator.manipulateAsync as jest.Mock).mockResolvedValue({
        uri: mockStrippedUri,
      });

      const result = await stripImageMetadata(mockUri);

      expect(ImageManipulator.manipulateAsync).toHaveBeenCalled();
      expect(result).toBe(mockStrippedUri);
    });
  });

  describe('stripMetadataAndConvertToBase64', () => {
    it('should strip metadata and convert to base64 data URI', async () => {
      const mockUri = 'file:///path/to/image.jpg';
      const mockStrippedUri = 'file:///path/to/stripped-image.jpg';
      const mockMimeType = 'image/jpeg';
      const mockBase64 = 'base64encodeddata';

      (ImageManipulator.manipulateAsync as jest.Mock).mockResolvedValue({
        uri: mockStrippedUri,
      });

      // Mock fetch to return a blob
      const mockBlob = new Blob(['image data'], { type: mockMimeType });
      (global.fetch as jest.Mock).mockResolvedValue({
        blob: jest.fn().mockResolvedValue(mockBlob),
      });

      // Mock FileReader
      const mockFileReader = {
        readAsDataURL: jest.fn(function (this: any) {
          setTimeout(() => {
            this.result = `data:${mockMimeType};base64,${mockBase64}`;
            if (this.onloadend) {
              this.onloadend({} as ProgressEvent<FileReader>);
            }
          }, 0);
        }),
        onloadend: null,
        result: null,
      };
      (global.FileReader as jest.Mock).mockImplementation(() => mockFileReader);

      const result = await stripMetadataAndConvertToBase64(mockUri, mockMimeType);

      expect(ImageManipulator.manipulateAsync).toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledWith(mockStrippedUri);
      expect(result).toBe(`data:${mockMimeType};base64,${mockBase64}`);
    });

    it('should use default MIME type if not provided', async () => {
      const mockUri = 'file:///path/to/image.jpg';
      const mockStrippedUri = 'file:///path/to/stripped-image.jpg';
      const defaultMimeType = 'image/jpeg';
      const mockBase64 = 'base64encodeddata';

      (ImageManipulator.manipulateAsync as jest.Mock).mockResolvedValue({
        uri: mockStrippedUri,
      });

      const mockBlob = new Blob(['image data'], { type: defaultMimeType });
      (global.fetch as jest.Mock).mockResolvedValue({
        blob: jest.fn().mockResolvedValue(mockBlob),
      });

      const mockFileReader = {
        readAsDataURL: jest.fn(function (this: any) {
          setTimeout(() => {
            this.result = `data:${defaultMimeType};base64,${mockBase64}`;
            if (this.onloadend) {
              this.onloadend({} as ProgressEvent<FileReader>);
            }
          }, 0);
        }),
        onloadend: null,
        result: null,
      };
      (global.FileReader as jest.Mock).mockImplementation(() => mockFileReader);

      const result = await stripMetadataAndConvertToBase64(mockUri);

      expect(result).toContain(`data:${defaultMimeType};base64,`);
    });

    it('should handle FileReader errors gracefully', async () => {
      const mockUri = 'file:///path/to/image.jpg';
      const mockStrippedUri = 'file:///path/to/stripped-image.jpg';

      (ImageManipulator.manipulateAsync as jest.Mock).mockResolvedValue({
        uri: mockStrippedUri,
      });

      const mockBlob = new Blob(['image data']);
      (global.fetch as jest.Mock).mockResolvedValue({
        blob: jest.fn().mockResolvedValue(mockBlob),
      });

      const mockFileReader = {
        readAsDataURL: jest.fn(function (this: any) {
          setTimeout(() => {
            if (this.onerror) {
              this.onerror({} as ProgressEvent<FileReader>);
            }
          }, 0);
        }),
        onerror: null,
        result: null,
      };
      (global.FileReader as jest.Mock).mockImplementation(() => mockFileReader);

      await expect(
        stripMetadataAndConvertToBase64(mockUri)
      ).rejects.toThrow('Failed to read stripped image');
    });
  });
});
