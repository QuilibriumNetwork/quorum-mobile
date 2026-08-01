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
// Desktop counterpart: quorum-desktop/src/utils/dmProfileGate.ts — same rule,
// same constants, same migration semantics.
//
// Decision, cost model and the loss measurements behind the number 3:
// quorum-desktop/.agents/tasks/2026-08-01-identity-announce-cadence-research.md
// (that repo's .agents/ is git-tracked; this one's is not, so the reasoning
// lives there on purpose.)

/** Minimum gap between two sends of the SAME identity to the same partner. */
export const RESEND_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

/** How many times an UNCHANGED identity is ever sent to one partner. */
export const MAX_SENDS_PER_IDENTITY = 3;

/**
 * Attempts credited to a record written before this cap existed.
 *
 * 2 leaves exactly ONE more try for pairs that are broken right now, then the
 * cap closes. On mobile EVERY existing record is a pre-cap one, so this is the
 * one-time heal for every partner announced under the old send-once rule.
 */
const MIGRATED_ATTEMPTS = MAX_SENDS_PER_IDENTITY - 1;

export interface DmProfileGateRecord {
  sig: string;
  at: number;
  /** Sends of THIS signature to this partner so far. */
  attempts: number;
}

/**
 * Parse a stored gate value.
 *
 * `migrated` tells the caller to persist the upgrade. That write matters: if the
 * upgrade were recomputed on every read instead, `now - at` would always be ~0
 * and the record could never age out — which is how the pre-cap code left every
 * record permanently shut.
 *
 * ⚠️ A migrated record is anchored at NOW, never at any stored timestamp. The
 * pre-cap values carry no timestamp at all on mobile, and on desktop carry one
 * up to 24h old — either way, treating them as "due" would fire every partner
 * on the first connect after deploy.
 */
export function readGateRecord(
  raw: string | null | undefined,
  now: number
): { record: DmProfileGateRecord | null; migrated: boolean } {
  if (!raw) return { record: null, migrated: false };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as DmProfileGateRecord).sig === 'string'
    ) {
      // Only `sig` is required to recognise the object form. The numbers are
      // validated separately so a record with unusable ones still migrates with
      // its REAL signature, rather than falling through and having the whole
      // JSON blob mistaken for a bare signature.
      const { sig, at, attempts } = parsed as DmProfileGateRecord;
      // `Number.isFinite` / `Number.isInteger`, not `typeof === 'number'`: NaN
      // and Infinity are both numbers, and either breaks the gate silently — a
      // NaN `attempts` defeats the cap (`NaN >= 3` is false, so it sends
      // forever) and a NaN `at` wedges the interval shut. Both serialise to
      // `null` through JSON, so this covers stored ones too. Desktop applies the
      // identical check.
      if (Number.isFinite(at) && Number.isInteger(attempts) && attempts >= 0) {
        return { record: { sig, at, attempts }, migrated: false };
      }
      return {
        record: { sig, at: now, attempts: MIGRATED_ATTEMPTS },
        migrated: true,
      };
    }
  } catch {
    // Not JSON — fall through. The legacy value is a bare signature, which is
    // itself valid JSON (an object), so the SHAPE check above is what actually
    // separates the two formats, not the try/catch.
  }
  return {
    record: { sig: raw, at: now, attempts: MIGRATED_ATTEMPTS },
    migrated: true,
  };
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
  if (!record) return true;
  if (record.sig !== sig) return true;
  if (record.attempts >= MAX_SENDS_PER_IDENTITY) return false;
  return now - record.at >= RESEND_INTERVAL_MS;
}

/**
 * The attempts value to persist after a successful send.
 * A different signature restarts the count: the cap is per identity-version.
 */
export function nextAttempts(
  record: DmProfileGateRecord | null,
  sig: string
): number {
  return record && record.sig === sig ? record.attempts + 1 : 1;
}
