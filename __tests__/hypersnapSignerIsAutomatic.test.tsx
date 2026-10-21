/**
 * The Hypersnap signer is provisioned for every Farcaster account, silently.
 *
 * There is no opt-in: no prompt, no setting, no stored choice. These tests pin
 * that down at three levels:
 *
 *   1. `ensureHypersnapSigner` provisions, keeps, replaces and renews the signer
 *      for the signed-in FID, and never throws.
 *   2. `useHypersnapSignerLifecycle` runs it on sign-in, on foreground and on a
 *      backoff after a failure, for the whole signed-in app.
 *   3. The opt-in surfaces are gone, and Reset App Data deletes the signer.
 */

import * as fs from 'fs';
import * as path from 'path';
import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';
// Imported once, not per test: a module-registry reset would hand the hook a
// different React instance from the renderer's.
import { useHypersnapSignerLifecycle } from '@/hooks/useHypersnapSignerLifecycle';

// --- keychain -----------------------------------------------------------------

jest.mock('expo-secure-store', () => {
  const g = globalThis as any;
  g.__keychain ??= new Map<string, string>();
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
    getItemAsync: async (k: string) => {
      if (g.__keychainLocked) throw new Error('locked');
      return g.__keychain.get(k) ?? null;
    },
    setItemAsync: async (k: string, v: string) => void g.__keychain.set(k, v),
    deleteItemAsync: async (k: string) => void g.__keychain.delete(k),
  };
});

jest.mock('@/services/offline/storage', () => {
  const g = globalThis as any;
  g.__mmkv ??= new Map<string, string>();
  return {
    mmkvStorage: {
      getItem: (k: string) => g.__mmkv.get(k) ?? null,
      setItem: (k: string, v: string) => void g.__mmkv.set(k, v),
      removeItem: (k: string) => void g.__mmkv.delete(k),
    },
  };
});

// Reset App Data drops messagesDb's memoized cipher key; not under test here.
jest.mock('@/services/storage/messagesDb', () => ({ clearCipherKeyCache: () => {} }));

// --- hub ----------------------------------------------------------------------

const mockProvisionSigner = jest.fn();
const mockRenewIfNearExpiry = jest.fn();
const mockListSigners = jest.fn();

jest.mock('@quilibrium/quorum-shared', () => ({
  logger: { log: () => {}, warn: () => {}, error: () => {} },
  getDefaultHypersnapClient: () => ({ listSnapchainSignersByFid: mockListSigners }),
  provisionSigner: (...args: unknown[]) => mockProvisionSigner(...args),
  renewIfNearExpiry: (...args: unknown[]) => mockRenewIfNearExpiry(...args),
}));

type Provision = typeof import('@/services/farcaster/hypersnapProvision');

const SIGNER_KEY = 'hypersnap.signerRecord.v1';
const CUSTODY_KEY = 'farcaster.custodyKey';
const CUSTODY_HEX = '11'.repeat(32);

const keychain = () => (globalThis as any).__keychain as Map<string, string>;

function record(fid: number, pub: string) {
  return {
    fid,
    publicKeyHex: pub,
    privateKeyHex: 'ab'.repeat(32),
    custodyAddress: '0x' + 'cd'.repeat(20),
    ttlSeconds: 90 * 24 * 60 * 60,
    lastRenewedAt: Math.floor(Date.now() / 1000),
  };
}

function storedSigner() {
  const raw = keychain().get(SIGNER_KEY);
  return raw ? JSON.parse(raw) : null;
}

let provisioned = 0;

/** Fresh module registry: a cold start, so per-session state resets. */
function load(): Provision {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/services/farcaster/hypersnapProvision') as Provision;
}

beforeEach(() => {
  (globalThis as any).__keychain = new Map();
  (globalThis as any).__mmkv = new Map();
  provisioned = 0;
  mockProvisionSigner.mockReset().mockImplementation(async ({ fid }: { fid: number }) => {
    provisioned += 1;
    return { record: record(fid, `${'0'.repeat(62)}${provisioned.toString().padStart(2, '0')}`) };
  });
  mockRenewIfNearExpiry.mockReset().mockResolvedValue(null);
  mockListSigners.mockReset().mockResolvedValue([]);
});

