/**
 * Kaspa Service
 *
 * Provides Kaspa address derivation, balance fetching, and transaction support.
 * Uses the official Kaspa REST API at api.kaspa.org
 *
 * References:
 * - SLIP-44 Coin Type: 111111
 * - Derivation Path: m/44'/111111'/0'/0/0
 * - Address Format: Bech32 with "kaspa:" prefix
 */

import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';

// Kaspa constants
export const KASPA_COIN_TYPE = 111111;
export const KASPA_DERIVATION_PATH = `m/44'/${KASPA_COIN_TYPE}'/0'/0/0`;

// RPC Proxy base URL
const RPC_PROXY_BASE = 'https://rpc-proxy.quorummessenger.com';
const KASPA_API_BASE = `${RPC_PROXY_BASE}/api/kaspa`;

// Bech32 charset for Kaspa addresses
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

// Network prefixes
type KaspaNetwork = 'mainnet' | 'testnet' | 'devnet' | 'simnet';
const NETWORK_PREFIXES: Record<KaspaNetwork, string> = {
  mainnet: 'kaspa',
  testnet: 'kaspatest',
  devnet: 'kaspadev',
  simnet: 'kaspasim',
};

// Address version bytes
const ADDRESS_VERSION_SCHNORR = 0x00; // Schnorr P2PK
const ADDRESS_VERSION_ECDSA = 0x01; // ECDSA P2PK (default for BIP32-derived keys)
const ADDRESS_VERSION_SCRIPT = 0x08; // P2SH

export interface KaspaKeys {
  address: string;
  privateKey: string;
  publicKey: string;
}

export interface KaspaBalance {
  address: string;
  balance: string; // In sompi (1 KAS = 100,000,000 sompi)
}

export interface KaspaUtxo {
  address: string;
  outpoint: {
    transactionId: string;
    index: number;
  };
  utxoEntry: {
    amount: string;
    scriptPublicKey: {
      scriptPublicKey: string;
    };
    blockDaaScore: string;
    isCoinbase: boolean;
  };
}

/**
 * Convert bytes to 5-bit words for Bech32 encoding
 */
function toWords(bytes: Uint8Array): number[] {
  const words: number[] = [];
  let value = 0;
  let bits = 0;

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((value >> bits) & 0x1f);
    }
  }

  if (bits > 0) {
    words.push((value << (5 - bits)) & 0x1f);
  }

  return words;
}

/**
 * Calculate Bech32 checksum using polymod
 */
function polymod(values: number[]): bigint {
  const GEN = [
    0x98f2bc8e61n,
    0x79b76d99e2n,
    0xf33e5fb3c4n,
    0xae2eabe2a8n,
    0x1e4f43e470n,
  ];

  let chk = 1n;
  for (const v of values) {
    const b = chk >> 35n;
    chk = ((chk & 0x07ffffffffn) << 5n) ^ BigInt(v);
    for (let i = 0; i < 5; i++) {
      if ((b >> BigInt(i)) & 1n) {
        chk ^= GEN[i];
      }
    }
  }
  return chk ^ 1n;
}

/**
 * Expand HRP (human-readable part) for checksum calculation
 */
function hrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (const c of hrp) {
    ret.push(c.charCodeAt(0) >> 5);
  }
  ret.push(0);
  for (const c of hrp) {
    ret.push(c.charCodeAt(0) & 31);
  }
  return ret;
}

/**
 * Create checksum for Bech32 encoding
 */
function createChecksum(hrp: string, data: number[]): number[] {
  const values = [...hrpExpand(hrp), ...data];
  // Pad with 8 zeros for checksum calculation
  for (let i = 0; i < 8; i++) {
    values.push(0);
  }

  const mod = polymod(values);
  const ret: number[] = [];
  for (let i = 0; i < 8; i++) {
    ret.push(Number((mod >> BigInt(5 * (7 - i))) & 31n));
  }
  return ret;
}

/**
 * Encode a Kaspa address from public key
 * Kaspa addresses use the X-coordinate of the public key (32 bytes)
 * Default version is Schnorr (0x00) which is the most common format
 */
