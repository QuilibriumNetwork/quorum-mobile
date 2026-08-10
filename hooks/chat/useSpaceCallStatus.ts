/**
 * Liveness-aware status for one space-call bubble.
 *
 * Owns the probe as well as the derivation because the two are mutually
 * dependent: whether to probe is part of what the status says
 * (`shouldProbe`), and the probe result is an input to the status. Splitting
 * them across the component would need one of the two to be computed twice.
 * The decision itself stays in the pure `deriveSpaceCallStatus` and the memo
 * in `livenessCache`, which is where both are tested.
 */

import { useEffect, useState } from 'react';
import { SFUClient } from '@/services/calling/sfu-client';
import { fetchLiveness, peekLiveness } from '@/services/calling/livenessCache';
import {
  deriveSpaceCallStatus,
  type SpaceCallLiveness,
  type SpaceCallStatus,
} from '@/services/calling/spaceCallStatus';

const sfuClient = new SFUClient();

/** How often a still-undecided bubble re-asks. */
export const LIVENESS_POLL_MS = 30_000;

const probe = (callId: string) => sfuClient.probeRoomLiveness(callId);

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

  // Stored WITH the id it describes. FlashList recycles row components, so the
  // same instance can be handed a different call without ever unmounting —
  // keeping the id alongside the verdict means a recycled row falls back to
  // the cache during the very first render rather than painting one frame of
  // the previous call's answer.
  const [probed, setProbed] = useState<{ callId: string; value: SpaceCallLiveness } | null>(null);
  const liveness: SpaceCallLiveness =
    probed && probed.callId === callId ? probed.value : peekLiveness(callId);

  const status = deriveSpaceCallStatus({ startedAt, endedAt, liveness, selfInCall, now });

  const { shouldProbe } = status;
  useEffect(() => {
    if (!callId || !shouldProbe) return;

    let cancelled = false;
    const ask = async () => {
      const value = await fetchLiveness(callId, probe);
      // Leaving the last verdict in place when the effect tears down is
      // deliberate: clearing it would make the status flip back to live,
      // re-enable probing, and loop.
      if (!cancelled) setProbed({ callId, value });
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
