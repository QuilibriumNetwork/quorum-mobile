/**
 * The DM identity send gate: dedup, bounded retry, and the migration off the
 * pre-cap format.
 *
 * Until 2026-08-01 the gate had NO expiry and NO retry — a given identity went
 * to a given partner exactly once, ever, so on a transport losing 15-20% of
 * messages a single dropped frame left that partner on a placeholder forever.
 * It now retries, but a bounded number of times, so a converged pair stops
 * paying. These tests pin both edges.
 *
 * Pure functions only, matching the house style (see dmBurstPrefs.test.ts) —
 * the MMKV wrapper around them is a thin persistence shim.
 *
 * Decision + cost model:
 * quorum-desktop/.agents/tasks/2026-08-01-identity-announce-cadence-research.md
 */
import {
  readGateRecord,
  shouldSendProfile,
  nextAttempts,
  RESEND_INTERVAL_MS,
  MAX_SENDS_PER_IDENTITY,
  type DmProfileGateRecord,
} from '../services/dm/dmProfileGate';

const T0 = 1_750_000_000_000;
const SIG = JSON.stringify({ displayName: 'Bob', userIcon: 'icon' });
const OTHER_SIG = JSON.stringify({ displayName: 'Roberta', userIcon: 'icon' });

/** Walk the gate the way the send loop does: decide, then record if it said yes. */
function simulate(
  connectsAt: number[],
  startingRaw: string | null = null,
  sig: string = SIG
): { sentAt: number[]; final: DmProfileGateRecord | null } {
  let raw: string | null = startingRaw;
  const sentAt: number[] = [];
  for (const now of connectsAt) {
    const { record, migrated } = readGateRecord(raw, now);
    if (migrated && record) raw = JSON.stringify(record);
    if (!shouldSendProfile(record, sig, now)) continue;
    sentAt.push(now);
    raw = JSON.stringify({ sig, at: now, attempts: nextAttempts(record, sig) });
  }
  return { sentAt, final: raw ? JSON.parse(raw) : null };
}

const days = (n: number) => Array.from({ length: n }, (_, i) => T0 + i * RESEND_INTERVAL_MS);

describe('shouldSendProfile', () => {
  it('sends to a partner we have never sent to', () => {
    expect(shouldSendProfile(null, SIG, T0)).toBe(true);
  });

  it('does not re-send the same identity within the interval', () => {
    const record = { sig: SIG, at: T0, attempts: 1 };
    expect(shouldSendProfile(record, SIG, T0 + 60_000)).toBe(false);
  });

  it('re-sends once the interval has elapsed', () => {
    const record = { sig: SIG, at: T0, attempts: 1 };
    expect(shouldSendProfile(record, SIG, T0 + RESEND_INTERVAL_MS - 1)).toBe(false);
    expect(shouldSendProfile(record, SIG, T0 + RESEND_INTERVAL_MS)).toBe(true);
  });

  it('sends immediately when the identity changed, ignoring interval and cap', () => {
    const exhausted = { sig: SIG, at: T0, attempts: MAX_SENDS_PER_IDENTITY };
    expect(shouldSendProfile(exhausted, OTHER_SIG, T0 + 1)).toBe(true);
  });

  it('stops once the cap is reached, however long we wait', () => {
    const exhausted = { sig: SIG, at: T0, attempts: MAX_SENDS_PER_IDENTITY };
    expect(shouldSendProfile(exhausted, SIG, T0 + 365 * RESEND_INTERVAL_MS)).toBe(false);
  });
});

describe('the retry cap', () => {
  it('sends exactly MAX_SENDS_PER_IDENTITY times, then never again', () => {
    // A fortnight of daily connects, far past the cap.
    const { sentAt } = simulate(days(14));
    expect(sentAt).toEqual(days(3));
    expect(sentAt.length).toBe(MAX_SENDS_PER_IDENTITY);
  });

  it('a flapping connection cannot burn the attempts in one session', () => {
    // First connect, then 200 reconnects seconds apart.
    const flaps = [T0, ...Array.from({ length: 200 }, (_, i) => T0 + (i + 1) * 1000)];
    expect(simulate(flaps).sentAt).toEqual([T0]);

    // The second real attempt is still available a day later.
    expect(simulate([...flaps, T0 + RESEND_INTERVAL_MS]).sentAt).toEqual([
      T0,
      T0 + RESEND_INTERVAL_MS,
    ]);
  });

  it('a rename resets the count and gets its own full set of attempts', () => {
    const exhausted = JSON.stringify({
      sig: SIG,
      at: T0,
      attempts: MAX_SENDS_PER_IDENTITY,
    });
    const later = days(14).slice(5);
    const { sentAt } = simulate(later, exhausted, OTHER_SIG);
    expect(sentAt).toEqual(later.slice(0, 3));
  });
});

