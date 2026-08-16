/**
 * Tier assembly, and the one property that is a security property.
 *
 * The ladder itself lives in quorum-shared and is tested there. What is pinned
 * here is which SOURCE each tier may come from — in particular that the QNS
 * tier can only ever come from the verified map, so a surface that never ran
 * verification cannot produce a `.q` no matter what it holds.
 */
import {
  identityFromMaps,
  selfLocalNameEntry,
  type IdentitySources,
} from '../identity/identityFromMaps';

const ADDR = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const SELF = 'QmPeerBEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

const sources = (over: Partial<IdentitySources> = {}): IdentitySources => ({
  rostersBySpace: {},
  verifiedQnsNames: {},
  profileGlobalNames: {},
  locallyKnownNames: {},
  selfAddress: null,
  ...over,
});

describe('identityFromMaps — where each tier comes from', () => {
  it('takes the per-space name from the roster override slot', () => {
    const r = identityFromMaps(ADDR, 'space-1', sources({
      rostersBySpace: {
        'space-1': { [ADDR]: { display_name: 'Mod Alice', global_display_name: 'Alice' } },
      },
    }));
    expect(r).toEqual({
      address: ADDR,
      spaceName: 'Mod Alice',
      qnsName: null,
      globalName: 'Alice',
    });
  });

  it('ignores the roster entirely when no spaceId is given', () => {
    // A DM, or a Space you have left. A per-space nickname is meaningless here.
    const r = identityFromMaps(ADDR, undefined, sources({
      rostersBySpace: {
        'space-1': { [ADDR]: { display_name: 'Mod Alice', global_display_name: 'Alice' } },
      },
    }));
    expect(r.spaceName).toBeNull();
    expect(r.globalName).toBeNull();
  });

  it('prefers the roster global slot over a fetched profile name', () => {
    const r = identityFromMaps(ADDR, 'space-1', sources({
      rostersBySpace: {
        'space-1': { [ADDR]: { display_name: '', global_display_name: 'Roster Alice' } },
      },
      profileGlobalNames: { [ADDR]: 'Profile Alice' },
    }));
    expect(r.globalName).toBe('Roster Alice');
  });

  it('falls to a locally-known name last, below the fetched profile', () => {
    // A DM partner who never published a profile. The app knows their name
    // from their own broadcast; rendering an address instead would be a
    // regression desktop shipped and had to send back.
    const r = identityFromMaps(ADDR, undefined, sources({
      locallyKnownNames: { [ADDR]: 'Alice' },
    }));
    expect(r.globalName).toBe('Alice');

    const withProfile = identityFromMaps(ADDR, undefined, sources({
      profileGlobalNames: { [ADDR]: 'Published Alice' },
      locallyKnownNames: { [ADDR]: 'Local Alice' },
    }));
    expect(withProfile.globalName).toBe('Published Alice');
  });

  it('returns an all-null identity for an unknown address, never undefined', () => {
    expect(identityFromMaps(ADDR, undefined, sources())).toEqual({
      address: ADDR,
      spaceName: null,
      qnsName: null,
      globalName: null,
    });
  });

  it('treats a whitespace-only tier as absent', () => {
    const r = identityFromMaps(ADDR, 'space-1', sources({
      rostersBySpace: { 'space-1': { [ADDR]: { global_display_name: '   ' } } },
      locallyKnownNames: { [ADDR]: 'Alice' },
    }));
    expect(r.globalName).toBe('Alice');
  });
});

describe('identityFromMaps — the QNS tier is verified-only (SECURITY)', () => {
  it('takes qnsName from the verified map', () => {
    const r = identityFromMaps(ADDR, undefined, sources({
      verifiedQnsNames: { [ADDR]: 'alice' },
    }));
    expect(r.qnsName).toBe('alice');
  });

  it('has NO other route to a qnsName', () => {
    // The point of the whole file. There is no profile object in
    // IdentitySources at all, so a caller cannot hand over a raw claim even
    // by accident — an unverified name has nowhere to be put.
    const s = sources({ profileGlobalNames: { [ADDR]: 'Alice' } });
    expect(Object.keys(s)).not.toContain('profiles');
    expect(identityFromMaps(ADDR, undefined, s).qnsName).toBeNull();
  });

  it('does not leak one member’s verified name to another', () => {
    const r = identityFromMaps(ADDR, undefined, sources({
      verifiedQnsNames: { [SELF]: 'bob' },
    }));
    expect(r.qnsName).toBeNull();
  });
});

describe('selfLocalNameEntry', () => {
  it('returns a stable empty object when there is nothing to contribute', () => {
    expect(selfLocalNameEntry(null, 'Alice')).toEqual({});
    expect(selfLocalNameEntry(SELF, '  ')).toEqual({});
    // Same REFERENCE, so a caller memoising on it does not churn every render.
    expect(selfLocalNameEntry(null, null)).toBe(selfLocalNameEntry(SELF, ''));
  });

  it('maps the address to the device name when both are present', () => {
    expect(selfLocalNameEntry(SELF, 'My Phone')).toEqual({ [SELF]: 'My Phone' });
  });
});
