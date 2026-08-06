/**
 * Which DM partners the inbox will look up a public profile for.
 *
 * This is a COST bound, and the reason it is tested separately from anything
 * that renders: getting it wrong is invisible in the app. Too many lookups
 * looks exactly like the correct behaviour — every name resolves — while
 * quietly issuing a request per partner as the user scrolls. The first version
 * of this hook had no cap at all and a comment asserting one.
 */

// The module reaches the API client for its query function, which pulls in MMKV
// (and a native module) at import time. Stub the storage rather than restructure
// production code around a test constraint.
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

import { qnsLookupAddresses } from '../hooks/chat/useConversationsWithQnsNames';

const addr = (n: number) => `QmPeer${String.fromCharCode(65 + (n % 26))}${n}zzzz`;
const convo = (address: string) => ({ address });

describe('qnsLookupAddresses', () => {
  it('caps the lookups however long the inbox gets', () => {
    // The regression. `useUnifiedConversations` accumulates every fetched page
    // and the inbox pages on scroll, so without a cap this grows with scroll
    // depth — the roster fetch storm, merely paced differently.
    const many = Array.from({ length: 800 }, (_, i) => convo(addr(i)));
    expect(qnsLookupAddresses(many, 50)).toHaveLength(50);
  });

  it('keeps the NEWEST conversations when it has to drop some', () => {
    // Callers hand rows most-recent-first. Taking from the head means the
    // partners who lose their `.q` are the ones the user is least likely to be
    // looking at.
    const many = Array.from({ length: 100 }, (_, i) => convo(addr(i)));
    const picked = qnsLookupAddresses(many, 3);
    expect(picked).toEqual([addr(0), addr(1), addr(2)]);
  });

  it('skips Farcaster rows, which have no Quorum profile to fetch', () => {
    // `fid:<n>` is synthetic (useFarcasterDirectCasts). Fetching one is a
    // guaranteed 404 per Farcaster DM on every inbox open.
    const rows = [convo('fid:1'), convo(addr(1)), convo('fid:0'), convo(addr(2))];
    expect(qnsLookupAddresses(rows, 50)).toEqual([addr(1), addr(2)]);
  });

  it('does not spend cap budget on a Farcaster row it skipped', () => {
    // The cap counts what will actually be FETCHED. Counting skipped rows
    // against it would silently shrink the real budget for anyone whose inbox
    // mixes the two.
    const rows = [convo('fid:1'), convo('fid:2'), convo(addr(1)), convo(addr(2))];
    expect(qnsLookupAddresses(rows, 2)).toEqual([addr(1), addr(2)]);
  });

  it('counts a repeated partner once', () => {
    const rows = [convo(addr(1)), convo(addr(1)), convo(addr(2))];
    expect(qnsLookupAddresses(rows, 50)).toEqual([addr(1), addr(2)]);
  });

  it('ignores rows with no address at all', () => {
    expect(qnsLookupAddresses([{}, convo(addr(1)), { address: '' }], 50)).toEqual([
      addr(1),
    ]);
  });

  it('asks for nothing when there is nothing to ask about', () => {
    // A user with no Quorum DMs must cost zero requests, not one empty batch.
    expect(qnsLookupAddresses([], 50)).toEqual([]);
    expect(qnsLookupAddresses([convo('fid:7')], 50)).toEqual([]);
  });
});
