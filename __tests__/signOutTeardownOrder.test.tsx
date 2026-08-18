/**
 * `signOut()` must delete the keys BEFORE it wipes local data.
 *
 * This order is load-bearing and looks backwards, so it is exactly the kind
 * of thing a later refactor "tidies up". Nothing marks the session
 * unauthenticated until the teardown finishes, so the socket keeps
 * delivering messages throughout it. While the Ed448 identity is still
 * readable, such a write re-derives the SQLCipher key and re-creates the
 * messages database — so wiping local data first means the write simply
 * restores what was just deleted, encrypted under an identity that is about
 * to vanish. The next cold start then cannot open it, and the "refuse to
 * wipe canonical history" guard makes that permanent.
 *
 * Deleting the keys first removes the ability to derive a key at all, and
 * the local wipe running last clears anything that landed in the window.
 *
 * See __tests__/resetAppDataCipherKey.test.ts for the storage-layer half.
 */

import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';

const mockClearAllSecureStorage = jest.fn(async () => {});
const mockClearAllMMKVStorage = jest.fn(() => {});

jest.mock('../services/offline/storage', () => ({
  clearAllMMKVStorage: (...args: unknown[]) => mockClearAllMMKVStorage(...(args as [])),
  mmkvStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

jest.mock('../services/onboarding/secureStorage', () => ({
  clearAllSecureStorage: (...args: unknown[]) => mockClearAllSecureStorage(...(args as [])),
  getPrivateKey: async () => null,
  getMnemonic: async () => null,
  getDeviceKeyset: async () => null,
  getFarcasterAuthToken: async () => null,
  getFarcasterAuthTokenExpiresAt: async () => null,
  getFarcasterCustodyKey: async () => null,
  storeFarcasterAuthToken: async () => {},
  storeFarcasterAuthTokenExpiresAt: async () => {},
  storeFarcasterCustodyKey: async () => {},
  storeFarcasterSignerKey: async () => {},
  storeFarcasterFid: async () => {},
}));

jest.mock('../services/onboarding/farcasterService', () => ({
  deriveFarcasterKeys: async () => null,
  lookupFarcasterAccount: async () => null,
  validateFarcasterMnemonic: () => false,
  refreshFarcasterAuthToken: async () => null,
  fetchFarcasterProfileByFid: async () => null,
}));

jest.mock('../services/farcaster/authTokenEvents', () => ({
  registerFarcasterAuthFailureHandler: () => () => {},
}));

jest.mock('../services/onboarding/keyService', () => ({
  initializeEncryptionKeys: async () => {},
  uploadUserRegistration: async () => {},
  deriveQuilibriumAddressWithMnemonic: async () => null,
  ensurePrivateKey: async () => null,
}));

jest.mock('../services/crypto', () => ({ NativeSigningProvider: class {} }));
jest.mock('../services/config', () => ({
  getConfig: async () => ({}),
  saveConfig: async () => {},
}));
jest.mock('../utils/primaryName', () => ({ mergeSyncedPrimaryName: (x: unknown) => x }));
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ clear: () => {} }) }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AuthProvider, useAuth } = require('../context/AuthContext');

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
);

async function mountAuth() {
  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(result.current).toBeTruthy());
  return result;
}

beforeEach(() => {
  mockClearAllSecureStorage.mockReset().mockImplementation(async () => {});
  mockClearAllMMKVStorage.mockReset().mockImplementation(() => {});
});

describe('signOut teardown order', () => {
  it('deletes the identity before wiping local data', async () => {
    const result = await mountAuth();

    await act(async () => {
      await result.current.signOut();
    });

    expect(mockClearAllSecureStorage).toHaveBeenCalledTimes(1);
    expect(mockClearAllMMKVStorage).toHaveBeenCalledTimes(1);
    expect(mockClearAllSecureStorage.mock.invocationCallOrder[0]).toBeLessThan(
      mockClearAllMMKVStorage.mock.invocationCallOrder[0]
    );
  });

  it('still wipes local data when the key deletion fails', async () => {
    // The half-wiped state is the bricking one: keys possibly gone, database
    // still on disk encrypted under them. The local wipe is what prevents it,
    // so it must not be skipped just because the first half threw.
    const boom = new Error('keystore unavailable');
    mockClearAllSecureStorage.mockRejectedValueOnce(boom);
    const result = await mountAuth();

    await act(async () => {
      await expect(result.current.signOut()).rejects.toThrow('keystore unavailable');
    });

    expect(mockClearAllMMKVStorage).toHaveBeenCalledTimes(1);
  });

  it('reports the key-deletion failure even when the local wipe also fails', async () => {
    // Both halves failing is rare, but a plain try/finally would surface only
    // the second error — and losing the first means losing the report that
    // the user's keys may still be on the device.
    mockClearAllSecureStorage.mockRejectedValueOnce(new Error('keystore unavailable'));
    mockClearAllMMKVStorage.mockImplementationOnce(() => {
      throw new Error('mmkv unavailable');
    });
    const result = await mountAuth();

    await act(async () => {
      await expect(result.current.signOut()).rejects.toThrow('keystore unavailable');
    });
  });
});
