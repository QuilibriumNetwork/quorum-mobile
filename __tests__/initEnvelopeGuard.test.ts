/**
 * Staleness rules for Double Ratchet init envelopes (pure logic).
 * Mirrors the desktop guard's semantics: a redelivered or zombie init
 * envelope must be refused so it cannot replace a newer session.
 */

import {
  isStaleInitEnvelope,
  INIT_ENVELOPE_STALENESS_TOLERANCE_MS,
} from '../services/crypto/initEnvelopeGuard';

const T = 1_750_000_000_000; // arbitrary base timestamp

describe('isStaleInitEnvelope', () => {
  it('rule 1: no existing timestamps → not stale (first init)', () => {
    expect(isStaleInitEnvelope(T, [])).toBe(false);
  });

  it('rule 2: exact timestamp match → stale (redelivery of a processed envelope)', () => {
    expect(isStaleInitEnvelope(T, [T])).toBe(true);
    expect(isStaleInitEnvelope(T, [T - 5_000, T, T + 5_000])).toBe(true);
  });

  it('rule 3: older than newest row beyond tolerance → stale (zombie)', () => {
    const newest = T;
    const zombie = newest - INIT_ENVELOPE_STALENESS_TOLERANCE_MS - 1;
    expect(isStaleInitEnvelope(zombie, [newest])).toBe(true);
    // Months-old zombie (the live-observed case)
    expect(isStaleInitEnvelope(newest - 60 * 24 * 60 * 60 * 1000, [newest])).toBe(true);
  });

  it('within skew tolerance → NOT stale (clock-domain skew absorbed)', () => {
    const newest = T;
    const slightlyOlder = newest - INIT_ENVELOPE_STALENESS_TOLERANCE_MS + 1;
    expect(isStaleInitEnvelope(slightlyOlder, [newest])).toBe(false);
  });

  it('genuinely newer envelope (session reset) → NOT stale', () => {
    expect(isStaleInitEnvelope(T + 10_000, [T - 50_000, T])).toBe(false);
  });

  it('respects a custom tolerance', () => {
    const newest = T;
    expect(isStaleInitEnvelope(newest - 1_500, [newest], 1_000)).toBe(true);
    expect(isStaleInitEnvelope(newest - 500, [newest], 1_000)).toBe(false);
  });
});
