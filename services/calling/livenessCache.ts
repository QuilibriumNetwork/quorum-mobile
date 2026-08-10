/**
 * Process-wide memo for space-call room liveness.
 *
 * A channel's message list can hold many call bubbles, and FlashList unmounts,
 * remounts and outright recycles their rows as you scroll. Without a memo, the
 * same handful of questions ("is this call still up?") would be re-asked over
 * the network on every pass. Kept out of the hook so the caching and dedup
 * rules can be tested without a renderer.
 */

import type { SpaceCallLiveness } from './spaceCallStatus';

/**
 * A live room can die at any moment, so its answer goes stale quickly. A gone
 * room cannot come back — call ids are minted per call and never reused — so
 * that answer is worth holding through a scroll back and forth. Neither is
 * cached forever: a wrong verdict should always age out rather than pin a
 * bubble to it for the session.
 */
export const LIVENESS_TTL_MS: Record<Exclude<SpaceCallLiveness, 'unknown'>, number> = {
  live: 15_000,
  gone: 5 * 60_000,
};

interface CacheEntry {
  value: Exclude<SpaceCallLiveness, 'unknown'>;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<SpaceCallLiveness>>();

/**
 * What we already know, without asking. Safe to call during render: it reads
 * and never mutates, so a double-invoked render cannot change what a later one
 * sees.
 */
export function peekLiveness(callId: string | undefined): SpaceCallLiveness {
  if (!callId) return 'unknown';
  const hit = cache.get(callId);
  if (!hit) return 'unknown';
  if (hit.expiresAt <= Date.now()) return 'unknown';
  return hit.value;
}

/**
 * Resolve liveness, asking `probe` only when the answer is not already known.
 * Concurrent callers for the same id share one request.
 */
export async function fetchLiveness(
  callId: string,
  probe: (callId: string) => Promise<SpaceCallLiveness>,
): Promise<SpaceCallLiveness> {
  const known = peekLiveness(callId);
  if (known !== 'unknown') return known;

  const existing = inFlight.get(callId);
  if (existing) return existing;

  const request = probe(callId)
    .then((value) => {
      // `unknown` is the absence of an answer, not an answer. Caching it would
      // suppress the retry that gets a real one.
      if (value === 'unknown') {
        cache.delete(callId);
      } else {
        cache.set(callId, { value, expiresAt: Date.now() + LIVENESS_TTL_MS[value] });
      }
      return value;
    })
    .finally(() => {
      inFlight.delete(callId);
    });

  inFlight.set(callId, request);
  return request;
}

/** Test seam — drops every cached verdict and in-flight request. */
export function resetLivenessCache(): void {
  cache.clear();
  inFlight.clear();
}
