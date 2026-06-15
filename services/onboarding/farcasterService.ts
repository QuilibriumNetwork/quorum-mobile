/**
 * Farcaster key derivation and account lookup service
 *
 * Farcaster uses:
 * - Ethereum addresses for custody (BIP44 path m/44'/60'/0'/0/0)
 * - ed25519 keys for signers
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export interface FarcasterKeys {
  custodyAddress: string;      // Ethereum address (0x...)
  custodyPrivateKey: string;   // secp256k1 private key (hex) - for SIWE signing
  signerPrivateKey: string;    // ed25519 private key (hex)
  signerPublicKey: string;     // ed25519 public key (hex)
}

export interface FarcasterAccount {
  fid: number;
  username: string;
  displayName?: string;
  pfpUrl?: string;
  custodyAddress: string;
  signerPublicKey: string;
  authToken?: string;  // Auth token for Farcaster API calls
  authTokenExpiresAt?: number | null;  // Unix ms expiry of authToken (null when API omits it)
}

// BIP32 derivation for secp256k1 (Ethereum)
const HARDENED_OFFSET = 0x80000000;
const BITCOIN_SEED_KEY = new TextEncoder().encode('Bitcoin seed');
const ED25519_SEED_KEY = new TextEncoder().encode('ed25519 seed');

function ser32(i: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = (i >>> 24) & 0xff;
  buf[1] = (i >>> 16) & 0xff;
  buf[2] = (i >>> 8) & 0xff;
  buf[3] = i & 0xff;
  return buf;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Derive Ethereum address from mnemonic using BIP44 path m/44'/60'/0'/0/0
 */
export function deriveEthereumAddress(mnemonic: string): { address: string; privateKey: string } {
  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid mnemonic phrase');
  }

  const seed = bip39.mnemonicToSeedSync(mnemonic);

  // Derive master key (BIP32)
  const masterKey = hmac(sha512, BITCOIN_SEED_KEY, seed);
  let key = masterKey.slice(0, 32);
  let chainCode = masterKey.slice(32);

  // BIP44 path: m/44'/60'/0'/0/0
  const path = [
    44 + HARDENED_OFFSET,   // purpose
    60 + HARDENED_OFFSET,   // coin type (ETH)
    0 + HARDENED_OFFSET,    // account
    0,                       // change
    0,                       // address index
  ];

  for (const index of path) {
    const isHardened = index >= HARDENED_OFFSET;
    let data: Uint8Array;

    if (isHardened) {
      data = concatBytes(new Uint8Array([0]), key, ser32(index));
    } else {
      const pubKey = secp256k1.getPublicKey(key, true);
      data = concatBytes(pubKey, ser32(index));
    }

    const I = hmac(sha512, chainCode, data);

    // Add parent key to derived key (mod n)
    const IL = I.slice(0, 32);
    const IR = I.slice(32);

    // key = (IL + key) mod n
    const keyBigInt = BigInt('0x' + bytesToHex(key));
    const ILBigInt = BigInt('0x' + bytesToHex(IL));
    const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
    const newKey = (keyBigInt + ILBigInt) % n;

    key = new Uint8Array(hexToBytes(newKey.toString(16).padStart(64, '0')));
    chainCode = IR;
  }

  // Get public key and derive Ethereum address
  const publicKey = secp256k1.getPublicKey(key, false);
  // Remove the 0x04 prefix and hash
  const publicKeyWithoutPrefix = publicKey.slice(1);
  const hash = keccak_256(publicKeyWithoutPrefix);
  // Take last 20 bytes
  const address = '0x' + bytesToHex(hash.slice(-20));

  return {
    address: address.toLowerCase(),
    privateKey: bytesToHex(key),
  };
}

/**
 * Derive ed25519 signer keys from mnemonic
 * Uses a deterministic derivation from the seed
 */
