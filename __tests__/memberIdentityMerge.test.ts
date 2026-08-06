/**
 * The fold of a roster row against a fetched public profile.
 *
 * Worth testing on its own because its failure mode is invisible. A dropped
 * field here does not throw and does not blank a screen — the member simply
 * renders under a lesser name, which is indistinguishable from ordinary missing
 * data. `primary_username` was silently discarded at this boundary for two
 * months, which meant the QNS rung of the resolution ladder could never fire
 * for anybody, and using the app never revealed it.
 *
 * The QNS cases below are the ones that would have caught that.
 */

// The function under test is pure, but its module imports the API client for
// the query function, which reaches MMKV (and through it a native module) at
// import time. Stub the storage rather than restructure production code around
// a test constraint.
jest.mock('react-native-mmkv', () => ({
  createMMKV: () => {
    const store = new Map<string, string>();
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

import { mergeMemberIdentity } from '../hooks/useMembersWithPublicProfileFallback';
import type { PublicProfile } from '../hooks/useUserPublicProfile';

const ADDR = 'QmTestMember0000000000000000000000000000000';

type Local = Parameters<typeof mergeMemberIdentity>[1];

const local = (over: Record<string, unknown> = {}): Local =>
  ({ address: ADDR, inbox_address: `${ADDR}-inbox`, ...over }) as Local;

const profile = (over: Partial<PublicProfile> = {}): PublicProfile => ({
  display_name: '',
  profile_image: '',
  bio: '',
  timestamp: 1000,
  signature: '',
  ...over,
});

describe('mergeMemberIdentity — QNS', () => {
  it('puts the .q name from the public profile onto the member row', () => {
    const next = mergeMemberIdentity(ADDR, local(), profile({ primary_username: 'alice' }));
    expect(next?.primary_username).toBe('alice');
  });

  it('carries the .q even when the row already has a per-space name', () => {
    // The regression that mattered most: a member with a perfectly good roster
    // name still needs their `.q` on the row, because the RESOLVER decides
    // which of the two wins. Dropping it here silently removes the choice.
    const next = mergeMemberIdentity(
      ADDR,
      local({ display_name: 'Deliberate Space Name' }),
      profile({ primary_username: 'alice' }),
    );
    expect(next?.primary_username).toBe('alice');
    expect(next?.display_name).toBe('Deliberate Space Name');
  });

  it('keeps a .q already on the row when a later fetch returns nothing', () => {
    // A 404 means "no public profile right now", not "this person never had a
    // name". Erasing on a miss would make the `.q` flicker away on any transient
    // failure.
    const next = mergeMemberIdentity(ADDR, local({ primary_username: 'alice' }), null);
    expect(next === null || next.primary_username === 'alice').toBe(true);
  });

  it('does NOT let a stale public profile lose the .q to the timestamp merge', () => {
    // primary_username has a single transport, so it is not part of the
    // newer-of reconciliation the name/avatar/bio fields go through. A public
    // profile older than the roster global slot must still deliver its `.q`.
    const next = mergeMemberIdentity(
      ADDR,
      local({ global_display_name: 'Fresh Global', globalProfileTimestamp: 9999 }),
      profile({ display_name: 'Stale Global', primary_username: 'alice', timestamp: 1 }),
    );
    expect(next?.primary_username).toBe('alice');
    // ...while the name itself correctly keeps the fresher global slot.
    expect(next?.display_name).toBe('Fresh Global');
  });

  it('reports no change when the row already carries the same .q', () => {
    const next = mergeMemberIdentity(
      ADDR,
      local({ primary_username: 'alice' }),
      profile({ primary_username: 'alice' }),
    );
    expect(next).toBeNull();
  });

  it('reports a change when only the .q is new, so the row is rewritten', () => {
    // Without primary_username in the change check, a member whose name and
    // avatar were already correct would keep their old row and the newly
    // fetched `.q` would be thrown away.
    const next = mergeMemberIdentity(
      ADDR,
      local({ display_name: 'Name', profile_image: 'img', bio: 'b' }),
      profile({ primary_username: 'alice' }),
    );
    expect(next).not.toBeNull();
    expect(next?.primary_username).toBe('alice');
  });
});

describe('mergeMemberIdentity — the two-transport merge it must not break', () => {
  it('lets a non-empty per-space override beat both global transports', () => {
    const next = mergeMemberIdentity(
      ADDR,
      local({ display_name: 'Per-Space', global_display_name: 'Global' }),
      profile({ display_name: 'Public', timestamp: 9999 }),
    );
    expect(next === null ? 'Per-Space' : next.display_name).toBe('Per-Space');
  });

  it('prefers the newer of the roster global slot and the public profile', () => {
    const globalWins = mergeMemberIdentity(
      ADDR,
      local({ global_display_name: 'Global', globalProfileTimestamp: 5000 }),
      profile({ display_name: 'Public', timestamp: 1000 }),
    );
    expect(globalWins?.display_name).toBe('Global');

    const publicWins = mergeMemberIdentity(
      ADDR,
      local({ global_display_name: 'Global', globalProfileTimestamp: 1000 }),
      profile({ display_name: 'Public', timestamp: 5000 }),
    );
    expect(publicWins?.display_name).toBe('Public');
  });

  it('synthesizes a row for a member with no local record at all', () => {
    const next = mergeMemberIdentity(ADDR, undefined, profile({ display_name: 'Public' }));
    expect(next?.address).toBe(ADDR);
    expect(next?.display_name).toBe('Public');
  });
});
