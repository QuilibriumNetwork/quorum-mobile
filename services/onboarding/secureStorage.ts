import * as SecureStore from 'expo-secure-store';

const STORAGE_KEYS = {
  // Quorum keys (Ed448 - for signing/identity)
  QUORUM_PRIVATE_KEY: 'quorum.privateKey',
  QUORUM_PUBLIC_KEY: 'quorum.publicKey',
  QUORUM_MNEMONIC: 'quorum.mnemonic',

  // X448 identity key for E2E encryption (X3DH)
  QUORUM_IDENTITY_X448_PRIVATE: 'quorum.identityX448Private',
  QUORUM_IDENTITY_X448_PUBLIC: 'quorum.identityX448Public',

  // X448 pre-key for E2E encryption (X3DH signed pre-key)
  QUORUM_PREKEY_PRIVATE: 'quorum.preKeyPrivate',
  QUORUM_PREKEY_PUBLIC: 'quorum.preKeyPublic',

  // X448 inbox encryption key (for unsealing envelopes)
  QUORUM_INBOX_ENCRYPTION_PRIVATE: 'quorum.inboxEncryptionPrivate',
  QUORUM_INBOX_ENCRYPTION_PUBLIC: 'quorum.inboxEncryptionPublic',

  // Ed448 inbox signing key (for signing delete requests)
  QUORUM_INBOX_SIGNING_PRIVATE: 'quorum.inboxSigningPrivate',
  QUORUM_INBOX_SIGNING_PUBLIC: 'quorum.inboxSigningPublic',

  // Inbox address (derived from inbox encryption key)
  QUORUM_INBOX_ADDRESS: 'quorum.inboxAddress',

  // Farcaster keys
  FARCASTER_SIGNER_KEY: 'farcaster.signerKey',
  FARCASTER_CUSTODY_KEY: 'farcaster.custodyKey',  // secp256k1 private key for SIWE signing
  FARCASTER_FID: 'farcaster.fid',
  FARCASTER_AUTH_TOKEN: 'farcaster.authToken',  // API auth token for Farcaster API calls
  FARCASTER_AUTH_TOKEN_EXPIRES_AT: 'farcaster.authTokenExpiresAt',  // Unix ms expiry of the auth token

  // Warpcast embedded wallet (imported from Warpcast/Privy)
  WARPCAST_WALLET_ADDRESS: 'warpcast.walletAddress',
  WARPCAST_WALLET_PRIVATE_KEY: 'warpcast.walletPrivateKey',
  WARPCAST_WALLET_MNEMONIC: 'warpcast.walletMnemonic',
  WARPCAST_WALLET_IMPORTED_AT: 'warpcast.walletImportedAt',

  // Onboarding state (for resume)
  ONBOARDING_STATE: 'onboarding.state',
} as const;

const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// ---------------------------------------------------------------------------
// In-memory cache for hot-path key reads.
//
// Android Keystore-backed SecureStore reads measured 650-900ms EACH; the DM
// send path paid ~2s per send re-reading immutable keys. The keys already
// transit JS memory on every use (they're passed to the native crypto
// module as strings), so caching them for the session adds no new exposure
// class; SecureStore remains the at-rest store.
//
// Invalidation: every store*/delete* mutator below updates or clears the
// cache, and clearAllSecureStorage() (the "Reset App Data" path — the app
// has no separate sign-out) wipes it entirely. Only non-null values are
// cached so an onboarding-in-progress read never pins a stale null.
// ---------------------------------------------------------------------------
let cachedPrivateKey: string | null = null;
let cachedPublicKey: string | null = null;
let cachedDeviceKeyset: DeviceKeyset | null = null;

function invalidateDeviceKeysetCache(): void {
  cachedDeviceKeyset = null;
}

/** Wipe all in-memory key caches. Called from clearAllSecureStorage. */
export function clearKeyCache(): void {
  cachedPrivateKey = null;
  cachedPublicKey = null;
  cachedDeviceKeyset = null;
}

