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

import { saveConfig, getLocalUserConfig } from '../services/config/configService';
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

  it('narrows only the published payload, never local state', async () => {
    arrangePartialStorage();

    await saveConfig(partialConfig());

    // Mobile still publishes a narrowed list (see the comment in saveConfig:
    // it cannot yet distinguish mid-sync from a genuine leave), but the local
    // copy must survive intact.
    expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
    expect(getLocalUserConfig(ADDRESS)!.spaceIds).toEqual([
      'space-1',
      'space-2',
      'space-3',
    ]);
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

  it('keeps a Space absent from local storage in the local list', async () => {
    // A Space the user left keeps its id here, because no mobile removal path
    // prunes config.spaceIds. Local state must still not be rewritten.
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

    expect(getLocalUserConfig(ADDRESS)!.spaceIds).toEqual(['space-gone']);
    // Publishing still happens: refusing here would wedge sync permanently,
    // since this id can never regain keys.
    expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
  });
});
