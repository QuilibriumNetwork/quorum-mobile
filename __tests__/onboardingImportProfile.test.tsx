/**
 * Restoring an account on a NEW device must bring back the display name and the
 * profile picture.
 *
 * This is the flow a user notices within seconds of signing in on a new phone,
 * and it is the one that `allowSync` becoming device-local put at risk. The
 * import path used to read:
 *
 *     if (config.allowSync && (config.name || config.profile_image || ...))
 *
 * On a fresh install there is no stored config, so the device-local rule makes
 * `allowSync` false by definition — and that gate could therefore never pass on
 * the single path it exists for. The gate is gone; these tests are what stop it
 * coming back.
 *
 * The companion check lives in `dev/harness/config-sync-two-device.scenario.ts`,
 * which proves the same two fields survive a real encrypt → POST → GET → decrypt
 * round trip against the live relay. This file covers the layer above it: that
 * onboarding actually READS them into the profile it hands to sign-in. Neither
 * test substitutes for the other — the data being on the device is not the same
 * claim as the screen using it.
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react-native';
import { Text } from 'react-native';

const mockGetConfig = jest.fn();
jest.mock('@/services/config', () => ({ getConfig: () => mockGetConfig() }));

jest.mock('@/services/onboarding/keyService', () => ({
  generateMnemonic: () => ({ words: [], entropy: '' }),
  keyPairFromMnemonic: () => ({
    publicKey: 'pub-hex',
    privateKey: 'priv-hex',
    address: 'QmRestoredAccount',
    quilibriumAddress: '0xrestored',
  }),
  keyPairFromHex: () => ({
    publicKey: 'pub-hex',
    privateKey: 'priv-hex',
    address: 'QmRestoredAccount',
    quilibriumAddress: '0xrestored',
  }),
  deriveAddress: () => 'QmRestoredAccount',
  initializeEncryptionKeys: jest.fn().mockResolvedValue({ keyset: true }),
  uploadUserRegistration: jest.fn().mockResolvedValue(undefined),
}));

// No Farcaster account behind the phrase — that branch is a different feature
// and would only add noise to the assertions below.
jest.mock('@/services/onboarding/farcasterService', () => ({
  lookupFarcasterAccount: jest.fn().mockResolvedValue(null),
  validateFarcasterMnemonic: jest.fn().mockReturnValue({ valid: true }),
  deriveFarcasterKeys: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/services/onboarding/secureStorage', () => ({
  storeMnemonic: jest.fn().mockResolvedValue(undefined),
  storePrivateKey: jest.fn().mockResolvedValue(undefined),
  storePublicKey: jest.fn().mockResolvedValue(undefined),
  storeIdentityX448: jest.fn().mockResolvedValue(undefined),
  storeInboxAddress: jest.fn().mockResolvedValue(undefined),
  storeInboxEncryptionKey: jest.fn().mockResolvedValue(undefined),
  storeInboxSigningKey: jest.fn().mockResolvedValue(undefined),
  storePreKey: jest.fn().mockResolvedValue(undefined),
  loadOnboardingState: jest.fn().mockResolvedValue(null),
  saveOnboardingState: jest.fn().mockResolvedValue(undefined),
  clearOnboardingState: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), back: jest.fn() }),
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ signIn: jest.fn(), user: null }),
}));

jest.mock('@/utils/image', () => ({
  fetchImageAsDataUri: jest.fn().mockResolvedValue(null),
}));

import { OnboardingProvider, useOnboarding } from '@/context/OnboardingContext';

const SYNCED_NAME = 'Restored Display Name';
const SYNCED_PFP = 'data:image/png;base64,AAAA';

/** Surfaces the pieces of onboarding state the restore flow has to populate. */
function Probe() {
  const { state } = useOnboarding();
  return (
    <>
      <Text testID="displayName">{state.profile.displayName ?? 'MISSING'}</Text>
      <Text testID="profileImage">{state.profile.profileImageUri ?? 'MISSING'}</Text>
      <Text testID="syncedName">{state.syncedConfig?.name ?? 'NO_SYNCED_CONFIG'}</Text>
      <Text testID="syncedSpaces">{String(state.syncedConfig?.spaceCount ?? 'NONE')}</Text>
    </>
  );
}

let importFn: (words: string[]) => Promise<void>;

function Driver() {
  const { importFromMnemonic } = useOnboarding();
  importFn = importFromMnemonic;
  return null;
}

const renderOnboarding = () =>
  render(
    <OnboardingProvider>
      <Driver />
      <Probe />
    </OnboardingProvider>
  );

beforeEach(() => {
  jest.clearAllMocks();
});

describe('restoring an account on a new device', () => {
  it('pre-fills the display name and profile picture from the synced config', async () => {
    // What a fresh device genuinely sees: allowSync false, because the setting
    // is device-local and nothing is stored here yet — but the account's own
    // name and picture present in the blob.
    mockGetConfig.mockResolvedValue({
      address: 'QmRestoredAccount',
      allowSync: false,
      name: SYNCED_NAME,
      profile_image: SYNCED_PFP,
      spaceKeys: [{ spaceId: 'space-1' }, { spaceId: 'space-2' }],
    });

    renderOnboarding();
    await act(async () => {
      await importFn(['word'.repeat(1)]);
    });

    expect(screen.getByTestId('displayName')).toHaveTextContent(SYNCED_NAME);
    expect(screen.getByTestId('profileImage')).toHaveTextContent(SYNCED_PFP);
  });

  it('still records the synced-account summary, which the old gate suppressed', async () => {
    // The regression this file exists for. With `config.allowSync &&` in front
    // of the condition, a fresh install could never populate this, because the
    // device-local rule guarantees `false` there.
    mockGetConfig.mockResolvedValue({
      address: 'QmRestoredAccount',
      allowSync: false,
      name: SYNCED_NAME,
      profile_image: SYNCED_PFP,
      spaceKeys: [{ spaceId: 'space-1' }, { spaceId: 'space-2' }],
    });

    renderOnboarding();
    await act(async () => {
      await importFn(['word']);
    });

    expect(screen.getByTestId('syncedName')).toHaveTextContent(SYNCED_NAME);
    expect(screen.getByTestId('syncedSpaces')).toHaveTextContent('2');
  });

  it('restores a picture-only account, where the name is not the thing that proves it', async () => {
    // A name arriving could mask a dropped image, since they travel together in
    // the same object and only one of them is a large payload.
    mockGetConfig.mockResolvedValue({
      address: 'QmRestoredAccount',
      allowSync: false,
      profile_image: SYNCED_PFP,
    });

    renderOnboarding();
    await act(async () => {
      await importFn(['word']);
    });

    expect(screen.getByTestId('profileImage')).toHaveTextContent(SYNCED_PFP);
  });

  it('CONTROL ARM — an account with nothing synced pre-fills nothing', async () => {
    // Without this, a test double that returned the expected strings regardless
    // of input would satisfy every assertion above.
    mockGetConfig.mockResolvedValue({
      address: 'QmRestoredAccount',
      allowSync: false,
    });

    renderOnboarding();
    await act(async () => {
      await importFn(['word']);
    });

    expect(screen.getByTestId('displayName')).toHaveTextContent('MISSING');
    expect(screen.getByTestId('profileImage')).toHaveTextContent('MISSING');
    expect(screen.getByTestId('syncedName')).toHaveTextContent('NO_SYNCED_CONFIG');
  });
});
