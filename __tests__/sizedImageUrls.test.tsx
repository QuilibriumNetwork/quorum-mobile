/**
 * Images are requested at the size they're shown, and fall back to the
 * original if the sized copy fails.
 *
 * ## The regression this pins
 *
 * Casts and profiles link Cloudflare Images' `original` variant, the full
 * upload, so a 44 px avatar or a phone-wide feed image downloaded (and
 * decoded) the whole thing. The account serves flexible `w=<px>` variants from
 * the same host; images now ask for one, bucketed, and fall back to the
 * original URL when a sized copy fails (the account owner could turn the
 * feature off).
 *
 * ## What is asserted
 *
 * - Cloudflare Images URLs get a bucketed width for the screen's density,
 *   capped at 2x (a 3x phone asked for a phone-wide feed image at 1280 px,
 *   about twice the bytes of 960), and avatars a still frame; any other URL is
 *   left alone.
 * - An avatar falls back to the original, then to initials.
 * - A feed image falls back to the original.
 * - So does any other picture shown through `SizedImage`.
 */
import React from 'react';
import { PixelRatio } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { Image as ExpoImage } from 'expo-image';
import { sizedImageUrl } from '@/utils/imageVariants';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { AutoHeightImage } from '@/components/SocialFeed/media/AutoHeightImage';
import { SizedImage } from '@/components/ui/SizedImage';

const ORIGINAL = 'https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/d40517e9-a5cb-49f4-d553-59c2c7e72e00/original';
const base = ORIGINAL.replace(/original$/, '');

beforeEach(() => {
  jest.spyOn(PixelRatio, 'get').mockReturnValue(3);
});
afterEach(() => jest.restoreAllMocks());

describe('sizedImageUrl', () => {
  it('asks Cloudflare Images for a bucketed width at the screen’s density, at most 2x', () => {
    // A 3x screen (mocked above) is asked for at 2x.
    expect(sizedImageUrl(ORIGINAL, 44)).toBe(`${base}w=96`);
    expect(sizedImageUrl(ORIGINAL, 400)).toBe(`${base}w=960`);
    expect(sizedImageUrl(ORIGINAL, 2000)).toBe(`${base}w=1920`);
  });

  it('uses the screen’s own density below 2x', () => {
    jest.spyOn(PixelRatio, 'get').mockReturnValue(1.5);
    expect(sizedImageUrl(ORIGINAL, 400)).toBe(`${base}w=640`);
  });

  it('drops animation for a still frame, and keeps a query string', () => {
    expect(sizedImageUrl(ORIGINAL, 44, { stillFrame: true })).toBe(`${base}anim=false,w=96`);
    expect(sizedImageUrl(`${ORIGINAL}?v=2`, 44)).toBe(`${base}w=96?v=2`);
  });

  it('leaves any other URL, or an unknown width, alone', () => {
    expect(sizedImageUrl('https://i.imgur.com/abc.jpg', 44)).toBe('https://i.imgur.com/abc.jpg');
    expect(sizedImageUrl('https://imagedelivery.net/acct/id', 44)).toBe('https://imagedelivery.net/acct/id');
    expect(sizedImageUrl(ORIGINAL, 0)).toBe(ORIGINAL);
  });
});

const sourceOf = (root: ReturnType<typeof render>) => root.UNSAFE_getByType(ExpoImage).props.source?.uri;
const fail = (root: ReturnType<typeof render>) =>
  act(() => root.UNSAFE_getByType(ExpoImage).props.onError({ error: 'failed' }));

it('an avatar tries the sized copy, then the original, then initials', () => {
  const root = render(
    <CachedAvatar source={{ uri: ORIGINAL }} style={{ width: 44, height: 44 }} fallbackName="Alice" />,
  );
  expect(sourceOf(root)).toBe(`${base}anim=false,w=96`);
  fail(root);
  expect(sourceOf(root)).toBe(ORIGINAL);
  fail(root);
  expect(root.UNSAFE_queryAllByType(ExpoImage)).toHaveLength(0);
});

it('a feed image tries the sized copy, then the original', () => {
  const root = render(<AutoHeightImage uri={ORIGINAL} maxWidth={400} maxHeight={Infinity} />);
  expect(sourceOf(root)).toBe(`${base}w=960`);
  fail(root);
  expect(sourceOf(root)).toBe(ORIGINAL);
});

it('a SizedImage tries the sized copy, then the original', () => {
  const root = render(<SizedImage uri={ORIGINAL} displayWidth={100} style={{ width: 100, height: 100 }} />);
  expect(sourceOf(root)).toBe(`${base}w=320`);
  fail(root);
  expect(sourceOf(root)).toBe(ORIGINAL);
});