export function encodeKaspaAddress(
  publicKeyHex: string,
  network: KaspaNetwork = 'mainnet',
  version: number = ADDRESS_VERSION_SCHNORR
): string {
  const prefix = NETWORK_PREFIXES[network];

  // For Schnorr addresses, we use only the X-coordinate (32 bytes)
  // If the public key is 33 bytes (compressed), strip the prefix byte
  // If it's 65 bytes (uncompressed), take only the X part
  let xCoordinate: Uint8Array;

  if (publicKeyHex.length === 66) {
    // 33 bytes compressed (with prefix)
    xCoordinate = hexToBytes(publicKeyHex.slice(2)); // Remove prefix byte
  } else if (publicKeyHex.length === 130) {
    // 65 bytes uncompressed
    xCoordinate = hexToBytes(publicKeyHex.slice(2, 66)); // Take X coordinate only
  } else if (publicKeyHex.length === 64) {
    // 32 bytes X-coordinate only
    xCoordinate = hexToBytes(publicKeyHex);
  } else {
    throw new Error(`Invalid public key length: ${publicKeyHex.length}`);
  }

  // Build payload: version byte + public key X-coordinate
  const payload = new Uint8Array(1 + xCoordinate.length);
  payload[0] = version;
  payload.set(xCoordinate, 1);

  // Convert to 5-bit words
  const words = toWords(payload);

  // Calculate checksum
  const checksum = createChecksum(prefix, words);

  // Encode to bech32
  const encoded = [...words, ...checksum].map((w) => CHARSET[w]).join('');

  return `${prefix}:${encoded}`;
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Derive Kaspa keys from BIP32 seed
 */
export function deriveKaspaKeys(seed: Uint8Array, network: KaspaNetwork = 'mainnet'): KaspaKeys {
  const masterKey = HDKey.fromMasterSeed(seed);
  const derivedKey = masterKey.derive(KASPA_DERIVATION_PATH);

  if (!derivedKey.privateKey || !derivedKey.publicKey) {
    throw new Error('Failed to derive Kaspa keys');
  }

  const privateKeyHex = bytesToHex(derivedKey.privateKey);
  const publicKeyHex = bytesToHex(derivedKey.publicKey);
  const address = encodeKaspaAddress(publicKeyHex, network);

  return {
    address,
    privateKey: privateKeyHex,
    publicKey: publicKeyHex,
  };
}

/**
 * Derive Kaspa keys from hex private key using HKDF
 * (For wallets imported via private key rather than mnemonic)
 */
export async function deriveKaspaKeysFromPrivateKey(
  masterPrivateKeyHex: string,
  network: KaspaNetwork = 'mainnet'
): Promise<KaspaKeys> {
  // Import hkdf dynamically since it might not be available
  const { hkdf } = await import('@noble/hashes/hkdf.js');
  const { sha256 } = await import('@noble/hashes/sha2.js');

  const masterKey = hexToBytes(masterPrivateKeyHex);
  const info = new TextEncoder().encode('kaspa-key-derivation');

  // Derive a 32-byte key using HKDF
  const derivedKey = hkdf(sha256, masterKey, undefined, info, 32);

  // Ensure the derived key is a valid secp256k1 private key
  let privateKey = derivedKey;
  const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
  let keyBigInt = BigInt('0x' + bytesToHex(privateKey));

  // Reduce if necessary
  if (keyBigInt >= n || keyBigInt === 0n) {
    keyBigInt = keyBigInt % n;
    if (keyBigInt === 0n) keyBigInt = 1n;
    privateKey = hexToBytes(keyBigInt.toString(16).padStart(64, '0'));
  }

  // Get compressed public key
  const publicKey = secp256k1.getPublicKey(privateKey, true);

  const privateKeyHex = bytesToHex(privateKey);
  const publicKeyHex = bytesToHex(publicKey);
  const address = encodeKaspaAddress(publicKeyHex, network);

  return {
    address,
    privateKey: privateKeyHex,
    publicKey: publicKeyHex,
  };
}

/**
 * Validate a Kaspa address format
 */
export function isValidKaspaAddress(address: string): boolean {
  // Check for valid prefix
  const prefixes = Object.values(NETWORK_PREFIXES);
  const hasValidPrefix = prefixes.some((prefix) => address.startsWith(`${prefix}:`));

  if (!hasValidPrefix) return false;

  // Check format: prefix:encoded (61-63 chars after prefix)
  const match = address.match(/^kaspa(test|dev|sim)?:[a-z0-9]{61,63}$/);
  return match !== null;
}

/**
 * Fetch Kaspa balance from the REST API
 */
export async function fetchKaspaBalance(address: string): Promise<KaspaBalance> {
  try {
    // Proxy expects: POST /api/kaspa/balance with {address}
    const response = await fetch(`${KASPA_API_BASE}/balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Kaspa balance: ${response.statusText}`);
    }

    const data = await response.json();
    return {
      address: data.address,
      balance: data.balance?.toString() || '0',
    };
  } catch (error) {
    return { address, balance: '0' };
  }
}

/**
 * Fetch UTXOs for a Kaspa address
 */
export async function fetchKaspaUtxos(address: string): Promise<KaspaUtxo[]> {
  try {
    // Proxy expects: POST /api/kaspa/utxos with {address}
    const response = await fetch(`${KASPA_API_BASE}/utxos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Kaspa UTXOs: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    return [];
  }
}

/**
 * Convert sompi to KAS
 * 1 KAS = 100,000,000 sompi (8 decimals, like Bitcoin satoshis)
 */
export function sompiToKas(sompi: string | bigint): string {
  const sompiValue = typeof sompi === 'string' ? BigInt(sompi) : sompi;
  const kas = Number(sompiValue) / 100_000_000;
  return kas.toString();
}

/**
 * Convert KAS to sompi
 */
export function kasToSompi(kas: string | number): bigint {
  const kasValue = typeof kas === 'string' ? parseFloat(kas) : kas;
  return BigInt(Math.floor(kasValue * 100_000_000));
}

/**
 * Get Kaspa block explorer URL for a transaction or address
 */
export function getKaspaExplorerUrl(hashOrAddress: string, type: 'tx' | 'address' = 'tx'): string {
  if (type === 'address') {
    return `https://explorer.kaspa.org/addresses/${hashOrAddress}`;
  }
  return `https://explorer.kaspa.org/txs/${hashOrAddress}`;
}

/**
 * Fetch current Kaspa price from CoinGecko (via proxy)
 */
export async function fetchKaspaPrice(): Promise<number> {
  try {
    const response = await fetch(
      `${RPC_PROXY_BASE}/api/price/simple?ids=kaspa&vs_currencies=usd`
    );
    const data = await response.json();
    return data.kaspa?.usd || 0;
  } catch (error) {
    return 0;
  }
}