describe('nextAttempts', () => {
  it('counts up for the same identity', () => {
    expect(nextAttempts(null, SIG)).toBe(1);
    expect(nextAttempts({ sig: SIG, at: T0, attempts: 1 }, SIG)).toBe(2);
  });

  it('restarts at 1 for a different identity', () => {
    expect(nextAttempts({ sig: SIG, at: T0, attempts: 3 }, OTHER_SIG)).toBe(1);
  });
});

describe('migration off the pre-cap format', () => {
  // Every existing mobile record is a bare signature string with no timestamp
  // and no counter. Reading one as "due now" would fire every partner on the
  // first connect after deploy.
  it('does not stampede on a legacy bare-signature record', () => {
    const { record, migrated } = readGateRecord(SIG, T0);
    expect(migrated).toBe(true);
    expect(record).toEqual({ sig: SIG, at: T0, attempts: MAX_SENDS_PER_IDENTITY - 1 });
    expect(shouldSendProfile(record, SIG, T0)).toBe(false);
  });

  it('still honours a changed identity over a legacy record', () => {
    const { record } = readGateRecord(SIG, T0);
    expect(shouldSendProfile(record, OTHER_SIG, T0)).toBe(true);
  });

  it('grants exactly ONE more attempt, then closes', () => {
    // Legacy record present; connect daily for a fortnight.
    const { sentAt } = simulate(days(14), SIG);
    expect(sentAt).toEqual([T0 + RESEND_INTERVAL_MS]);
  });

  it('anchors the migration so the record can still age out', () => {
    // The upgrade must be persisted, not recomputed per read — otherwise
    // now - at is always ~0 and the one remaining attempt never becomes due.
    const { record, migrated } = readGateRecord(SIG, T0);
    expect(migrated).toBe(true);
    expect(shouldSendProfile(record, SIG, T0 + RESEND_INTERVAL_MS)).toBe(true);
  });

  it('leaves an already-migrated record alone', () => {
    const current = JSON.stringify({ sig: SIG, at: T0, attempts: 1 });
    const { record, migrated } = readGateRecord(current, T0 + 999);
    expect(migrated).toBe(false);
    expect(record).toEqual({ sig: SIG, at: T0, attempts: 1 });
  });

  it('treats an absent record as never-sent', () => {
    expect(readGateRecord(null, T0)).toEqual({ record: null, migrated: false });
    expect(readGateRecord(undefined, T0)).toEqual({ record: null, migrated: false });
  });

  // typeof NaN === 'number', so a naive shape check lets these through — and
  // then NaN >= MAX is false, which defeats the cap silently and sends forever.
  // NaN and Infinity both serialise to null through JSON, so a stored record can
  // carry them even though nothing here writes one.
  it.each([
    ['NaN attempts', { sig: SIG, at: T0, attempts: NaN }],
    ['Infinity attempts', { sig: SIG, at: T0, attempts: Infinity }],
    ['negative attempts', { sig: SIG, at: T0, attempts: -5 }],
    ['fractional attempts', { sig: SIG, at: T0, attempts: 1.5 }],
    ['NaN at', { sig: SIG, at: NaN, attempts: 1 }],
    ['missing attempts', { sig: SIG, at: T0 }],
  ])('re-migrates a corrupt record, keeping its real signature (%s)', (_label, bad) => {
    const { record, migrated } = readGateRecord(JSON.stringify(bad), T0);
    expect(migrated).toBe(true);
    // The signature must survive, or the gate forgets what it already announced.
    expect(record!.sig).toBe(SIG);
    expect(Number.isInteger(record!.attempts)).toBe(true);
    expect(Number.isFinite(record!.at)).toBe(true);
    // Anchored at now, so it is not instantly due...
    expect(shouldSendProfile(record, SIG, T0)).toBe(false);
    // ...and the cap still bites rather than sending forever.
    const { sentAt } = simulate(days(10), JSON.stringify(bad));
    expect(sentAt.length).toBeLessThanOrEqual(MAX_SENDS_PER_IDENTITY);
  });
});
