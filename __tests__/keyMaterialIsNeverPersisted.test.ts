/**
 * Key material never reaches the persisted query cache.
 *
 * The React Query cache is persisted to a plain, unencrypted MMKV file. Private
 * keys and mnemonics belong in SecureStore and are read there at the moment of
 * signing. This file pins every layer of that rule:
 *
 *   1. writes:   `shouldPersistQuery` / `shouldPersistMutation` refuse secret
 *                query families, opted-out entries, and paused mutations whose
 *                variables carry a key
 *   2. restores: `stripNeverPersisted` + `deserializePersistedClient` drop the same
 *                entries from a cache read back from disk, rewrite the file, and
 *                scrub it, so the rule holds whatever wrote the file
 *   3. sources:  the wallet-key and Warpcast-wallet readers never put a key into a
 *                query in the first place
 *
 * Every refusal has a CONTROL arm. A predicate narrowed to "persist nothing"
 * would satisfy all the refusals while silently killing offline support.
 *
 * Persistence is an allow-list (`PERSISTED_QUERY_ROOTS`), so a secret family is
 * refused twice over: it isn't allow-listed, and the secret rule refuses it
 * anyway. The guards below fail if a secret family is ever allow-listed, so
 * the secret rule never becomes the only line without a test noticing.
 */
import { QueryClient, type Mutation, type Query } from '@tanstack/react-query';
import type { PersistedClient } from '@tanstack/react-query-persist-client';

import {
  PERSISTED_QUERY_ROOTS,
  SECRET_QUERY_KEY_PREFIXES,
  isSecretQueryKey,
  shouldPersistMutation,
  shouldPersistQuery,
  stripNeverPersisted,
} from '@/services/offline/shouldPersistQuery';

const PRIVATE_KEY = '0x' + 'ab'.repeat(32);
const MNEMONIC = 'abandon '.repeat(11) + 'about';

/**
 * `gcTime: Infinity` schedules no garbage-collection timer. The default (5 min)
 * leaves one per fixture, and run on its own this file then never exits.
 */
const fixtureClient = () =>
  new QueryClient({ defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } } });

/** A real, successful `Query`, built through a `QueryClient` (see claimRecordsAreNeverPersisted). */
function successfulQuery(queryKey: readonly unknown[], data: unknown, meta?: Record<string, unknown>): Query {
  const client = fixtureClient();
  const query = client.getQueryCache().build(client, { queryKey, meta, gcTime: Infinity });
  query.setData(data);
  expect(query.state.status).toBe('success');
  return query as Query;
}

/** A real `Mutation` in the paused state React Query persists. */
function pausedMutation(variables: unknown, meta?: Record<string, unknown>): Mutation {
  const client = fixtureClient();
  return client.getMutationCache().build(
    client,
    { mutationFn: async () => undefined, meta, gcTime: Infinity },
    {
      context: undefined,
      data: undefined,
      error: null,
      failureCount: 0,
      failureReason: null,
      isPaused: true,
      status: 'pending',
      variables,
      submittedAt: Date.now(),
    },
  ) as unknown as Mutation;
}

