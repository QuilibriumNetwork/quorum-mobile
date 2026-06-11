/**
 * Resolve a Farcaster channel key (slug) to its canonical FIP-2 parent URL.
 *
 * A cast's channel membership is determined on-protocol by `parent_url`
 * matching the channel's canonical `url` EXACTLY. That URL is an opaque
 * identifier set at channel creation and never changes:
 *   - Warpcast-era channels: `https://warpcast.com/~/channel/<key>`
 *     (still the identifier post-rebrand — it is NOT a link)
 *   - original channels: FIP-2 URIs like `chain://eip155:1/erc721:0x…`
 *     (/ethereum, /memes, …)
 *
 * Constructing the URL from the key (the old behavior — and especially the
 * `farcaster.xyz` host form) produces an identifier no Farcaster backend
 * recognizes, so hub-submitted casts silently fall out of their channel.
 * The only correct source is the channel object from the Farcaster API.
 *
 * Canonical URLs are immutable, so successful lookups are cached forever
 * in MMKV. Failed lookups fall back to the warpcast.com form (correct for
 * the vast majority of channels) WITHOUT caching, so a later attempt can
 * still fetch the true value.
 */

import { mmkvStorage } from '@/services/offline/storage';
import { logger } from '@quilibrium/quorum-shared';

const CHANNEL_ENDPOINT = 'https://api.farcaster.xyz/v1/channel?channelId=';
const CACHE_KEY = 'farcaster.channelParentUrls.v1';
const FETCH_TIMEOUT_MS = 8000;

let memCache: Record<string, string> | null = null;

function loadCache(): Record<string, string> {
  if (memCache) return memCache;
  try {
    const raw = mmkvStorage.getItem(CACHE_KEY);
    memCache = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    memCache = {};
  }
  return memCache;
}

function persistCache(): void {
  if (!memCache) return;
  try {
    mmkvStorage.setItem(CACHE_KEY, JSON.stringify(memCache));
  } catch {
    // Cache persistence is best-effort; the in-memory copy still works.
  }
}

/** Constructed fallback — correct for most channels, but not guaranteed. */
export function fallbackChannelParentUrl(key: string): string {
  return `https://warpcast.com/~/channel/${key}`;
}

/**
 * Resolve a channel key to its canonical parent URL. Never throws — on any
 * failure it returns the warpcast.com fallback form (uncached).
 */
export async function resolveChannelParentUrl(key: string): Promise<string> {
  const cache = loadCache();
  const cached = cache[key];
  if (cached) return cached;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(
      `${CHANNEL_ENDPOINT}${encodeURIComponent(key)}`,
      { headers: { accept: 'application/json' }, signal: controller.signal }
    );
    clearTimeout(timeoutId);
    if (response.ok) {
      const json = (await response.json()) as {
        result?: { channel?: { url?: string } };
      };
      const url = json.result?.channel?.url;
      if (typeof url === 'string' && url.length > 0) {
        cache[key] = url;
        persistCache();
        return url;
      }
    }
    logger.warn(
      `[channelUrlResolver] no canonical url for channel "${key}" (status ${response.status}); using fallback`
    );
  } catch (e) {
    logger.warn(
      `[channelUrlResolver] lookup failed for channel "${key}"; using fallback`,
      e instanceof Error ? e.message : e
    );
  }

  return fallbackChannelParentUrl(key);
}
