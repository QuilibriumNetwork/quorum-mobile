/**
 * Feed images are sized from their own load, and take a recycled cell's new
 * size at once.
 *
 * ## The regression this pins
 *
 * `AutoHeightImage` measured each image with `Image.getSize` before showing it
 * with expo-image: two downloads of every image in the feed. Its height lived
 * in state set by an effect, so a FlashList cell recycled onto a new image kept
 * the previous image's height until that effect ran, a visible jump.
 *
 * ## What is asserted
 *
 * - No `Image.getSize`; the ratio comes from expo-image's `onLoad`.
 * - An unmeasured image gets a 4:3 box; a measured one its own ratio, capped by
 *   `maxHeight` and clamped against extreme shapes.
 * - Rebinding to another URL resizes in the same render, from the cache when
 *   that URL was seen before.
 */
import React from 'react';
import { Image as RNImage, StyleSheet } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { Image as ExpoImage } from 'expo-image';
import { AutoHeightImage } from '@/components/SocialFeed/media/AutoHeightImage';
import { imageDimensionCache } from '@/components/SocialFeed/utils';

const WIDTH = 400;

function boxOf(root: ReturnType<typeof render>) {
  const image = root.UNSAFE_getByType(ExpoImage);
  return { image, style: StyleSheet.flatten(image.props.style) as { width: number; height: number } };
}

function load(root: ReturnType<typeof render>, width: number, height: number) {
  const { image } = boxOf(root);
  act(() => image.props.onLoad({ source: { url: image.props.source.uri, width, height, mediaType: null }, cacheType: 'none' }));
}

beforeEach(() => imageDimensionCache.clear());

it('sizes from the load event, without measuring first', () => {
  const getSize = jest.spyOn(RNImage, 'getSize');
  const root = render(<AutoHeightImage uri="https://example.invalid/a.jpg" maxWidth={WIDTH} maxHeight={Infinity} />);

  expect(boxOf(root).style).toMatchObject({ width: WIDTH, height: 300 });
  load(root, 1000, 500);
  expect(boxOf(root).style.height).toBe(200);
  expect(getSize).not.toHaveBeenCalled();
});

it('caps at maxHeight and clamps extreme shapes', () => {
  const tall = render(<AutoHeightImage uri="https://example.invalid/tall.jpg" maxWidth={WIDTH} maxHeight={Infinity} />);
  load(tall, 100, 10_000);
  expect(boxOf(tall).style.height).toBe(WIDTH * 3);

  const capped = render(<AutoHeightImage uri="https://example.invalid/sq.jpg" maxWidth={WIDTH} maxHeight={250} />);
  load(capped, 500, 500);
  expect(boxOf(capped).style.height).toBe(250);
});

it('resizes in the same render when a recycled cell gets a new image', () => {
  const root = render(<AutoHeightImage uri="https://example.invalid/a.jpg" maxWidth={WIDTH} maxHeight={Infinity} />);
  load(root, 1000, 500);
  expect(boxOf(root).style.height).toBe(200);

  // An image never seen before: the default box straight away, not a's height.
  root.rerender(<AutoHeightImage uri="https://example.invalid/b.jpg" maxWidth={WIDTH} maxHeight={Infinity} />);
  expect(boxOf(root).style.height).toBe(300);

  // Back to a: its cached ratio, before it loads again.
  root.rerender(<AutoHeightImage uri="https://example.invalid/a.jpg" maxWidth={WIDTH} maxHeight={Infinity} />);
  expect(boxOf(root).style.height).toBe(200);
});