// Defensive copy so callers can never mutate the cached arrays.
function copyKeyset(k: DeviceKeyset): DeviceKeyset {
  return {
    identityPrivateKey: [...k.identityPrivateKey],
    identityPublicKey: [...k.identityPublicKey],
    preKeyPrivateKey: [...k.preKeyPrivateKey],
    preKeyPublicKey: [...k.preKeyPublicKey],
    inboxEncryptionPrivateKey: [...k.inboxEncryptionPrivateKey],
    inboxEncryptionPublicKey: [...k.inboxEncryptionPublicKey],
    inboxSigningPrivateKey: [...k.inboxSigningPrivateKey],
    inboxSigningPublicKey: [...k.inboxSigningPublicKey],
    inboxAddress: k.inboxAddress,
  };
}

// Quorum Keys

export async function storePrivateKey(privateKey: string): Promise<void> {
  await SecureStore.setItemAsync(
    STORAGE_KEYS.QUORUM_PRIVATE_KEY,
    privateKey,
    SECURE_OPTIONS
  );
  cachedPrivateKey = privateKey;
}

export async function getPrivateKey(): Promise<string | null> {
  if (cachedPrivateKey !== null) return cachedPrivateKey;
  const value = await SecureStore.getItemAsync(STORAGE_KEYS.QUORUM_PRIVATE_KEY);
  if (value !== null) cachedPrivateKey = value;
  return value;
}

export async function deletePrivateKey(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEYS.QUORUM_PRIVATE_KEY);
  cachedPrivateKey = null;
}

export async function hasPrivateKey(): Promise<boolean> {
  const key = await getPrivateKey();
  return key !== null;
}

export async function storePublicKey(publicKey: string): Promise<void> {
  await SecureStore.setItemAsync(
    STORAGE_KEYS.QUORUM_PUBLIC_KEY,
    publicKey,
    SECURE_OPTIONS
  );
  cachedPublicKey = publicKey;
}

export async function getPublicKey(): Promise<string | null> {
  if (cachedPublicKey !== null) return cachedPublicKey;
  const value = await SecureStore.getItemAsync(STORAGE_KEYS.QUORUM_PUBLIC_KEY);
  if (value !== null) cachedPublicKey = value;
  return value;
}

// X448 Pre-Key Storage (E2E Encryption)

// Matches desktop SDK's DeviceKeyset: X448 for encryption, Ed448 for inbox signing.
export interface DeviceKeyset {
  identityPrivateKey: number[];
  identityPublicKey: number[];
  preKeyPrivateKey: number[];
  preKeyPublicKey: number[];
  inboxEncryptionPrivateKey: number[];
  inboxEncryptionPublicKey: number[];
  inboxSigningPrivateKey: number[];
  inboxSigningPublicKey: number[];
  inboxAddress: string;
}

export async function storePreKey(privateKey: string, publicKey: string): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(STORAGE_KEYS.QUORUM_PREKEY_PRIVATE, privateKey, SECURE_OPTIONS),
    SecureStore.setItemAsync(STORAGE_KEYS.QUORUM_PREKEY_PUBLIC, publicKey, SECURE_OPTIONS),
  ]);
  invalidateDeviceKeysetCache();
}

export async function getPreKey(): Promise<{ privateKey: number[]; publicKey: number[] } | null> {
  const [privateKey, publicKey] = await Promise.all([
    SecureStore.getItemAsync(STORAGE_KEYS.QUORUM_PREKEY_PRIVATE),
    SecureStore.getItemAsync(STORAGE_KEYS.QUORUM_PREKEY_PUBLIC),
  ]);

  if (!privateKey || !publicKey) return null;

  try {
    return {
      privateKey: JSON.parse(privateKey),
      publicKey: JSON.parse(publicKey),
    };
  } catch {
    return null;
  }
}

