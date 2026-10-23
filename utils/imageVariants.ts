/**
 * Ask Cloudflare Images for an image at the size it's shown, not its original.
 *
 * Farcaster's uploads live on `imagedelivery.net/<account>/<image id>/<variant>`,
 * and casts and profiles link the `original` variant: the full upload, for a
 * 44 px avatar or a feed image a phone's width across. The account has flexible
 * variants on, so `w=<px>` returns a resized copy from the same host
 * (checked 2026-10-19: one feed image went from 47.7 KB to 14.4 KB at w=640).
 * Widths are bucketed so the same image at nearby sizes shares one cache entry.
 *
 * That setting belongs to whoever runs the account and could be turned off;
 * callers fall back to the original URL when a sized one fails to load.
 */
import { PixelRatio } from 'react-native';

const WIDTH_BUCKETS = [96, 192, 320, 640, 960, 1280, 1920];

// Pixels asked for per point are capped at 2. At 3, a phone-wide feed image
// landed in the 1280 bucket; at 2 it's 960, roughly half the bytes, and the
// difference is hard to see at arm's length.
const MAX_PIXEL_RATIO = 2;

// https://imagedelivery.net/<account>/<image id>/<variant>[?query]
const IMAGEDELIVERY = /^(https:\/\/imagedelivery\.net\/[^/?#]+\/[^/?#]+\/)([^/?#]+)([?#].*)?$/;

/**
 * `url` resized for `displayWidth` points on this screen, when it's a Cloudflare
 * Images URL; otherwise `url` unchanged. `stillFrame` drops animation (avatars).
 */
export function sizedImageUrl(url: string, displayWidth: number, options: { stillFrame?: boolean } = {}): string {
  const match = IMAGEDELIVERY.exec(url);
  if (!match || !(displayWidth > 0)) return url;
  const pixels = Math.ceil(displayWidth * Math.min(PixelRatio.get(), MAX_PIXEL_RATIO));
  const width = WIDTH_BUCKETS.find((bucket) => bucket >= pixels) ?? WIDTH_BUCKETS[WIDTH_BUCKETS.length - 1];
  const variant = options.stillFrame ? `anim=false,w=${width}` : `w=${width}`;
  return `${match[1]}${variant}${match[3] ?? ''}`;
}
