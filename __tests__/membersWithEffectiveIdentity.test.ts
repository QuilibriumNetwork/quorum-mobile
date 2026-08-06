/**
 * The roster array handed to the two mention surfaces.
 *
 * Both the `@` autocomplete and the rendered mention pill already resolved
 * names through the one resolver, and both still showed a global name where a
 * `.q` existed. Neither was a resolver bug: they were handed the RAW roster,
 * and a roster row cannot carry `primary_username` — a `.q` reaches the client
 * only inside a public profile, which the chat view fetches into a separate
 * map used for message headers.
 *
 * These cases pin the projection that closes that gap.
 */

// The function under test is pure, but its module imports the API client for
// the query function, which reaches MMKV (and through it a native module) at
// import time. Stub the storage rather than restructure production code around
// a test constraint — same treatment as memberIdentityMerge.test.ts.
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

import { membersWithEffectiveIdentity } from '../hooks/useMembersWithPublicProfileFallback';
import type { MemberMap } from '../components/Chat/types';

const ALICE = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const BOB = 'QmPeerBEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

const member = (address: string, extra: Record<string, unknown> = {}) =>
  ({ address, ...extra }) as never;

describe('membersWithEffectiveIdentity', () => {
  it('gives a roster row the .q the public-profile map holds', () => {
    // The regression: without this the mention surfaces never see a `.q` at all.
    const roster = [member(ALICE, { global_display_name: 'Alice' })];
    const effective = {
      [ALICE]: member(ALICE, { global_display_name: 'Alice', primary_username: 'alice' }),
    } as unknown as MemberMap;

    const out = membersWithEffectiveIdentity(roster, effective)!;
    expect(out[0].primary_username).toBe('alice');
  });

  it('keeps roster order, which is the order the autocomplete presents', () => {
    const roster = [member(BOB), member(ALICE)];
    // Insertion order here is the opposite of the roster's, so taking
    // Object.values instead of mapping the roster would reorder the list.
    const effective = {
      [ALICE]: member(ALICE, { primary_username: 'alice' }),
      [BOB]: member(BOB, { primary_username: 'bob' }),
    } as unknown as MemberMap;

    const out = membersWithEffectiveIdentity(roster, effective)!;
    expect(out.map((m) => m.address)).toEqual([BOB, ALICE]);
  });

  it('passes through a member the map does not know', () => {
    // The map only holds members who appear as a sender in the loaded messages,
    // so most of a large roster is absent from it. Those rows must survive.
    const roster = [member(ALICE, { global_display_name: 'Alice' })];
    const out = membersWithEffectiveIdentity(roster, {} as MemberMap)!;
    expect(out).toHaveLength(1);
    expect(out[0].global_display_name).toBe('Alice');
  });

  it('leaves undefined undefined, so a not-yet-loaded roster stays absent', () => {
    // The prop is optional downstream; turning "not loaded" into an empty array
    // would render an autocomplete with no members instead of none at all.
    expect(membersWithEffectiveIdentity(undefined, {} as MemberMap)).toBeUndefined();
  });
});
