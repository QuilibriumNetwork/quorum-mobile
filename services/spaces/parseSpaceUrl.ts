/**
 * Recognize `https://farcaster.xyz/~/spaces/<uuid>` URLs and pull out
 * the space id. Matches both the standard UUID-v4 form and the
 * lowercase v7 form farcaster.xyz actually issues
 * (e.g. `019e7436-9abf-6395-ff65-c6eb7b3a8d89`).
 */

const SPACE_URL_RE =
  /^https?:\/\/(?:www\.)?farcaster\.xyz\/~\/spaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export function parseFarcasterSpaceUrl(url: string | undefined): { id: string } | null {
  if (!url) return null;
  const m = url.match(SPACE_URL_RE);
  return m ? { id: m[1].toLowerCase() } : null;
}
