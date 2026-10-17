/**
 * Mobile-side adapter that fulfils the SignerStore contract from
 * @quilibrium/quorum-shared.
 *
 * SignerStore → SecureStore (the Ed25519 private key must live in the keychain).
 * One slot per device, holding the signer for the signed-in FID. Reset App Data
 * clears it (`clearAllSecureStorage`).
 */

import * as SecureStore from 'expo-secure-store';
import type { SignerRecord, SignerStore } from '@quilibrium/quorum-shared';

const SIGNER_KEY = 'hypersnap.signerRecord.v1';
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const hypersnapSignerStore: SignerStore = {
  async get(): Promise<SignerRecord | null> {
    const raw = await SecureStore.getItemAsync(SIGNER_KEY, SECURE_OPTIONS);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SignerRecord;
    } catch {
      return null;
    }
  },
  async save(record: SignerRecord): Promise<void> {
    await SecureStore.setItemAsync(SIGNER_KEY, JSON.stringify(record), SECURE_OPTIONS);
  },
  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(SIGNER_KEY);
  },
};
