/**
 * Next-letter suggestion logic for the dev-only DM test burst tool (T2).
 * Pure function only — the MMKV-backed wrapper (getSuggestedBurstPrefix /
 * markBurstPrefixUsed) is a thin persistence shim around this.
 */
import { nextBurstPrefix } from '../services/dev/dmBurstPrefix';

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

  it('wraps from Z back to A', () => {
    expect(nextBurstPrefix('Z')).toBe('A');
  });

  it('is case-insensitive', () => {
    expect(nextBurstPrefix('v')).toBe('W');
  });

  it('falls back to A for an unrecognized value', () => {
    expect(nextBurstPrefix('')).toBe('A');
    expect(nextBurstPrefix('1')).toBe('A');
    expect(nextBurstPrefix('AB')).toBe('A');
  });
});
