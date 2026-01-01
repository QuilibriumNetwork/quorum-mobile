/**
 * Test helpers for image metadata tests
 */

export function createMockImageAsset(overrides: Partial<any> = {}) {
  return {
    uri: 'file:///path/to/test-image.jpg',
    width: 800,
    height: 600,
    mimeType: 'image/jpeg',
    fileSize: 500000,
    base64: 'mockbase64data',
    ...overrides,
  };
}

export function createMockStrippedImageResponse() {
  return {
    uri: 'file:///path/to/stripped-image.jpg',
  };
}

export function mockFileReaderWithResult(base64Data: string) {
  return {
    readAsDataURL: jest.fn(function (this: any) {
      setTimeout(() => {
        this.result = `data:image/jpeg;base64,${base64Data}`;
        if (this.onloadend) {
          this.onloadend({} as ProgressEvent<FileReader>);
        }
      }, 0);
    }),
    onloadend: null,
    result: null,
  };
}
