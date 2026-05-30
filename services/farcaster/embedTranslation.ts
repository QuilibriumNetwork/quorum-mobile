/**
 * Embed translation — convert composer-side embed URLs into the
 * protocol-correct `CastEmbed[]` shape that `buildSignedMessage` accepts.
 *
 * The composer collects URLs as plain strings (image URLs, page links,
 * farcaster.xyz cast links). Hypersnap's submit path takes
 * `{ url } | { castId: { fid, hash } }`. The castId form is the right
 * one for a quote-cast — using the URL form would create a duplicate
 * on the reading side (we already dedupe `castId + farcaster.xyz/<u>/0x<h>`
 * pairs in `fromHypersnapEmbeds`, but submitting the canonical form
 * keeps the protocol-level message clean).
 *
 * Resolution failures fall back to the URL form, so the embed is never
 * lost.
 */

import { QueryClient } from '@tanstack/react-query';
import { fetchFarcasterCastByUrl, type CastEmbed } from '@quilibrium/quorum-shared';

/** 0x-prefixed lowercase hex → bytes. Tiny — not worth bringing in a
 *  package-level helper for the one site that needs it. */
function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.replace(/^0x/i, '');
  if (stripped.length % 2 !== 0) throw new Error('hexToBytes: odd-length hex');
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const FARCASTER_CAST_URL_RE =
  /^https?:\/\/(?:www\.)?farcaster\.xyz\/([^\/\s]+)\/(0x[a-fA-F0-9]+)/;

function parseFarcasterCastUrl(url: string): { username: string; prefix: string } | null {
  const m = url.match(FARCASTER_CAST_URL_RE);
  return m ? { username: m[1], prefix: m[2] } : null;
}

/**
 * For each URL: if it's a `farcaster.xyz/<user>/0x<hash>` cast link,
 * try to resolve it to a `{ fid, fullHash }` pair and emit the
 * `castId` embed. Anything else (or a failed resolve) stays as `{ url }`.
 */
export async function translateEmbedUrls(
  urls: string[],
  qc: QueryClient,
): Promise<CastEmbed[]> {
  if (urls.length === 0) return [];
  const results = await Promise.all(
    urls.map(async (url): Promise<CastEmbed> => {
      const parsed = parseFarcasterCastUrl(url);
      if (!parsed) return { url };
      try {
        const cast = await qc.fetchQuery({
          queryKey: ['farcaster', 'cast-by-url', { username: parsed.username, castHashPrefix: parsed.prefix }] as const,
          queryFn: () => fetchFarcasterCastByUrl(parsed.username, parsed.prefix),
          staleTime: Number.POSITIVE_INFINITY,
          gcTime: Number.POSITIVE_INFINITY,
        });
        if (cast?.hash && cast.author?.fid) {
          return {
            castId: {
              fid: cast.author.fid,
              hash: hexToBytes(cast.hash),
            },
          };
        }
      } catch {
        // Resolution failed — fall through to URL form.
      }
      return { url };
    }),
  );
  return results;
}