describe('writes: secret query families are never persisted', () => {
  it.each([
    [['wallet', 'keys', 'v7']],
    [['wallet', 'keys']],
    [['warpcastWallet', 'imported']],
    [['warpcastWallet', 'recoveryKey']],
  ])('refuses %j', (queryKey) => {
    expect(isSecretQueryKey(queryKey)).toBe(true);
    expect(shouldPersistQuery(successfulQuery(queryKey, { ethereum: { privateKey: PRIVATE_KEY } }))).toBe(false);
  });

  it('refuses any query that opts out with meta.neverPersist', () => {
    expect(shouldPersistQuery(successfulQuery(['anything'], { ok: true }, { neverPersist: true }))).toBe(false);
  });

  it.each([
    [['wallet', 'addresses', 'v7']],
    [['wallet', 'balances', '0xabc']],
    [['walletSelection', 'active']],
    [['spaces']],
  ])('is not a secret family: %j', (queryKey) => {
    expect(isSecretQueryKey(queryKey)).toBe(false);
  });

  it.each([
    [['user-public-profile', '0xabc']],
    [['hypersnap-notifications', 42]],
  ])('CONTROL: still persists the allow-listed %j', (queryKey) => {
    expect(isSecretQueryKey(queryKey)).toBe(false);
    expect(shouldPersistQuery(successfulQuery(queryKey, { ok: true }))).toBe(true);
  });

  it('persists nothing outside the allow-list', () => {
    expect(shouldPersistQuery(successfulQuery(['spaces'], [{ id: 's1' }]))).toBe(false);
    expect(shouldPersistQuery(successfulQuery(['messages', 's1', 'c1'], { pages: [] }))).toBe(false);
  });

  it('GUARD: no secret family is allow-listed', () => {
    for (const root of PERSISTED_QUERY_ROOTS) {
      expect(SECRET_QUERY_KEY_PREFIXES.some((prefix) => prefix[0] === root)).toBe(false);
    }
  });

  it('matches by prefix, not by substring', () => {
    // ['wallet'] alone and a key that merely CONTAINS 'keys' later are not secret.
    expect(isSecretQueryKey(['wallet'])).toBe(false);
    expect(isSecretQueryKey(['spaces', 'wallet', 'keys'])).toBe(false);
  });
});

describe('writes: paused mutations carrying a key are never persisted', () => {
  it.each([
    ['privateKey', { address: '0x1', privateKey: PRIVATE_KEY }],
    ['mnemonic', { address: '0x1', mnemonic: MNEMONIC }],
  ])('refuses one whose variables carry %s', (_field, variables) => {
    expect(shouldPersistMutation(pausedMutation(variables))).toBe(false);
  });

  it('refuses one that opts out with meta.neverPersist', () => {
    expect(shouldPersistMutation(pausedMutation({ text: 'hi' }, { neverPersist: true }))).toBe(false);
  });

  it('persists no paused mutation at all: one restored from disk has no mutationFn and cannot run', () => {
    expect(shouldPersistMutation(pausedMutation({ text: 'hello', conversationId: 'c1' }))).toBe(false);
  });
});