export async function hasPreKey(): Promise<boolean> {
  const preKey = await getPreKey();
  return preKey !== null;
}

export async function deletePreKey(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(STORAGE_KEYS.QUORUM_PREKEY_PRIVATE),
    SecureStore.deleteItemAsync(STORAGE_KEYS.QUORUM_PREKEY_PUBLIC),
  ]);
  invalidateDeviceKeysetCache();
}

// X448 Identity Key Storage (X3DH)

export async function storeIdentityX448(privateKey: string, publicKey: string): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(STORAGE_KEYS.QUORUM_IDENTITY_X448_PRIVATE, privateKey, SECURE_OPTIONS),
    SecureStore.setItemAsync(STORAGE_KEYS.QUORUM_IDENTITY_X448_PUBLIC, publicKey, SECURE_OPTIONS),
  ]);
  invalidateDeviceKeysetCache();
}

export async function getIdentityX448(): Promise<{ privateKey: number[]; publicKey: number[] } | null> {
  const [privateKey, publicKey] = await Promise.all([
    SecureStore.getItemAsync(STORAGE_KEYS.QUORUM_IDENTITY_X448_PRIVATE),
    SecureStore.getItemAsync(STORAGE_KEYS.QUORUM_IDENTITY_X448_PUBLIC),
  ]);

  if (!privateKey || !publicKey) return null;

  try {
    return {
      privateKey: JSON.parse(privateKey),
      publicKey: JSON.parse(publicKey),
    };
  } catch {
    return null;
  }
}

// X448 Inbox Encryption Key Storage

export async function storeInboxEncryptionKey(privateKey: string, publicKey: string): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(STORAGE_KEYS.QUORUM_INBOX_ENCRYPTION_PRIVATE, privateKey, SECURE_OPTIONS),
    SecureStore.setItemAsync(STORAGE_KEYS.QUORUM_INBOX_ENCRYPTION_PUBLIC, publicKey, SECURE_OPTIONS),
  ]);
  invalidateDeviceKeysetCache();
}

export async function getInboxEncryptionKey(): Promise<{ privateKey: number[]; publicKey: number[] } | null> {
  const [privateKey, publicKey] = await Promise.all([
    SecureStore.getItemAsync(STORAGE_KEYS.QUORUM_INBOX_ENCRYPTION_PRIVATE),
    SecureStore.getItemAsync(STORAGE_KEYS.QUORUM_INBOX_ENCRYPTION_PUBLIC),
  ]);

  if (!privateKey || !publicKey) return null;

  try {
    return {
      privateKey: JSON.parse(privateKey),
      publicKey: JSON.parse(publicKey),
    };
  } catch {
    return null;
  }
}

// Ed448 Inbox Signing Key Storage

export async function storeInboxSigningKey(privateKey: string, publicKey: string): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(STORAGE_KEYS.QUORUM_INBOX_SIGNING_PRIVATE, privateKey, SECURE_OPTIONS),
    SecureStore.setItemAsync(STORAGE_KEYS.QUORUM_INBOX_SIGNING_PUBLIC, publicKey, SECURE_OPTIONS),
  ]);
  invalidateDeviceKeysetCache();
}

export async function getInboxSigningKey(): Promise<{ privateKey: number[]; publicKey: number[] } | null> {
  const [privateKey, publicKey] = await Promise.all([
    SecureStore.getItemAsync(STORAGE_KEYS.QUORUM_INBOX_SIGNING_PRIVATE),
    SecureStore.getItemAsync(STORAGE_KEYS.QUORUM_INBOX_SIGNING_PUBLIC),
  ]);

  if (!privateKey || !publicKey) return null;

  try {
    return {
      privateKey: JSON.parse(privateKey),
      publicKey: JSON.parse(publicKey),
    };
  } catch {
    return null;
  }
}

// Inbox Address Storage

