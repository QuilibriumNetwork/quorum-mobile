/**
 * Electing a primary name must actually leave the device.
 *
 * ## The bug this exists to prevent, which shipped once already
 *
 * Both broadcast paths dedupe on a signature of the payload: if the signature
 * matches the last announce to that destination, the send is suppressed as
 * redundant. A field missing from the signature is therefore **silently
 * undeliverable** — the payload carries it, the gate says "same as last time",
 * and nothing is sent. No error, no log, nothing to retry.
 *
 * Electing a primary name is exactly the case that triggers it, because it
 * touches no other profile field: display name, avatar and bio are all
 * unchanged, so the signature is identical unless the name is part of it.
 *
 * The space-side signature omitted `primaryUsername` while the DM twin included
 * it, so a `.q` would reach DM partners and never reach spacemates — an
 * asymmetry that looks like a rendering bug rather than a delivery one.
 *
 * ## Why a test and not review
 *
 * The failure is invisible from the app: no error surfaces, and a fresh launch
 * broadcasts correctly anyway (the in-memory dedupe ref starts empty), so the
 * obvious manual check — restart and look — PASSES while an in-session election
 * silently fails. Only a live in-session change reproduces it, which is not
 * something anyone thinks to try.
 */

// The space service imports the signing path, which reaches the native Rust
// module. Neither is exercised here — these are pure string functions — so stub
// it the same way the bookmark test does.
jest.mock('../modules/quorum-crypto/src', () => ({ verifyEd448: async () => true }));

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

import { profileBroadcastSignature } from '../services/space/spaceMessageService';
import { payloadSignature } from '../services/dm/dmProfileService';

const spaceBase = {
  spaceId: 'space-1',
  channelId: 'channel-1',
  senderAddress: 'QmMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMe',
  displayName: 'Nobody',
  userIcon: 'icon',
};

const dmBase = {
  selfAddress: 'QmMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMe',
  displayName: 'Nobody',
  userIcon: 'icon',
};

describe('the space profile broadcast signature', () => {
  it('changes when a primary name is elected and nothing else moves', () => {
    // The whole bug in one assertion. Equal signatures here mean the gate
    // suppresses the announce and no spacemate ever learns the name.
    expect(profileBroadcastSignature({ ...spaceBase, primaryUsername: 'alice' })).not.toBe(
      profileBroadcastSignature(spaceBase),
    );
  });

  it('changes when a primary name is un-elected', () => {
    // '' is a deliberate withdrawal and must be distinguishable from both
    // "unchanged" and "still elected", or dropping a name never propagates and
    // peers keep rendering it indefinitely.
    expect(profileBroadcastSignature({ ...spaceBase, primaryUsername: '' })).not.toBe(
      profileBroadcastSignature({ ...spaceBase, primaryUsername: 'alice' }),
    );
    expect(profileBroadcastSignature({ ...spaceBase, primaryUsername: '' })).not.toBe(
      profileBroadcastSignature(spaceBase),
    );
  });

  it('is stable when nothing changed, so ordinary reconnects stay deduped', () => {
    // The gate has to keep working: this must not become "always send".
    expect(profileBroadcastSignature({ ...spaceBase, primaryUsername: 'alice' })).toBe(
      profileBroadcastSignature({ ...spaceBase, primaryUsername: 'alice' }),
    );
  });

  it('distinguishes one primary name from another', () => {
    expect(profileBroadcastSignature({ ...spaceBase, primaryUsername: 'alice' })).not.toBe(
      profileBroadcastSignature({ ...spaceBase, primaryUsername: 'bob' }),
    );
  });
});

describe('the DM profile broadcast signature', () => {
  // Asserted independently of the space twin rather than assumed to match. The
  // two drifted apart once already, which is how the space side lost the field.
  it('changes when a primary name is elected and nothing else moves', () => {
    expect(payloadSignature({ ...dmBase, primaryUsername: 'alice' })).not.toBe(
      payloadSignature(dmBase),
    );
  });

  it('changes when a primary name is un-elected', () => {
    expect(payloadSignature({ ...dmBase, primaryUsername: '' })).not.toBe(
      payloadSignature({ ...dmBase, primaryUsername: 'alice' }),
    );
  });

  it('is stable when nothing changed', () => {
    expect(payloadSignature({ ...dmBase, primaryUsername: 'alice' })).toBe(
      payloadSignature({ ...dmBase, primaryUsername: 'alice' }),
    );
  });
});
