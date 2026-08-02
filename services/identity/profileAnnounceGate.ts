// Shared decision logic for identity-announce gates — the DECISION half only,
// deliberately free of MMKV (and therefore of native modules) so it is directly
// unit-testable. Each caller supplies its own persistence.
//
// Two callers: the per-partner DM push (`services/dm/dmProfileGate.ts`) and the
// per-space announce (`services/space/spaceAnnounceGate.ts`). They differ only
// in where the record is stored; the rule below — cap, expiry, legacy migration —
// is identical, and every clause of it was paid for with a live failure.
//
// The rule:
//
//   never sent / identity changed → send (a rename resets the count)
//   attempts exhausted            → never again, until the identity changes
//   otherwise                     → send once the interval has elapsed
//
// Why both halves matter:
//
// - NO EXPIRY makes a single lost or unheard frame a PERMANENT, silent failure.
//   The sender records success, the peer renders a placeholder forever, nothing
//   retries. This was mobile's behaviour on both paths until 2026-08-01: an
//   identity went to a given destination exactly ONCE, ever, across launches.
// - NO CAP makes a converged pair pay forever to say nothing new — desktop's
//   old DM gate expired every 24h with no cap, i.e. 365 sends a year per pair.
//
// The two platforms sat at opposite extremes. Three attempts is the number in
// between, and it is deliberately identical on both.
//
// ⚠️ TRANSITIONAL SAFETY NET, not architecture. With reliable delivery ONE send
// per identity is enough, and the cap should shrink toward 1 as the transport is
// proven. Do not build as if it were permanent.
//
// Desktop counterpart: quorum-desktop/src/utils/profileSendGate.ts — same rule,
// same constants, same migration semantics. Decision and cost model:
// quorum-desktop/.agents/tasks/2026-08-01-identity-announce-cadence-research.md
// (that repo's .agents/ is git-tracked; this one's is not, so the reasoning
// lives there on purpose.)

export interface ProfileGateRecord {
  sig: string;
  at: number;
  /** Sends of THIS signature to this destination so far. */
  attempts: number;
}

export interface ProfileAnnounceGate {
  /**
   * Parse a stored gate value.
   *
   * `migrated` tells the caller to PERSIST the upgrade. That write matters: if
   * the upgrade were recomputed on every read instead, `now - at` would always
   * be ~0 and the record could never age out — which is exactly how the pre-cap
   * code left every record permanently shut.
   */
  readGateRecord(
    raw: string | null | undefined,
    now: number
  ): { record: ProfileGateRecord | null; migrated: boolean };
  /** Send when never sent, when the identity CHANGED, or when the interval has elapsed and we are under the cap. */
  shouldSend(record: ProfileGateRecord | null, sig: string, now: number): boolean;
  /** The attempts value to persist after a successful send. */
  nextAttempts(record: ProfileGateRecord | null, sig: string): number;
}

export function createProfileAnnounceGate(config: {
  intervalMs: number;
  maxSends: number;
}): ProfileAnnounceGate {
  const { intervalMs, maxSends } = config;

  /**
   * Attempts credited to a record written before the cap existed.
   *
   * One below the cap leaves exactly ONE more try for destinations that are
   * broken right now, then it closes. On mobile EVERY existing record is a
   * pre-cap one, so this is the one-time heal for everything announced under
   * the old send-once rule.
   */
  const migratedAttempts = Math.max(0, maxSends - 1);

  return {
    readGateRecord(raw, now) {
      if (!raw) return { record: null, migrated: false };
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          typeof (parsed as ProfileGateRecord).sig === 'string'
        ) {
          // Only `sig` is required to recognise the object form. The numbers are
          // validated separately so a record with unusable ones still migrates
          // with its REAL signature, rather than falling through and having the
          // whole JSON blob mistaken for a bare signature.
          const { sig, at, attempts } = parsed as ProfileGateRecord;
          // `Number.isFinite` / `Number.isInteger`, not `typeof === 'number'`:
          // NaN and Infinity are both numbers, and either breaks the gate
          // silently — a NaN `attempts` defeats the cap (`NaN >= 3` is false, so
          // it sends forever) and a NaN `at` wedges the interval shut. Both
          // serialise to `null` through JSON, so this covers stored ones too.
          if (Number.isFinite(at) && Number.isInteger(attempts) && attempts >= 0) {
            return { record: { sig, at, attempts }, migrated: false };
          }
          return {
            record: { sig, at: now, attempts: migratedAttempts },
            migrated: true,
          };
        }
      } catch {
        // Not JSON — fall through. A legacy value is a bare signature, which is
        // itself valid JSON (an object), so the SHAPE check above is what
        // actually separates the two formats, not the try/catch.
      }
      // ⚠️ Anchored at NOW, never at any stored timestamp. Pre-cap values carry
      // no timestamp at all on mobile; treating them as "due" would fire every
      // destination on the first connect after deploy.
      return {
        record: { sig: raw, at: now, attempts: migratedAttempts },
        migrated: true,
      };
    },

    shouldSend(record, sig, now) {
      if (!record) return true;
      // A changed identity is not a retry — it is new information, so it ignores
      // both the interval and the cap and starts its own count.
      if (record.sig !== sig) return true;
      // The cap, checked BEFORE the interval so a converged destination
      // short-circuits without arithmetic.
      if (record.attempts >= maxSends) return false;
      return now - record.at >= intervalMs;
    },

    nextAttempts(record, sig) {
      // A different signature restarts the count: the cap is per
      // identity-version, not per destination for all time, so a rename gets its
      // own full set of attempts.
      return record && record.sig === sig ? record.attempts + 1 : 1;
    },
  };
}