describe('ensureHypersnapSigner', () => {
  it('provisions a signer when the device has none, with no choice stored anywhere', async () => {
    keychain().set(CUSTODY_KEY, CUSTODY_HEX);
    const { ensureHypersnapSigner } = load();

    const result = await ensureHypersnapSigner(42);

    expect(result.status).toBe('ready');
    expect(mockProvisionSigner).toHaveBeenCalledTimes(1);
    expect(mockProvisionSigner.mock.calls[0][0]).toMatchObject({ fid: 42 });
    expect(storedSigner()).toMatchObject({ fid: 42 });
    // The old opt-in keys are neither read nor written.
    expect((globalThis as any).__mmkv.has('hypersnap.optInChoice')).toBe(false);
    expect((globalThis as any).__mmkv.has('hypersnap.optInPromptShown')).toBe(false);
  });

  it('provisions even for a user who opted out under the old toggle', async () => {
    keychain().set(CUSTODY_KEY, CUSTODY_HEX);
    (globalThis as any).__mmkv.set('hypersnap.optInChoice', 'opted-out');
    (globalThis as any).__mmkv.set('hypersnap.optInPromptShown', '1');
    const { ensureHypersnapSigner } = load();

    expect((await ensureHypersnapSigner(42)).status).toBe('ready');
    expect(mockProvisionSigner).toHaveBeenCalledTimes(1);
  });

  it('reports no-custody-key, without provisioning, when the device has no custody key', async () => {
    const { ensureHypersnapSigner } = load();

    expect(await ensureHypersnapSigner(42)).toEqual({ status: 'no-custody-key' });
    expect(mockProvisionSigner).not.toHaveBeenCalled();
  });

  it('replaces a signer that belongs to a previously connected account', async () => {
    keychain().set(CUSTODY_KEY, CUSTODY_HEX);
    keychain().set(SIGNER_KEY, JSON.stringify(record(7, 'aa'.repeat(32))));
    const { ensureHypersnapSigner } = load();

    const result = await ensureHypersnapSigner(42);

    expect(result.status).toBe('ready');
    expect(mockProvisionSigner).toHaveBeenCalledTimes(1);
    expect(storedSigner()).toMatchObject({ fid: 42 });
  });

  it('keeps a stored signer the hub confirms, checks it once per session, and renews it', async () => {
    keychain().set(CUSTODY_KEY, CUSTODY_HEX);
    const pub = 'bb'.repeat(32);
    keychain().set(SIGNER_KEY, JSON.stringify(record(42, pub)));
    mockListSigners.mockResolvedValue([pub]);
    const { ensureHypersnapSigner } = load();

    expect((await ensureHypersnapSigner(42)).status).toBe('ready');
    expect((await ensureHypersnapSigner(42)).status).toBe('ready');

    expect(mockProvisionSigner).not.toHaveBeenCalled();
    expect(mockListSigners).toHaveBeenCalledTimes(1);
    expect(mockRenewIfNearExpiry).toHaveBeenCalledTimes(2);
  });

  it('keeps a stored signer when the hub cannot be asked, and asks again next time', async () => {
    keychain().set(CUSTODY_KEY, CUSTODY_HEX);
    keychain().set(SIGNER_KEY, JSON.stringify(record(42, 'bb'.repeat(32))));
    mockListSigners.mockRejectedValue(new Error('hub down'));
    const { ensureHypersnapSigner } = load();

    expect((await ensureHypersnapSigner(42)).status).toBe('ready');
    expect((await ensureHypersnapSigner(42)).status).toBe('ready');

    expect(mockProvisionSigner).not.toHaveBeenCalled();
    expect(mockListSigners).toHaveBeenCalledTimes(2);
  });

  it('replaces a stored signer the hub does not have, and drops it even if replacing fails', async () => {
    keychain().set(CUSTODY_KEY, CUSTODY_HEX);
    keychain().set(SIGNER_KEY, JSON.stringify(record(42, 'bb'.repeat(32))));
    mockListSigners.mockResolvedValue(['cc'.repeat(32)]);
    mockProvisionSigner.mockRejectedValueOnce(new Error('rate limited'));
    const { ensureHypersnapSigner } = load();

    const failed = await ensureHypersnapSigner(42);
    expect(failed).toEqual({ status: 'failed', error: 'rate limited' });
    expect(storedSigner()).toBeNull();

    const retried = await ensureHypersnapSigner(42);
    expect(retried.status).toBe('ready');
    expect(storedSigner()).toMatchObject({ fid: 42 });
  });

  it('shares one provisioning run between concurrent callers', async () => {
    keychain().set(CUSTODY_KEY, CUSTODY_HEX);
    const { ensureHypersnapSigner } = load();

    const [a, b, c] = await Promise.all([
      ensureHypersnapSigner(42),
      ensureHypersnapSigner(42),
      ensureHypersnapSigner(42),
    ]);

    expect(mockProvisionSigner).toHaveBeenCalledTimes(1);
    expect([a.status, b.status, c.status]).toEqual(['ready', 'ready', 'ready']);
  });

  it('never throws, even when the keychain does', async () => {
    const { ensureHypersnapSigner } = load();
    (globalThis as any).__keychainLocked = true;
    try {
      await expect(ensureHypersnapSigner(42)).resolves.toEqual({ status: 'failed', error: 'locked' });
    } finally {
      (globalThis as any).__keychainLocked = false;
    }
  });
});

