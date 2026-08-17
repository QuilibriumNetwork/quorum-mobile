/**
 * Acceptance tests for the two mobile halves of the config-sync overhaul.
 *
 * §1 — the device records what its last publish actually DID. Sync being off, a
 * refuse-to-publish hold and a genuine upload all write the local row and all
 * look identical, so "my setting saved" has never been evidence that it synced.
 * On mobile the only existing signal is `logger.warn`, which compiles to a no-op
 * in release builds, so a real user gets nothing at all.
 *
 * §2 — `allowSync` describes THIS device's relationship with the server, but it
 * rides in the account-level blob, so turning sync off on the phone could be
 * flipped back on by a laptop that was still publishing.
 *
 * Assertions read the stored record straight out of the MMKV fake rather than
 * through the production reader, so a test cannot pass by agreeing with a broken
 * implementation of its own accessor.
 *
 * Only the boundaries are mocked (storage, network, native crypto). The real
 * narrowing, hold, timestamp, encryption and adopt logic runs.
 */

// Stores hang off globalThis rather than a module-scope const: jest hoists the
// factory above every declaration, and configService creates its MMKV instances
// at import time, while a const would still be in its TDZ.
type MemoryStores = Map<string, Map<string, string>>;
const memoryStores = (): MemoryStores =>
  ((globalThis as Record<string, unknown>).__mmkv ??= new Map()) as MemoryStores;