describe('restores: a cache read back from disk is cleaned before hydration', () => {
  const persisted = (): PersistedClient => ({
    timestamp: Date.now(),
    buster: '',
    clientState: {
      queries: [
        {
          queryKey: ['wallet', 'keys', 'v7'],
          queryHash: '["wallet","keys","v7"]',
          state: { data: { ethereum: { privateKey: PRIVATE_KEY } } } as never,
        },
        {
          queryKey: ['warpcastWallet', 'imported'],
          queryHash: '["warpcastWallet","imported"]',
          state: { data: { address: '0x1', privateKey: PRIVATE_KEY, mnemonic: MNEMONIC } } as never,
        },
        { queryKey: ['spaces'], queryHash: '["spaces"]', state: { data: [{ id: 's1' }] } as never },
        {
          queryKey: ['user-public-profile', '0x1'],
          queryHash: '["user-public-profile","0x1"]',
          state: { data: { display_name: 'Alice' } } as never,
        },
      ],
      mutations: [
        { state: { isPaused: true, variables: { address: '0x1', privateKey: PRIVATE_KEY, mnemonic: MNEMONIC } } as never },
        { state: { isPaused: true, variables: { text: 'queued while offline' } } as never },
      ],
    },
  });

  it('drops every secret entry, everything outside the allow-list, and every mutation', () => {
    const { client, removed } = stripNeverPersisted(persisted());

    expect(removed).toBe(5);
    expect(client.clientState.queries.map((q) => q.queryKey)).toEqual([['user-public-profile', '0x1']]);
    expect(client.clientState.mutations).toHaveLength(0);
    const serialised = JSON.stringify(client);
    expect(serialised).not.toContain(PRIVATE_KEY);
    expect(serialised).not.toContain(MNEMONIC);
  });

  it('CONTROL: a clean cache comes back untouched, the same object', () => {
    const clean = persisted();
    clean.clientState.queries = clean.clientState.queries.filter((q) => q.queryKey[0] === 'user-public-profile');
    clean.clientState.mutations = [];

    const { client, removed } = stripNeverPersisted(clean);
    expect(removed).toBe(0);
    expect(client).toBe(clean);
  });

  describe('deserializePersistedClient', () => {
    const replaceAndScrub = jest.fn();
    let deserializePersistedClient: (raw: string) => PersistedClient;
    let QUERY_CACHE_STORAGE_KEY: string;

    beforeAll(() => {
      jest.isolateModules(() => {
        jest.doMock('@/services/offline/storage', () => ({
          queryCacheStore: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn(), replaceAndScrub },
          removeAndScrubFile: jest.fn(),
          sharedCacheHas: jest.fn(() => false),
        }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules needs a fresh require
        ({ deserializePersistedClient, QUERY_CACHE_STORAGE_KEY } = require('@/services/offline/queryPersister'));
      });
    });
    beforeEach(() => replaceAndScrub.mockClear());
    // `doMock` registrations outlive `isolateModules`; later blocks need the real module.
    afterAll(() => jest.dontMock('@/services/offline/storage'));

    it('hydrates without the secrets, and rewrites and scrubs the file at once', () => {
      const restored = deserializePersistedClient(JSON.stringify(persisted()));

      expect(JSON.stringify(restored)).not.toContain(PRIVATE_KEY);
      expect(replaceAndScrub).toHaveBeenCalledTimes(1);
      const [key, written] = replaceAndScrub.mock.calls[0];
      expect(key).toBe(QUERY_CACHE_STORAGE_KEY);
      expect(written).not.toContain(PRIVATE_KEY);
      expect(written).not.toContain(MNEMONIC);
      expect(JSON.parse(written)).toEqual(restored);
    });

    it('CONTROL: a clean cache restores without touching the file', () => {
      const clean = persisted();
      clean.clientState.queries = clean.clientState.queries.slice(3);
      clean.clientState.mutations = [];

      expect(deserializePersistedClient(JSON.stringify(clean))).toEqual(clean);
      expect(replaceAndScrub).not.toHaveBeenCalled();
    });
  });
});

describe('restores: replaceAndScrubFile leaves no copy of the old value', () => {
  it('writes the new value, overwrites the compacted tail with filler, then removes the filler', () => {
    const calls: string[] = [];
    const store = new Map<string, string>();
    jest.isolateModules(() => {
      jest.doMock('react-native-mmkv', () => ({
        createMMKV: () => ({
          set: (k: string, v: string) => {
            calls.push(`set ${k} ${v.length}`);
            store.set(k, v);
          },
          getString: (k: string) => store.get(k),
          remove: (k: string) => {
            calls.push(`remove ${k}`);
            store.delete(k);
          },
          trim: () => calls.push('trim'),
          clearAll: () => store.clear(),
          get size() {
            let n = 0;
            for (const [k, v] of store) n += k.length + v.length;
            return n;
          },
        }),
      }));
      // storage.ts's other imports reach the native crypto module, absent under jest.
      jest.doMock('@/services/config', () => ({ clearConfigStorage: jest.fn() }));
      jest.doMock('@/services/crypto/encryption-state-storage', () => ({
        encryptionStateStorage: { clearAll: jest.fn() },
      }));
      const { replaceAndScrubFile } = jest.requireActual('@/services/offline/storage');
      store.set('spaces', 'x'.repeat(1000));
      replaceAndScrubFile('REACT_QUERY_OFFLINE_CACHE', '{"clean":true}');
    });

    expect(calls[0]).toBe('set REACT_QUERY_OFFLINE_CACHE 14');
    expect(calls[1]).toBe('trim');
    // The filler is longer than all live data, so it covers the whole tail
    // (after a trim the file is at most twice the live data).
    const [, fillerKey, fillerLength] = calls[2].split(' ');
    expect(Number(fillerLength)).toBeGreaterThan(1000 + 'REACT_QUERY_OFFLINE_CACHE'.length + 14);
    expect(calls.slice(3)).toEqual([`remove ${fillerKey}`, 'trim']);
    expect(store.has(fillerKey)).toBe(false);
    expect(store.get('REACT_QUERY_OFFLINE_CACHE')).toBe('{"clean":true}');
    expect(store.get('spaces')).toBe('x'.repeat(1000));
    jest.dontMock('react-native-mmkv');
    jest.dontMock('@/services/config');
    jest.dontMock('@/services/crypto/encryption-state-storage');
  });
});

describe('sources: keys are never placed in a query', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('@/services/onboarding/secureStorage');
    jest.dontMock('@/services/wallet/multiChainWallet');
    jest.dontMock('expo-secure-store');
  });

  function loadWalletKeyCache(publicKey: { current: string | null }) {
    const derive = jest.fn(async (mnemonic: string[]) => ({ ethereum: { privateKey: PRIVATE_KEY, from: mnemonic.join(' ') } }));
    let mod: typeof import('@/services/wallet/walletKeyCache') | undefined;
    jest.isolateModules(() => {
      jest.doMock('@/services/onboarding/secureStorage', () => ({
        getMnemonic: jest.fn(async () => MNEMONIC.split(' ')),
        getPrivateKey: jest.fn(async () => null),
        getPublicKey: jest.fn(async () => publicKey.current),
      }));
      jest.doMock('@/services/wallet/multiChainWallet', () => ({
        deriveMultiChainKeysAsync: derive,
        deriveMultiChainKeysFromPrivateKeyAsync: jest.fn(),
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules needs a fresh require
      mod = require('@/services/wallet/walletKeyCache');
    });
    return { mod: mod!, derive };
  }

  it('wallet keys: reused for the same identity, re-derived for a different one', async () => {
    const identity = { current: 'identity-A' as string | null };
    const { mod, derive } = loadWalletKeyCache(identity);

    await mod.getWalletKeys();
    await mod.getWalletKeys();
    expect(derive).toHaveBeenCalledTimes(1);

    // Reset App Data, re-onboard as someone else: never hand back A's keys.
    identity.current = 'identity-B';
    await mod.getWalletKeys();
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it('wallet keys: dropped after the TTL and on clearWalletKeysCache()', async () => {
    const identity = { current: 'identity-A' as string | null };
    const { mod, derive } = loadWalletKeyCache(identity);
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      await mod.getWalletKeys();
      now.mockReturnValue(1_000_000 + mod.WALLET_KEYS_TTL_MS + 1);
      await mod.getWalletKeys();
      expect(derive).toHaveBeenCalledTimes(2);

      mod.clearWalletKeysCache();
      await mod.getWalletKeys();
      expect(derive).toHaveBeenCalledTimes(3);
    } finally {
      now.mockRestore();
    }
  });

  it('wallet keys: concurrent callers share one derivation', async () => {
    const { mod, derive } = loadWalletKeyCache({ current: 'identity-A' });
    await Promise.all([mod.getWalletKeys(), mod.getWalletKeys(), mod.getWalletKeys()]);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it('Warpcast wallet: the imported record carries the address, never the key or mnemonic', async () => {
    const secure: Record<string, string> = {};
    let mod: typeof import('@/services/onboarding/secureStorage') | undefined;
    jest.isolateModules(() => {
      jest.doMock('expo-secure-store', () => ({
        WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
        setItemAsync: jest.fn(async (k: string, v: string) => {
          secure[k] = v;
        }),
        getItemAsync: jest.fn(async (k: string) => secure[k] ?? null),
        deleteItemAsync: jest.fn(async (k: string) => {
          delete secure[k];
        }),
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules needs a fresh require
      mod = require('@/services/onboarding/secureStorage');
    });
    await mod!.storeWarpcastWallet({ address: '0xwarp', privateKey: PRIVATE_KEY, mnemonic: MNEMONIC, importedAt: '2026-10-13' });

    const imported = await mod!.getImportedWarpcastWallet();
    expect(imported).toEqual({ address: '0xwarp', importedAt: '2026-10-13' });
    expect(JSON.stringify(imported)).not.toContain(PRIVATE_KEY);
    expect(JSON.stringify(imported)).not.toContain(MNEMONIC);

    // ...and the key is still there to sign with, read on demand.
    expect(await mod!.getWarpcastWalletPrivateKey()).toBe(PRIVATE_KEY);
  });
});
