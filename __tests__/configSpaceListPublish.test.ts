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
