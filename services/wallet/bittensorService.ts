/**
 * Bittensor Service
 *
 * Provides Bittensor (TAO) address derivation and balance fetching.
 * Bittensor is a Substrate-based chain using ed25519 keys with SS58 addresses.
 *
 * References:
 * - SLIP-44 Coin Type: 1006
 * - Derivation Path: m/44'/1006'/0'/0/0
 * - Address Format: SS58 with network prefix 42
 * - Mainnet RPC: wss://entrypoint-finney.opentensor.ai:443
 */

import { HDKey } from '@scure/bip32';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { sha512 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';

// Bittensor constants
export const BITTENSOR_COIN_TYPE = 1006;
export const BITTENSOR_DERIVATION_PATH = `m/44'/${BITTENSOR_COIN_TYPE}'/0'/0/0`;
export const BITTENSOR_SS58_PREFIX = 42; // Substrate generic prefix, used by Bittensor

// RPC Proxy base URL
const RPC_PROXY_BASE = 'https://rpc-proxy.quorummessenger.com';

export interface BittensorKeys {
  address: string;
  privateKey: string;
  publicKey: string;
}

export interface BittensorBalance {
  address: string;
  balance: string; // In RAO (1 TAO = 1e9 RAO)
  balanceTao: string;
}

/**
 * SS58 checksum prefix
 */
const SS58_PREFIX = new TextEncoder().encode('SS58PRE');

/**
 * Calculate SS58 checksum
 */
function ss58Checksum(data: Uint8Array): Uint8Array {
  const input = new Uint8Array(SS58_PREFIX.length + data.length);
  input.set(SS58_PREFIX);
  input.set(data, SS58_PREFIX.length);
  return blake2b(input, { dkLen: 64 }).slice(0, 2);
}

/**
 * Encode a public key to SS58 address format
 */
export function encodeSSS58Address(publicKey: Uint8Array, prefix: number = BITTENSOR_SS58_PREFIX): string {
  if (publicKey.length !== 32) {
    throw new Error(`Invalid public key length: ${publicKey.length}, expected 32`);
  }

  // For prefix < 64, use single byte
  // For prefix >= 64, use two bytes
  let prefixBytes: Uint8Array;
  if (prefix < 64) {
    prefixBytes = new Uint8Array([prefix]);
  } else if (prefix < 16384) {
    // Two-byte encoding for larger prefixes
    const first = ((prefix & 0xfc) >> 2) | 0x40;
    const second = (prefix >> 8) | ((prefix & 0x03) << 6);
    prefixBytes = new Uint8Array([first, second]);
  } else {
    throw new Error(`SS58 prefix too large: ${prefix}`);
  }

  // Combine prefix + public key
  const payload = new Uint8Array(prefixBytes.length + publicKey.length);
  payload.set(prefixBytes);
  payload.set(publicKey, prefixBytes.length);

  // Calculate checksum
  const checksum = ss58Checksum(payload);

  // Combine all parts
  const full = new Uint8Array(payload.length + 2);
  full.set(payload);
  full.set(checksum, payload.length);

  return bs58.encode(full);
}

/**
 * Derive ed25519 key from BIP32 seed using SLIP-0010
 * Since ed25519 doesn't work with standard BIP32, we use a simplified approach
 */
function deriveEd25519FromSeed(seed: Uint8Array): { privateKey: Uint8Array; publicKey: Uint8Array } {
  // Use HMAC-SHA512 to derive ed25519 seed (SLIP-0010 style)
  // For simplicity, we'll use the first 32 bytes of the seed directly
  // A more complete implementation would follow SLIP-0010 fully

  // Hash the seed with a domain separator for Bittensor
  const hash = sha512(new Uint8Array([...seed, ...new TextEncoder().encode('bittensor')]));
  const privateKeySeed = hash.slice(0, 32);

  // Derive public key from private key seed
  const publicKey = ed25519.getPublicKey(privateKeySeed);

  return {
    privateKey: privateKeySeed,
    publicKey,
  };
}

/**
 * Derive Bittensor keys from BIP32 master key
 * Uses the derivation path m/44'/1006'/0'/0/0
 */
export function deriveBittensorKeys(masterKey: HDKey): BittensorKeys {
  // Derive using BIP32 path first to get entropy
  const derived = masterKey.derive(BITTENSOR_DERIVATION_PATH);

  if (!derived.privateKey) {
    throw new Error('Failed to derive Bittensor key');
  }

  // Use the derived key material to generate ed25519 keypair
  const { privateKey, publicKey } = deriveEd25519FromSeed(derived.privateKey);

  // Encode SS58 address
  const address = encodeSSS58Address(publicKey, BITTENSOR_SS58_PREFIX);

  return {
    address,
    privateKey: bytesToHex(privateKey),
    publicKey: bytesToHex(publicKey),
  };
}

/**
 * Derive Bittensor keys from seed bytes
 */
export function deriveBittensorKeysFromSeed(seed: Uint8Array): BittensorKeys {
  const masterKey = HDKey.fromMasterSeed(seed);
  return deriveBittensorKeys(masterKey);
}

/**
 * Convert bytes to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert hex string to bytes
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Validate a Bittensor SS58 address
 */
export function isValidBittensorAddress(address: string): boolean {
  try {
    const decoded = bs58.decode(address);
    if (decoded.length < 3) return false;

    // Check prefix byte indicates SS58 format
    const prefix = decoded[0];

    // Determine prefix byte count
    let prefixLen = 1;
    if (prefix >= 64) {
      prefixLen = 2;
    }

    // Should have prefix + 32 byte pubkey + 2 byte checksum
    if (decoded.length !== prefixLen + 32 + 2) return false;

    // Verify checksum
    const payload = decoded.slice(0, prefixLen + 32);
    const expectedChecksum = ss58Checksum(payload);
    const actualChecksum = decoded.slice(-2);

    return expectedChecksum[0] === actualChecksum[0] && expectedChecksum[1] === actualChecksum[1];
  } catch {
    return false;
  }
}

/**
 * Fetch Bittensor balance using proxy
 * Falls back to 0 if API is unavailable
 */
export async function fetchBittensorBalance(address: string): Promise<BittensorBalance> {
  try {
    // Proxy expects: POST /api/bittensor/balance with {address}
    const response = await fetch(
      `${RPC_PROXY_BASE}/api/bittensor/balance`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      }
    );

    if (response.ok) {
      const data = await response.json();
      // Balance is returned in RAO (1 TAO = 1e9 RAO)
      const balanceRao = data?.balance?.toString() || '0';
      const balanceTao = (Number(balanceRao) / 1e9).toFixed(9);

      return {
        address,
        balance: balanceRao,
        balanceTao,
      };
    }
  } catch {
    // API unavailable — fall through to zero balance
  }

  // Fallback: return zero balance
  return {
    address,
    balance: '0',
    balanceTao: '0',
  };
}