describe('getHypersnapSignerFor (the write path)', () => {
  it('returns the stored signer without touching the hub', async () => {
    keychain().set(SIGNER_KEY, JSON.stringify(record(42, 'bb'.repeat(32))));
    const { getHypersnapSignerFor } = load();

    expect(await getHypersnapSignerFor(42)).toMatchObject({ fid: 42 });
    expect(mockListSigners).not.toHaveBeenCalled();
    expect(mockProvisionSigner).not.toHaveBeenCalled();
  });

  it('provisions one on demand when a write finds none', async () => {
    keychain().set(CUSTODY_KEY, CUSTODY_HEX);
    const { getHypersnapSignerFor } = load();

    expect(await getHypersnapSignerFor(42)).toMatchObject({ fid: 42 });
    expect(mockProvisionSigner).toHaveBeenCalledTimes(1);
  });

  it('returns null when no signer can be had', async () => {
    const { getHypersnapSignerFor } = load();
    expect(await getHypersnapSignerFor(42)).toBeNull();
  });
});

describe('useHypersnapSignerLifecycle', () => {
  let appStateListener: ((s: string) => void) | null = null;
  beforeEach(() => {
    appStateListener = null;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, fn: (s: string) => void) => {
      appStateListener = fn;
      return { remove: () => { appStateListener = null; } };
    }) as unknown as typeof AppState.addEventListener);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does nothing without a Farcaster account', async () => {
    renderHook(() => useHypersnapSignerLifecycle(undefined));
    await act(async () => {});
    expect(mockProvisionSigner).not.toHaveBeenCalled();
  });

  it('provisions as soon as a FID is known, with no prompt', async () => {
    keychain().set(CUSTODY_KEY, CUSTODY_HEX);

    renderHook(() => useHypersnapSignerLifecycle(42));
    await act(async () => {});

    expect(mockProvisionSigner).toHaveBeenCalledTimes(1);
    expect(storedSigner()).toMatchObject({ fid: 42 });
  });

  it('retries a failed provision on a backoff, and on return to the foreground', async () => {
    jest.useFakeTimers();
    keychain().set(CUSTODY_KEY, CUSTODY_HEX);
    mockProvisionSigner.mockRejectedValueOnce(new Error('hub down')).mockRejectedValueOnce(new Error('hub down'));

    const { unmount } = renderHook(() => useHypersnapSignerLifecycle(42));
    await act(async () => {});
    expect(mockProvisionSigner).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(mockProvisionSigner).toHaveBeenCalledTimes(2);

    // Second failure backs off further; coming back to the app retries now.
    await act(async () => {
      appStateListener?.('active');
    });
    expect(mockProvisionSigner).toHaveBeenCalledTimes(3);
    expect(storedSigner()).toMatchObject({ fid: 42 });

    unmount();
    expect(appStateListener).toBeNull();
  });

  it('provisions for the new account when the FID changes', async () => {
    keychain().set(CUSTODY_KEY, CUSTODY_HEX);

    const { rerender } = renderHook(({ fid }: { fid: number }) => useHypersnapSignerLifecycle(fid), {
      initialProps: { fid: 7 },
    });
    await act(async () => {});
    expect(storedSigner()).toMatchObject({ fid: 7 });

    rerender({ fid: 42 });
    await act(async () => {});
    expect(storedSigner()).toMatchObject({ fid: 42 });
  });
});

describe('no opt-in remains, and Reset App Data deletes the signer', () => {
  const root = path.resolve(__dirname, '..');
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

  it('has no opt-in store, prompt or settings toggle', () => {
    expect(fs.existsSync(path.join(root, 'services/farcaster/hypersnapOptIn.ts'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'components/HypersnapSignerPromptModal.tsx'))).toBe(false);
    // "Hypersnap" is now the account's name throughout the UI, so check for the
    // toggle itself: its label, state and handler.
    const profileModal = read('components/ProfileModal.tsx');
    expect(profileModal).not.toMatch(/Hypersnap Signer/);
    expect(profileModal).not.toMatch(/hypersnapEnabled|handleToggleHypersnap|HypersnapOptIn/);
    expect(read('app/(tabs)/feed/index.tsx')).not.toMatch(/HypersnapSignerPrompt/);
  });

  it('keeps the signer for the whole signed-in app, not one screen', () => {
    expect(read('app/(tabs)/_layout.tsx')).toMatch(/useHypersnapSignerLifecycle\(/);
  });

  it('deletes the signer record on Reset App Data', async () => {
    keychain().set(SIGNER_KEY, JSON.stringify(record(42, 'bb'.repeat(32))));
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { clearAllSecureStorage } = require('@/services/onboarding/secureStorage');

    await clearAllSecureStorage();

    expect(keychain().has(SIGNER_KEY)).toBe(false);
  });
});