jest.mock('react-native-mmkv', () => ({
  createMMKV: ({ id }: { id: string }) => {
    const stores = ((globalThis as Record<string, unknown>).__mmkv ??=
      new Map()) as Map<string, Map<string, string>>;
    if (!stores.has(id)) stores.set(id, new Map());
    const store = stores.get(id)!;
    const removeKey = (k: string) => {
      // Lets one test fail the bookkeeping that runs AFTER a successful POST,
      // which is the only way to reach the catch block with the upload already
      // accepted by the server.
      if ((globalThis as Record<string, unknown>).__mmkvThrowOnRemove) {
        throw new Error('MMKV remove failed');
      }
      store.delete(k);
    };
    return {
      getString: (k: string) => store.get(k),
      set: (k: string, v: string) => {
        // Lets one test break the RECORDER specifically, to prove it cannot
        // take down the save it is measuring.
        //
        // Scoped to the record's own key on purpose: mobile's config row goes
        // through this same `set`, unlike desktop where the record is in
        // localStorage and the config is in IndexedDB. A blanket throw here
        // would break the local save too, and the test would then "pass"
        // against a broken recorder for the wrong reason.
        if (
          (globalThis as Record<string, unknown>).__mmkvThrowOnSet &&
          k === 'quorum:sync:lastPublish'
        ) {
          throw new Error('MMKV set failed: no space left on device');
        }
        store.set(k, v);
      },
      remove: removeKey,
      delete: removeKey,
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

// getConfig verifies the remote blob's Ed448 signature through the native module
// before it will decrypt anything. The mock is a function so one test can make
// the verification itself yield to the event loop — see "re-reads the local
// value" below.
const mockVerifyEd448 = jest.fn<Promise<boolean>, []>();
jest.mock('../modules/quorum-crypto/src', () => ({
  verifyEd448: () => mockVerifyEd448(),
}));

import { sha512 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { hexToBytes, bytesToHex } from '@quilibrium/quorum-shared';
import type { UserConfig, LastPublish } from '@quilibrium/quorum-shared';
import {
  saveConfig,
  getConfig,
  getLocalUserConfig,
  saveLocalUserConfig,
} from '../services/config/configService';
// The real reader, deliberately NOT mocked here: `readRecord` below reads the
// store directly so the WRITE side cannot pass by agreeing with a broken
// accessor, which leaves the reader itself needing its own coverage.
import { readLastPublish } from '../services/config/lastPublish';

const ADDRESS = 'QmUserAddress';
const PRIVATE_KEY = 'aa'.repeat(57);
const PUBLIC_KEY = 'bb'.repeat(57);
const SIGNATURE = 'cc'.repeat(114);

/** Where the device-local publish record lives. Deliberately NOT in UserConfig. */
const RECORD_STORE = 'quorum-config';
const RECORD_KEY = 'quorum:sync:lastPublish';

function readRecord(): LastPublish | null {
  const raw = memoryStores().get(RECORD_STORE)?.get(RECORD_KEY);
  return raw ? (JSON.parse(raw) as LastPublish) : null;
}

/** Same derivation as the service: AES-256 key = SHA-512(private_key)[0:32]. */
function configKey(): Uint8Array {
  return sha512(new Uint8Array(hexToBytes(PRIVATE_KEY))).slice(0, 32);
}

/** hex(ciphertext + IV), the wire shape the service decrypts. */
function encryptForServer(config: Partial<UserConfig>): string {
  // A fixed IV is fine here and keeps the fixture deterministic; nothing under
  // test depends on IV entropy.
  const iv = new Uint8Array(12);
  const ciphertext = gcm(configKey(), iv).encrypt(
    new TextEncoder().encode(JSON.stringify(config))
  );
  return bytesToHex(ciphertext) + bytesToHex(iv);
}

function decryptPostedConfig(): UserConfig {
  const posted = mockPostUserSettings.mock.calls[0][1] as { user_config: string };
  const hex = posted.user_config;
  const iv = new Uint8Array(hexToBytes(hex.slice(-24)));
  const ciphertext = new Uint8Array(hexToBytes(hex.slice(0, -24)));
  return JSON.parse(
    new TextDecoder().decode(gcm(configKey(), iv).decrypt(ciphertext))
  ) as UserConfig;
}

const encState = (conversationId: string) => ({
  conversationId,
  inboxId: 'inbox-1',
  state: '{}',
  timestamp: 1,
});

/** A config whose Space list this device can fully key, so a save publishes. */
const publishableConfig = (): UserConfig =>
  ({
    address: ADDRESS,
    allowSync: true,
    timestamp: 1000,
    spaceIds: ['space-1'],
    items: [{ type: 'space', id: 'space-1' }],
  }) as unknown as UserConfig;

beforeEach(() => {
  jest.clearAllMocks();
  memoryStores().forEach((s) => s.clear());
  (globalThis as Record<string, unknown>).__mmkvThrowOnRemove = false;
  (globalThis as Record<string, unknown>).__mmkvThrowOnSet = false;
  mockGetPrivateKey.mockResolvedValue(PRIVATE_KEY);
  mockGetPublicKey.mockResolvedValue(PUBLIC_KEY);
  mockPostUserSettings.mockResolvedValue({});
  mockGetUserSettings.mockResolvedValue(null);
  mockGetSpaceKeys.mockReturnValue([{ keyId: 'config' }]);
  mockGetAllSpaces.mockReturnValue([{ spaceId: 'space-1' }]);
  mockGetEncryptionStates.mockImplementation((id) => [encState(id)]);
  mockVerifyEd448.mockResolvedValue(true);
});

describe('saveConfig records what the publish actually did', () => {
  // CONTROL ARM. Without it, never writing a record at all passes every
  // "records the failure" test below while the instrument is dead.
  it('CONTROL ARM — an accepted publish records `published` with the payload size', async () => {
    await saveConfig(publishableConfig());

    expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
    const record = readRecord();
    expect(record?.outcome).toBe('published');
    expect(record?.payloadBytes).toBeGreaterThan(0);
    expect(record?.spacesPublished).toBe(1);
    expect(record?.at).toBeGreaterThan(0);
  });

  it('records `off` when the user has sync switched off', async () => {
    await saveConfig({ ...publishableConfig(), allowSync: false });

    expect(mockPostUserSettings).not.toHaveBeenCalled();
    expect(readRecord()?.outcome).toBe('off');
  });

  it('records `no-keys` when this device has no keypair to sign with', async () => {
    mockGetPrivateKey.mockResolvedValue(null);

    await saveConfig(publishableConfig());

    expect(mockPostUserSettings).not.toHaveBeenCalled();
    expect(readRecord()?.outcome).toBe('no-keys');
  });

  it('records `held`, with both counts, when the Space list would be narrowed', async () => {
    // Config wants three Spaces; local storage can only key one, so publishing
    // would hand every other device a shorter list.
    const config = {
      ...publishableConfig(),
      spaceIds: ['space-1', 'space-2', 'space-3'],
    } as UserConfig;

    await saveConfig(config);

    expect(mockPostUserSettings).not.toHaveBeenCalled();
    const record = readRecord();
    expect(record?.outcome).toBe('held');
    expect(record?.spacesPublished).toBe(1);
    expect(record?.spacesHeld).toBe(2);
  });

  it('records `rejected`, with the size and the server message, when the server refuses it', async () => {
    // The real evals-bloat rejection, which is the failure this instrument
    // exists to make visible.
    mockPostUserSettings.mockRejectedValue(new Error('400: invalid config missing data'));

    await saveConfig(publishableConfig());

    const record = readRecord();
    expect(record?.outcome).toBe('rejected');
    expect(record?.detail).toContain('invalid config missing data');
    // The size of a payload the server refused is the whole point of collecting
    // it: it is how the unknown server limit eventually gets settled.
    expect(record?.payloadBytes).toBeGreaterThan(0);
  });

  it('records `timeout` rather than `rejected` when the request never completed', async () => {
    mockPostUserSettings.mockRejectedValue(new Error('Network request timed out'));

    await saveConfig(publishableConfig());

    expect(readRecord()?.outcome).toBe('timeout');
  });

  it('keeps `published` when the POST succeeded and only the bookkeeping after it threw', async () => {
    // The server has accepted the upload. A throw from the local tidying that
    // follows must not be reported to the user as a failed sync.
    mockPostUserSettings.mockImplementation(async () => {
      (globalThis as Record<string, unknown>).__mmkvThrowOnRemove = true;
      return {};
    });

    await saveConfig(publishableConfig());

    expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
    expect(readRecord()?.outcome).toBe('published');
  });

  it('a recorder failure on the publish path still saves the edit', async () => {
    // Be precise about what this pins, because it is less than it looks.
    //
    // On THIS path the record write sits inside saveConfig's own try/catch, so
    // the edit survives a broken recorder whether or not recordLastPublish has
    // its own guard. MEASURED: removing that guard leaves this test green. So
    // it is not evidence for the recorder's internal catch — it pins the outer
    // behaviour, and would break if saveConfig's catch were ever narrowed.
    //
    // The test below is the one that pins the recorder's own guard.
    (globalThis as Record<string, unknown>).__mmkvThrowOnSet = true;

    await expect(saveConfig(publishableConfig())).resolves.toBeUndefined();

    expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
    // The edit still landed locally, which is the part that would actually hurt.
    expect(getLocalUserConfig(ADDRESS)?.spaceIds).toEqual(['space-1']);
  });

  it('a broken recorder never takes down a save it cannot be caught by', async () => {
    // THE one that earns its place. `off` and `no-keys` are recorded before
    // saveConfig's try block begins, and ahead of the unconditional local save,
    // so nothing but recordLastPublish's own catch stands between a full disk
    // and the user losing the edit entirely — "we failed to note something
    // down" silently becoming real data loss.
    //
    // MEASURED: making recordLastPublish rethrow turns this red while leaving
    // the publish-path test above green.
    (globalThis as Record<string, unknown>).__mmkvThrowOnSet = true;

    await expect(
      saveConfig({ ...publishableConfig(), allowSync: false })
    ).resolves.toBeUndefined();

    expect(getLocalUserConfig(ADDRESS)?.spaceIds).toEqual(['space-1']);
  });

  it('reads back null rather than throwing when the stored record is corrupt', async () => {
    // Exercises the REAL reader, which both test files otherwise bypass — one
    // reads the store directly, the other mocks the module. Without this the
    // parse guard has no coverage from any angle.
    memoryStores().get(RECORD_STORE)!.set(RECORD_KEY, '{ not json');
    expect(readLastPublish()).toBeNull();

    // Shape check, not just parseability: valid JSON of the wrong shape.
    memoryStores().get(RECORD_STORE)!.set(RECORD_KEY, JSON.stringify({ nope: true }));
    expect(readLastPublish()).toBeNull();

    memoryStores().get(RECORD_STORE)!.set(RECORD_KEY, JSON.stringify({ at: 'soon', outcome: 1 }));
    expect(readLastPublish()).toBeNull();

    // Control: a well-formed record still reads back, so the guard above is not
    // simply rejecting everything.
    await saveConfig(publishableConfig());
    expect(readLastPublish()?.outcome).toBe('published');
  });

  it('never lets the record into the synced blob', async () => {
    // In the blob it would broadcast a per-device fact to every other device,
    // rewrite the blob on every save, and grow the very payload it exists to
    // watch.
    await saveConfig(publishableConfig());

    const posted = decryptPostedConfig() as Record<string, unknown>;
    expect(posted.lastPublish).toBeUndefined();
    expect(posted.outcome).toBeUndefined();
    expect(posted.payloadBytes).toBeUndefined();

    const stored = getLocalUserConfig(ADDRESS) as unknown as Record<string, unknown>;
    expect(stored.lastPublish).toBeUndefined();
  });
});

describe('allowSync is device-local and never inherited from the blob', () => {
  const remoteSaying = (allowSync: boolean, timestamp = 5000) => ({
    user_config: encryptForServer({
      address: ADDRESS,
      allowSync,
      timestamp,
      spaceIds: [],
      items: [],
    } as unknown as UserConfig),
    timestamp,
    signature: SIGNATURE,
  });

  it('CONTROL ARM — a device that had sync ON still has it ON after a pull', async () => {
    // Without this arm, hardcoding `false` passes every other test in this
    // block while quietly disabling sync for every user.
    //
    // Local and remote deliberately DISAGREE (local on, remote off), matching
    // desktop's equivalent arm. An earlier version had both saying `true`, so
    // adopting the remote produced the same answer as preserving the local one
    // and the arm stayed green against a full revert of the fix — it caught the
    // hardcode but not the removal. Opposite values catch both.
    saveLocalUserConfig({
      ...publishableConfig(),
      allowSync: true,
      timestamp: 1000,
    } as UserConfig);
    mockGetUserSettings.mockResolvedValue(remoteSaying(false));

    const result = await getConfig(ADDRESS);

    // Proves the pull actually happened. Without this the arm passes vacuously
    // whenever the remote blob is rejected before the adopt site is reached,
    // which is a green that says nothing at all.
    expect(mockVerifyEd448).toHaveBeenCalled();
    expect(result.timestamp).toBe(5000);
    expect(result.allowSync).toBe(true);
    expect(getLocalUserConfig(ADDRESS)?.allowSync).toBe(true);
  });

  it('keeps sync OFF when a still-publishing device sends a blob that says ON', async () => {
    saveLocalUserConfig({
      ...publishableConfig(),
      allowSync: false,
      timestamp: 1000,
    } as UserConfig);
    mockGetUserSettings.mockResolvedValue(remoteSaying(true));

    const result = await getConfig(ADDRESS);

    // The rest of the blob is still adopted — off means "do not publish", it has
    // never meant "do not pull".
    expect(result.timestamp).toBe(5000);
    expect(result.allowSync).toBe(false);
    expect(getLocalUserConfig(ADDRESS)?.allowSync).toBe(false);
  });

  it('starts OFF on a device with no stored config, whatever the blob says', async () => {
    // Losing local storage used to restore the account's old blob with sync
    // switched back on, because the remote always wins against `?? 0`.
    mockGetUserSettings.mockResolvedValue(remoteSaying(true));

    const result = await getConfig(ADDRESS);

    expect(result.allowSync).toBe(false);
    expect(getLocalUserConfig(ADDRESS)?.allowSync).toBe(false);
  });

  it('re-reads the local value at the adopt site, so a toggle mid-pull is not overwritten', async () => {
    // Signature verification awaits the native module, which yields the event
    // loop, so a settings toggle can land in that window. The file already
    // applies this reasoning to conversationSettings.
    saveLocalUserConfig({
      ...publishableConfig(),
      allowSync: true,
      timestamp: 1000,
    } as UserConfig);
    mockGetUserSettings.mockResolvedValue(remoteSaying(true));
    mockVerifyEd448.mockImplementation(async () => {
      saveLocalUserConfig({
        ...(getLocalUserConfig(ADDRESS) as UserConfig),
        allowSync: false,
      });
      return true;
    });

    const result = await getConfig(ADDRESS);

    expect(result.allowSync).toBe(false);
    expect(getLocalUserConfig(ADDRESS)?.allowSync).toBe(false);
  });
});
