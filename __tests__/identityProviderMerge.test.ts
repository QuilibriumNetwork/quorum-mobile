/**
 * The merge rules, tested as pure functions.
 *
 * These are not a detail. Four desktop surfaces shipped mounting a provider
 * with strictly LESS data than the one above it, each rendering members as raw
 * addresses, each found by hand hours apart. Replacing rather than merging is
 * the bug; these pin the fix.
 */
import { mergeFlat, mergeRostersBySpace } from '../identity/identityProvider';

const A = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const B = 'QmPeerBEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

describe('mergeFlat', () => {
  it('lets the child win per key and the parent fill the rest', () => {
    expect(mergeFlat({ [A]: 'Parent A', [B]: 'Parent B' }, { [A]: 'Child A' })).toEqual({
      [A]: 'Child A',
      [B]: 'Parent B',
    });
  });

  it('returns an input UNCHANGED when the other side is empty', () => {
    // Reference equality, not just deep equality: returning a fresh object
    // when there is nothing to merge reintroduces the per-render allocation
    // the stable empty references exist to avoid.
    const own = { [A]: 'A' };
    expect(mergeFlat({}, own)).toBe(own);
    const parent = { [B]: 'B' };
    expect(mergeFlat(parent, {})).toBe(parent);
  });
});

describe('mergeRostersBySpace', () => {
  it('merges per ADDRESS, so a still-loading child cannot blank the parent', () => {
    // The regression this shape exists to prevent: a child provider that sets
    // map[spaceId] = {} while its own read is in flight would, under a shallow
    // merge, erase every row the parent already had for that space.
    const parent = { 's1': { [A]: { global_display_name: 'Alice' } } };
    const own = { 's1': {} };
    expect(mergeRostersBySpace(parent, own)).toEqual({
      's1': { [A]: { global_display_name: 'Alice' } },
    });
  });

  it('lets a loaded child row win over the parent for the same address', () => {
    const parent = { 's1': { [A]: { global_display_name: 'Stale' } } };
    const own = { 's1': { [A]: { global_display_name: 'Fresh' } } };
    expect(mergeRostersBySpace(parent, own)['s1'][A].global_display_name).toBe('Fresh');
  });

  it('keeps spaces only the parent knows about', () => {
    const parent = { 's1': { [A]: { global_display_name: 'Alice' } } };
    const own = { 's2': { [B]: { global_display_name: 'Bob' } } };
    expect(Object.keys(mergeRostersBySpace(parent, own)).sort()).toEqual(['s1', 's2']);
  });
});
