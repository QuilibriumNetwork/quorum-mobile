// The per-space announce gate.
//
// Before 2026-08-02 the rule was dedup ONLY — `if (last === sig) return null`,
// no timestamp, no expiry, no retry. A member announced a given identity to a
// given space exactly ONCE, ever, so anybody who joined afterwards never learned
// who they were, and hub-log replay does not backfill pre-join entries.
//
// These tests pin both edges of the replacement:
//   too strict → a member stays a truncated address on other people's screens
//   too loose  → every launch re-broadcasts an avatar to every member of every
//                space (the relay fans out one copy per member, so an announce
//                costs `members × payload`)
//
// The migration cases matter more here than anywhere else: on mobile EVERY
// stored record is a legacy bare signature, so the migration path is not an
// edge case, it is what every user hits on first launch after this ships.

import {
  readAnnounceRecord,
  shouldAnnounce,
  nextAnnounceAttempts,
  ANNOUNCE_INTERVAL_MS,
  MAX_ANNOUNCES_PER_IDENTITY,
} from '../services/space/spaceAnnounceGate';
// Safe to import statically: the DM gate is the MMKV-free decision half, so it
// pulls in no native modules.
import {
  MAX_SENDS_PER_IDENTITY,
  RESEND_INTERVAL_MS,
} from '../services/dm/dmProfileGate';

const T0 = 1_750_000_000_000;
// A realistic legacy value: the old code stored the bare signature string, which
// is itself valid JSON, which is why the shape check matters more than the
// try/catch.
const LEGACY_SIG = JSON.stringify({ globalDisplayName: 'Ada', globalUserIcon: 'i' });
const SIG = LEGACY_SIG;

describe('reading a stored record', () => {
  it('treats an empty store as never announced', () => {
    const { record, migrated } = readAnnounceRecord(undefined, T0);
    expect(record).toBeNull();
    expect(migrated).toBe(false);
  });

  it('reads back a current-format record unchanged', () => {
    const stored = JSON.stringify({ sig: SIG, at: T0, attempts: 1 });
    const { record, migrated } = readAnnounceRecord(stored, T0 + 5);
    expect(record).toEqual({ sig: SIG, at: T0, attempts: 1 });
    expect(migrated).toBe(false);
  });

  // THE case every existing user hits.
  it('migrates a legacy bare signature, keeping its real signature', () => {
    const { record, migrated } = readAnnounceRecord(LEGACY_SIG, T0);
    expect(migrated).toBe(true);
    expect(record?.sig).toBe(LEGACY_SIG);
    expect(record?.attempts).toBe(MAX_ANNOUNCES_PER_IDENTITY - 1);
  });

  // Anchoring to the stored value would make every record instantly due and
  // fire the entire fleet on the first launch after deploy. There IS no stored
  // timestamp on mobile, so `now` is the only defensible anchor.
  it('anchors a migrated record at NOW, so it is not instantly due', () => {
    const { record } = readAnnounceRecord(LEGACY_SIG, T0);
    expect(record?.at).toBe(T0);
    expect(shouldAnnounce(record, SIG, T0)).toBe(false);
  });

  it('leaves the migrated record exactly one more attempt', () => {
    const { record } = readAnnounceRecord(LEGACY_SIG, T0);
    expect(shouldAnnounce(record, SIG, T0 + ANNOUNCE_INTERVAL_MS)).toBe(true);
    const after = {
      sig: SIG,
      at: T0 + ANNOUNCE_INTERVAL_MS,
      attempts: nextAnnounceAttempts(record, SIG),
    };
    expect(shouldAnnounce(after, SIG, T0 + 10 * ANNOUNCE_INTERVAL_MS)).toBe(false);
  });

  // NaN and Infinity are both numbers and both break the gate silently: a NaN
  // attempts count defeats the cap, a NaN timestamp wedges the interval shut.
  it('migrates a record whose numbers are unusable, keeping its signature', () => {
    const stored = JSON.stringify({ sig: SIG, at: null, attempts: null });
    const { record, migrated } = readAnnounceRecord(stored, T0);
    expect(migrated).toBe(true);
    expect(record?.sig).toBe(SIG);
    expect(record?.attempts).toBe(MAX_ANNOUNCES_PER_IDENTITY - 1);
  });

  it('rejects a negative attempts count', () => {
    const stored = JSON.stringify({ sig: SIG, at: T0, attempts: -5 });
    expect(readAnnounceRecord(stored, T0).migrated).toBe(true);
  });

  it('treats unparseable garbage as a legacy signature rather than throwing', () => {
    const { record } = readAnnounceRecord('not json at all', T0);
    expect(record?.sig).toBe('not json at all');
    // Reads as a DIFFERENT identity, so ours announces — fails open.
    expect(shouldAnnounce(record, SIG, T0)).toBe(true);
  });
});

