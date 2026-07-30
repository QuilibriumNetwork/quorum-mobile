/**
 * Next-prefix suggestion + validation logic for the dev-only DM test burst
 * tool (T2). Pure functions only — the MMKV-backed wrapper
 * (getSuggestedBurstPrefix / markBurstPrefixUsed) is a thin persistence shim
 * around these.
 */
import { isValidBurstPrefix, nextBurstPrefix } from '../services/dev/dmBurstPrefix';

describe('nextBurstPrefix', () => {
  it('starts at A when nothing has been used yet', () => {
    expect(nextBurstPrefix(null)).toBe('A');
    expect(nextBurstPrefix(undefined)).toBe('A');
  });

  it('suggests the following letter', () => {
    expect(nextBurstPrefix('A')).toBe('B');
    expect(nextBurstPrefix('V')).toBe('W');
    expect(nextBurstPrefix('Y')).toBe('Z');
  });

  it('is case-insensitive', () => {
    expect(nextBurstPrefix('v')).toBe('W');
  });

  it('falls back to A for an unrecognized value', () => {
    expect(nextBurstPrefix('')).toBe('A');
    expect(nextBurstPrefix('1')).toBe('A');
    // Contains a digit, so it isn't part of the pure-letter suggestion
    // sequence even though it's a valid stored prefix on its own.
    expect(nextBurstPrefix('R2')).toBe('A');
  });

  it('rolls over to two letters after Z, spreadsheet-column style', () => {
    expect(nextBurstPrefix('Z')).toBe('AA');
    expect(nextBurstPrefix('z')).toBe('AA');
  });

  it('continues the two-letter sequence', () => {
    expect(nextBurstPrefix('AA')).toBe('AB');
    expect(nextBurstPrefix('AY')).toBe('AZ');
  });

  it('carries into the next letter at the AZ boundary', () => {
    expect(nextBurstPrefix('AZ')).toBe('BA');
  });

  it('rolls over to three letters after ZZ', () => {
    expect(nextBurstPrefix('ZZ')).toBe('AAA');
  });
});

describe('isValidBurstPrefix', () => {
  it('accepts 1-3 letters or digits', () => {
    expect(isValidBurstPrefix('A')).toBe(true);
    expect(isValidBurstPrefix('AA')).toBe(true);
    expect(isValidBurstPrefix('R2')).toBe(true);
    expect(isValidBurstPrefix('ZZ9')).toBe(true);
    expect(isValidBurstPrefix('a')).toBe(true);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(isValidBurstPrefix('  AA  ')).toBe(true);
  });

  it('rejects empty or whitespace-only input', () => {
    expect(isValidBurstPrefix('')).toBe(false);
    expect(isValidBurstPrefix('   ')).toBe(false);
  });

  it('rejects more than 3 characters', () => {
    expect(isValidBurstPrefix('AAAA')).toBe(false);
    expect(isValidBurstPrefix('ZZ99')).toBe(false);
  });

  it('rejects characters outside A-Z/0-9', () => {
    expect(isValidBurstPrefix('A!')).toBe(false);
    expect(isValidBurstPrefix('A B')).toBe(false);
    expect(isValidBurstPrefix('-A')).toBe(false);
  });
});