export function deriveSignerKeys(mnemonic: string): { privateKey: string; publicKey: string } {
  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid mnemonic phrase');
  }

  const seed = bip39.mnemonicToSeedSync(mnemonic);

  // Derive ed25519 key using SLIP-0010
  const masterKey = hmac(sha512, ED25519_SEED_KEY, seed);
  let key = masterKey.slice(0, 32);
  let chainCode = masterKey.slice(32);

  // Use a Farcaster-specific derivation path: m/44'/60'/0'/0/0 (same indices, different curve)
  // This ensures the signer is deterministically derived from the mnemonic
  const path = [
    44 + HARDENED_OFFSET,
    60 + HARDENED_OFFSET,
    0 + HARDENED_OFFSET,
    0 + HARDENED_OFFSET,  // ed25519 only supports hardened derivation
    0 + HARDENED_OFFSET,
  ];

  for (const index of path) {
    const data = concatBytes(new Uint8Array([0]), key, ser32(index));
    const I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }

  const publicKey = ed25519.getPublicKey(key);

  return {
    privateKey: bytesToHex(key),
    publicKey: bytesToHex(publicKey),
  };
}

/**
 * Derive all Farcaster keys from a mnemonic
 */
export function deriveFarcasterKeys(words: string[]): FarcasterKeys {
  const mnemonic = words.map(w => w.toLowerCase().trim()).join(' ');

  const { address, privateKey: custodyPrivateKey } = deriveEthereumAddress(mnemonic);
  const { privateKey, publicKey } = deriveSignerKeys(mnemonic);

  return {
    custodyAddress: address,
    custodyPrivateKey,
    signerPrivateKey: privateKey,
    signerPublicKey: publicKey,
  };
}

// Farcaster API configuration
const FARCASTER_API_BASE_URL = 'https://client.farcaster.xyz';
const DEFAULT_AUTH_TOKEN_EXPIRES_IN = 1000 * 24 * 60 * 60 * 1000; // 1000 days

/**
 * Canonicalize an object for signing (deterministic JSON stringification)
 * Uses a simple implementation that matches the canonicalize package behavior
 */
function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(obj as object).sort();
  const pairs = keys.map(key => {
    const value = (obj as Record<string, unknown>)[key];
    return JSON.stringify(key) + ':' + canonicalize(value);
  });
  return '{' + pairs.join(',') + '}';
}

/**
 * Build the custody bearer payload for auth token generation
 */
function buildCustodyBearerPayload(expiresIn: number = DEFAULT_AUTH_TOKEN_EXPIRES_IN) {
  const timestamp = Date.now();
  return {
    method: 'generateToken' as const,
    params: {
      timestamp,
      expiresAt: timestamp + expiresIn,
    },
  };
}

/**
 * Build the custody bearer token (signed payload)
 * @param payload - The auth request payload
 * @param privateKeyHex - The custody private key in hex format
 * @returns The bearer token string (eip191: prefix + base64 signature)
 */
function buildCustodyBearerToken(
  payload: ReturnType<typeof buildCustodyBearerPayload>,
  privateKeyHex: string
): string {
  const canonicalizedPayload = canonicalize(payload);
  const signature = signPersonalMessage(canonicalizedPayload, privateKeyHex);

  // Convert hex signature to bytes then base64
  // Remove 0x prefix
  const sigHex = signature.startsWith('0x') ? signature.slice(2) : signature;
  const sigBytes = hexToBytes(sigHex);
  const sigBase64 = btoa(String.fromCharCode(...sigBytes));

  return 'eip191:' + sigBase64;
}

/**
 * Look up FID and user info from custody address via official Farcaster API
 * Uses the /v2/onboarding-state endpoint with custody bearer authentication
 */
