/**
 * A multi-image cast loads its first image, and the next one once it's laid
 * out, not every image up front.
 *
 * ## The regression this pins
 *
 * `SocialFeed/media/ImageCarousel` (thread and profile screens) is a
 * horizontal FlatList left at its defaults: ten items rendered up front and a
 * window of 21 screens, so every image in a cast mounted and downloaded as it
 * scrolled into view, though most carousels are never swiped.
 *
 * ## What is asserted
 *
 * - Only the first page mounts at first.
 * - Once the list is laid out, its neighbour mounts too, and nothing further.
 */
import React from 'react';
import { act, cleanup, fireEvent } from '@testing-library/react-native';
import { ScrollView } from 'react-native';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { ImageCarousel } from '@/components/SocialFeed/media/ImageCarousel';
import { SCREEN_WIDTH } from '@/components/SocialFeed/utils';
import { DarkTheme } from '@/theme';

const mockMounted = new Set<string>();
jest.mock('@/components/SocialFeed/media/AutoHeightImage', () => ({
  AutoHeightImage: ({ uri }: { uri: string }) => {
    mockMounted.add(uri);
    return null;
  },
}));

const urls = ['a', 'b', 'c', 'd'].map((n) => `https://example.invalid/${n}.jpg`);

afterEach(() => {
  cleanup();
  mockMounted.clear();
});

it('mounts the first image, then its neighbour once laid out, not all four', () => {
  jest.useFakeTimers();
  try {
    const root = renderWithProviders(<ImageCarousel urls={urls} maxHeight={600} theme={DarkTheme} />);
    expect([...mockMounted]).toEqual([urls[0]]);

    // The FlatList's own ScrollView carries its layout handlers.
    const list = root.UNSAFE_getByType(ScrollView);
    act(() => {
      fireEvent(list, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: SCREEN_WIDTH, height: 400 } } });
      fireEvent(list, 'contentSizeChange', SCREEN_WIDTH * urls.length, 400);
      jest.runAllTimers();
    });
    expect([...mockMounted]).toEqual(urls.slice(0, 2));
  } finally {
    jest.useRealTimers();
  }
});
