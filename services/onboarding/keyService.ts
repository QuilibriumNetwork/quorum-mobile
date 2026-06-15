/**
 * Key generation and management service for Quorum accounts
 *
 * Uses ed448 for Quorum keys (57-byte private keys, 57-byte public keys)
 * Derivation path: m/44'/1776'/0'/1/0
 */

import { base64ToHex, numberArrayToBase64 } from '@/utils/encoding';
import * as ed448Module from '@noble/curves/ed448.js';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js';
// @ts-ignore - module resolution works at runtime
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import * as multihashes from 'multihashes';
import bs58 from 'bs58';

// Extract ed448 and decaf448 from module (decaf448 type not in declarations)
const { ed448 } = ed448Module;

// Extended type for decaf448 with full point operations
interface Decaf448Point {
  toBytes(): Uint8Array;
  multiply(scalar: bigint): Decaf448Point;
  add(other: Decaf448Point): Decaf448Point;
  equals(other: Decaf448Point): boolean;
}

const decaf448 = (ed448Module as any).decaf448 as {
  Point: {
    BASE: Decaf448Point;
    fromBytes(bytes: Uint8Array): Decaf448Point;
    Fn: { ORDER: bigint };
  };
  randomBytes(length: number): Uint8Array;
};

// Quorum signing key derivation path: m/44'/1776'/0'/1/0
const DERIVATION_PATH = [
  0x8000002c, // 44' (hardened)
  0x800006f0, // 1776' (hardened)
  0x80000000, // 0' (hardened)
  1,          // 1
  0,          // 0
];

// Quilibrium view key derivation path: m/44'/1776'/0'/2/0
const VIEW_KEY_PATH = [
  0x8000002c, // 44' (hardened)
  0x800006f0, // 1776' (hardened)
  0x80000000, // 0' (hardened)
  2,          // 2
  0,          // 0
];

// Quilibrium spend key derivation path: m/44'/1776'/0'/3/0
const SPEND_KEY_PATH = [
  0x8000002c, // 44' (hardened)
  0x800006f0, // 1776' (hardened)
  0x80000000, // 0' (hardened)
  3,          // 3
  0,          // 0
];

export interface KeyPair {
  publicKey: string;        // hex-encoded ed448 public key
  privateKey: string;       // hex-encoded ed448 private key
  address: string;          // Qm... style Quorum address
  quilibriumAddress: string; // 0x-prefixed Quilibrium address (view + spend pubkeys)
}

export interface MnemonicResult {
  mnemonic: string[];
  keyPair: KeyPair;
}

export interface ValidationResult {
  valid: boolean;
  invalidWords: number[];  // indices of invalid words
}

/**
 * Generate a new ed448 key pair
 * Note: Uses HKDF workaround for Quilibrium address since there's no mnemonic
 */
export function generateKeyPair(): KeyPair {
  const privateKeyBytes = ed448.utils.randomPrivateKey();
  const publicKeyBytes = ed448.getPublicKey(privateKeyBytes);

  const privateKey = bytesToHex(privateKeyBytes);
  const publicKey = bytesToHex(publicKeyBytes);
  const address = deriveAddress(publicKeyBytes);
  const quilibriumAddress = deriveQuilibriumAddressFromPrivateKey(privateKeyBytes);

  return { publicKey, privateKey, address, quilibriumAddress };
}

/**
 * Derive address from public key using libp2p multihash approach
 * SHA-256 hashes the public key, wraps in multihash, encodes as base58
 * Produces a "Qm..." style address
 */
export function deriveAddress(publicKey: Uint8Array | string): string {
  const keyBytes = typeof publicKey === 'string'
    ? hexToBytes(publicKey.replace('0x', ''))
    : publicKey;

  // SHA-256 hash the public key
  const hash = sha256(keyBytes);

  // Wrap in multihash format (SHA-256 = 0x12)
  const multihash = multihashes.encode(hash, 'sha2-256');

  // Base58 encode to get "Qm..." address
  return bs58.encode(multihash);
}

/**
 * Generate a 24-word mnemonic and derive ed448 key pair
 */
export function generateMnemonic(): MnemonicResult {
  // Generate 256-bit entropy for 24 words
  const mnemonic = bip39.generateMnemonic(wordlist, 256);
  const words = mnemonic.split(' ');

  const keyPair = keyPairFromMnemonic(words);

  return { mnemonic: words, keyPair };
}

/**
 * Serialize a 32-bit unsigned integer as big-endian bytes
 */
function ser32(i: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = (i >>> 24) & 0xff;
  buf[1] = (i >>> 16) & 0xff;
  buf[2] = (i >>> 8) & 0xff;
  buf[3] = i & 0xff;
  return buf;
}

// HMAC key for ed448 derivation (similar to SLIP-0010's "ed25519 seed")
const ED448_SEED_KEY = new TextEncoder().encode('ed448 seed');

/**
 * Derive master key and chain code from seed using SLIP-0010 style derivation
 * Returns 57 bytes key + 32 bytes chain code
 */
function deriveMasterKey(seed: Uint8Array): { key: Uint8Array; chainCode: Uint8Array } {
  // Use HMAC-SHA512 with "ed448 seed" as key (similar to SLIP-0010)
  const I = hmac(sha512, ED448_SEED_KEY, seed);

  // For ed448, we need 57 bytes for the key
  // Do a second round of HMAC to get more key material
  const I2 = hmac(sha512, ED448_SEED_KEY, I);

  // Combine first 57 bytes from I and I2 for the key
  const key = new Uint8Array(57);
  key.set(I.slice(0, 32), 0);
  key.set(I2.slice(0, 25), 32);

  // Chain code is last 32 bytes of I
  const chainCode = I.slice(32, 64);

  return { key, chainCode };
}

/**
 * Derive child key at index using SLIP-0010 style derivation
 */
function deriveChildKey(
  parentKey: Uint8Array,
  parentChainCode: Uint8Array,
  index: number
): { key: Uint8Array; chainCode: Uint8Array } {
  const isHardened = index >= 0x80000000;

  let data: Uint8Array;
  if (isHardened) {
    // Hardened: 0x00 || key || ser32(index)
    data = concatBytes(new Uint8Array([0]), parentKey, ser32(index));
  } else {
    // Normal: pubkey || ser32(index)
    const pubKey = ed448.getPublicKey(parentKey);
    data = concatBytes(pubKey, ser32(index));
  }

  const I = hmac(sha512, parentChainCode, data);
  const I2 = hmac(sha512, parentChainCode, I);

  // Combine for 57-byte key
  const key = new Uint8Array(57);
  key.set(I.slice(0, 32), 0);
  key.set(I2.slice(0, 25), 32);

  const chainCode = I.slice(32, 64);

  return { key, chainCode };
}

/**
 * Derive key at a specific path from seed
 */