export async function storeInboxAddress(address: string): Promise<void> {
  await SecureStore.setItemAsync(STORAGE_KEYS.QUORUM_INBOX_ADDRESS, address, SECURE_OPTIONS);
  invalidateDeviceKeysetCache();
}

export async function getInboxAddress(): Promise<string | null> {
  return SecureStore.getItemAsync(STORAGE_KEYS.QUORUM_INBOX_ADDRESS);
}

// Returns null if any required key is missing.
export async function getDeviceKeyset(): Promise<DeviceKeyset | null> {
  if (cachedDeviceKeyset !== null) return copyKeyset(cachedDeviceKeyset);
  const [identityX448, preKey, inboxEncryptionKey, inboxSigningKey, inboxAddress] = await Promise.all([
    getIdentityX448(),
    getPreKey(),
    getInboxEncryptionKey(),
    getInboxSigningKey(),
    getInboxAddress(),
  ]);

  if (!identityX448 || !preKey || !inboxEncryptionKey || !inboxSigningKey || !inboxAddress) {
    return null;
  }

  cachedDeviceKeyset = {
    identityPrivateKey: identityX448.privateKey,
    identityPublicKey: identityX448.publicKey,
    preKeyPrivateKey: preKey.privateKey,
    preKeyPublicKey: preKey.publicKey,
    inboxEncryptionPrivateKey: inboxEncryptionKey.privateKey,
    inboxEncryptionPublicKey: inboxEncryptionKey.publicKey,
    inboxSigningPrivateKey: inboxSigningKey.privateKey,
    inboxSigningPublicKey: inboxSigningKey.publicKey,
    inboxAddress,
  };
  return copyKeyset(cachedDeviceKeyset);
}

function hexToNumberArray(hex: string): number[] {
  const cleanHex = hex.replace('0x', '');
  const bytes: number[] = [];
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes.push(parseInt(cleanHex.substring(i, i + 2), 16));
  }
  return bytes;
}

// Mnemonic Storage

export async function storeMnemonic(words: string[]): Promise<void> {
  await SecureStore.setItemAsync(
    STORAGE_KEYS.QUORUM_MNEMONIC,
    JSON.stringify(words),
    SECURE_OPTIONS
  );
}

export async function getMnemonic(): Promise<string[] | null> {
  const stored = await SecureStore.getItemAsync(STORAGE_KEYS.QUORUM_MNEMONIC);
  return stored ? JSON.parse(stored) : null;
}

export async function deleteMnemonic(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEYS.QUORUM_MNEMONIC);
}

// Farcaster Keys

export async function storeFarcasterSignerKey(signerKey: string): Promise<void> {
  await SecureStore.setItemAsync(
    STORAGE_KEYS.FARCASTER_SIGNER_KEY,
    signerKey,
    SECURE_OPTIONS
  );
}

export async function getFarcasterSignerKey(): Promise<string | null> {
  return SecureStore.getItemAsync(STORAGE_KEYS.FARCASTER_SIGNER_KEY);
}

export async function deleteFarcasterSignerKey(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEYS.FARCASTER_SIGNER_KEY);
}

export async function storeFarcasterCustodyKey(custodyKey: string): Promise<void> {
  await SecureStore.setItemAsync(
    STORAGE_KEYS.FARCASTER_CUSTODY_KEY,
    custodyKey,
    SECURE_OPTIONS
  );
}

export async function getFarcasterCustodyKey(): Promise<string | null> {
  return SecureStore.getItemAsync(STORAGE_KEYS.FARCASTER_CUSTODY_KEY);
}

export async function deleteFarcasterCustodyKey(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEYS.FARCASTER_CUSTODY_KEY);
}