/**
 * Convert RAO to TAO
 * 1 TAO = 1,000,000,000 RAO (9 decimals)
 */
export function raoToTao(rao: string | bigint): string {
  const raoValue = typeof rao === 'string' ? BigInt(rao) : rao;
  const tao = Number(raoValue) / 1e9;
  return tao.toString();
}

/**
 * Convert TAO to RAO
 */
export function taoToRao(tao: string | number): bigint {
  const taoValue = typeof tao === 'string' ? parseFloat(tao) : tao;
  return BigInt(Math.floor(taoValue * 1e9));
}

/**
 * Get Taostats explorer URL for an address or transaction
 */
export function getBittensorExplorerUrl(hashOrAddress: string, type: 'tx' | 'address' = 'address'): string {
  if (type === 'address') {
    return `https://taostats.io/address/${hashOrAddress}`;
  }
  return `https://taostats.io/tx/${hashOrAddress}`;
}

/**
 * Fetch current TAO price from CoinGecko (via proxy)
 */
export async function fetchBittensorPrice(): Promise<number> {
  try {
    const response = await fetch(
      `${RPC_PROXY_BASE}/api/price/simple?ids=bittensor&vs_currencies=usd`
    );
    const data = await response.json();
    return data.bittensor?.usd || 0;
  } catch (error) {
    return 0;
  }
}
