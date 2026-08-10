/**
 * Liveness-aware status for one space-call bubble.
 *
 * Owns the probe as well as the derivation because the two are mutually
 * dependent: whether to probe is part of what the status says
 * (`shouldProbe`), and the probe result is an input to the status. Splitting
 * them across the component would need one of the two to be computed twice.
 * The decision itself stays in the pure `deriveSpaceCallStatus`, which is
 * where the branches are tested.
 */

import { useEffect, useState } from 'react';
import { SFUClient } from '@/services/calling/sfu-client';
import {
  deriveSpaceCallStatus,
  type SpaceCallLiveness,
  type SpaceCallStatus,
} from '@/services/calling/spaceCallStatus';

const sfuClient = new SFUClient();

/** How often a still-undecided bubble re-asks. */
export const LIVENESS_POLL_MS = 30_000;

/**
 * A live room can die at any moment, so its answer goes stale quickly. A gone
 * room cannot come back — call ids are minted per call and never reused — so
 * that answer is worth holding through a scroll back and forth. Neither is
 * cached forever: a wrong cached verdict should always age out.
 */
const CACHE_TTL_MS: Record<Exclude<SpaceCallLiveness, 'unknown'>, number> = {
  live: 15_000,
  gone: 5 * 60_000,
};

interface CacheEntry {
  value: Exclude<SpaceCallLiveness, 'unknown'>;
  expiresAt: number;
}

// Module-level so scrolling a channel (which unmounts and remounts rows, and
// with FlashList recycles the components outright) does not re-ask for every
// bubble it has already settled.
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<SpaceCallLiveness>>();

function peekCache(callId: string | undefined): SpaceCallLiveness {
  if (!callId) return 'unknown';
  const hit = cache.get(callId);
  if (!hit) return 'unknown';
  if (hit.expiresAt <= Date.now()) {
    cache.delete(callId);
    return 'unknown';
  }
  return hit.value;
}

async function probeLiveness(callId: string): Promise<SpaceCallLiveness> {
  const cached = peekCache(callId);
  if (cached !== 'unknown') return cached;

  // Two bubbles for the same call (or a remount mid-flight) share one request.
  const existing = inFlight.get(callId);
  if (existing) return existing;

  const request = sfuClient
    .probeRoomLiveness(callId)
    .then((value) => {
      // `unknown` is the absence of an answer, not an answer. Caching it would
      // suppress the retry that gets a real one.
      if (value !== 'unknown') {
        cache.set(callId, { value, expiresAt: Date.now() + CACHE_TTL_MS[value] });
      }
      return value;
    })
    .finally(() => {
      inFlight.delete(callId);
    });

  inFlight.set(callId, request);
  return request;
}

export interface UseSpaceCallStatusInput {
  /** Room id of the call this bubble describes. */
  callId?: string;
  /** Timestamp (ms) of the `space-call-start` message. */
  startedAt: number;
  /** Timestamp (ms) of the matching `space-call-end`, if one has arrived. */
  endedAt?: number | null;
  /** Whether THIS device is currently in this call. */
  selfInCall?: boolean;
  /** Current wall clock (ms) — the caller's ticker, so the timer and the
   *  status advance together. */
  now: number;
}

export function useSpaceCallStatus(input: UseSpaceCallStatusInput): SpaceCallStatus {
  const { callId, startedAt, endedAt, selfInCall, now } = input;
  const [liveness, setLiveness] = useState<SpaceCallLiveness>(() => peekCache(callId));

  const status = deriveSpaceCallStatus({ startedAt, endedAt, liveness, selfInCall, now });

  // FlashList recycles row components, so the same instance can be handed a
  // different call without ever unmounting. Re-seed from the cache when that
  // happens, or the new bubble inherits the previous call's verdict.
  useEffect(() => {
    setLiveness(peekCache(callId));
  }, [callId]);

  const { shouldProbe } = status;
  useEffect(() => {
    if (!callId || !shouldProbe) return;

    let cancelled = false;
    const ask = async () => {
      const value = await probeLiveness(callId);
      // Leaving `liveness` at its last value when the effect tears down is
      // deliberate: resetting it to `unknown` would make the status flip back
      // to live, re-enable probing, and loop.
      if (!cancelled) setLiveness(value);
    };

    void ask();
    const interval = setInterval(() => void ask(), LIVENESS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [callId, shouldProbe]);

  return status;
}

/** Test seam — drops every cached verdict. */
export function __resetLivenessCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