describe('the announce decision', () => {
  it('announces when nothing was ever stored', () => {
    expect(shouldAnnounce(null, SIG, T0)).toBe(true);
  });

  it('does not re-announce the same identity immediately', () => {
    const record = { sig: SIG, at: T0, attempts: 1 };
    expect(shouldAnnounce(record, SIG, T0 + 1000)).toBe(false);
  });

  // The actual behaviour change: this used to be `false` forever.
  it('re-announces once the interval has elapsed', () => {
    const record = { sig: SIG, at: T0, attempts: 1 };
    expect(shouldAnnounce(record, SIG, T0 + ANNOUNCE_INTERVAL_MS)).toBe(true);
  });

  it('announces a CHANGED identity immediately, ignoring interval and cap', () => {
    const exhausted = { sig: SIG, at: T0, attempts: MAX_ANNOUNCES_PER_IDENTITY };
    expect(shouldAnnounce(exhausted, 'a different signature', T0 + 1)).toBe(true);
  });
});

describe('the cap', () => {
  it('allows exactly MAX_ANNOUNCES_PER_IDENTITY announces', () => {
    let record: { sig: string; at: number; attempts: number } | null = null;
    let sent = 0;
    for (let i = 0; i < 20; i++) {
      const at = T0 + i * ANNOUNCE_INTERVAL_MS;
      if (shouldAnnounce(record, SIG, at)) {
        record = { sig: SIG, at, attempts: nextAnnounceAttempts(record, SIG) };
        sent++;
      }
    }
    expect(sent).toBe(MAX_ANNOUNCES_PER_IDENTITY);
  });

  it('stays shut however long we wait — a cap, not a cadence', () => {
    const exhausted = {
      sig: SIG,
      at: T0,
      attempts: MAX_ANNOUNCES_PER_IDENTITY,
    };
    const aYear = T0 + 365 * 24 * 60 * 60 * 1000;
    expect(shouldAnnounce(exhausted, SIG, aYear)).toBe(false);
  });

  // Without this a rename after the cap closed would never reach anybody.
  it('a rename gets its own full allowance', () => {
    const exhausted = {
      sig: SIG,
      at: T0,
      attempts: MAX_ANNOUNCES_PER_IDENTITY,
    };
    expect(nextAnnounceAttempts(exhausted, 'renamed')).toBe(1);
  });

  // A relaunch loop must not spend the whole allowance in one sitting: the
  // announce fires on every connect, and three frames minutes apart buy nothing
  // over one.
  it('a relaunch storm cannot burn the allowance in one window', () => {
    let record: { sig: string; at: number; attempts: number } | null = null;
    let sent = 0;
    for (let i = 0; i < 50; i++) {
      const at = T0 + i * 1000;
      if (shouldAnnounce(record, SIG, at)) {
        record = { sig: SIG, at, attempts: nextAnnounceAttempts(record, SIG) };
        sent++;
      }
    }
    expect(sent).toBe(1);
  });
});

describe('parity with the DM gate', () => {
  // One rule across four call sites (two platforms x DM/space) is the whole
  // point; a silent divergence here is how the two apps drifted to opposite
  // extremes in the first place.
  it('uses the same cap as the DM gate', () => {
    expect(MAX_ANNOUNCES_PER_IDENTITY).toBe(MAX_SENDS_PER_IDENTITY);
    expect(ANNOUNCE_INTERVAL_MS).toBe(RESEND_INTERVAL_MS);
  });
});
