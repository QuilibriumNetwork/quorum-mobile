/**
 * Config sync moves the blob less often.
 *
 * ## The regressions this pins
 *
 * The encrypted config blob carries every Space's encryption state, so it runs
 * to megabytes, and it moved in full far more often than it changed:
 *
 * - DOWNLOAD: `getConfig` fetched the whole blob on every call — every DM
 *   screen open, and twice at once when the profile screen opened (two hooks
 *   mounting together) — mostly to learn nothing had changed.
 * - UPLOAD: every mute, bookmark, receipt or notification toggle uploaded the
 *   whole blob the moment it was made, so three toggles in a row were three
 *   full uploads.
 *
 * ## What is asserted
 *
 * - Toggles made close together become ONE upload, after a quiet period,
 *   carrying every one of them; awaiting a toggle settles once that upload
 *   has run; backgrounding the app uploads at once.
 * - A toggle made while an upload is in flight is not erased when that upload
 *   finishes, and goes out with the next one.
 * - A pull never adopts a newer remote over a toggle still waiting to upload.
 * - Overlapping `getConfig` calls share one download; a refresh may reuse a
 *   recent one; a plain `getConfig` (the one used before a save) never does.
 * - CONTROL: a save that is not a toggle (joining a Space) still uploads at
 *   once.
 *
 * Only the boundaries are mocked (storage, network, native crypto), as in
 * configPublishOutcome.test.ts; the server is a fake that stores what is
 * posted and returns it, so pulls see uploads the way the real one would.
 */

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
      remove: (k: string) => store.delete(k),
      delete: (k: string) => store.delete(k),
      clearAll: () => store.clear(),
      getAllKeys: () => Array.from(store.keys()),
      contains: (k: string) => store.has(k),
    };
  },
}));

jest.mock('../services/onboarding/secureStorage', () => ({
  getPrivateKey: async () => 'aa'.repeat(57),
  getPublicKey: async () => 'bb'.repeat(57),
}));

type Stored = { user_config: string; timestamp: number; signature: string };
const mockServer: { stored: Stored | null } = { stored: null };
const mockPostUserSettings = jest.fn();
const mockGetUserSettings = jest.fn();
jest.mock('../services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    postUserSettings: (...a: unknown[]) => mockPostUserSettings(...a),
    getUserSettings: (...a: unknown[]) => mockGetUserSettings(...a),
  }),
}));

jest.mock('../services/config/spaceStorage', () => ({
  getAllSpaces: () => [{ spaceId: 'space-1' }],
  getSpaceKeys: () => [{ keyId: 'config' }],
  getSpaceKey: () => ({ keyId: 'signing', address: 'a', publicKey: 'b', privateKey: 'c' }),
  saveSpaceKey: jest.fn(),
  clearSpaceStorage: jest.fn(),
}));
jest.mock('../services/crypto/encryption-state-storage', () => ({
  encryptionStateStorage: {
    getEncryptionStates: (id: string) => [
      { conversationId: id, inboxId: 'inbox-1', state: '{}', timestamp: 1 },
    ],
  },
}));
jest.mock('../services/storage/mmkvAdapter', () => ({
  getMMKVAdapter: () => ({ getSpaceMember: async () => null }),
}));
jest.mock('../services/crypto/native-provider', () => ({
  NativeCryptoProvider: class {
    async signEd448() {
      return btoa('signature');
    }
  },
}));
jest.mock('../modules/quorum-crypto/src', () => ({ verifyEd448: async () => true }));
jest.mock('../services/offline/storage', () => ({
  mmkvStorage: { getItem: () => null, setItem: jest.fn(), removeItem: jest.fn() },
}));

