/**
 * saveConfig must never publish a Space list truncated by incomplete local
 * storage, and must never let that narrowing reach local state.
 *
 * The server rejects a config whose spaceIds and spaceKeys disagree, so the
 * uploaded parcel is narrowed to Spaces this device holds keys for. Publishing
 * that narrowed list is what emptied other devices' navigation: the config wins
 * on timestamp and both clients apply a remote Space list verbatim.
 *
 * Only the boundaries are mocked (storage, network, native crypto); the real
 * narrowing, hold and timestamp logic runs.
 */

// Stores hang off globalThis rather than a module-scope const: jest hoists the
// factory above every declaration, and configService creates its MMKV
// instances at import time, while a const would still be in its TDZ.
type MemoryStores = Map<string, Map<string, string>>;
const memoryStores = (): MemoryStores =>
  ((globalThis as Record<string, unknown>).__mmkv ??= new Map()) as MemoryStores;

jest.mock('react-native-mmkv', () => ({
  createMMKV: ({ id }: { id: string }) => {
    const stores = ((globalThis as Record<string, unknown>).__mmkv ??=
      new Map()) as Map<string, Map<string, string>>;
    if (!stores.has(id)) stores.set(id, new Map());
    const store = stores.get(id)!;
    return {
      getString: (k: string) => store.get(k),
      set: (k: string, v: string) => store.set(k, v),
      // configService calls .remove(); keep .delete() too so the fake matches
      // whichever the real binding exposes. Omitting .remove made
      // clearDeletedBookmarkIds throw AFTER the POST, so the publish path
      // silently landed in the catch block during tests.
      remove: (k: string) => store.delete(k),
      delete: (k: string) => store.delete(k),
      clearAll: () => store.clear(),
      getAllKeys: () => Array.from(store.keys()),
      contains: (k: string) => store.has(k),
    };
  },
}));

const mockGetPrivateKey = jest.fn<Promise<string | null>, []>();
const mockGetPublicKey = jest.fn<Promise<string | null>, []>();
jest.mock('../services/onboarding/secureStorage', () => ({
  getPrivateKey: () => mockGetPrivateKey(),
  getPublicKey: () => mockGetPublicKey(),
}));

const mockPostUserSettings = jest.fn();
const mockGetUserSettings = jest.fn();
jest.mock('../services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    postUserSettings: (...a: unknown[]) => mockPostUserSettings(...a),
    getUserSettings: (...a: unknown[]) => mockGetUserSettings(...a),
  }),
}));

const mockGetAllSpaces = jest.fn<{ spaceId: string }[], []>();
const mockGetSpaceKeys = jest.fn<{ keyId: string }[], [string]>();
jest.mock('../services/config/spaceStorage', () => ({
  getAllSpaces: () => mockGetAllSpaces(),
  getSpaceKeys: (id: string) => mockGetSpaceKeys(id),
  // promoteSpaceSigningKeys short-circuits when a 'signing' key already exists
  getSpaceKey: () => ({ keyId: 'signing', address: 'a', publicKey: 'b', privateKey: 'c' }),
  saveSpaceKey: jest.fn(),
  clearSpaceStorage: jest.fn(),
}));

const mockGetEncryptionStates = jest.fn<unknown[], [string]>();
jest.mock('../services/crypto/encryption-state-storage', () => ({
  encryptionStateStorage: {
    getEncryptionStates: (id: string) => mockGetEncryptionStates(id),
  },
}));

jest.mock('../services/storage/mmkvAdapter', () => ({
  getMMKVAdapter: () => ({ getSpaceMember: jest.fn().mockResolvedValue(null) }),
}));

jest.mock('../services/crypto/native-provider', () => ({
  NativeCryptoProvider: class {
    async signEd448() {
      return btoa('signature');
    }
  },
}));

jest.mock('../services/offline/storage', () => ({
  mmkvStorage: { getItem: () => null, setItem: jest.fn(), removeItem: jest.fn() },
}));

import {
  saveConfig,
  getLocalUserConfig,
  saveLocalUserConfig,
  removeSpaceFromConfig,
  setAllowSync,
} from '../services/config/configService';
import type { UserConfig } from '@quilibrium/quorum-shared';