function deriveKeyAtPath(seed: Uint8Array, path: number[]): Uint8Array {
  let { key, chainCode } = deriveMasterKey(seed);
  for (const index of path) {
    ({ key, chainCode } = deriveChildKey(key, chainCode, index));
  }
  return key;
}

/**
 * Convert ed448 private key bytes to decaf448 scalar and derive public point
 * Uses first 56 bytes of the key material as the scalar
 */
function deriveDecaf448PublicKey(keyMaterial: Uint8Array): Uint8Array {
  // Use SHA-512 to derive a uniform scalar from the key material
  const hash = sha512(keyMaterial);
  // Take first 56 bytes and reduce mod order for decaf448 scalar
  const scalarBytes = hash.slice(0, 56);
  // Multiply base point by scalar to get public key
  const point = decaf448.Point.BASE.multiply(BigInt('0x' + bytesToHex(scalarBytes)) % decaf448.Point.Fn.ORDER);
  return point.toBytes();
}

/**
 * Derive Quilibrium address from mnemonic seed
 * Uses proper BIP44 paths for view and spend keys
 * Address = 0x + viewPubKey (56 bytes) + spendPubKey (56 bytes) = 112 bytes
 */
function deriveQuilibriumAddressFromSeed(seed: Uint8Array): string {
  // Derive view key at m/44'/1776'/0'/2/0
  const viewKeyMaterial = deriveKeyAtPath(seed, VIEW_KEY_PATH);
  const viewPubKey = deriveDecaf448PublicKey(viewKeyMaterial);

  // Derive spend key at m/44'/1776'/0'/3/0
  const spendKeyMaterial = deriveKeyAtPath(seed, SPEND_KEY_PATH);
  const spendPubKey = deriveDecaf448PublicKey(spendKeyMaterial);

  // Concatenate: 0x + view (56 bytes) + spend (56 bytes)
  return '0x' + bytesToHex(viewPubKey) + bytesToHex(spendPubKey);
}

/**
 * Derive Quilibrium address from private key (workaround for non-mnemonic imports)
 * Uses HKDF to deterministically derive view and spend keys from the signing key
 */
function deriveQuilibriumAddressFromPrivateKey(privateKey: Uint8Array): string {
  const textEncoder = new TextEncoder();

  // Derive view key using HKDF with "quilibrium-view" info
  const viewKeyMaterial = hkdf(sha256, privateKey, undefined, textEncoder.encode('quilibrium-view'), 57);
  const viewPubKey = deriveDecaf448PublicKey(viewKeyMaterial);

  // Derive spend key using HKDF with "quilibrium-spend" info
  const spendKeyMaterial = hkdf(sha256, privateKey, undefined, textEncoder.encode('quilibrium-spend'), 57);
  const spendPubKey = deriveDecaf448PublicKey(spendKeyMaterial);

  // Concatenate: 0x + view (56 bytes) + spend (56 bytes)
  return '0x' + bytesToHex(viewPubKey) + bytesToHex(spendPubKey);
}

/**
 * Derive Quilibrium address from hex-encoded private key (HKDF method)
 * WARNING: This produces different results than mnemonic-based derivation!
 * Use deriveQuilibriumAddressWithMnemonic if you have a mnemonic.
 */
export function deriveQuilibriumAddress(hexPrivateKey: string): string {
  const cleanHex = hexPrivateKey.replace('0x', '').trim();
  const privateKeyBytes = hexToBytes(cleanHex);
  return deriveQuilibriumAddressFromPrivateKey(privateKeyBytes);
}

/**
 * Derive Quilibrium address, preferring mnemonic-based derivation if available
 * This should be used for migrations to ensure consistency with how the account was created.
 *
 * @param mnemonic - Optional mnemonic words (preferred if available)
 * @param hexPrivateKey - Fallback private key (used if no mnemonic)
 */
export function deriveQuilibriumAddressWithMnemonic(
  mnemonic?: string[] | null,
  hexPrivateKey?: string | null
): string {
  if (mnemonic && mnemonic.length >= 12) {
    // Use seed-based derivation (matches keyPairFromMnemonic)
    const mnemonicStr = mnemonic.map(w => w.toLowerCase().trim()).join(' ');
    const seed = bip39.mnemonicToSeedSync(mnemonicStr);
    return deriveQuilibriumAddressFromSeed(seed);
  } else if (hexPrivateKey) {
    // Fall back to HKDF derivation
    return deriveQuilibriumAddress(hexPrivateKey);
  } else {
    throw new Error('Either mnemonic or hexPrivateKey must be provided');
  }
}

/**
 * Derive ed448 key pair from mnemonic phrase using path m/44'/1776'/0'/1/0
 */
export function keyPairFromMnemonic(words: string[]): KeyPair {
  const mnemonic = words.map(w => w.toLowerCase().trim()).join(' ');

  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid mnemonic phrase');
  }

  // Derive seed from mnemonic (64 bytes)
  const seed = bip39.mnemonicToSeedSync(mnemonic);

  // Derive master key
  let { key, chainCode } = deriveMasterKey(seed);

  // Derive through path m/44'/1776'/0'/1/0
  for (const index of DERIVATION_PATH) {
    ({ key, chainCode } = deriveChildKey(key, chainCode, index));
  }

  const privateKeyBytes = key;
  const publicKeyBytes = ed448.getPublicKey(privateKeyBytes);

  return {
    privateKey: bytesToHex(privateKeyBytes),
    publicKey: bytesToHex(publicKeyBytes),
    address: deriveAddress(publicKeyBytes),
    quilibriumAddress: deriveQuilibriumAddressFromSeed(seed),
  };
}

/**
 * Import key pair from hex-encoded private key
 * Note: Uses HKDF workaround for Quilibrium address since we don't have the mnemonic
 */
export function keyPairFromHex(hexPrivateKey: string): KeyPair {
  const cleanHex = hexPrivateKey.replace('0x', '').trim();
  const privateKeyBytes = hexToBytes(cleanHex);

  if (privateKeyBytes.length !== 57) {
    throw new Error(`Invalid ed448 private key length: expected 57 bytes, got ${privateKeyBytes.length}`);
  }

  const publicKeyBytes = ed448.getPublicKey(privateKeyBytes);

  return {
    privateKey: cleanHex,
    publicKey: bytesToHex(publicKeyBytes),
    address: deriveAddress(publicKeyBytes),
    quilibriumAddress: deriveQuilibriumAddressFromPrivateKey(privateKeyBytes),
  };
}

/**
 * Validate mnemonic words
 * Returns validation result with indices of any invalid words
 */
