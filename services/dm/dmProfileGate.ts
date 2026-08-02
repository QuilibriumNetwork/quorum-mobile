// Per-partner send gate for the `dm-update-profile` broadcast — the DECISION
// half, kept free of MMKV (and therefore of native modules) so it is directly
// unit-testable. The persistence shim around it lives in dmProfileService.
//
// Why a gate at all: the on-connect rebroadcast fires on every
// reconnect/remount and the save handlers fire on every tap-save, so without
// one a partner gets the same identity re-sent — a real DM plus a push — every
// single time.
//
// UNTIL 2026-08-01 the rule was ONLY dedup: no expiry, no retry. A given
// identity went to a given partner exactly ONCE, ever, across app launches. On
// a transport measured losing 15-20% of messages, that made a single dropped
// frame a PERMANENT failure — the sender's gate is shut, the partner renders a
// placeholder forever, and nothing ever tries again.
//
// So the gate now expires, a BOUNDED number of times: an unchanged identity is
// re-sent at most once per RESEND_INTERVAL_MS, at most MAX_SENDS_PER_IDENTITY
// times, per partner.
//
// Note the direction. This is an INCREASE for mobile (1 attempt -> 3). The
// identical change on desktop was a large DECREASE: its gate expired every 24h
// with NO cap, so a converged pair paid 365 sends a year to say nothing new.
// The two platforms sat at opposite extremes; this is the number in between,
// and it is deliberately identical on both.
//
// ⚠️ The retry is a TRANSITIONAL SAFETY NET, not architecture. With reliable
// delivery ONE send per identity is enough, and the cap should shrink toward 1
// as the transport is proven. Do not build as if it were permanent.
//
// The rule itself (cap, expiry, legacy migration) lives in
// services/identity/profileAnnounceGate.ts and is shared with the per-space
// announce. What stays here is DM-specific: the constants and the exported
// names the DM service calls.
//
// Desktop counterpart: quorum-desktop/src/utils/dmProfileGate.ts — same rule,
// same constants, same migration semantics.
//
// Decision, cost model and the loss measurements behind the number 3:
// quorum-desktop/.agents/tasks/2026-08-01-identity-announce-cadence-research.md
// (that repo's .agents/ is git-tracked; this one's is not, so the reasoning
// lives there on purpose.)

import {
  createProfileAnnounceGate,
  type ProfileGateRecord,
} from '../identity/profileAnnounceGate';

/** Minimum gap between two sends of the SAME identity to the same partner. */
export const RESEND_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

/** How many times an UNCHANGED identity is ever sent to one partner. */
export const MAX_SENDS_PER_IDENTITY = 3;

const gate = createProfileAnnounceGate({
  intervalMs: RESEND_INTERVAL_MS,
  maxSends: MAX_SENDS_PER_IDENTITY,
});

export type DmProfileGateRecord = ProfileGateRecord;

/** See `profileAnnounceGate.readGateRecord`. */
export function readGateRecord(
  raw: string | null | undefined,
  now: number
): { record: DmProfileGateRecord | null; migrated: boolean } {
  return gate.readGateRecord(raw, now);
}

/**
 * The send decision.
 *
 * Send when we have never sent, when the identity CHANGED (new information, so
 * it ignores both the interval and the cap and starts its own count), or when
 * the interval has elapsed AND we are still under the cap.
 */
export function shouldSendProfile(
  record: DmProfileGateRecord | null,
  sig: string,
  now: number
): boolean {
  return gate.shouldSend(record, sig, now);
}

/**
 * The attempts value to persist after a successful send.
 * A different signature restarts the count: the cap is per identity-version.
 */
export function nextAttempts(
  record: DmProfileGateRecord | null,
  sig: string
): number {
  return gate.nextAttempts(record, sig);
}