const ADDRESS = 'QmUserAddress';

/** A Space that this device holds a usable encryption state for. */
const keyedSpace = (spaceId: string) => ({ spaceId });

const encState = (conversationId: string) => ({
  conversationId,
  inboxId: 'inbox-1',
  state: '{}',
  timestamp: 1,
});

describe('saveConfig — truncated Space lists are never published', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    memoryStores().forEach((s) => s.clear());
    mockGetPrivateKey.mockResolvedValue('aa'.repeat(57));
    mockGetPublicKey.mockResolvedValue('bb'.repeat(57));
    mockPostUserSettings.mockResolvedValue({});
    mockGetSpaceKeys.mockReturnValue([{ keyId: 'config' }]);
  });

  /** Config lists three Spaces; local storage only knows about space-1. */
  const partialConfig = (): UserConfig =>
    ({
      address: ADDRESS,
      allowSync: true,
      timestamp: 1000,
      spaceIds: ['space-1', 'space-2', 'space-3'],
      items: [
        { type: 'space', id: 'space-1' },
        { type: 'space', id: 'space-2' },
        { type: 'folder', id: 'folder-1', name: 'Work', spaceIds: ['space-1', 'space-3'] },
      ],
    }) as unknown as UserConfig;

  const arrangePartialStorage = () => {
    mockGetAllSpaces.mockReturnValue([keyedSpace('space-1')]);
    mockGetEncryptionStates.mockImplementation((id) => [encState(id)]);
  };

  it('persists the full Space list locally even when storage is incomplete', async () => {
    arrangePartialStorage();

    await saveConfig(partialConfig());

    const saved = getLocalUserConfig(ADDRESS)!;
    expect(saved.spaceIds).toEqual(['space-1', 'space-2', 'space-3']);
    expect(saved.items).toHaveLength(3);
    // The folder keeps both Spaces: narrowing must not mutate it
    expect((saved.items![2] as { spaceIds: string[] }).spaceIds).toEqual([
      'space-1',
      'space-3',
    ]);
  });

  it('does not publish a Space list truncated by incomplete storage', async () => {
    arrangePartialStorage();

    await saveConfig(partialConfig());

    // The whole point of the guard: this device's incomplete storage must not
    // become every other device's empty sidebar. The local copy survives intact.
    expect(mockPostUserSettings).not.toHaveBeenCalled();
    expect(getLocalUserConfig(ADDRESS)!.spaceIds).toEqual([
      'space-1',
      'space-2',
      'space-3',
    ]);
  });

  it('does not advance the stored timestamp when the publish is held', async () => {
    arrangePartialStorage();

    await saveConfig(partialConfig());

    // getConfig resolves purely by timestamp and never merges the losing side.
    // A device that advanced its own timestamp without the server agreeing
    // would treat its config as newer than every remote one and quietly stop
    // applying other devices' changes for as long as it kept holding.
    expect(getLocalUserConfig(ADDRESS)!.timestamp).toBe(1000);
  });

  it('publishes, and advances the timestamp, once every Space is known', async () => {
    mockGetAllSpaces.mockReturnValue([
      keyedSpace('space-1'),
      keyedSpace('space-2'),
      keyedSpace('space-3'),
    ]);
    mockGetEncryptionStates.mockImplementation((id) => [encState(id)]);

    await saveConfig(partialConfig());

    expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
    expect(getLocalUserConfig(ADDRESS)!.timestamp).toBeGreaterThan(1000);
  });

  it('still publishes when the user removed a Space, so removals propagate', async () => {
    // The user left space-2: the caller already took it out of spaceIds, and
    // the real removal paths delete its encryption state before saveConfig
    // runs. Nothing is dropped by narrowing, so this must publish as normal.
    const afterLeaving = {
      address: ADDRESS,
      allowSync: true,
      timestamp: 1000,
      spaceIds: ['space-1'],
      items: [{ type: 'space', id: 'space-1' }],
    } as unknown as UserConfig;

    mockGetAllSpaces.mockReturnValue([keyedSpace('space-1'), keyedSpace('space-2')]);
    mockGetEncryptionStates.mockImplementation((id) =>
      id.startsWith('space-1') ? [encState(id)] : []
    );

    await saveConfig(afterLeaving);

    expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
    expect(getLocalUserConfig(ADDRESS)!.spaceIds).toEqual(['space-1']);
  });

  describe('removeSpaceFromConfig — leaving a Space reaches other devices', () => {
    const folder = (spaceIds: string[]) => ({
      type: 'folder' as const,
      id: 'folder-1',
      name: 'Work',
      spaceIds,
      createdDate: 1,
      modifiedDate: 1,
    });

    const seed = (config: Partial<UserConfig>) =>
      saveLocalUserConfig({
        address: ADDRESS,
        allowSync: true,
        timestamp: 1000,
        spaceIds: ['space-1', 'space-2'],
        items: [{ type: 'space', id: 'space-1' }, folder(['space-2'])],
        ...config,
      } as unknown as UserConfig);

    beforeEach(() => {
      // Every Space is still keyed at removal time: the local wipe happens
      // after this call, so nothing is dropped by narrowing.
      mockGetAllSpaces.mockReturnValue([keyedSpace('space-1'), keyedSpace('space-2')]);
      mockGetEncryptionStates.mockImplementation((id) => [encState(id)]);
    });

    it('publishes the removal so other devices see it', async () => {
      seed({});

      await removeSpaceFromConfig(ADDRESS, 'space-2');

      // Publishing is the whole point: without it the other device never learns
      expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
      expect(getLocalUserConfig(ADDRESS)!.spaceIds).toEqual(['space-1']);
    });

    it('prunes the Space out of folders too', async () => {
      seed({});

      await removeSpaceFromConfig(ADDRESS, 'space-2');

      // The folder held only space-2, so it goes with it
      expect(getLocalUserConfig(ADDRESS)!.items).toEqual([
        { type: 'space', id: 'space-1' },
      ]);
    });

    it('leaves other Spaces and folders untouched', async () => {
      seed({
        spaceIds: ['space-1', 'space-2'],
        items: [folder(['space-1', 'space-2'])],
      });

      await removeSpaceFromConfig(ADDRESS, 'space-2');

      expect(getLocalUserConfig(ADDRESS)!.items).toEqual([folder(['space-1'])]);
    });

    it('still removes it locally when allowSync is off', async () => {
      seed({ allowSync: false });

      await removeSpaceFromConfig(ADDRESS, 'space-2');

      // Sync-off must not mean the Space lingers in this device's own list
      expect(mockPostUserSettings).not.toHaveBeenCalled();
      expect(getLocalUserConfig(ADDRESS)!.spaceIds).toEqual(['space-1']);
    });

    it('does nothing when the Space is not in the config', async () => {
      seed({});

      await removeSpaceFromConfig(ADDRESS, 'never-joined');

      // No pointless publish, and no timestamp bump
      expect(mockPostUserSettings).not.toHaveBeenCalled();
      expect(getLocalUserConfig(ADDRESS)!.timestamp).toBe(1000);
    });
  });

  it('holds, and keeps local state, for a Space absent from storage entirely', async () => {
    // The accepted cost of the guard, pinned so it is a decision rather than a
    // surprise: a Space that can never be keyed here — a bloated encryption
    // state (desktop #108), or one never synced to this device — stops this
    // device publishing ANY config change until it syncs or is removed.
    //
    // That fails safe (stale settings) rather than destructive (every device
    // loses its Spaces), and removeSpaceFromConfig gives the user a way out
    // that did not exist when this guard was first tried and reverted.
    const staleId = {
      address: ADDRESS,
      allowSync: true,
      timestamp: 500,
      spaceIds: ['space-gone'],
      items: [{ type: 'space', id: 'space-gone' }],
    } as unknown as UserConfig;

    mockGetAllSpaces.mockReturnValue([]);
    mockGetEncryptionStates.mockReturnValue([]);

    await saveConfig(staleId);

    expect(mockPostUserSettings).not.toHaveBeenCalled();
    expect(getLocalUserConfig(ADDRESS)!.spaceIds).toEqual(['space-gone']);
    expect(getLocalUserConfig(ADDRESS)!.timestamp).toBe(500);
  });

  describe('carrying previously-synced Space keys', () => {
    /** A spaceKeys entry as it arrives in the config blob from another device. */
    const blobKey = (spaceId: string) => ({
      spaceId,
      encryptionState: {
        conversationId: `${spaceId}/${spaceId}`,
        inboxId: 'inbox-from-blob',
        state: '{}',
        timestamp: 1,
      },
      keys: [
        {
          keyId: 'config',
          address: 'addr',
          publicKey: 'pub-from-blob',
          privateKey: 'priv-from-blob',
          spaceId,
        },
      ],
    });

    /** Nothing is keyable from local storage — the 0/3 case measured on device. */
    const arrangeNothingKeyable = () => {
      mockGetAllSpaces.mockReturnValue([]);
      mockGetEncryptionStates.mockReturnValue([]);
    };

    const configWithBlobKeys = (): UserConfig =>
      ({
        address: ADDRESS,
        allowSync: true,
        timestamp: 1000,
        spaceIds: ['space-1', 'space-2', 'space-3'],
        items: [
          { type: 'space', id: 'space-1' },
          { type: 'space', id: 'space-2' },
          { type: 'space', id: 'space-3' },
        ],
        spaceKeys: [blobKey('space-1'), blobKey('space-2'), blobKey('space-3')],
      }) as unknown as UserConfig;

    it('publishes the full list when local storage can key nothing at all', async () => {
      // The regression this exists to prevent: a device that imported its Spaces
      // from the blob rather than creating them keys 0 of them, so the guard
      // held every publish and the phone silently stopped syncing any setting.
      arrangeNothingKeyable();

      await saveConfig({ ...configWithBlobKeys(), name: 'renamed' });

      expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
      expect(getLocalUserConfig(ADDRESS)!.spaceIds).toEqual([
        'space-1',
        'space-2',
        'space-3',
      ]);
      expect(getLocalUserConfig(ADDRESS)!.name).toBe('renamed');
    });

    it('prefers the locally collected key over the carried-over copy', async () => {
      // A key rotated on this device must not be overwritten by the older copy
      // the blob happens to carry.
      mockGetAllSpaces.mockReturnValue([keyedSpace('space-1')]);
      mockGetEncryptionStates.mockImplementation((id) => [encState(id)]);
      mockGetSpaceKeys.mockReturnValue([
        { keyId: 'config', publicKey: 'pub-local', privateKey: 'priv-local' },
      ] as never);

      await saveConfig(configWithBlobKeys());

      const effective = getLocalUserConfig(ADDRESS)!.spaceKeys!;
      const space1 = effective.find((sk) => sk.spaceId === 'space-1')!;
      expect(space1.keys[0].privateKey).toBe('priv-local');
      // The two it cannot key are still carried, so the list is not narrowed
      expect(effective.map((sk) => sk.spaceId).sort()).toEqual([
        'space-1',
        'space-2',
        'space-3',
      ]);
    });

    it('does not carry a Space the user removed from the config', async () => {
      // removeSpaceFromConfig takes the Space out of spaceIds before saveConfig
      // runs. Carrying its stale blob key would resurrect it on every device.
      arrangeNothingKeyable();

      const afterLeaving = {
        ...configWithBlobKeys(),
        spaceIds: ['space-1', 'space-2'],
        items: [
          { type: 'space', id: 'space-1' },
          { type: 'space', id: 'space-2' },
        ],
      } as unknown as UserConfig;

      await saveConfig(afterLeaving);

      expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
      expect(
        getLocalUserConfig(ADDRESS)!
          .spaceKeys!.map((sk) => sk.spaceId)
          .sort()
      ).toEqual(['space-1', 'space-2']);
    });

    it('never wipes the stored keys when local storage can key nothing', async () => {
      // The defect that wedged a real device. saveConfig assigns
      // config.spaceKeys = <what it could rebuild locally> and then persists
      // that object, so the first save on a device keying nothing overwrote its
      // stored key material with an empty list. Carry-forward then had nothing
      // to carry, and the hold kept the local timestamp equal to the server's,
      // so no pull ever re-stored them. Permanently stuck.
      arrangeNothingKeyable();
      saveLocalUserConfig(configWithBlobKeys());

      await saveConfig(configWithBlobKeys());
      await saveConfig(getLocalUserConfig(ADDRESS)!);

      expect(
        getLocalUserConfig(ADDRESS)!
          .spaceKeys!.map((sk) => sk.spaceId)
          .sort()
      ).toEqual(['space-1', 'space-2', 'space-3']);
    });

    it('recovers the keys from storage when the caller omits them', async () => {
      // A caller that does not build its object from getLocalUserConfig must
      // not look like "this device has never known any keys".
      arrangeNothingKeyable();
      saveLocalUserConfig(configWithBlobKeys());

      const withoutKeys = { ...configWithBlobKeys(), spaceKeys: undefined };
      await saveConfig(withoutKeys as UserConfig);

      expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
      expect(getLocalUserConfig(ADDRESS)!.spaceKeys).toHaveLength(3);
    });

    it('still holds when a Space has no key material anywhere', async () => {
      // The genuine dead end the guard is for: no local keys, and nothing in the
      // blob either. Rare now, but it must still refuse rather than truncate.
      arrangeNothingKeyable();

      await saveConfig({
        ...configWithBlobKeys(),
        spaceKeys: [blobKey('space-1')],
      } as UserConfig);

      expect(mockPostUserSettings).not.toHaveBeenCalled();
      expect(getLocalUserConfig(ADDRESS)!.timestamp).toBe(1000);
    });
  });

  it('publishes a username change while every Space is keyed', async () => {
    // The reported reproduction, in miniature: changing the username routes
    // through saveConfig like any other setting, which is how an unrelated
    // edit emptied every other device's sidebar. With storage complete there
    // is nothing to drop, so this must still publish normally — the guard must
    // not turn into "mobile never syncs settings".
    mockGetAllSpaces.mockReturnValue([
      keyedSpace('space-1'),
      keyedSpace('space-2'),
      keyedSpace('space-3'),
    ]);
    mockGetEncryptionStates.mockImplementation((id) => [encState(id)]);

    await saveConfig({ ...partialConfig(), name: 'renamed' });

    expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
    expect(getLocalUserConfig(ADDRESS)!.name).toBe('renamed');
  });
});