export function validateMnemonic(words: string[]): ValidationResult {
  const invalidWords: number[] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i].toLowerCase().trim();
    if (word && !wordlist.includes(word)) {
      invalidWords.push(i);
    }
  }

  // Check if we have correct word count (12, 15, 18, 21, or 24)
  const validWordCounts = [12, 15, 18, 21, 24];
  const nonEmptyWords = words.filter(w => w.trim().length > 0);

  if (!validWordCounts.includes(nonEmptyWords.length)) {
    return { valid: false, invalidWords };
  }

  // Final validation using bip39
  const mnemonic = nonEmptyWords.map(w => w.toLowerCase().trim()).join(' ');
  const valid = invalidWords.length === 0 && bip39.validateMnemonic(mnemonic, wordlist);

  return { valid, invalidWords };
}

/**
 * Get a single word suggestion from partial input
 */
export function suggestWord(partial: string): string[] {
  const lower = partial.toLowerCase().trim();
  if (lower.length < 2) return [];

  return wordlist
    .filter(word => word.startsWith(lower))
    .slice(0, 5);
}

// formatAddress is now imported from @/utils/formatAddress and re-exported
export { formatAddress } from '@/utils/formatAddress';

export function isValidHex(hex: string): boolean {
  const clean = hex.replace('0x', '');
  return /^[0-9a-fA-F]+$/.test(clean);
}

// X448 Pre-Key for E2E Encryption

import { NativeCryptoProvider } from '../crypto';
import {
  storePreKey,
  storeIdentityX448,
  storeInboxEncryptionKey,
  storeInboxSigningKey,
  storeInboxAddress,
  storePublicKey,
  getPreKey,
  getIdentityX448,
  getInboxEncryptionKey,
  getInboxSigningKey,
  getInboxAddress,
  getPrivateKey,
  storePrivateKey,
  getMnemonic,
  type DeviceKeyset as StoredDeviceKeyset,
} from './secureStorage';

/**
 * Ensure the Ed448 private key is available in secure storage.
 *
 * If the key is present, return it.
 * If the key is missing but a mnemonic is stored, re-derive the key from the
 * mnemonic, persist it, and return it. This self-heals accounts where the
 * private key was lost (e.g. after a restore-from-backup migration, an
 * interrupted onboarding, or secure-store corruption) while the mnemonic
 * survived — without this, uploadUserRegistration is skipped on startup and
 * the user's current device inbox never reaches the server, making them
 * unreachable.
 *
 * Returns null only if neither key nor mnemonic is stored.
 */