export async function storeFarcasterFid(fid: number): Promise<void> {
  await SecureStore.setItemAsync(
    STORAGE_KEYS.FARCASTER_FID,
    fid.toString(),
    SECURE_OPTIONS
  );
  // Re-bind push token to the new FID; otherwise the server's push-fid
  // index stays at startup's FID and Farcaster pushes stop until restart.
  // Dynamic import breaks a circular dep with pushRegistration.
  try {
    const { registerPushTokenWithQuorum } = await import('../notifications/pushRegistration');
    void registerPushTokenWithQuorum({ force: true });
  } catch {
    // Next startup registration will pick up the new FID.
  }
}

export async function getFarcasterFid(): Promise<number | null> {
  const stored = await SecureStore.getItemAsync(STORAGE_KEYS.FARCASTER_FID);
  return stored ? parseInt(stored, 10) : null;
}

export async function storeFarcasterAuthToken(authToken: string): Promise<void> {
  await SecureStore.setItemAsync(
    STORAGE_KEYS.FARCASTER_AUTH_TOKEN,
    authToken,
    SECURE_OPTIONS
  );
}

export async function getFarcasterAuthToken(): Promise<string | null> {
  return SecureStore.getItemAsync(STORAGE_KEYS.FARCASTER_AUTH_TOKEN);
}

export async function deleteFarcasterAuthToken(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEYS.FARCASTER_AUTH_TOKEN);
}

export async function storeFarcasterAuthTokenExpiresAt(ts: number): Promise<void> {
  await SecureStore.setItemAsync(
    STORAGE_KEYS.FARCASTER_AUTH_TOKEN_EXPIRES_AT,
    ts.toString(),
    SECURE_OPTIONS
  );
}

export async function getFarcasterAuthTokenExpiresAt(): Promise<number | null> {
  const stored = await SecureStore.getItemAsync(STORAGE_KEYS.FARCASTER_AUTH_TOKEN_EXPIRES_AT);
  if (!stored) return null;
  const parsed = parseInt(stored, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function deleteFarcasterAuthTokenExpiresAt(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEYS.FARCASTER_AUTH_TOKEN_EXPIRES_AT);
}

// Onboarding State

export interface OnboardingStateData {
  currentStep: string;
  completedSteps: string[];
  quorumAddress?: string;
  quorumPublicKey?: string;
  quilibriumAddress?: string;  // 0x-prefixed Quilibrium address for QNS
  farcasterEnabled?: boolean;
  farcasterUsername?: string;
  profile?: {
    username?: string;
    displayName?: string;
    bio?: string;
    profileImageUri?: string;
  };
  privacyLevel?: string;
}

export async function saveOnboardingState(state: OnboardingStateData): Promise<void> {
  await SecureStore.setItemAsync(
    STORAGE_KEYS.ONBOARDING_STATE,
    JSON.stringify(state),
    SECURE_OPTIONS
  );
}

export async function loadOnboardingState(): Promise<OnboardingStateData | null> {
  const stored = await SecureStore.getItemAsync(STORAGE_KEYS.ONBOARDING_STATE);
  return stored ? JSON.parse(stored) : null;
}

export async function clearOnboardingState(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEYS.ONBOARDING_STATE);
}

// Warpcast Wallet Storage

export interface WarpcastWalletData {
  address: string;
  privateKey: string;
  mnemonic?: string;
  importedAt: string;
}

export async function storeWarpcastWallet(data: WarpcastWalletData): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(STORAGE_KEYS.WARPCAST_WALLET_ADDRESS, data.address, SECURE_OPTIONS),
    SecureStore.setItemAsync(STORAGE_KEYS.WARPCAST_WALLET_PRIVATE_KEY, data.privateKey, SECURE_OPTIONS),
    data.mnemonic
      ? SecureStore.setItemAsync(STORAGE_KEYS.WARPCAST_WALLET_MNEMONIC, data.mnemonic, SECURE_OPTIONS)
      : Promise.resolve(),
    SecureStore.setItemAsync(STORAGE_KEYS.WARPCAST_WALLET_IMPORTED_AT, data.importedAt, SECURE_OPTIONS),
  ]);
}