/**
 * Publishing is what earns the right to a newer timestamp.
 *
 * The refuse-to-publish branch already applied this rule (covered above). It is
 * the SAME rule, and the other three non-publishing paths were missing it:
 * sync off, no keypair, and a failed POST. Each of them advanced this device's
 * timestamp without the server ever agreeing.
 *
 * Two silent consequences follow, and both are why this is worth pinning.
 * getConfig resolves purely by timestamp and discards the losing side whole, so
 * a drifted device stops applying every other device's changes — permanently,
 * from its first local edit. And when it eventually does publish, that stale
 * picture is adopted verbatim everywhere, taking with it every Space and
 * setting the other devices had and this one did not.
 *
 * The control arm is load-bearing: if every arm withheld the timestamp these
 * assertions would pass while proving nothing.
 *
 * See 2026-08-07-a-device-with-sync-off-still-claims-a-newer-timestamp.md
 */
describe('saveConfig — only a publish advances the timestamp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    memoryStores().forEach((s) => s.clear());
    mockGetPrivateKey.mockResolvedValue('aa'.repeat(57));
    mockGetPublicKey.mockResolvedValue('bb'.repeat(57));
    mockPostUserSettings.mockResolvedValue({});
    mockGetSpaceKeys.mockReturnValue([{ keyId: 'config' }]);
    // Everything keyable, so nothing here is held by the truncation guard —
    // these tests must exercise the other branches, not that one.
    mockGetAllSpaces.mockReturnValue([keyedSpace('space-1')]);
    mockGetEncryptionStates.mockImplementation((id) => [encState(id)]);
  });

  const config = (over: Partial<UserConfig> = {}): UserConfig =>
    ({
      address: ADDRESS,
      allowSync: true,
      timestamp: 1000,
      spaceIds: ['space-1'],
      items: [{ type: 'space', id: 'space-1' }],
      ...over,
    }) as unknown as UserConfig;

  it('withholds the timestamp when sync is off, but still persists the change', async () => {
    await saveConfig(config({ allowSync: false, name: 'renamed' }));

    expect(mockPostUserSettings).not.toHaveBeenCalled();
    expect(getLocalUserConfig(ADDRESS)!.timestamp).toBe(1000);
    // Only the claim to authority is withheld — the user's edit still landed.
    expect(getLocalUserConfig(ADDRESS)!.name).toBe('renamed');
  });

  it('does not drift across repeated saves with sync off', async () => {
    for (const name of ['one', 'two', 'three']) {
      await saveConfig(config({ ...getLocalUserConfig(ADDRESS), allowSync: false, name }));
    }

    expect(getLocalUserConfig(ADDRESS)!.timestamp).toBe(1000);
    expect(getLocalUserConfig(ADDRESS)!.name).toBe('three');
  });

  it('withholds the timestamp when there is no keypair to sign with', async () => {
    mockGetPrivateKey.mockResolvedValue(null);

    await saveConfig(config({ name: 'renamed' }));

    expect(mockPostUserSettings).not.toHaveBeenCalled();
    expect(getLocalUserConfig(ADDRESS)!.timestamp).toBe(1000);
    expect(getLocalUserConfig(ADDRESS)!.name).toBe('renamed');
  });

  it('withholds the timestamp when the POST fails', async () => {
    // The "nothing syncs" black hole: a device that keeps a fresh timestamp
    // after a failed request stops accepting every other device's config from
    // then on, so one transient 400 outlives the request that caused it.
    mockPostUserSettings.mockRejectedValue(new Error('413 payload too large'));

    await saveConfig(config({ name: 'renamed' }));

    expect(getLocalUserConfig(ADDRESS)!.timestamp).toBe(1000);
    expect(getLocalUserConfig(ADDRESS)!.name).toBe('renamed');
  });

  describe('setAllowSync — enabling pulls before it publishes', () => {
    it('pulls before publishing when sync is turned ON', async () => {
      saveLocalUserConfig(config({ allowSync: false }));

      await setAllowSync(ADDRESS, true);

      // Order is the whole point: publishing first would put this device's
      // picture on the server before it had seen what the others added.
      expect(mockGetUserSettings).toHaveBeenCalled();
      expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
      expect(mockGetUserSettings.mock.invocationCallOrder[0]).toBeLessThan(
        mockPostUserSettings.mock.invocationCallOrder[0]
      );
      expect(getLocalUserConfig(ADDRESS)!.allowSync).toBe(true);
    });

    it('does not pull when sync is turned OFF', async () => {
      saveLocalUserConfig(config({ allowSync: true }));

      await setAllowSync(ADDRESS, false);

      // Nothing is published, so there is nothing to reconcile against.
      expect(mockGetUserSettings).not.toHaveBeenCalled();
      expect(mockPostUserSettings).not.toHaveBeenCalled();
      expect(getLocalUserConfig(ADDRESS)!.allowSync).toBe(false);
    });

    it('still enables sync when the pull fails', async () => {
      // Offline must not leave the user unable to turn the setting on.
      saveLocalUserConfig(config({ allowSync: false }));
      mockGetUserSettings.mockRejectedValue(new Error('offline'));

      await setAllowSync(ADDRESS, true);

      expect(getLocalUserConfig(ADDRESS)!.allowSync).toBe(true);
      expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
    });
  });

  it('CONTROL ARM: a config that reaches the server does advance the timestamp', async () => {
    await saveConfig(config({ name: 'renamed' }));

    expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
    const posted = mockPostUserSettings.mock.calls[0][1] as { timestamp: number };
    expect(posted.timestamp).toBeGreaterThan(1000);
    // What we kept locally must match what the server was told.
    expect(getLocalUserConfig(ADDRESS)!.timestamp).toBe(posted.timestamp);
  });
});