export async function ensurePrivateKey(): Promise<string | null> {
  const existing = await getPrivateKey();
  if (existing) {
    logger.debug('[ensurePrivateKey] existing key present');
    return existing;
  }

  logger.debug('[ensurePrivateKey] key missing — attempting re-derive from mnemonic');
  const mnemonic = await getMnemonic();
  if (!mnemonic || mnemonic.length === 0) {
    logger.debug(
      `[ensurePrivateKey] no mnemonic stored either (mnemonic=${mnemonic === null ? 'null' : `len${mnemonic?.length ?? 0}`}) — unrecoverable on this device`,
    );
    return null;
  }

  try {
    const keyPair = keyPairFromMnemonic(mnemonic);
    await storePrivateKey(keyPair.privateKey);
    logger.debug('[ensurePrivateKey] re-derived private key from mnemonic SUCCESS');
    return keyPair.privateKey;
  } catch (error) {
    logger.debug(
      '[ensurePrivateKey] failed to re-derive from mnemonic:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export interface DeviceEncryptionKeyset {
  identityKey: { publicKey: number[]; privateKey: number[] };
  preKey: { publicKey: number[]; privateKey: number[] };
  inboxEncryptionKey: { publicKey: number[]; privateKey: number[] };
  inboxSigningKey: { publicKey: number[]; privateKey: number[] };
  inboxAddress: string;
}
export async function generateDeviceEncryptionKeyset(): Promise<DeviceEncryptionKeyset> {
  const cryptoProvider = new NativeCryptoProvider();

  // Generate three X448 key pairs and one Ed448 key pair
  const [identityKeypair, preKeypair, inboxEncryptionKeypair, inboxSigningKeypair] = await Promise.all([
    cryptoProvider.generateX448(),
    cryptoProvider.generateX448(),
    cryptoProvider.generateX448(),
    cryptoProvider.generateEd448(),
  ]);

  // Derive inbox address from Ed448 inbox signing public key (NOT X448 encryption key)
  // This matches desktop SDK's NewInboxKeyset which derives from inbox_key (Ed448)
  const inboxAddress = deriveAddress(new Uint8Array(inboxSigningKeypair.public_key));

  return {
    identityKey: {
      publicKey: identityKeypair.public_key,
      privateKey: identityKeypair.private_key,
    },
    preKey: {
      publicKey: preKeypair.public_key,
      privateKey: preKeypair.private_key,
    },
    inboxEncryptionKey: {
      publicKey: inboxEncryptionKeypair.public_key,
      privateKey: inboxEncryptionKeypair.private_key,
    },
    inboxSigningKey: {
      publicKey: inboxSigningKeypair.public_key,
      privateKey: inboxSigningKeypair.private_key,
    },
    inboxAddress,
  };
}

/**
 * Initialize encryption keys for E2E messaging
 * Generates all keys needed for X3DH, envelope unsealing, and inbox signing
 * Also stores the Ed448 identity public key (for signing, not encryption)
 *
 * @param identityPublicKey The user's Ed448 identity public key (hex string) - for signing
 * @returns The generated device encryption keyset
 */
export async function initializeEncryptionKeys(
  identityPublicKey: string
): Promise<DeviceEncryptionKeyset> {
  // Store Ed448 identity public key (for signing operations)
  await storePublicKey(identityPublicKey);

  // Check if we already have encryption keys
  const [existingIdentityX448, existingPreKey, existingInboxEncKey, existingInboxSignKey, existingInboxAddress] = await Promise.all([
    getIdentityX448(),
    getPreKey(),
    getInboxEncryptionKey(),
    getInboxSigningKey(),
    getInboxAddress(),
  ]);

  if (existingIdentityX448 && existingPreKey && existingInboxEncKey && existingInboxSignKey && existingInboxAddress) {
    return {
      identityKey: existingIdentityX448,
      preKey: existingPreKey,
      inboxEncryptionKey: existingInboxEncKey,
      inboxSigningKey: existingInboxSignKey,
      inboxAddress: existingInboxAddress,
    };
  }

  // Generate new device encryption keyset
  const keyset = await generateDeviceEncryptionKeyset();

  // Store all keys securely
  await Promise.all([
    storeIdentityX448(
      JSON.stringify(keyset.identityKey.privateKey),
      JSON.stringify(keyset.identityKey.publicKey)
    ),
    storePreKey(
      JSON.stringify(keyset.preKey.privateKey),
      JSON.stringify(keyset.preKey.publicKey)
    ),
    storeInboxEncryptionKey(
      JSON.stringify(keyset.inboxEncryptionKey.privateKey),
      JSON.stringify(keyset.inboxEncryptionKey.publicKey)
    ),
    storeInboxSigningKey(
      JSON.stringify(keyset.inboxSigningKey.privateKey),
      JSON.stringify(keyset.inboxSigningKey.publicKey)
    ),
    storeInboxAddress(keyset.inboxAddress),
  ]);

  return keyset;
}

// Registration Upload

import { getQuorumClient, type UserRegistration, type DeviceRegistration, type InboxRegistration } from '../api/quorumClient';
import { logger } from '@quilibrium/quorum-shared';
/**
 * Convert stored device keyset to encryption keyset format
 */
export function storedKeysetToEncryptionKeyset(stored: StoredDeviceKeyset): DeviceEncryptionKeyset {
  return {
    identityKey: {
      publicKey: stored.identityPublicKey,
      privateKey: stored.identityPrivateKey,
    },
    preKey: {
      publicKey: stored.preKeyPublicKey,
      privateKey: stored.preKeyPrivateKey,
    },
    inboxEncryptionKey: {
      publicKey: stored.inboxEncryptionPublicKey,
      privateKey: stored.inboxEncryptionPrivateKey,
    },
    inboxSigningKey: {
      publicKey: stored.inboxSigningPublicKey,
      privateKey: stored.inboxSigningPrivateKey,
    },
    inboxAddress: stored.inboxAddress,
  };
}

/**
 * Build UserRegistration from user keys and device encryption keyset
 *
 * This creates the structure the server expects for E2E messaging registration
 */
export function buildUserRegistration(
  userAddress: string,
  userPublicKey: string,  // Ed448 public key (hex)
  peerPublicKey: string,  // Ed448 peer public key (hex) - same as user for now
  deviceKeyset: DeviceEncryptionKeyset,
  signature: string       // Ed448 signature of the registration data (hex)
): UserRegistration {
  // Convert byte arrays to hex strings
  const identityPublicKeyHex = deviceKeyset.identityKey.publicKey
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const prePublicKeyHex = deviceKeyset.preKey.publicKey
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const inboxEncryptionPublicKeyHex = deviceKeyset.inboxEncryptionKey.publicKey
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Ed448 inbox signing key for verifying delete requests
  const inboxSigningPublicKeyHex = deviceKeyset.inboxSigningKey.publicKey
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const inboxRegistration: InboxRegistration = {
    inbox_address: deviceKeyset.inboxAddress,
    inbox_encryption_public_key: inboxEncryptionPublicKeyHex,
    inbox_public_key: inboxSigningPublicKeyHex,
  };

  const deviceRegistration: DeviceRegistration = {
    identity_public_key: identityPublicKeyHex,
    pre_public_key: prePublicKeyHex,
    inbox_registration: inboxRegistration,
  };

  return {
    user_address: userAddress,
    user_public_key: userPublicKey,
    peer_public_key: peerPublicKey,
    device_registrations: [deviceRegistration],
    signature,
  };
}

/**
 * Build device registration from keyset
 */
function buildDeviceRegistration(keyset: DeviceEncryptionKeyset): DeviceRegistration {
  const identityPublicKeyHex = keyset.identityKey.publicKey
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const prePublicKeyHex = keyset.preKey.publicKey
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const inboxEncryptionPublicKeyHex = keyset.inboxEncryptionKey.publicKey
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const inboxSigningPublicKeyHex = keyset.inboxSigningKey.publicKey
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return {
    identity_public_key: identityPublicKeyHex,
    pre_public_key: prePublicKeyHex,
    inbox_registration: {
      inbox_address: keyset.inboxAddress,
      inbox_encryption_public_key: inboxEncryptionPublicKeyHex,
      inbox_public_key: inboxSigningPublicKeyHex,
    },
  };
}

/**
 * Upload registration so others can start E2E conversations with the user.
 * Merges with existing device entries to preserve multi-device support.
 */
export async function uploadUserRegistration(
  userAddress: string,
  userPublicKey: string,
  userPrivateKey: string,
  deviceKeyset: DeviceEncryptionKeyset | StoredDeviceKeyset
): Promise<void> {
  const cryptoProvider = new NativeCryptoProvider();
  const client = getQuorumClient();

  // Convert StoredDeviceKeyset to DeviceEncryptionKeyset if needed
  const keyset: DeviceEncryptionKeyset = 'identityKey' in deviceKeyset
    ? deviceKeyset
    : storedKeysetToEncryptionKeyset(deviceKeyset);

  // Build our new device registration
  const newDeviceReg = buildDeviceRegistration(keyset);
  const me = userAddress.slice(0, 8);
  logger.debug(
    `[Register ${me}] starting upload. currentInbox=${keyset.inboxAddress.slice(0, 16)}`,
  );

  // Fetch existing registration to merge with (if any)
  let existingDevices: DeviceRegistration[] = [];
  try {
    const existingReg = await client.fetchUserRegistration(userAddress);
    if (existingReg && existingReg.device_registrations) {
      logger.debug(
        `[Register ${me}] server has ${existingReg.device_registrations.length} existing device(s):`,
        existingReg.device_registrations.map((d) =>
          d.inbox_registration?.inbox_address?.slice(0, 16),
        ),
      );
      // Filter out any existing registration with the same inbox address (replacing our own)
      existingDevices = existingReg.device_registrations.filter(
        (d) => d.inbox_registration.inbox_address !== keyset.inboxAddress
      );
    } else {
      logger.debug(`[Register ${me}] server has no existing registration`);
    }
  } catch (fetchError) {
    logger.debug(
      `[Register ${me}] fetch existing failed:`,
      fetchError instanceof Error ? fetchError.message : fetchError,
    );
    // No existing registration or fetch failed - that's fine, we'll create a new one
  }

  // Merge: existing devices + our new device
  const allDevices = [...existingDevices, newDeviceReg];
  logger.debug(
    `[Register ${me}] uploading ${allDevices.length} device(s):`,
    allDevices.map((d) => d.inbox_registration.inbox_address.slice(0, 16)),
  );

  // Build the data to sign (matching desktop SDK format):
  // peer_public_key + for each device: (identity_public_key + pre_public_key + inbox_address_bytes + inbox_encryption_public_key)
  const peerPublicKeyBytes = hexToBytes(userPublicKey);

  // Concatenate data for ALL devices
  const deviceDataArrays: Uint8Array[] = [];
  for (const device of allDevices) {
    const identityBytes = hexToBytes(device.identity_public_key);
    const preBytes = hexToBytes(device.pre_public_key);
    const inboxAddressBytes = bs58.decode(device.inbox_registration.inbox_address);
    const inboxEncryptionBytes = hexToBytes(device.inbox_registration.inbox_encryption_public_key);

    deviceDataArrays.push(new Uint8Array([
      ...identityBytes,
      ...preBytes,
      ...inboxAddressBytes,
      ...inboxEncryptionBytes,
    ]));
  }

  // Concatenate: peer_public_key + all device data
  const allDeviceData = deviceDataArrays.reduce((acc, arr) => new Uint8Array([...acc, ...arr]), new Uint8Array());
  const dataToSign = new Uint8Array([
    ...peerPublicKeyBytes,
    ...allDeviceData,
  ]);

  // Sign with Ed448 - native module expects base64 inputs
  const privateKeyBase64 = btoa(
    String.fromCharCode(...hexToBytes(userPrivateKey))
  );
  const messageBase64 = numberArrayToBase64(Array.from(dataToSign));

  const signatureBase64 = await cryptoProvider.signEd448(privateKeyBase64, messageBase64);
  const signatureHex = base64ToHex(signatureBase64);

  // Build registration with all devices and new signature
  const registration: UserRegistration = {
    user_address: userAddress,
    user_public_key: userPublicKey,
    peer_public_key: userPublicKey,
    device_registrations: allDevices,
    signature: signatureHex,
  };

  try {
    await client.uploadRegistration(registration);
    logger.debug(`[Register ${me}] upload SUCCESS`);
  } catch (uploadErr) {
    logger.debug(
      `[Register ${me}] upload FAILED:`,
      uploadErr instanceof Error ? uploadErr.message : uploadErr,
    );
    throw uploadErr;
  }
}

/**
 * Upload a user registration with a specific set of devices
 * Used when removing devices - allows passing the exact device list to register
 *
 * @param userAddress - User's address (Qm...)
 * @param userPublicKey - User's Ed448 public key (hex)
 * @param userPrivateKey - User's Ed448 private key (hex) - for signing
 * @param devices - The exact list of device registrations to include
 */
export async function uploadUserRegistrationWithDevices(
  userAddress: string,
  userPublicKey: string,
  userPrivateKey: string,
  devices: DeviceRegistration[]
): Promise<void> {
  const cryptoProvider = new NativeCryptoProvider();
  const client = getQuorumClient();

  // Build the data to sign (matching desktop SDK format):
  // peer_public_key + for each device: (identity_public_key + pre_public_key + inbox_address_bytes + inbox_encryption_public_key)
  const peerPublicKeyBytes = hexToBytes(userPublicKey);

  // Concatenate data for ALL devices
  const deviceDataArrays: Uint8Array[] = [];
  for (const device of devices) {
    const identityBytes = hexToBytes(device.identity_public_key);
    const preBytes = hexToBytes(device.pre_public_key);
    const inboxAddressBytes = bs58.decode(device.inbox_registration.inbox_address);
    const inboxEncryptionBytes = hexToBytes(device.inbox_registration.inbox_encryption_public_key);

    deviceDataArrays.push(new Uint8Array([
      ...identityBytes,
      ...preBytes,
      ...inboxAddressBytes,
      ...inboxEncryptionBytes,
    ]));
  }

  // Concatenate: peer_public_key + all device data
  const allDeviceData = deviceDataArrays.reduce((acc, arr) => new Uint8Array([...acc, ...arr]), new Uint8Array());
  const dataToSign = new Uint8Array([
    ...peerPublicKeyBytes,
    ...allDeviceData,
  ]);

  // Sign with Ed448 - native module expects base64 inputs
  const privateKeyBase64 = btoa(
    String.fromCharCode(...hexToBytes(userPrivateKey))
  );
  const messageBase64 = numberArrayToBase64(Array.from(dataToSign));

  const signatureBase64 = await cryptoProvider.signEd448(privateKeyBase64, messageBase64);
  const signatureHex = base64ToHex(signatureBase64);

  // Build registration with specified devices and new signature
  const registration: UserRegistration = {
    user_address: userAddress,
    user_public_key: userPublicKey,
    peer_public_key: userPublicKey,
    device_registrations: devices,
    signature: signatureHex,
  };

  await client.uploadRegistration(registration);
}

/**
 * Remove a device from user registration
 *
 * @param userAddress - User's address (Qm...)
 * @param userPublicKey - User's Ed448 public key (hex)
 * @param userPrivateKey - User's Ed448 private key (hex) - for signing
 * @param inboxAddressToRemove - Inbox address of the device to remove
 * @returns true if device was removed, false if device not found or is the only device
 */
export async function removeDeviceFromRegistration(
  userAddress: string,
  userPublicKey: string,
  userPrivateKey: string,
  inboxAddressToRemove: string
): Promise<boolean> {
  const client = getQuorumClient();

  // Fetch existing registration
  let existingReg: UserRegistration;
  try {
    existingReg = await client.fetchUserRegistration(userAddress);
  } catch (error) {
    return false;
  }

  if (!existingReg?.device_registrations || existingReg.device_registrations.length === 0) {
    return false;
  }

  // Filter out the device to remove
  const remainingDevices = existingReg.device_registrations.filter(
    (d) => d.inbox_registration.inbox_address !== inboxAddressToRemove
  );

  if (remainingDevices.length === existingReg.device_registrations.length) {
    return false;
  }

  if (remainingDevices.length === 0) {
    return false;
  }

  // Re-upload with remaining devices
  await uploadUserRegistrationWithDevices(
    userAddress,
    userPublicKey,
    userPrivateKey,
    remainingDevices
  );

  return true;
}

// Decaf448 Schnorr Signatures for QNS

/**
 * Sign a message using Decaf448 Schnorr signature scheme with a raw scalar
 * Compatible with the server's bulletproofs SimpleSign/SimpleVerify
 *
 * Signature format: R (56 bytes) || s (56 bytes) = 112 bytes total
 *
 * @param scalar - The private scalar as a bigint
 * @param message - The message to sign (as Uint8Array)
 * @returns Hex-encoded 112-byte Schnorr signature
 */
function signDecaf448SchnorrWithScalar(x: bigint, message: Uint8Array): string {
  // Generate random nonce k
  // Use HMAC-based deterministic nonce for security (RFC 6979 style)
  let xHex = x.toString(16).padStart(112, '0');
  const xBytes = hexToBytes(xHex);
  const nonceHash = sha512(concatBytes(xBytes, message, new Uint8Array([0x00])));
  const k = BigInt('0x' + bytesToHex(nonceHash.slice(0, 56))) % decaf448.Point.Fn.ORDER;

  // Compute R = k * G
  const R = decaf448.Point.BASE.multiply(k);
  const RBytes = R.toBytes();

  // Compute public key P = x * G
  const P = decaf448.Point.BASE.multiply(x);
  const PBytes = P.toBytes();

  // Compute challenge e = H(R || P || message)
  const challengeInput = concatBytes(RBytes, PBytes, message);
  const challengeHash = sha512(challengeInput);
  const e = BigInt('0x' + bytesToHex(challengeHash.slice(0, 56))) % decaf448.Point.Fn.ORDER;

  // Compute s = k + e * x (mod order)
  const s = (k + e * x) % decaf448.Point.Fn.ORDER;

  // Convert s to 56 bytes (big-endian)
  let sHex = s.toString(16).padStart(112, '0');
  const sBytes = hexToBytes(sHex);

  // Signature = R || s (112 bytes total)
  const signature = concatBytes(RBytes, sBytes);

  return bytesToHex(signature);
}

/**
 * Sign a message using Decaf448 Schnorr signature scheme
 * Compatible with the server's bulletproofs SimpleSign/SimpleVerify
 *
 * Signature format: R (56 bytes) || s (56 bytes) = 112 bytes total
 *
 * @param spendKeyMaterial - The spend key material (57 bytes)
 * @param message - The message to sign (as Uint8Array)
 * @returns Hex-encoded 112-byte Schnorr signature
 */
export function signDecaf448Schnorr(spendKeyMaterial: Uint8Array, message: Uint8Array): string {
  // Derive spend private scalar from key material (same as deriveDecaf448PublicKey)
  const hash = sha512(spendKeyMaterial);
  const scalarBytes = hash.slice(0, 56);
  const x = BigInt('0x' + bytesToHex(scalarBytes)) % decaf448.Point.Fn.ORDER;

  // Generate random nonce k
  // Use HMAC-based deterministic nonce for security (RFC 6979 style)
  const nonceHash = sha512(concatBytes(scalarBytes, message, new Uint8Array([0x00])));
  const k = BigInt('0x' + bytesToHex(nonceHash.slice(0, 56))) % decaf448.Point.Fn.ORDER;

  // Compute R = k * G
  const R = decaf448.Point.BASE.multiply(k);
  const RBytes = R.toBytes();

  // Compute public key P = x * G
  const P = decaf448.Point.BASE.multiply(x);
  const PBytes = P.toBytes();

  // Compute challenge e = H(R || P || message)
  const challengeInput = concatBytes(RBytes, PBytes, message);
  const challengeHash = sha512(challengeInput);
  const e = BigInt('0x' + bytesToHex(challengeHash.slice(0, 56))) % decaf448.Point.Fn.ORDER;

  // Compute s = k + e * x (mod order)
  const s = (k + e * x) % decaf448.Point.Fn.ORDER;

  // Convert s to 56 bytes (big-endian)
  let sHex = s.toString(16).padStart(112, '0');
  const sBytes = hexToBytes(sHex);

  // Signature = R || s (112 bytes total)
  const signature = concatBytes(RBytes, sBytes);

  return bytesToHex(signature);
}

/**
 * Get spend key material for signing
 * Derives the spend key material from mnemonic or private key
 */
export function getSpendKeyMaterial(
  quilibriumAddress: string,
  mnemonic?: string[],
  hexPrivateKey?: string
): Uint8Array {
  // Parse spend public key from quilibriumAddress to verify derivation
  const cleanAddr = quilibriumAddress.replace('0x', '');
  if (cleanAddr.length !== 224) {
    throw new Error('Invalid Quilibrium address length');
  }

  const spendPubKey = hexToBytes(cleanAddr.slice(112)); // Last 56 bytes
  const spendPubKeyHex = bytesToHex(spendPubKey);

  let spendKeyMaterial: Uint8Array | null = null;

  // Try mnemonic derivation first if available
  if (mnemonic && mnemonic.length >= 12) {
    const mnemonicStr = mnemonic.map(w => w.toLowerCase().trim()).join(' ');
    const seed = bip39.mnemonicToSeedSync(mnemonicStr);
    const mnemonicSpendKeyMaterial = deriveKeyAtPath(seed, SPEND_KEY_PATH);
    const mnemonicSpendPubKey = deriveDecaf448PublicKey(mnemonicSpendKeyMaterial);

    if (bytesToHex(mnemonicSpendPubKey) === spendPubKeyHex) {
      spendKeyMaterial = mnemonicSpendKeyMaterial;
    }
  }

  // Try HKDF derivation if mnemonic didn't work
  if (!spendKeyMaterial && hexPrivateKey) {
    const textEncoder = new TextEncoder();
    const cleanHex = hexPrivateKey.replace('0x', '').trim();
    const privateKeyBytes = hexToBytes(cleanHex);
    const hkdfSpendKeyMaterial = hkdf(sha256, privateKeyBytes, undefined, textEncoder.encode('quilibrium-spend'), 57);
    const hkdfSpendPubKey = deriveDecaf448PublicKey(hkdfSpendKeyMaterial);

    if (bytesToHex(hkdfSpendPubKey) === spendPubKeyHex) {
      spendKeyMaterial = hkdfSpendKeyMaterial;
    }
  }

  if (!spendKeyMaterial) {
    throw new Error('Could not derive spendKeyMaterial that matches address');
  }

  return spendKeyMaterial;
}

/**
 * Build the message to sign for resolve key updates
 * Format: "QNS-RESOLVE-KEY:v1:<name_type>:<name>:<timestamp>:<nonce>"
 */
export function buildResolveKeyMessage(
  name: string,
  nameType: string,
  timestamp: number,
  nonce: string
): Uint8Array {
  const message = `QNS-RESOLVE-KEY:v1:${nameType.toLowerCase()}:${name.toLowerCase()}:${timestamp}:${nonce}`;
  return new TextEncoder().encode(message);
}

/**
 * Generate a random nonce for signing
 */
export function generateNonce(): string {
  // Generate 16 random bytes and convert to hex
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

// Stealth Ownership for QNS

/**
 * Stealth ownership markers for privacy-preserving name registration
 */
export interface StealthOwnership {
  oneTimeKey: Uint8Array; // R = r * G (56 bytes)
  verificationKey: Uint8Array; // P = H(shared) * G + spendPubKey (56 bytes)
  bucketTag: number; // H(shared)[0] for bucketed lookup (0-255)
}

/**
 * Generate stealth ownership markers for claiming a QNS name
 * Uses Monero-style stealth addressing for privacy
 *
 * Note: We derive r deterministically from the user's keys so the bucket tag
 * is consistent and the user knows which bucket to query for their names.
 *
 * @param quilibriumAddress - The user's Quilibrium address (0x + 224 hex)
 * @returns Stealth ownership markers (oneTimeKey, verificationKey, bucketTag)
 */
export function generateStealthOwnership(quilibriumAddress: string): StealthOwnership {
  // Parse view and spend public keys from Quilibrium address
  const cleanAddr = quilibriumAddress.replace('0x', '');
  if (cleanAddr.length !== 224) {
    throw new Error('Invalid Quilibrium address length');
  }

  const viewPubKeyBytes = hexToBytes(cleanAddr.slice(0, 112)); // First 56 bytes
  const spendPubKeyBytes = hexToBytes(cleanAddr.slice(112)); // Last 56 bytes

  // Deserialize public keys as decaf448 points
  const viewPubKey = decaf448.Point.fromBytes(viewPubKeyBytes);
  const spendPubKey = decaf448.Point.fromBytes(spendPubKeyBytes);

  // Derive r deterministically from user's public keys
  // This ensures the bucket tag is consistent for lookups
  // Add randomness per-registration by including a random nonce, but derive bucket deterministically
  const rSeed = sha512(concatBytes(viewPubKeyBytes, spendPubKeyBytes));
  const r = BigInt('0x' + bytesToHex(rSeed.slice(0, 56))) % decaf448.Point.Fn.ORDER;

  // Compute one-time key R = r * G
  const oneTimeKey = decaf448.Point.BASE.multiply(r).toBytes();

  // Compute shared secret: shared = r * viewPubKey
  const sharedPoint = viewPubKey.multiply(r);
  const shared = sha256(sharedPoint.toBytes());

  // Compute verification key: P = H(shared) * G + spendPubKey
  const hScalar = BigInt('0x' + bytesToHex(shared.slice(0, 56))) % decaf448.Point.Fn.ORDER;
  const hPoint = decaf448.Point.BASE.multiply(hScalar);
  const verificationKey = hPoint.add(spendPubKey).toBytes();

  // Compute bucket tag from shared secret (first byte)
  const bucketTag = shared[0];

  return { oneTimeKey, verificationKey, bucketTag };
}

/**
 * Convert stealth ownership to API format (base64 encoded)
 */
export function stealthOwnershipToApi(stealth: StealthOwnership): {
  type: 'quilibrium';
  one_time_key: string;
  verification_key: string;
  bucket_tag: number;
} {
  return {
    type: 'quilibrium',
    one_time_key: btoa(String.fromCharCode(...stealth.oneTimeKey)),
    verification_key: btoa(String.fromCharCode(...stealth.verificationKey)),
    bucket_tag: stealth.bucketTag,
  };
}

/**
 * Verify if a stealth ownership record belongs to us
 * Uses our view private key to check if we can derive the verification key
 *
 * @param viewPrivKey - Our view private key (derived from quilibriumAddress derivation)
 * @param spendPubKey - Our spend public key
 * @param oneTimeKey - The one-time key R from the record
 * @param verificationKey - The verification key P from the record
 * @returns true if this record belongs to us
 */
export function verifyStealthOwnership(
  viewPrivKey: Uint8Array,
  spendPubKey: Uint8Array,
  oneTimeKey: Uint8Array,
  verificationKey: Uint8Array
): boolean {
  try {
    // Deserialize points
    const R = decaf448.Point.fromBytes(oneTimeKey);
    const storedP = decaf448.Point.fromBytes(verificationKey);
    const S = decaf448.Point.fromBytes(spendPubKey);

    // Derive view scalar from view private key (same as deriveDecaf448PublicKey)
    const vHash = sha512(viewPrivKey);
    const v = BigInt('0x' + bytesToHex(vHash.slice(0, 56))) % decaf448.Point.Fn.ORDER;

    // Compute shared secret: shared = v * R
    const sharedPoint = R.multiply(v);
    const shared = sha256(sharedPoint.toBytes());

    // Compute expected verification key: P' = H(shared) * G + S
    const hScalar = BigInt('0x' + bytesToHex(shared.slice(0, 56))) % decaf448.Point.Fn.ORDER;
    const hPoint = decaf448.Point.BASE.multiply(hScalar);
    const expectedP = hPoint.add(S);

    // Check if computed P matches stored P
    return expectedP.equals(storedP);
  } catch (error) {
    return false;
  }
}

/**
 * Get view and spend key material for stealth verification
 *
 * For mnemonic-based accounts, we must derive from the seed using the same paths
 * as quilibriumAddress generation. For imported private key accounts, we use HKDF.
 *
 * @param quilibriumAddress - The user's Quilibrium address (0x + 224 hex)
 * @param mnemonic - Optional mnemonic words (required for proper verification with mnemonic accounts)
 * @param hexPrivateKey - Fallback private key (used for non-mnemonic accounts)
 */
export function getStealthKeyMaterial(
  quilibriumAddress: string,
  mnemonic?: string[],
  hexPrivateKey?: string
): {
  viewKeyMaterial: Uint8Array;
  spendPubKey: Uint8Array;
  bucketTag: number;
} {
  // Parse view + spend pubkeys from the address so bucket-tag derivation
  // matches generateStealthOwnership exactly.
  const cleanAddr = quilibriumAddress.replace('0x', '');
  if (cleanAddr.length !== 224) {
    throw new Error('Invalid Quilibrium address length');
  }

  const viewPubKey = hexToBytes(cleanAddr.slice(0, 112));
  const spendPubKey = hexToBytes(cleanAddr.slice(112));

  const rSeed = sha512(concatBytes(viewPubKey, spendPubKey));
  const r = BigInt('0x' + bytesToHex(rSeed.slice(0, 56))) % decaf448.Point.Fn.ORDER;
  const viewPoint = decaf448.Point.fromBytes(viewPubKey);
  const sharedPoint = viewPoint.multiply(r);
  const shared = sha256(sharedPoint.toBytes());
  const bucketTag = shared[0];

  // Derive view key material for verification
  // We need to try BOTH mnemonic and HKDF derivation because the quilibriumAddress
  // might have been created using either method, depending on how the account was created.
  let viewKeyMaterial: Uint8Array | null = null;
  const viewPubKeyHex = bytesToHex(viewPubKey);

  // Try mnemonic derivation first if available
  if (mnemonic && mnemonic.length >= 12) {
    const mnemonicStr = mnemonic.map(w => w.toLowerCase().trim()).join(' ');
    const seed = bip39.mnemonicToSeedSync(mnemonicStr);
    const mnemonicViewKeyMaterial = deriveKeyAtPath(seed, VIEW_KEY_PATH);
    const mnemonicViewPubKey = deriveDecaf448PublicKey(mnemonicViewKeyMaterial);

    if (bytesToHex(mnemonicViewPubKey) === viewPubKeyHex) {
      viewKeyMaterial = mnemonicViewKeyMaterial;
    }
  }

  // Try HKDF derivation if mnemonic didn't work
  if (!viewKeyMaterial && hexPrivateKey) {
    const textEncoder = new TextEncoder();
    const cleanHex = hexPrivateKey.replace('0x', '').trim();
    const privateKeyBytes = hexToBytes(cleanHex);
    const hkdfViewKeyMaterial = hkdf(sha256, privateKeyBytes, undefined, textEncoder.encode('quilibrium-view'), 57);
    const hkdfViewPubKey = deriveDecaf448PublicKey(hkdfViewKeyMaterial);

    if (bytesToHex(hkdfViewPubKey) === viewPubKeyHex) {
      viewKeyMaterial = hkdfViewKeyMaterial;
    }
  }

  if (!viewKeyMaterial) {
    throw new Error('Could not derive viewKeyMaterial that matches address');
  }

  return { viewKeyMaterial, spendPubKey, bucketTag };
}

/**
 * Build the stealth message for signing (must match server's BuildStealthMessage)
 * Format: "QNS-STEALTH:v1:<name_type>:<name>:<one_time_key>:<verification_key>:<timestamp>:<nonce>"
 */
export function buildStealthMessage(
  name: string,
  nameType: string,
  oneTimeKeyHex: string,
  verificationKeyHex: string,
  timestamp: number,
  nonce: string
): Uint8Array {
  const msg = `QNS-STEALTH:v1:${nameType.toLowerCase()}:${name.toLowerCase()}:${oneTimeKeyHex.toLowerCase()}:${verificationKeyHex.toLowerCase()}:${timestamp}:${nonce}`;
  return new TextEncoder().encode(msg);
}

/**
 * Build the resale listing message for signing
 * Format: "QNS-STEALTH:v1:<name_type>:<name>:<one_time_key>:<verification_key>:<timestamp>:<nonce>"
 * (Same format as stealth ownership signing - the signature proves ownership of the verification key)
 */
export function buildResaleMessage(
  name: string,
  nameType: string,
  oneTimeKeyHex: string,
  verificationKeyHex: string,
  timestamp: number,
  nonce: string
): Uint8Array {
  // Uses the same format as stealth ownership signing
  return buildStealthMessage(name, nameType, oneTimeKeyHex, verificationKeyHex, timestamp, nonce);
}

/**
 * Derive the stealth private key scalar for signing ownership proofs
 * x = H(viewPrivKey * oneTimeKey) + spendPrivKey
 *
 * This private key corresponds to the verificationKey stored at registration
 * verificationKey = x * G = H(shared) * G + spendPubKey
 *
 * @param viewKeyMaterial - View private key material (57 bytes)
 * @param spendKeyMaterial - Spend private key material (57 bytes)
 * @param oneTimeKey - One-time key R from registration (56 bytes)
 * @returns The derived stealth private key as a bigint scalar
 */
export function deriveStealthPrivateKeyScalar(
  viewKeyMaterial: Uint8Array,
  spendKeyMaterial: Uint8Array,
  oneTimeKey: Uint8Array
): bigint {
  // Derive view scalar from view key material
  const viewHash = sha512(viewKeyMaterial);
  const viewScalar = BigInt('0x' + bytesToHex(viewHash.slice(0, 56))) % decaf448.Point.Fn.ORDER;

  // Compute shared secret: shared = viewScalar * R (oneTimeKey)
  const R = decaf448.Point.fromBytes(oneTimeKey);
  const sharedPoint = R.multiply(viewScalar);
  const shared = sha256(sharedPoint.toBytes());

  // Derive H(shared) as a scalar
  const hShared = BigInt('0x' + bytesToHex(shared.slice(0, 56))) % decaf448.Point.Fn.ORDER;

  // Derive spend scalar from spend key material
  const spendHash = sha512(spendKeyMaterial);
  const spendScalar = BigInt('0x' + bytesToHex(spendHash.slice(0, 56))) % decaf448.Point.Fn.ORDER;

  // Compute x = H(shared) + spendScalar (mod order)
  return (hShared + spendScalar) % decaf448.Point.Fn.ORDER;
}

/**
 * Sign a stealth ownership proof
 * Uses the derived stealth private key to sign against the verificationKey
 *
 * @param viewKeyMaterial - View private key material
 * @param spendKeyMaterial - Spend private key material
 * @param oneTimeKey - One-time key from registration (56 bytes)
 * @param verificationKey - Verification key from registration (56 bytes)
 * @param name - The name being updated
 * @param nameType - "username" or "domain"
 * @param timestamp - Unix timestamp
 * @param nonce - Random nonce
 * @returns Hex-encoded Schnorr signature (112 bytes)
 */
export function signStealthOwnership(
  viewKeyMaterial: Uint8Array,
  spendKeyMaterial: Uint8Array,
  oneTimeKey: Uint8Array,
  verificationKey: Uint8Array,
  name: string,
  nameType: string,
  timestamp: number,
  nonce: string
): string {
  // Derive the stealth private key scalar
  const stealthPrivKeyScalar = deriveStealthPrivateKeyScalar(viewKeyMaterial, spendKeyMaterial, oneTimeKey);

  // Build the message to sign (includes oneTimeKey and verificationKey for binding)
  const oneTimeKeyHex = bytesToHex(oneTimeKey);
  const verificationKeyHex = bytesToHex(verificationKey);
  const message = buildStealthMessage(name, nameType, oneTimeKeyHex, verificationKeyHex, timestamp, nonce);

  // Sign with Schnorr using the stealth private key scalar directly
  return signDecaf448SchnorrWithScalar(stealthPrivKeyScalar, message);
}

/**
 * Get full stealth key material for signing ownership proofs
 * Returns both view and spend key materials plus the stealth markers from a bucket record
 *
 * @param quilibriumAddress - The user's quilibrium address
 * @param mnemonic - Optional mnemonic words
 * @param hexPrivateKey - Optional private key
 * @returns Object containing viewKeyMaterial, spendKeyMaterial, and bucketTag
 */
export function getFullStealthKeyMaterial(
  quilibriumAddress: string,
  mnemonic?: string[],
  hexPrivateKey?: string
): {
  viewKeyMaterial: Uint8Array;
  spendKeyMaterial: Uint8Array;
  bucketTag: number;
} {
  // Get spend key material
  const spendKeyMaterial = getSpendKeyMaterial(quilibriumAddress, mnemonic, hexPrivateKey);

  // Get stealth key material (includes view key material and bucket tag)
  const { viewKeyMaterial, bucketTag } = getStealthKeyMaterial(quilibriumAddress, mnemonic, hexPrivateKey);

  return { viewKeyMaterial, spendKeyMaterial, bucketTag };
}

/**
 * Sign a resale listing for a name
 * Uses the same stealth signing mechanism as signStealthOwnership
 *
 * @param viewKeyMaterial - View private key material
 * @param spendKeyMaterial - Spend private key material
 * @param oneTimeKey - One-time key from the name record (56 bytes)
 * @param verificationKey - Verification key from the name record (56 bytes)
 * @param name - The name being listed for resale
 * @param nameType - "username" or "domain"
 * @param timestamp - Unix timestamp
 * @param nonce - Random nonce
 * @returns Hex-encoded Schnorr signature (112 bytes)
 */
export function signResaleListing(
  viewKeyMaterial: Uint8Array,
  spendKeyMaterial: Uint8Array,
  oneTimeKey: Uint8Array,
  verificationKey: Uint8Array,
  name: string,
  nameType: string,
  timestamp: number,
  nonce: string
): string {
  // Resale signing uses the same stealth ownership proof
  return signStealthOwnership(
    viewKeyMaterial,
    spendKeyMaterial,
    oneTimeKey,
    verificationKey,
    name,
    nameType,
    timestamp,
    nonce
  );
}