import { AppState } from 'react-native';
import { sha512 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { hexToBytes, bytesToHex, logger } from '@quilibrium/quorum-shared';
import type { UserConfig } from '@quilibrium/quorum-shared';
import {
  CONFIG_PUBLISH_DEBOUNCE_MS,
  CONFIG_REFRESH_MAX_AGE_MS,
  clearConfigStorage,
  getConfig,
  getLocalUserConfig,
  saveConfig,
  saveLocalUserConfig,
  setBlockedUsers,
  setMutedChannels,
  setMutedConversations,
} from '../services/config/configService';

const ADDRESS = 'QmUserAddress';
const NOW = 1_750_000_000_000;

// Every publish logs a line; none of it is under test.
jest.spyOn(logger, 'log').mockImplementation(() => {});
jest.spyOn(logger, 'debug').mockImplementation(() => {});

function configKey(): Uint8Array {
  return sha512(new Uint8Array(hexToBytes('aa'.repeat(57)))).slice(0, 32);
}

function decrypt(hex: string): UserConfig {
  const iv = new Uint8Array(hexToBytes(hex.slice(-24)));
  const ciphertext = new Uint8Array(hexToBytes(hex.slice(0, -24)));
  return JSON.parse(new TextDecoder().decode(gcm(configKey(), iv).decrypt(ciphertext))) as UserConfig;
}

function encrypt(config: Partial<UserConfig>): string {
  const iv = new Uint8Array(12);
  const ciphertext = gcm(configKey(), iv).encrypt(new TextEncoder().encode(JSON.stringify(config)));
  return bytesToHex(ciphertext) + bytesToHex(iv);
}

/** The config carried by upload number `n` (0-based). */
const uploaded = (n: number): UserConfig =>
  decrypt((mockPostUserSettings.mock.calls[n][1] as Stored).user_config);

const seed = (over: Partial<UserConfig> = {}) =>
  saveLocalUserConfig({
    address: ADDRESS,
    allowSync: true,
    timestamp: 1000,
    spaceIds: ['space-1'],
    items: [{ type: 'space', id: 'space-1' }],
    ...over,
  } as unknown as UserConfig);

/** Let the async publish chain (key reads, signing, the POST) run to the end. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  // Also drops the in-memory download cache and any scheduled upload.
  clearConfigStorage();
  memoryStores().forEach((s) => s.clear());
  mockServer.stored = null;
  mockPostUserSettings.mockReset();
  mockGetUserSettings.mockReset();
  mockPostUserSettings.mockImplementation(async (_address: string, payload: Stored) => {
    mockServer.stored = {
      user_config: payload.user_config,
      timestamp: payload.timestamp,
      signature: payload.signature,
    };
    return {};
  });
  mockGetUserSettings.mockImplementation(async () => mockServer.stored);
});

afterEach(async () => {
  // Drain anything a test left scheduled so it cannot leak into the next.
  await jest.advanceTimersByTimeAsync(CONFIG_PUBLISH_DEBOUNCE_MS * 2);
  jest.useRealTimers();
});

describe('toggles upload once, coalesced', () => {
  it('turns three quick toggles into one upload that carries all three', async () => {
    seed();
    const toggles = [
      setMutedConversations(ADDRESS, ['dm-1']),
      setMutedChannels(ADDRESS, 'space-1', ['channel-1']),
      setBlockedUsers(ADDRESS, 'space-1', ['user-1']),
    ];

    await jest.advanceTimersByTimeAsync(CONFIG_PUBLISH_DEBOUNCE_MS - 1);
    expect(mockPostUserSettings).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    await Promise.all(toggles);
    expect(mockPostUserSettings).toHaveBeenCalledTimes(1);

    const sent = uploaded(0) as UserConfig & { blockedUsers?: Record<string, string[]> };
    expect(sent.mutedConversations).toEqual(['dm-1']);
    expect(sent.mutedChannels).toEqual({ 'space-1': ['channel-1'] });
    expect(sent.blockedUsers).toEqual({ 'space-1': ['user-1'] });
  });

  it('applies each toggle locally at once', async () => {
    seed();
    void setMutedConversations(ADDRESS, ['dm-1']);
    expect(getLocalUserConfig(ADDRESS)?.mutedConversations).toEqual(['dm-1']);
  });

  it('settles an awaited toggle only once its upload has run', async () => {
    seed();
    let settled = false;
    const toggle = setMutedConversations(ADDRESS, ['dm-1']).then(() => {
      settled = true;
    });

    await jest.advanceTimersByTimeAsync(CONFIG_PUBLISH_DEBOUNCE_MS / 2);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(CONFIG_PUBLISH_DEBOUNCE_MS);
    await toggle;
    expect(settled).toBe(true);
    expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
    // The local copy carries the timestamp the upload earned.
    expect(getLocalUserConfig(ADDRESS)?.timestamp).toBe(mockServer.stored?.timestamp);
  });

  it('uploads at once when the app goes to the background', async () => {
    seed();
    const toggle = setMutedConversations(ADDRESS, ['dm-1']);
    const listener = (AppState.addEventListener as jest.Mock).mock.calls.find(
      ([type]) => type === 'change',
    )?.[1] as ((state: string) => void) | undefined;
    expect(listener).toBeDefined();

    listener!('background');
    await settle();
    await toggle;
    expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
    expect(uploaded(0).mutedConversations).toEqual(['dm-1']);
  });

  it('keeps a toggle made while an upload is in flight, and sends it next', async () => {
    seed();
    let releaseFirstUpload!: () => void;
    mockPostUserSettings.mockImplementationOnce(
      (_address: string, payload: Stored) =>
        new Promise((resolve) => {
          releaseFirstUpload = () => {
            mockServer.stored = payload;
            resolve({});
          };
        }),
    );

    const first = setMutedConversations(ADDRESS, ['dm-1']);
    await jest.advanceTimersByTimeAsync(CONFIG_PUBLISH_DEBOUNCE_MS);
    expect(mockPostUserSettings).toHaveBeenCalledTimes(1);

    // Made while the first upload is still on the wire.
    const second = setMutedChannels(ADDRESS, 'space-1', ['channel-1']);
    releaseFirstUpload();
    await first;

    // The finished upload must not have written its older copy over it.
    expect(getLocalUserConfig(ADDRESS)?.mutedChannels).toEqual({ 'space-1': ['channel-1'] });

    await jest.advanceTimersByTimeAsync(CONFIG_PUBLISH_DEBOUNCE_MS);
    await second;
    expect(mockPostUserSettings).toHaveBeenCalledTimes(2);
    expect(uploaded(1).mutedConversations).toEqual(['dm-1']);
    expect(uploaded(1).mutedChannels).toEqual({ 'space-1': ['channel-1'] });
  });

  it('uploads a waiting toggle before a pull can replace it with a newer remote', async () => {
    // Another device published after this one last synced.
    mockServer.stored = {
      user_config: encrypt({ address: ADDRESS, allowSync: true, spaceIds: ['space-1'] }),
      timestamp: 5000,
      signature: 'cc'.repeat(114),
    };
    seed();
    void setMutedConversations(ADDRESS, ['dm-1']);

    const config = await getConfig(ADDRESS);
    expect(config.mutedConversations).toEqual(['dm-1']);
    expect(getLocalUserConfig(ADDRESS)?.mutedConversations).toEqual(['dm-1']);
    expect(mockPostUserSettings.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetUserSettings.mock.invocationCallOrder[0],
    );
  });

  it('CONTROL: a save that is not a toggle still uploads at once', async () => {
    seed();
    await saveConfig({
      ...getLocalUserConfig(ADDRESS)!,
      spaceIds: ['space-1'],
    });
    expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
  });
});

describe('downloads are shared', () => {
  it('serves overlapping getConfig calls from one download', async () => {
    seed();
    await Promise.all([getConfig(ADDRESS), getConfig(ADDRESS)]);
    expect(mockGetUserSettings).toHaveBeenCalledTimes(1);
  });

  it('lets a refresh reuse a recent download', async () => {
    seed();
    await getConfig(ADDRESS);
    await getConfig(ADDRESS, { maxAgeMs: CONFIG_REFRESH_MAX_AGE_MS });
    expect(mockGetUserSettings).toHaveBeenCalledTimes(1);
  });

  it('downloads again once the reused copy is too old', async () => {
    seed();
    await getConfig(ADDRESS);
    jest.setSystemTime(NOW + CONFIG_REFRESH_MAX_AGE_MS + 1);
    await getConfig(ADDRESS, { maxAgeMs: CONFIG_REFRESH_MAX_AGE_MS });
    expect(mockGetUserSettings).toHaveBeenCalledTimes(2);
  });

  it('never reuses a finished download for a plain getConfig', async () => {
    // The read a save is built on must see the server as it is now.
    seed();
    await getConfig(ADDRESS);
    await getConfig(ADDRESS);
    expect(mockGetUserSettings).toHaveBeenCalledTimes(2);
  });

  it('does not remember a failed download', async () => {
    seed();
    mockGetUserSettings.mockRejectedValueOnce(new Error('offline'));
    await getConfig(ADDRESS, { maxAgeMs: CONFIG_REFRESH_MAX_AGE_MS });
    await getConfig(ADDRESS, { maxAgeMs: CONFIG_REFRESH_MAX_AGE_MS });
    expect(mockGetUserSettings).toHaveBeenCalledTimes(2);
  });
});
