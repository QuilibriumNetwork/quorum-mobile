/**
 * The dev-only QNS overlay.
 *
 * Tested despite being dev-only because it is an INSTRUMENT: everything the
 * operator concludes about where `.q` names render is downstream of it. An
 * overlay that quietly fails open ("no fake applied") would read on screen as
 * "this surface does not show `.q` names" — a false negative that sends someone
 * hunting a bug in the render path that does not exist.
 *
 * The `null` cases matter most. A test account's spacemates usually have NO
 * public profile, so an overlay that only decorated existing profiles would
 * decorate nothing and appear inert.
 */

jest.mock('react-native-mmkv', () => ({
  createMMKV: ({ id }: { id: string }) => {
    const stores = ((globalThis as Record<string, unknown>).__mmkv ??= new Map()) as Map<
      string,
      Map<string, string>
    >;
    if (!stores.has(id)) stores.set(id, new Map());
    const store = stores.get(id)!;
    return {
      getString: (k: string) => store.get(k),
      set: (k: string, v: string) => store.set(k, v),
      remove: (k: string) => store.delete(k),
      getAllKeys: () => Array.from(store.keys()),
      clearAll: () => store.clear(),
      contains: (k: string) => store.has(k),
    };
  },
}));

import {
  applyFakeQns,
  clearFakeQns,
  deriveFakeQName,
  setFakeQnsEntry,
  setFakeQnsState,
  type FakeablePublicProfile,
} from '../services/dev/fakeQns';

const A = 'QmAlice1111111111111111111111111111111111';
const B = 'QmBob22222222222222222222222222222222222222';

const realProfile: FakeablePublicProfile = {
  display_name: 'Real Name',
  profile_image: 'img',
  bio: 'real bio',
  timestamp: 500,
  signature: 'sig',
};

beforeEach(() => clearFakeQns());

describe('applyFakeQns — inert unless enabled', () => {
  it('passes a real profile through untouched when disabled', () => {
    setFakeQnsState({ enabled: false, giveEveryoneAName: true });
    expect(applyFakeQns(A, realProfile)).toBe(realProfile);
  });

  it('passes a 404 through untouched when disabled', () => {
    setFakeQnsState({ enabled: false, giveEveryoneAName: true });
    expect(applyFakeQns(A, null)).toBeNull();
  });

  it('leaves a profile alone when enabled but no rule matches', () => {
    setFakeQnsState({ enabled: true });
    expect(applyFakeQns(A, realProfile)).toBe(realProfile);
  });
});

describe('applyFakeQns — give everyone a name', () => {
  beforeEach(() => setFakeQnsState({ enabled: true, giveEveryoneAName: true }));

  it('adds a .q to a real profile without clobbering its other fields', () => {
    const out = applyFakeQns(A, realProfile);
    expect(out?.primary_username).toBe(deriveFakeQName(A));
    expect(out?.display_name).toBe('Real Name');
    expect(out?.bio).toBe('real bio');
    expect(out?.profile_image).toBe('img');
  });

  it('SYNTHESIZES a profile for someone who has none', () => {
    // The case that makes the tool usable at all.
    const out = applyFakeQns(A, null);
    expect(out).not.toBeNull();
    expect(out?.primary_username).toBe(deriveFakeQName(A));
  });

  it('gives different addresses different names, stably', () => {
    expect(deriveFakeQName(A)).not.toBe(deriveFakeQName(B));
    expect(deriveFakeQName(A)).toBe(deriveFakeQName(A));
  });

  it('never fakes over a REAL published .q', () => {
    // If the instrument overwrote a genuine registration, the one case it
    // exists to observe would be the one case it hid.
    const out = applyFakeQns(A, { ...realProfile, primary_username: 'genuine' });
    expect(out?.primary_username).toBe('genuine');
  });

  it('an explicit entry still overrides a real .q', () => {
    setFakeQnsEntry(A, { primaryUsername: 'pinned' });
    const out = applyFakeQns(A, { ...realProfile, primary_username: 'genuine' });
    expect(out?.primary_username).toBe('pinned');
  });

  it('stamps a fresh timestamp so a faked global name is not lost to the merge', () => {
    // The merge downstream prefers the newer of the roster global slot and the
    // public profile. A synthesized profile carrying an old timestamp would be
    // silently discarded and the overlay would look broken.
    const before = Date.now();
    const out = applyFakeQns(A, realProfile);
    expect(out!.timestamp).toBeGreaterThanOrEqual(before);
  });
});

describe('applyFakeQns — private profiles', () => {
  it('returns nothing for every address when all-private is on', () => {
    setFakeQnsState({ enabled: true, allProfilesPrivate: true });
    expect(applyFakeQns(A, realProfile)).toBeNull();
  });

  it('all-private outranks give-everyone-a-name', () => {
    // Both switches on is a reachable state in the panel, so the precedence has
    // to be defined rather than incidental.
    setFakeQnsState({ enabled: true, allProfilesPrivate: true, giveEveryoneAName: true });
    expect(applyFakeQns(A, realProfile)).toBeNull();
  });

  it('marks a single address private, leaving others alone', () => {
    setFakeQnsState({ enabled: true, giveEveryoneAName: true });
    setFakeQnsEntry(A, { private: true });
    expect(applyFakeQns(A, realProfile)).toBeNull();
    expect(applyFakeQns(B, realProfile)?.primary_username).toBe(deriveFakeQName(B));
  });
});

describe('applyFakeQns — per-address entries', () => {
  it('an explicit entry wins over the everyone rule', () => {
    setFakeQnsState({ enabled: true, giveEveryoneAName: true });
    setFakeQnsEntry(A, { primaryUsername: 'pinned' });
    expect(applyFakeQns(A, realProfile)?.primary_username).toBe('pinned');
  });

  it('an entry with only a global name gets no .q, even under the everyone rule', () => {
    // Otherwise there is no way to build the control arm — a member who has a
    // global name and NO `.q`, to prove the `.q` is what is winning elsewhere.
    setFakeQnsState({ enabled: true, giveEveryoneAName: true });
    setFakeQnsEntry(A, { displayName: 'Only Global' });
    const out = applyFakeQns(A, realProfile);
    expect(out?.primary_username).toBeUndefined();
    expect(out?.display_name).toBe('Only Global');
  });

  it('matches the address case-insensitively', () => {
    setFakeQnsState({ enabled: true });
    setFakeQnsEntry(A.toUpperCase(), { primaryUsername: 'pinned' });
    expect(applyFakeQns(A, realProfile)?.primary_username).toBe('pinned');
  });
});