export async function lookupFarcasterAccount(
  custodyAddress: string,
  custodyPrivateKey: string
): Promise<FarcasterAccount | null> {
  try {
    // Build the auth request payload
    const authRequest = buildCustodyBearerPayload();

    // Build the bearer token
    const bearerToken = buildCustodyBearerToken(authRequest, custodyPrivateKey);

    // Call the Farcaster API to get onboarding state and auth token
    const response = await fetch(
      `${FARCASTER_API_BASE_URL}/v2/onboarding-state`,
      {
        method: 'PUT',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({ authRequest }),
      }
    );

    if (!response.ok) {
      if (response.status === 404 || response.status === 401) {
        return null; // No account found for this address
      }
      const errorText = await response.text();
      throw new Error(`Farcaster API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    // Check if user exists in the onboarding state
    if (!data.result?.state?.user) {
      return null;
    }

    const user = data.result.state.user;
    // Token is an object with { secret, expiresAt } — expiresAt is unix ms
    // (mirrors the request's own params.expiresAt in buildCustodyBearerPayload).
    const tokenObj = data.result?.token;
    const authToken = tokenObj?.secret;
    const authTokenExpiresAt =
      typeof tokenObj?.expiresAt === 'number' ? tokenObj.expiresAt : null;

    return {
      fid: user.fid,
      username: user.username,
      displayName: user.displayName,
      pfpUrl: user.pfp?.url,
      custodyAddress: custodyAddress,
      signerPublicKey: '', // Will be set by caller
      authToken,
      authTokenExpiresAt,
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Refresh/fetch the Farcaster auth token using custody key
 * Use this when we have custody key but no stored auth token
 */
export async function refreshFarcasterAuthToken(
  custodyPrivateKey: string
): Promise<{ secret: string; expiresAt: number | null } | null> {
  try {
    // Build the auth request payload
    const authRequest = buildCustodyBearerPayload();

    // Build the bearer token
    const bearerToken = buildCustodyBearerToken(authRequest, custodyPrivateKey);

    // Call the Farcaster API to get auth token
    const response = await fetch(
      `${FARCASTER_API_BASE_URL}/v2/onboarding-state`,
      {
        method: 'PUT',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({ authRequest }),
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    // Token is an object with { secret, expiresAt } — expiresAt is unix ms
    // (mirrors the request's own params.expiresAt in buildCustodyBearerPayload).
    const tokenObj = data.result?.token;
    const authToken = tokenObj?.secret;
    if (typeof authToken !== 'string') return null;

    return {
      secret: authToken,
      expiresAt: typeof tokenObj?.expiresAt === 'number' ? tokenObj.expiresAt : null,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Validate mnemonic for Farcaster (12 or 24 words)
 */
export function validateFarcasterMnemonic(words: string[]): boolean {
  const mnemonic = words.map(w => w.toLowerCase().trim()).join(' ');
  return bip39.validateMnemonic(mnemonic, wordlist);
}

// SIWE (Sign-In with Ethereum)

/**
 * Convert an Ethereum address to EIP-55 checksum format
 * Required by EIP-4361 (SIWE)
 */
export function toChecksumAddress(address: string): string {
  // Remove 0x prefix and convert to lowercase
  const addr = address.toLowerCase().replace('0x', '');

  // Hash the lowercase address
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(addr)));

  // Build checksum address
  let checksumAddress = '0x';
  for (let i = 0; i < addr.length; i++) {
    // If the hash character is 8 or higher, uppercase the address character
    if (parseInt(hash[i], 16) >= 8) {
      checksumAddress += addr[i].toUpperCase();
    } else {
      checksumAddress += addr[i];
    }
  }

  return checksumAddress;
}

export interface SiweMessage {
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  version: string;
  chainId: number;
  nonce?: string;
  issuedAt: string;
  expirationTime?: string;
  notBefore?: string;
  resources?: string[];
}

/**
 * Create a SIWE (Sign-In with Ethereum) message string
 * Format follows EIP-4361
 */
export function createSiweMessage(params: SiweMessage): string {
  const lines: string[] = [];

  // Header
  lines.push(`${params.domain} wants you to sign in with your Ethereum account:`);
  lines.push(params.address);
  lines.push('');

  // Statement (optional)
  if (params.statement) {
    lines.push(params.statement);
    lines.push('');
  }

  // Required fields
  lines.push(`URI: ${params.uri}`);
  lines.push(`Version: ${params.version}`);
  lines.push(`Chain ID: ${params.chainId}`);
  if (params.nonce) {
    lines.push(`Nonce: ${params.nonce}`);
  }
  lines.push(`Issued At: ${params.issuedAt}`);

  // Optional fields
  if (params.expirationTime) {
    lines.push(`Expiration Time: ${params.expirationTime}`);
  }
  if (params.notBefore) {
    lines.push(`Not Before: ${params.notBefore}`);
  }

  // Resources (optional)
  if (params.resources && params.resources.length > 0) {
    lines.push('Resources:');
    for (const resource of params.resources) {
      lines.push(`- ${resource}`);
    }
  }

  return lines.join('\n');
}

/**
 * Sign a message using EIP-191 personal sign
 * This is how Ethereum wallets sign messages for authentication
 *
 * @param message - The message to sign
 * @param privateKeyHex - The private key in hex format (without 0x prefix)
 * @returns The signature in hex format with 0x prefix
 */
export function signPersonalMessage(message: string, privateKeyHex: string): string {
  // EIP-191 prefix: "\x19Ethereum Signed Message:\n" + message length
  const prefix = '\x19Ethereum Signed Message:\n';
  const messageBytes = new TextEncoder().encode(message);
  const prefixedMessage = prefix + messageBytes.length + message;

  // Hash the prefixed message with keccak256
  const messageHash = keccak_256(new TextEncoder().encode(prefixedMessage));

  // Sign the hash with secp256k1
  const privateKey = hexToBytes(privateKeyHex);

  // sign() returns Uint8Array in compact format: [r (32), s (32)] = 64 bytes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sigBytes: Uint8Array = (secp256k1 as any).sign(messageHash, privateKey, { lowS: true, prehash: false });

  // Parse signature bytes - r and s are each 32 bytes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Signature = (secp256k1 as any).Signature;
  const sig = Signature.fromBytes(sigBytes);

  // Get r and s as hex strings
  const r: string = sig.r.toString(16).padStart(64, '0');
  const s: string = sig.s.toString(16).padStart(64, '0');

  // Compute recovery bit by trying both values
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  let recovery = 0;

  for (let v = 0; v <= 1; v++) {
    try {
      // Add recovery bit and try to recover public key
      const sigWithRecovery = sig.addRecoveryBit(v);
      const recovered = sigWithRecovery.recoverPublicKey(messageHash);
      const recoveredBytes: Uint8Array = recovered.toBytes(false); // uncompressed
      if (bytesToHex(recoveredBytes) === bytesToHex(publicKey)) {
        recovery = v;
        break;
      }
    } catch {
      continue;
    }
  }

  // Ethereum signature format: r (32) + s (32) + v (1), where v = recovery + 27
  const vHex = (recovery + 27).toString(16).padStart(2, '0');

  return '0x' + r + s + vHex;
}

/**
 * Create and sign a SIWE message for mini app authentication
 */
export function createSignedSiweMessage(
  domain: string,
  uri: string,
  custodyAddress: string,
  custodyPrivateKey: string,
  fid: number,
  options?: {
    nonce?: string;
    notBefore?: string;
    expirationTime?: string;
  }
): { message: string; signature: string } {
  const now = new Date();

  // EIP-4361 requires EIP-55 checksum address
  const checksumAddress = toChecksumAddress(custodyAddress);

  const siweParams: SiweMessage = {
    domain,
    address: checksumAddress,
    statement: 'Farcaster Auth',
    uri,
    version: '1',
    chainId: 10, // Optimism
    nonce: options?.nonce,
    issuedAt: now.toISOString(),
    expirationTime: options?.expirationTime,
    notBefore: options?.notBefore,
    resources: [`farcaster://fid/${fid}`],
  };

  const message = createSiweMessage(siweParams);
  const signature = signPersonalMessage(message, custodyPrivateKey);

  return { message, signature };
}

// Profile Fetching

/**
 * Fetch a Farcaster user's profile by FID
 * Uses the public Farcaster API to get profile info including pfpUrl
 */
export async function fetchFarcasterProfileByFid(fid: number): Promise<{
  fid: number;
  username?: string;
  displayName?: string;
  pfpUrl?: string;
} | null> {
  try {
    const response = await fetch(
      `${FARCASTER_API_BASE_URL}/v2/user-by-fid?fid=${fid}`,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const user = data.result?.user;

    if (!user) {
      return null;
    }

    return {
      fid: user.fid,
      username: user.username,
      displayName: user.displayName,
      pfpUrl: user.pfp?.url,
    };
  } catch (error) {
    return null;
  }
}
