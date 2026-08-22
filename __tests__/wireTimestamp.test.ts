/**
 * Unit tests for the wire-timestamp clamp.
 *
 * The direction of the clamp is the whole security property, so most of these
 * are about direction rather than about rejecting junk: pulling a stamp
 * BACKWARD removes the ability to pin a row in the future, while never pushing
 * one forward keeps honest ordering between two real messages intact. A clamp
 * that got the direction wrong would still "sanitise" the input and would still
 * look reasonable in a diff.
 */
import { clampWireTimestamp, isPlausibleTimestamp } from '../utils/wireTimestamp';

const NOW = 1_700_000_000_000;

describe('clampWireTimestamp', () => {
  it('pulls a future claim back to now', () => {
    // The finding: a year-2099 stamp becomes the LWW high-water mark and every
    // later genuine update loses to it, permanently.
    expect(clampWireTimestamp(4_100_000_000_000, NOW)).toBe(NOW);
  });

  it('leaves an ordinary past timestamp exactly as sent', () => {
    // Not merely "does not crash": if this rounded to now, two messages created
    // seconds apart would become indistinguishable and LWW would decide by
    // arrival order instead of creation order.
    expect(clampWireTimestamp(NOW - 60_000, NOW)).toBe(NOW - 60_000);
  });

  it('never pushes a queue-delayed message forward', () => {
    // A frame that sat in an inbox for an hour still reports when it was
    // created. Stamping it `now` on arrival would let it outrank updates that
    // genuinely came after it.
    const createdAnHourAgo = NOW - 3_600_000;
    expect(clampWireTimestamp(createdAnHourAgo, NOW)).toBe(createdAnHourAgo);
  });

  it('accepts a timestamp exactly equal to now', () => {
    expect(clampWireTimestamp(NOW, NOW)).toBe(NOW);
  });

  it('falls back to now for a missing value', () => {
    expect(clampWireTimestamp(undefined, NOW)).toBe(NOW);
    expect(clampWireTimestamp(null, NOW)).toBe(NOW);
  });

  it('falls back to now for a NEGATIVE value', () => {
    // The case the old `value || Date.now()` idiom silently accepted: a
    // negative number is truthy, so it was stored as the clock and made the row
    // permanently overwritable by anything.
    expect(clampWireTimestamp(-1, NOW)).toBe(NOW);
  });

  it('falls back to now for NaN and Infinity', () => {
    // NaN poisons the comparison in both directions — `>=` and `<` are both
    // false — so a row stamped with it can be neither updated nor protected.
    expect(clampWireTimestamp(NaN, NOW)).toBe(NOW);
    expect(clampWireTimestamp(Infinity, NOW)).toBe(NOW);
    expect(clampWireTimestamp(-Infinity, NOW)).toBe(NOW);
  });

  it('falls back to now for a non-number the wire can still deliver', () => {
    // The payload is parsed from JSON through a bare cast with no runtime
    // validation, so a string or an object reaches this function unchallenged.
    expect(clampWireTimestamp('4100000000000', NOW)).toBe(NOW);
    expect(clampWireTimestamp({}, NOW)).toBe(NOW);
    expect(clampWireTimestamp(true, NOW)).toBe(NOW);
  });
});

describe('isPlausibleTimestamp', () => {
  it('accepts a positive finite number', () => {
    expect(isPlausibleTimestamp(NOW)).toBe(true);
  });

  it('rejects zero, negatives, non-finite values and non-numbers', () => {
    expect(isPlausibleTimestamp(0)).toBe(false);
    expect(isPlausibleTimestamp(-1)).toBe(false);
    expect(isPlausibleTimestamp(NaN)).toBe(false);
    expect(isPlausibleTimestamp(Infinity)).toBe(false);
    expect(isPlausibleTimestamp('123')).toBe(false);
    expect(isPlausibleTimestamp(undefined)).toBe(false);
    expect(isPlausibleTimestamp(null)).toBe(false);
  });
});
