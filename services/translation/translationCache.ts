/**
 * translationCache — process-lifetime caches for detection + translation.
 *
 * These are plain module-scope Maps (NOT React state) so they survive FlashList
 * cell recycling and re-renders: scrolling a feed/chat re-mounts cells with the
 * same text, and we want zero repeated native bridge calls for text we've
 * already detected/translated. Keyed by a cheap 32-bit hash of the text to
 * bound memory; FIFO-evicted past a cap.
 *
 * Detection entries can be an in-flight Promise so concurrent cells showing the
 * same text de-dupe onto one native call.
 */

import type { Detection } from 'quorum-translation';

const MAX_ENTRIES = 500;

const detectionCache = new Map<number, Detection | Promise<Detection>>();
const translationCache = new Map<string, string>();

/** FNV-1a 32-bit hash — fast, good enough for cache keys. */
export function hashText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function evict<K, V>(map: Map<K, V>): void {
  if (map.size <= MAX_ENTRIES) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

export function getCachedDetection(hash: number): Detection | Promise<Detection> | undefined {
  return detectionCache.get(hash);
}

export function setCachedDetection(hash: number, value: Detection | Promise<Detection>): void {
  detectionCache.set(hash, value);
  evict(detectionCache);
}

export function getCachedTranslation(hash: number, target: string): string | undefined {
  return translationCache.get(`${hash}:${target}`);
}

export function setCachedTranslation(hash: number, target: string, value: string): void {
  translationCache.set(`${hash}:${target}`, value);
  evict(translationCache);
}
