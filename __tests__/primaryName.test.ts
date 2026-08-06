/**
 * How "no primary QNS name" is spelled, and whether an un-election survives.
 *
 * These four assertions exist because the bug they guard is completely silent.
 * Un-electing a primary `.q` writes a field that then has to survive two hops
 * — out to the synced config and back in at the next login — and both hops use
 * `undefined`-means-absent semantics that are correct for a partial update and
 * wrong for a deliberate clear. Get it wrong and un-elect appears to work, the
 * header falls back to the global name, and the old `.q` returns at the next
 * login with nothing logged and no way for the user to tell "it reverted" from
 * "it never applied".
 *
 * The `??` vs `||` case below is the specific regression to fear: the two read
 * identically at a glance and differ on exactly the value that carries an
 * un-election.
 */

import { NO_PRIMARY_NAME, hasPrimaryName, mergeSyncedPrimaryName } from '../utils/primaryName';

describe('NO_PRIMARY_NAME', () => {
  it('is a value, not undefined — a clear has to be distinguishable from "untouched"', () => {
    // `updateProfile` only forwards a field to the synced config when it is
    // `!== undefined`. A clear spelled as `undefined` never leaves the device.
    expect(NO_PRIMARY_NAME).not.toBeUndefined();
    expect(NO_PRIMARY_NAME).toBe('');
  });

  it('is falsy, so every `name ? … : …` check keeps working untouched', () => {
    // The publish path picks its signing payload with `primaryUsername ? v2 : v1`.
    // A truthy sentinel would sign a v2 payload claiming a name of "none".
    expect(NO_PRIMARY_NAME).toBeFalsy();
  });
});

describe('mergeSyncedPrimaryName', () => {
  it('lets a cleared config win — this is the un-elect surviving a login', () => {
    // Swapping the implementation to `||` returns 'gatto' here: the name the
    // user removed on another device comes back, permanently.
    expect(mergeSyncedPrimaryName(NO_PRIMARY_NAME, 'gatto')).toBe(NO_PRIMARY_NAME);
  });

  it('keeps the local name when the config has no opinion', () => {
    // An older client, or a config written before the field existed. Absent is
    // not a clear.
    expect(mergeSyncedPrimaryName(undefined, 'gatto')).toBe('gatto');
  });

  it('lets another device\'s election win', () => {
    expect(mergeSyncedPrimaryName('lamat', 'gatto')).toBe('lamat');
  });
});

describe('hasPrimaryName', () => {
  it('treats unset, cleared and whitespace alike', () => {
    expect(hasPrimaryName(undefined)).toBe(false);
    expect(hasPrimaryName(NO_PRIMARY_NAME)).toBe(false);
    expect(hasPrimaryName('   ')).toBe(false);
  });

  it('is true for a real name', () => {
    expect(hasPrimaryName('gatto')).toBe(true);
  });
});
