/**
 * Ownership is possession of the `owner` key slot, and nothing else.
 *
 * There is no ownership flag in the Space record, no server-side owner lookup a
 * client can ask, and no ownership transfer. `holdsSpaceOwnerKey` is therefore the
 * single gate in front of every owner-only action on mobile — the Danger tab, the
 * member-management controls, and the withholding of "Leave" from owners.
 *
 * These tests exist because desktop shipped `const isOwner = true` for the same
 * question, which grants owner UI to every member. Mobile's version is correct; this
 * pins it so it stays correct, and pins the two facts a future change is most likely
 * to break: a member's device must read false even though it holds plenty of OTHER
 * keys for the same Space, and deleting a Space destroys the owner key with the rest.
 */

// The store hangs off globalThis rather than a module-scope const: jest hoists the
// mock factory above every declaration, and spaceStorage creates its MMKV instance at
// import time, so a const would still be in its TDZ. Same pattern as
// configSpaceListPublish.test.ts.
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
      delete: (k: string) => store.delete(k),
      getAllKeys: () => Array.from(store.keys()),
      clearAll: () => store.clear(),
      contains: (k: string) => store.has(k),
    };
  },
}));

import {
  clearSpaceStorage,
  deleteSpaceKeys,
  holdsSpaceOwnerKey,
  saveSpaceKey,
  type SpaceKey,
} from '@/services/config/spaceStorage';

const SPACE_ID = 'space-under-test';

const key = (keyId: string): SpaceKey => ({
  spaceId: SPACE_ID,
  keyId,
  publicKey: `pub-${keyId}`,
  privateKey: `priv-${keyId}`,
});

beforeEach(() => {
  clearSpaceStorage();
});

describe('holdsSpaceOwnerKey', () => {
  it('is false for a Space this device holds no keys for at all', () => {
    expect(holdsSpaceOwnerKey(SPACE_ID)).toBe(false);
  });

  it('is false on a member device that holds every other key for the Space', () => {
    // This is the case desktop's `isOwner = true` gets wrong. A joined member legitimately
    // holds the space, config, hub and inbox keys; only the owner slot is absent.
    saveSpaceKey(key(SPACE_ID));
    saveSpaceKey(key('config'));
    saveSpaceKey(key('hub'));
    saveSpaceKey(key('inbox'));

    expect(holdsSpaceOwnerKey(SPACE_ID)).toBe(false);
  });

  it('is true once the owner key is present', () => {
    saveSpaceKey(key('owner'));

    expect(holdsSpaceOwnerKey(SPACE_ID)).toBe(true);
  });

  it('does not confuse one Space for another', () => {
    saveSpaceKey({ ...key('owner'), spaceId: 'a-different-space' });

    expect(holdsSpaceOwnerKey(SPACE_ID)).toBe(false);
  });

  it('is false after the Space is removed, because removal destroys the owner key', () => {
    // Removing a Space from a device wipes every key slot including `owner`, and there
    // is no ownership transfer and no second copy to recover from. An owner who removes
    // their own Space cannot moderate, rekey or ever delete it again. That is why the
    // release build disables the button rather than merely relabelling it.
    saveSpaceKey(key('owner'));
    expect(holdsSpaceOwnerKey(SPACE_ID)).toBe(true);

    deleteSpaceKeys(SPACE_ID);

    expect(holdsSpaceOwnerKey(SPACE_ID)).toBe(false);
  });
});