export async function getWarpcastWallet(): Promise<WarpcastWalletData | null> {
  const [address, privateKey, mnemonic, importedAt] = await Promise.all([
    SecureStore.getItemAsync(STORAGE_KEYS.WARPCAST_WALLET_ADDRESS),
    SecureStore.getItemAsync(STORAGE_KEYS.WARPCAST_WALLET_PRIVATE_KEY),
    SecureStore.getItemAsync(STORAGE_KEYS.WARPCAST_WALLET_MNEMONIC),
    SecureStore.getItemAsync(STORAGE_KEYS.WARPCAST_WALLET_IMPORTED_AT),
  ]);

  if (!address || !privateKey || !importedAt) {
    return null;
  }

  return {
    address,
    privateKey,
    mnemonic: mnemonic ?? undefined,
    importedAt,
  };
}

export async function hasWarpcastWallet(): Promise<boolean> {
  const address = await SecureStore.getItemAsync(STORAGE_KEYS.WARPCAST_WALLET_ADDRESS);
  return address !== null;
}

export async function deleteWarpcastWallet(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(STORAGE_KEYS.WARPCAST_WALLET_ADDRESS),
    SecureStore.deleteItemAsync(STORAGE_KEYS.WARPCAST_WALLET_PRIVATE_KEY),
    SecureStore.deleteItemAsync(STORAGE_KEYS.WARPCAST_WALLET_MNEMONIC),
    SecureStore.deleteItemAsync(STORAGE_KEYS.WARPCAST_WALLET_IMPORTED_AT),
  ]);
}

// Device Keys Reset

// Clears device-specific encryption keys without touching the Ed448 identity key or mnemonic.
// Used when importing an existing user to force fresh device key generation.
export async function clearDeviceKeys(): Promise<void> {
  await Promise.all([
    // X448 identity key for X3DH
    SecureStore.deleteItemAsync(STORAGE_KEYS.QUORUM_IDENTITY_X448_PRIVATE),
    SecureStore.deleteItemAsync(STORAGE_KEYS.QUORUM_IDENTITY_X448_PUBLIC),
    // X448 pre-key for X3DH
    deletePreKey(),
    // X448 inbox encryption key
    SecureStore.deleteItemAsync(STORAGE_KEYS.QUORUM_INBOX_ENCRYPTION_PRIVATE),
    SecureStore.deleteItemAsync(STORAGE_KEYS.QUORUM_INBOX_ENCRYPTION_PUBLIC),
    // Ed448 inbox signing key
    SecureStore.deleteItemAsync(STORAGE_KEYS.QUORUM_INBOX_SIGNING_PRIVATE),
    SecureStore.deleteItemAsync(STORAGE_KEYS.QUORUM_INBOX_SIGNING_PUBLIC),
    // Inbox address
    SecureStore.deleteItemAsync(STORAGE_KEYS.QUORUM_INBOX_ADDRESS),
  ]);
  invalidateDeviceKeysetCache();
}

// Full Reset

export async function clearAllSecureStorage(): Promise<void> {
  // "Reset App Data" path — the in-memory key cache MUST die with the
  // stored keys, otherwise a later re-onboard could sign with the old
  // identity.
  clearKeyCache();
  await Promise.all([
    deletePrivateKey(),
    SecureStore.deleteItemAsync(STORAGE_KEYS.QUORUM_PUBLIC_KEY),
    clearDeviceKeys(),
    deleteMnemonic(),
    deleteFarcasterSignerKey(),
    deleteFarcasterCustodyKey(),
    SecureStore.deleteItemAsync(STORAGE_KEYS.FARCASTER_FID),
    deleteFarcasterAuthToken(),
    deleteFarcasterAuthTokenExpiresAt(),
    clearOnboardingState(),
    deleteWarpcastWallet(),
  ]);
}
