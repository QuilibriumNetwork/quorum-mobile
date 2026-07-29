// expo-secure-store replacement for Node.
//
// The real module is backed by the iOS Keychain / Android Keystore. There is no
// equivalent here, and there should not be a persistent one: the values mobile
// puts in SecureStore are ACCOUNT PRIVATE KEYS. Keeping them in memory only
// means a harness run cannot leave key material on disk by accident.
//
// Seeding: a scenario that needs to drive a specific account writes the key in
// with setItemAsync before exercising the code under test, exactly as onboarding
// would have. Nothing here reads .env directly — that stays the scenario's job,
// so key handling is visible at the call site rather than hidden in a shim.
//
// ⚠️ Note for whoever wires identity later: mobile REGENERATES the entire device
// keyset if any one SecureStore item reads as missing (keyService
// initializeEncryptionKeys). A shim that silently returns null for a key a
// scenario forgot to seed will therefore mint a NEW device identity and register
// it — feeding the ghost-device accumulation problem against a real account.
// Seed completely, or assert before running.

const store = new Map<string, string>();

/** Mirrors SecureStore.WHEN_UNLOCKED etc. Values are irrelevant off-device. */
export const WHEN_UNLOCKED = 'whenUnlocked';
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'whenUnlockedThisDeviceOnly';
export const AFTER_FIRST_UNLOCK = 'afterFirstUnlock';
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 'afterFirstUnlockThisDeviceOnly';
export const ALWAYS = 'always';
export const ALWAYS_THIS_DEVICE_ONLY = 'alwaysThisDeviceOnly';

export interface SecureStoreOptions {
  keychainService?: string;
  keychainAccessible?: string;
  requireAuthentication?: boolean;
}

/**
 * Keys are namespaced by keychainService when given, because mobile passes
 * different services for different key classes and the real module keeps those
 * separate. Collapsing them would let one class overwrite another.
 */
const k = (key: string, opts?: SecureStoreOptions) =>
  opts?.keychainService ? `${opts.keychainService}::${key}` : key;

export async function getItemAsync(
  key: string,
  opts?: SecureStoreOptions
): Promise<string | null> {
  return store.get(k(key, opts)) ?? null;
}

/** Synchronous variant — mobile uses this one too. */
export function getItem(key: string, opts?: SecureStoreOptions): string | null {
  return store.get(k(key, opts)) ?? null;
}

export async function setItemAsync(
  key: string,
  value: string,
  opts?: SecureStoreOptions
): Promise<void> {
  store.set(k(key, opts), value);
}

export async function deleteItemAsync(
  key: string,
  opts?: SecureStoreOptions
): Promise<void> {
  store.delete(k(key, opts));
}

export async function isAvailableAsync(): Promise<boolean> {
  return true;
}

/** Test helper — not part of the real API. */
export function __resetSecureStore(): void {
  store.clear();
}

export default {
  getItem,
  getItemAsync,
  setItemAsync,
  deleteItemAsync,
  isAvailableAsync,
  WHEN_UNLOCKED,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  AFTER_FIRST_UNLOCK,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  ALWAYS,
  ALWAYS_THIS_DEVICE_ONLY,
};
