/**
 * Multi-chain wallet derivation service
 *
 * Derives wallet addresses for Ethereum, Bitcoin, and Solana from
 * the same BIP39 mnemonic used for Quilibrium keys.
 *
 * Standard derivation paths:
 * - Ethereum: m/44'/60'/0'/0/0
 * - Bitcoin Legacy (P2PKH): m/44'/0'/0'/0/0
 * - Bitcoin SegWit (P2SH-P2WPKH): m/49'/0'/0'/0/0
 * - Bitcoin Native SegWit (P2WPKH): m/84'/0'/0'/0/0
 * - Solana: m/44'/501'/0'/0'
 */

import { HDKey } from '@scure/bip32';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import bs58 from 'bs58';

// BIP44/49/84 coin types
const COIN_TYPE_BTC = 0;
const COIN_TYPE_ETH = 60;
const COIN_TYPE_SOL = 501;
const COIN_TYPE_KASPA = 111111;
const COIN_TYPE_BITTENSOR = 1006;
const COIN_TYPE_TEZOS = 1729;

// Bitcoin address types
export type BitcoinAddressType = 'legacy' | 'segwit' | 'native-segwit';

export interface BitcoinAddresses {
  legacy: string;      // P2PKH - starts with 1
  segwit: string;      // P2SH-P2WPKH - starts with 3
  nativeSegwit: string; // P2WPKH (Bech32) - starts with bc1q
}

export interface TezosAddresses {
  /** SLIP-10 Ed25519 derivation — interoperable with Temple, Kukai,
   *  AirGap, Ledger Live, etc. This is the default for any UI that
   *  shows "the user's Tezos address." */
  slip10: string;
  /** BIP32 (secp256k1) bytes used as an Ed25519 seed. Mirrors the
   *  non-standard pattern used for Solana/Bittensor in this codebase.
   *  Exposed for users who want continuity with how Solana derives
   *  here. NOT compatible with mainstream Tezos wallets. */
  bip32: string;
}

export interface ChainAddresses {
  ethereum: string;
  bitcoin: BitcoinAddresses;
  solana: string;
  kaspa: string;
  bittensor: string;
  tezos: TezosAddresses;
}

export interface BitcoinKeys {
  legacy: {
    address: string;
    privateKey: string;  // WIF format
    publicKey: string;
    path: string;
  };
  segwit: {
    address: string;
    privateKey: string;
    publicKey: string;
    path: string;
  };
  nativeSegwit: {
    address: string;
    privateKey: string;
    publicKey: string;
    path: string;
  };
}

export interface TezosKeys {
  slip10: {
    address: string;     // tz1...
    privateKey: string;  // hex (32-byte Ed25519 seed)
    publicKey: string;   // hex
  };
  bip32: {
    address: string;
    privateKey: string;
    publicKey: string;
  };
}

export interface ChainKeys {
  ethereum: {
    address: string;
    privateKey: string;
    publicKey: string;
  };
  bitcoin: BitcoinKeys;
  solana: {
    address: string;
    privateKey: string;  // base58
    publicKey: string;
  };
  kaspa: {
    address: string;
    privateKey: string;
    publicKey: string;
  };
  bittensor: {
    address: string;
    privateKey: string;
    publicKey: string;
  };
  tezos: TezosKeys;
}

// Helper to yield to the UI thread
const yieldToUI = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * Derive multi-chain addresses from a BIP39 mnemonic
 */
export function deriveMultiChainAddresses(mnemonic: string[]): ChainAddresses {
  const keys = deriveMultiChainKeys(mnemonic);
  return {
    ethereum: keys.ethereum.address,
    bitcoin: {
      legacy: keys.bitcoin.legacy.address,
      segwit: keys.bitcoin.segwit.address,
      nativeSegwit: keys.bitcoin.nativeSegwit.address,
    },
    solana: keys.solana.address,
    kaspa: keys.kaspa.address,
    bittensor: keys.bittensor.address,
    tezos: {
      slip10: keys.tezos.slip10.address,
      bip32: keys.tezos.bip32.address,
    },
  };
}

/**
 * Derive multi-chain addresses from a BIP39 mnemonic (async version with UI yields)
 * This breaks up the CPU-intensive work to prevent UI freezing
 */
export async function deriveMultiChainAddressesAsync(mnemonic: string[]): Promise<ChainAddresses> {
  const keys = await deriveMultiChainKeysAsync(mnemonic);
  return {
    ethereum: keys.ethereum.address,
    bitcoin: {
      legacy: keys.bitcoin.legacy.address,
      segwit: keys.bitcoin.segwit.address,
      nativeSegwit: keys.bitcoin.nativeSegwit.address,
    },
    solana: keys.solana.address,
    kaspa: keys.kaspa.address,
    bittensor: keys.bittensor.address,
    tezos: {
      slip10: keys.tezos.slip10.address,
      bip32: keys.tezos.bip32.address,
    },
  };
}

/**
 * Derive full key material for all chains from a BIP39 mnemonic
 */
export function deriveMultiChainKeys(mnemonic: string[]): ChainKeys {
  const mnemonicStr = mnemonic.map(w => w.toLowerCase().trim()).join(' ');

  if (!bip39.validateMnemonic(mnemonicStr, wordlist)) {
    throw new Error('Invalid mnemonic phrase');
  }

  const seed = bip39.mnemonicToSeedSync(mnemonicStr);
  const masterKey = HDKey.fromMasterSeed(seed);

  return {
    ethereum: deriveEthereumKey(masterKey),
    bitcoin: deriveBitcoinKeys(masterKey),
    solana: deriveSolanaKey(masterKey),
    kaspa: deriveKaspaKey(masterKey),
    bittensor: deriveBittensorKey(masterKey),
    tezos: deriveTezosKey(seed, masterKey),
  };
}

/**
 * Derive full key material for all chains from a BIP39 mnemonic (async version)
 * Yields to the UI thread between each chain derivation to prevent freezing
 */
export async function deriveMultiChainKeysAsync(mnemonic: string[]): Promise<ChainKeys> {
  const mnemonicStr = mnemonic.map(w => w.toLowerCase().trim()).join(' ');

  if (!bip39.validateMnemonic(mnemonicStr, wordlist)) {
    throw new Error('Invalid mnemonic phrase');
  }

  // Use async seed derivation - this is the heaviest operation
  // mnemonicToSeed uses PBKDF2 which is intentionally slow
  const seed = await bip39.mnemonicToSeed(mnemonicStr);
  await yieldToUI();

  const masterKey = HDKey.fromMasterSeed(seed);
  await yieldToUI();

  // Derive each chain with yields between
  const ethereum = deriveEthereumKey(masterKey);
  await yieldToUI();

  const bitcoin = deriveBitcoinKeys(masterKey);
  await yieldToUI();

  const solana = deriveSolanaKey(masterKey);
  await yieldToUI();

  const kaspa = deriveKaspaKey(masterKey);
  await yieldToUI();

  const bittensor = deriveBittensorKey(masterKey);
  await yieldToUI();

  const tezos = deriveTezosKey(seed, masterKey);

  return { ethereum, bitcoin, solana, kaspa, bittensor, tezos };
}

/**
 * Derive multi-chain addresses from a hex private key (for non-mnemonic accounts)
 * Uses HKDF to derive deterministic keys for each chain from the master private key
 */
export function deriveMultiChainAddressesFromPrivateKey(hexPrivateKey: string): ChainAddresses {
  const keys = deriveMultiChainKeysFromPrivateKey(hexPrivateKey);
  return {
    ethereum: keys.ethereum.address,
    bitcoin: {
      legacy: keys.bitcoin.legacy.address,
      segwit: keys.bitcoin.segwit.address,
      nativeSegwit: keys.bitcoin.nativeSegwit.address,
    },
    solana: keys.solana.address,
    kaspa: keys.kaspa.address,
    bittensor: keys.bittensor.address,
    tezos: {
      slip10: keys.tezos.slip10.address,
      bip32: keys.tezos.bip32.address,
    },
  };
}

/**
 * Derive multi-chain addresses from a hex private key (async version with UI yields)
 */
export async function deriveMultiChainAddressesFromPrivateKeyAsync(hexPrivateKey: string): Promise<ChainAddresses> {
  const keys = await deriveMultiChainKeysFromPrivateKeyAsync(hexPrivateKey);
  return {
    ethereum: keys.ethereum.address,
    bitcoin: {
      legacy: keys.bitcoin.legacy.address,
      segwit: keys.bitcoin.segwit.address,
      nativeSegwit: keys.bitcoin.nativeSegwit.address,
    },
    solana: keys.solana.address,
    kaspa: keys.kaspa.address,
    bittensor: keys.bittensor.address,
    tezos: {
      slip10: keys.tezos.slip10.address,
      bip32: keys.tezos.bip32.address,
    },
  };
}

/**
 * Derive full key material for all chains from a hex private key
 * Uses HKDF to deterministically derive keys for each chain
 */
export function deriveMultiChainKeysFromPrivateKey(hexPrivateKey: string): ChainKeys {
  // Clean up the hex string
  const cleanHex = hexPrivateKey.replace(/^0x/i, '');
  const privateKeyBytes = hexToBytes(cleanHex);

  // Use HKDF to derive a 64-byte seed that can be used with HDKey
  // This creates a deterministic seed from the private key
  const salt = new TextEncoder().encode('quorum-multichain-wallet');
  const info = new TextEncoder().encode('master-seed');
  const seed = hkdf(sha256, privateKeyBytes, salt, info, 64);

  // Create HD key from the derived seed
  const masterKey = HDKey.fromMasterSeed(seed);

  return {
    ethereum: deriveEthereumKey(masterKey),
    bitcoin: deriveBitcoinKeys(masterKey),
    solana: deriveSolanaKey(masterKey),
    kaspa: deriveKaspaKey(masterKey),
    bittensor: deriveBittensorKey(masterKey),
    tezos: deriveTezosKey(seed, masterKey),
  };
}

/**
 * Derive full key material for all chains from a hex private key (async version)
 * Yields to the UI thread between each chain derivation
 */
export async function deriveMultiChainKeysFromPrivateKeyAsync(hexPrivateKey: string): Promise<ChainKeys> {
  // Clean up the hex string
  const cleanHex = hexPrivateKey.replace(/^0x/i, '');
  const privateKeyBytes = hexToBytes(cleanHex);

  // Use HKDF to derive a 64-byte seed that can be used with HDKey
  const salt = new TextEncoder().encode('quorum-multichain-wallet');
  const info = new TextEncoder().encode('master-seed');
  const seed = hkdf(sha256, privateKeyBytes, salt, info, 64);
  await yieldToUI();

  // Create HD key from the derived seed
  const masterKey = HDKey.fromMasterSeed(seed);
  await yieldToUI();

  // Derive each chain with yields between
  const ethereum = deriveEthereumKey(masterKey);
  await yieldToUI();

  const bitcoin = deriveBitcoinKeys(masterKey);
  await yieldToUI();

  const solana = deriveSolanaKey(masterKey);
  await yieldToUI();

  const kaspa = deriveKaspaKey(masterKey);
  await yieldToUI();

  const bittensor = deriveBittensorKey(masterKey);
  await yieldToUI();

  const tezos = deriveTezosKey(seed, masterKey);

  return { ethereum, bitcoin, solana, kaspa, bittensor, tezos };
}

/**
 * Derive Ethereum key and address
 * Path: m/44'/60'/0'/0/0
 */
function deriveEthereumKey(masterKey: HDKey): ChainKeys['ethereum'] {
  const path = `m/44'/${COIN_TYPE_ETH}'/0'/0/0`;
  const derived = masterKey.derive(path);

  if (!derived.privateKey || !derived.publicKey) {
    throw new Error('Failed to derive Ethereum key');
  }

  const privateKey = bytesToHex(derived.privateKey);
  const publicKey = bytesToHex(derived.publicKey);

  // Ethereum address = keccak256(uncompressed pubkey without prefix)[12:]
  // Using dynamic import for keccak since it's a viem dependency
  const address = ethereumAddressFromPublicKey(derived.publicKey);

  return {
    address,
    privateKey,
    publicKey,
  };
}

/**
 * Derive Ethereum address from compressed public key
 */
function ethereumAddressFromPublicKey(compressedPubKey: Uint8Array): string {
  // Decompress the public key (secp256k1)
  const uncompressedPubKey = decompressSecp256k1PublicKey(compressedPubKey);

  // Remove the 0x04 prefix (uncompressed marker)
  const pubKeyWithoutPrefix = uncompressedPubKey.slice(1);

  // Keccak256 hash
  const hash = keccak256(pubKeyWithoutPrefix);

  // Take last 20 bytes
  const addressBytes = hash.slice(-20);

  // Checksum encode
  return checksumAddress('0x' + bytesToHex(addressBytes));
}

/**
 * Decompress a secp256k1 compressed public key
 */
function decompressSecp256k1PublicKey(compressed: Uint8Array): Uint8Array {
  if (compressed.length !== 33) {
    throw new Error('Invalid compressed public key length');
  }

  const prefix = compressed[0];
  const x = BigInt('0x' + bytesToHex(compressed.slice(1)));

  // secp256k1 curve parameters
  const p = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F');
  const a = BigInt(0);
  const b = BigInt(7);

  // y² = x³ + ax + b (mod p)
  const ySquared = (modPow(x, BigInt(3), p) + a * x + b) % p;

  // y = ySquared^((p+1)/4) mod p (since p ≡ 3 mod 4)
  let y = modPow(ySquared, (p + BigInt(1)) / BigInt(4), p);

  // Check parity
  const isOdd = y % BigInt(2) === BigInt(1);
  const shouldBeOdd = prefix === 0x03;

  if (isOdd !== shouldBeOdd) {
    y = p - y;
  }

  // Construct uncompressed key (0x04 || x || y)
  const result = new Uint8Array(65);
  result[0] = 0x04;

  const xBytes = hexToBytes(x.toString(16).padStart(64, '0'));
  const yBytes = hexToBytes(y.toString(16).padStart(64, '0'));

  result.set(xBytes, 1);
  result.set(yBytes, 33);

  return result;
}

/**
 * Modular exponentiation
 */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = BigInt(1);
  base = base % mod;
  while (exp > BigInt(0)) {
    if (exp % BigInt(2) === BigInt(1)) {
      result = (result * base) % mod;
    }
    exp = exp / BigInt(2);
    base = (base * base) % mod;
  }
  return result;
}

/**
 * Keccak256 hash (for Ethereum)
 */
function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

/**
 * EIP-55 checksum encoding for Ethereum address
 */
function checksumAddress(address: string): string {
  const addr = address.toLowerCase().replace('0x', '');
  const hash = bytesToHex(keccak256(new TextEncoder().encode(addr)));

  let checksummed = '0x';
  for (let i = 0; i < addr.length; i++) {
    if (parseInt(hash[i], 16) >= 8) {
      checksummed += addr[i].toUpperCase();
    } else {
      checksummed += addr[i];
    }
  }

  return checksummed;
}

/**
 * Derive all Bitcoin keys and addresses (Legacy, SegWit, Native SegWit)
 */
function deriveBitcoinKeys(masterKey: HDKey): BitcoinKeys {
  return {
    legacy: deriveBitcoinLegacy(masterKey),
    segwit: deriveBitcoinSegwit(masterKey),
    nativeSegwit: deriveBitcoinNativeSegwit(masterKey),
  };
}

/**
 * Derive Bitcoin Legacy (P2PKH) key and address
 * Path: m/44'/0'/0'/0/0
 * Address starts with '1'
 */
function deriveBitcoinLegacy(masterKey: HDKey): BitcoinKeys['legacy'] {
  const path = `m/44'/${COIN_TYPE_BTC}'/0'/0/0`;
  const derived = masterKey.derive(path);

  if (!derived.privateKey || !derived.publicKey) {
    throw new Error('Failed to derive Bitcoin legacy key');
  }

  const privateKey = privateKeyToWIF(derived.privateKey, true);
  const publicKey = bytesToHex(derived.publicKey);
  const address = bitcoinP2PKHAddress(derived.publicKey);

  return { address, privateKey, publicKey, path };
}

/**
 * Derive Bitcoin SegWit (P2SH-P2WPKH) key and address
 * Path: m/49'/0'/0'/0/0 (BIP49)
 * Address starts with '3'
 */
function deriveBitcoinSegwit(masterKey: HDKey): BitcoinKeys['segwit'] {
  const path = `m/49'/${COIN_TYPE_BTC}'/0'/0/0`;
  const derived = masterKey.derive(path);

  if (!derived.privateKey || !derived.publicKey) {
    throw new Error('Failed to derive Bitcoin SegWit key');
  }

  const privateKey = privateKeyToWIF(derived.privateKey, true);
  const publicKey = bytesToHex(derived.publicKey);
  const address = bitcoinP2SHP2WPKHAddress(derived.publicKey);

  return { address, privateKey, publicKey, path };
}

/**
 * Derive Bitcoin Native SegWit (P2WPKH / Bech32) key and address
 * Path: m/84'/0'/0'/0/0 (BIP84)
 * Address starts with 'bc1q'
 */
function deriveBitcoinNativeSegwit(masterKey: HDKey): BitcoinKeys['nativeSegwit'] {
  const path = `m/84'/${COIN_TYPE_BTC}'/0'/0/0`;
  const derived = masterKey.derive(path);

  if (!derived.privateKey || !derived.publicKey) {
    throw new Error('Failed to derive Bitcoin Native SegWit key');
  }

  const privateKey = privateKeyToWIF(derived.privateKey, true);
  const publicKey = bytesToHex(derived.publicKey);
  const address = bitcoinBech32Address(derived.publicKey);

  return { address, privateKey, publicKey, path };
}

/**
 * Convert private key to WIF (Wallet Import Format)
 */
function privateKeyToWIF(privateKey: Uint8Array, mainnet: boolean = true): string {
  // WIF: version (1) + key (32) + compression flag (1) + checksum (4)
  const version = mainnet ? 0x80 : 0xef;

  const data = new Uint8Array(34);
  data[0] = version;
  data.set(privateKey, 1);
  data[33] = 0x01; // compressed

  return base58CheckEncode(data);
}

/**
 * Hash160 = RIPEMD160(SHA256(data))
 */
function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/**
 * Base58Check encoding (without Buffer dependency)
 * Format: base58(data || sha256(sha256(data))[0:4])
 */
function base58CheckEncode(data: Uint8Array): string {
  const checksum = sha256(sha256(data)).slice(0, 4);
  const dataWithChecksum = new Uint8Array(data.length + 4);
  dataWithChecksum.set(data, 0);
  dataWithChecksum.set(checksum, data.length);
  return bs58.encode(dataWithChecksum);
}

/**
 * Derive Bitcoin P2PKH (Legacy) address from compressed public key
 * Format: Base58Check(0x00 || Hash160(pubkey))
 */
function bitcoinP2PKHAddress(publicKey: Uint8Array): string {
  const pubkeyHash = hash160(publicKey);

  // P2PKH address: version (0x00 for mainnet) + hash160 (20 bytes)
  const data = new Uint8Array(21);
  data[0] = 0x00; // mainnet P2PKH version
  data.set(pubkeyHash, 1);

  return base58CheckEncode(data);
}

/**
 * Derive Bitcoin P2SH-P2WPKH (SegWit wrapped) address from compressed public key
 * Format: Base58Check(0x05 || Hash160(0x0014 || Hash160(pubkey)))
 */
function bitcoinP2SHP2WPKHAddress(publicKey: Uint8Array): string {
  const pubkeyHash = hash160(publicKey);

  // Create witness program: OP_0 (0x00) + push 20 bytes (0x14) + pubkey hash
  const witnessProgram = new Uint8Array(22);
  witnessProgram[0] = 0x00; // OP_0
  witnessProgram[1] = 0x14; // Push 20 bytes
  witnessProgram.set(pubkeyHash, 2);

  // Hash the witness program
  const scriptHash = hash160(witnessProgram);

  // P2SH address: version (0x05 for mainnet) + script hash (20 bytes)
  const data = new Uint8Array(21);
  data[0] = 0x05; // mainnet P2SH version
  data.set(scriptHash, 1);

  return base58CheckEncode(data);
}

/**
 * Derive Bitcoin Bech32 (Native SegWit P2WPKH) address from compressed public key
 * Format: bc1q + bech32(Hash160(pubkey))
 */
function bitcoinBech32Address(publicKey: Uint8Array): string {
  const pubkeyHash = hash160(publicKey);
  return bech32Encode('bc', 0, pubkeyHash);
}

/**
 * Bech32 encoding for Bitcoin addresses
 */
function bech32Encode(hrp: string, version: number, data: Uint8Array): string {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

  // Convert 8-bit data to 5-bit groups
  const converted = convertBits(data, 8, 5, true);
  if (!converted) throw new Error('Failed to convert bits for bech32');

  // Prepend version
  const values = [version, ...converted];

  // Calculate checksum
  const polymod = (values: number[]): number => {
    let chk = 1;
    for (const v of values) {
      const top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) {
        if ((top >> i) & 1) {
          chk ^= GENERATOR[i];
        }
      }
    }
    return chk;
  };

  const hrpExpand = (hrp: string): number[] => {
    const result: number[] = [];
    for (let i = 0; i < hrp.length; i++) {
      result.push(hrp.charCodeAt(i) >> 5);
    }
    result.push(0);
    for (let i = 0; i < hrp.length; i++) {
      result.push(hrp.charCodeAt(i) & 31);
    }
    return result;
  };

  const createChecksum = (hrp: string, data: number[]): number[] => {
    const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
    const mod = polymod(values) ^ 1;
    const result: number[] = [];
    for (let i = 0; i < 6; i++) {
      result.push((mod >> (5 * (5 - i))) & 31);
    }
    return result;
  };

  const checksum = createChecksum(hrp, values);
  const combined = [...values, ...checksum];

  let result = hrp + '1';
  for (const v of combined) {
    result += CHARSET[v];
  }

  return result;
}

/**
 * Convert between bit groups (for bech32 encoding)
 */
function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxv = (1 << toBits) - 1;

  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) {
      return null;
    }
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) {
      result.push((acc << (toBits - bits)) & maxv);
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    return null;
  }

  return result;
}

/**
 * Derive Solana key and address
 * Path: m/44'/501'/0'/0' (hardened)
 */
function deriveSolanaKey(masterKey: HDKey): ChainKeys['solana'] {
  // Solana uses ed25519, but we derive a seed from BIP32
  // Then use that seed to generate the ed25519 keypair
  const path = `m/44'/${COIN_TYPE_SOL}'/0'/0'`;
  const derived = masterKey.derive(path);

  if (!derived.privateKey) {
    throw new Error('Failed to derive Solana key');
  }

  // For Solana, we use the derived private key as the seed for ed25519
  // Use first 32 bytes of the derived key as the ed25519 seed
  const seed = derived.privateKey.slice(0, 32);
  const publicKey = ed25519.getPublicKey(seed);

  // Solana address is the base58-encoded public key
  const address = bs58.encode(publicKey);

  // Private key in base58 (full 64-byte keypair: seed + pubkey)
  const fullKeypair = new Uint8Array(64);
  fullKeypair.set(seed, 0);
  fullKeypair.set(publicKey, 32);
  const privateKey = bs58.encode(fullKeypair);

  return {
    address,
    privateKey,
    publicKey: bs58.encode(publicKey),
  };
}

/**
 * Derive Kaspa key and address
 * Path: m/44'/111111'/0'/0/0 (SLIP-44 coin type 111111)
 * Kaspa uses secp256k1 with Schnorr signatures, addresses are Bech32 encoded
 */
function deriveKaspaKey(masterKey: HDKey): ChainKeys['kaspa'] {
  const path = `m/44'/${COIN_TYPE_KASPA}'/0'/0/0`;
  const derived = masterKey.derive(path);

  if (!derived.privateKey || !derived.publicKey) {
    throw new Error('Failed to derive Kaspa key');
  }

  const privateKeyHex = bytesToHex(derived.privateKey);
  const publicKeyHex = bytesToHex(derived.publicKey);

  // Encode Kaspa address using Bech32 with "kaspa:" prefix
  // Kaspa Schnorr addresses use only the X-coordinate of the public key
  const address = encodeKaspaAddress(publicKeyHex);

  return {
    address,
    privateKey: privateKeyHex,
    publicKey: publicKeyHex,
  };
}

/**
 * Encode a Kaspa address from compressed public key
 * Uses Bech32 encoding with "kaspa:" prefix
 *
 * Address formats:
 * - Schnorr (0x00): version (1 byte) + X-coordinate (32 bytes) = 33 bytes → 53 words + 8 checksum = 61 chars
 * - ECDSA (0x01): version (1 byte) + compressed pubkey (33 bytes) = 34 bytes → 55 words + 8 checksum = 63 chars
 *
 * Using Schnorr format (0x00) as it's the standard on Kaspa mainnet
 */
function encodeKaspaAddress(publicKeyHex: string): string {
  const KASPA_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const prefix = 'kaspa';
  // Using Schnorr version (0x00) - standard Kaspa address format
  const version = 0x00; // Schnorr P2PK

  // Extract X-coordinate (remove the 02/03 prefix from compressed key)
  const xCoordinate = publicKeyHex.slice(2); // Remove prefix byte, keep 32-byte X

  // Build payload: version byte + X-coordinate (32 bytes)
  const payloadHex = version.toString(16).padStart(2, '0') + xCoordinate;
  const payloadBytes = new Uint8Array(payloadHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));

  // Convert to 5-bit words
  const words = convertToKaspaWords(payloadBytes);

  // Calculate checksum (8 characters for Kaspa)
  const checksum = createKaspaChecksum(prefix, words);

  // Encode to bech32
  const encoded = [...words, ...checksum].map((w) => KASPA_CHARSET[w]).join('');

  return `${prefix}:${encoded}`;
}

/**
 * Convert bytes to 5-bit words for Kaspa Bech32
 */
function convertToKaspaWords(bytes: Uint8Array): number[] {
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
 * Kaspa polymod function - matches the Rust implementation
 */
function kaspaPolymod(values: number[]): bigint {
  const GEN = [
    0x98f2bc8e61n,
    0x79b76d99e2n,
    0xf33e5fb3c4n,
    0xae2eabe2a8n,
    0x1e4f43e470n,
  ];

  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    if (c0 & 0x01n) c ^= GEN[0];
    if (c0 & 0x02n) c ^= GEN[1];
    if (c0 & 0x04n) c ^= GEN[2];
    if (c0 & 0x08n) c ^= GEN[3];
    if (c0 & 0x10n) c ^= GEN[4];
  }
  return c ^ 1n;
}

/**
 * Get Kaspa prefix as 5-bit values (c & 0x1f for each char)
 * This is different from standard bech32 HRP expansion!
 */
function kaspaFivebitPrefix(prefix: string): number[] {
  return prefix.split('').map(c => c.charCodeAt(0) & 0x1f);
}

/**
 * Convert 5-bit array to 8-bit array (for checksum extraction)
 */
function conv5to8(payload: number[]): number[] {
  const eightBit: number[] = new Array(Math.floor(payload.length * 5 / 8)).fill(0);
  let currentIdx = 0;
  let buff = 0;
  let bits = 0;

  for (const c of payload) {
    buff = (buff << 5) | c;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      eightBit[currentIdx] = (buff >> bits) & 0xff;
      buff &= (1 << bits) - 1;
      currentIdx++;
    }
  }
  return eightBit;
}

/**
 * Convert 8-bit array to 5-bit array (for checksum encoding)
 */
function conv8to5(payload: number[]): number[] {
  const padding = payload.length % 5 === 0 ? 0 : 1;
  const fiveBit: number[] = new Array(Math.floor(payload.length * 8 / 5) + padding).fill(0);
  let currentIdx = 0;
  let buff = 0;
  let bits = 0;

  for (const c of payload) {
    buff = (buff << 8) | c;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      fiveBit[currentIdx] = (buff >> bits) & 0x1f;
      buff &= (1 << bits) - 1;
      currentIdx++;
    }
  }
  if (bits > 0) {
    fiveBit[currentIdx] = (buff << (5 - bits)) & 0x1f;
  }
  return fiveBit;
}

/**
 * Create Kaspa Bech32 checksum (8 characters)
 * Matches Kaspa Rust implementation
 */
function createKaspaChecksum(prefix: string, fivebitPayload: number[]): number[] {
  // Kaspa uses only lower 5 bits of prefix chars, NOT standard bech32 HRP expansion
  const fivebitPrefix = kaspaFivebitPrefix(prefix);

  // checksum input: prefix + [0] + payload + [0,0,0,0,0,0,0,0]
  const checksumInput = [...fivebitPrefix, 0, ...fivebitPayload, 0, 0, 0, 0, 0, 0, 0, 0];
  const checksumValue = kaspaPolymod(checksumInput);

  // Convert checksum (u64) to 5-bit values
  // The Rust code does: conv8to5(&checksum.to_be_bytes()[3..])
  // checksum is u64 (8 bytes), take last 5 bytes, convert to 5-bit
  const checksumBytes: number[] = [];
  for (let i = 4; i >= 0; i--) {
    checksumBytes.push(Number((checksumValue >> BigInt(i * 8)) & 0xffn));
  }
  return conv8to5(checksumBytes);
}

/**
 * Validate a Kaspa address (basic format check)
 */
export function isValidKaspaAddress(address: string): boolean {
  // Check for valid prefix and format
  return /^kaspa(test|dev|sim)?:[a-z0-9]{61,63}$/.test(address);
}

/**
 * Decode a Kaspa address to extract version and payload
 * Used for debugging address format
 */
export function decodeKaspaAddress(address: string): { version: number; payload: Uint8Array } | null {
  const KASPA_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

  const colonIndex = address.indexOf(':');
  if (colonIndex === -1) return null;

  const data = address.slice(colonIndex + 1);

  // Decode data part to 5-bit values (excluding 8-char checksum)
  const values: number[] = [];
  for (let i = 0; i < data.length - 8; i++) {
    const idx = KASPA_CHARSET.indexOf(data[i]);
    if (idx === -1) return null;
    values.push(idx);
  }

  // Convert 5-bit words back to 8-bit bytes
  let acc = 0;
  let bits = 0;
  const bytes: number[] = [];

  for (const value of values) {
    acc = (acc << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }

  if (bytes.length < 1) return null;

  return {
    version: bytes[0],
    payload: new Uint8Array(bytes.slice(1)),
  };
}

/**
 * Verify Kaspa address checksum
 * Returns true if the address has a valid checksum
 *
 * Matches Rust implementation:
 * 1. Extract checksum from last 8 chars
 * 2. Calculate expected checksum using payload (without checksum)
 * 3. Compare calculated vs extracted checksum
 */
export function verifyKaspaChecksum(address: string, debug: boolean = false): boolean {
  const KASPA_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

  // Parse address
  const colonIndex = address.indexOf(':');
  if (colonIndex === -1) return false;

  const prefix = address.slice(0, colonIndex);
  const data = address.slice(colonIndex + 1);

  // Decode ENTIRE data part to 5-bit values (INCLUDING checksum)
  const allValues: number[] = [];
  for (const char of data) {
    const idx = KASPA_CHARSET.indexOf(char);
    if (idx === -1) return false;
    allValues.push(idx);
  }

  // Split into payload and checksum (last 8 chars)
  const payload = allValues.slice(0, -8);
  const extractedChecksumWords = allValues.slice(-8);

  // Convert extracted checksum from 5-bit words to u64
  const extractedBytes = conv5to8(extractedChecksumWords);
  // Pad to 8 bytes for u64
  while (extractedBytes.length < 8) {
    extractedBytes.unshift(0);
  }
  let extractedChecksum = 0n;
  for (const byte of extractedBytes) {
    extractedChecksum = (extractedChecksum << 8n) | BigInt(byte);
  }

  // Calculate expected checksum using Kaspa's method
  // Input: fivebit_prefix + [0] + payload + [0,0,0,0,0,0,0,0]
  const fivebitPrefix = kaspaFivebitPrefix(prefix);
  const checksumInput = [...fivebitPrefix, 0, ...payload, 0, 0, 0, 0, 0, 0, 0, 0];
  const calculatedChecksum = kaspaPolymod(checksumInput);

  if (debug) {
  }

  return calculatedChecksum === extractedChecksum;
}

// Bittensor SS58 constants
const BITTENSOR_SS58_PREFIX = 42;
const SS58_PREFIX_BYTES = new TextEncoder().encode('SS58PRE');

/**
 * Calculate SS58 checksum using blake2b
 */
function ss58Checksum(data: Uint8Array): Uint8Array {
  const input = new Uint8Array(SS58_PREFIX_BYTES.length + data.length);
  input.set(SS58_PREFIX_BYTES);
  input.set(data, SS58_PREFIX_BYTES.length);
  return blake2b(input, { dkLen: 64 }).slice(0, 2);
}

/**
 * Encode a public key to SS58 address format
 */
function encodeSSS58Address(publicKey: Uint8Array, prefix: number = BITTENSOR_SS58_PREFIX): string {
  if (publicKey.length !== 32) {
    throw new Error(`Invalid public key length: ${publicKey.length}, expected 32`);
  }

  // For prefix < 64, use single byte
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
 * Derive Bittensor key and address
 * Path: m/44'/1006'/0'/0/0 (SLIP-44 coin type 1006)
 * Bittensor uses ed25519 keys with SS58 address encoding
 */
function deriveBittensorKey(masterKey: HDKey): ChainKeys['bittensor'] {
  const path = `m/44'/${COIN_TYPE_BITTENSOR}'/0'/0/0`;
  const derived = masterKey.derive(path);

  if (!derived.privateKey) {
    throw new Error('Failed to derive Bittensor key');
  }

  // Derive ed25519 keypair from BIP32 derived key
  // Use sha512 to expand the key material for ed25519
  const hash = sha512(new Uint8Array([...derived.privateKey, ...new TextEncoder().encode('bittensor')]));
  const privateKeySeed = hash.slice(0, 32);

  // Get ed25519 public key
  const publicKey = ed25519.getPublicKey(privateKeySeed);

  // Encode SS58 address
  const address = encodeSSS58Address(publicKey, BITTENSOR_SS58_PREFIX);

  return {
    address,
    privateKey: bytesToHex(privateKeySeed),
    publicKey: bytesToHex(publicKey),
  };
}

// =====================================================================
// Tezos
//
// Two derivations are exposed:
//
//  - SLIP-10 (default): the standard Ed25519 HD derivation Temple,
//    Kukai, AirGap, and Ledger Live all use. A user importing this
//    mnemonic into any of those wallets sees the same tz1 address.
//    Path: m/44'/1729'/0'/0' (all hardened — required by SLIP-10
//    Ed25519, which does not support non-hardened indices).
//
//  - BIP32 (variant): mirrors the non-standard pattern used here for
//    Solana / Bittensor — derive via @scure/bip32 (which is
//    secp256k1-only), then interpret the 32-byte private key bytes
//    as an Ed25519 seed. Same path. The resulting tz1 will NOT match
//    any mainstream Tezos wallet from the same mnemonic. Exposed for
//    users who specifically want continuity with how this codebase
//    derives the other Ed25519 chains.
// =====================================================================

const TEZOS_TZ1_PREFIX = new Uint8Array([6, 161, 159]); // base58check produces "tz1..."
const TEZOS_SLIP10_PATH = [44, 1729, 0, 0]; // hardened-by-default in SLIP-10 Ed25519

/**
 * Base58Check encode: bs58(payload || sha256(sha256(payload))[:4]).
 * Tezos addresses and keys are all Base58Check with a versioned prefix.
 */
function base58check(payload: Uint8Array): string {
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(payload.length + checksum.length);
  full.set(payload, 0);
  full.set(checksum, payload.length);
  return bs58.encode(full);
}

/**
 * SLIP-10 Ed25519 child-key derivation.
 * Only hardened indices are valid for Ed25519 SLIP-10 — the caller
 * provides the un-hardened index and the 0x80000000 bit is OR'd here.
 */
function slip10Ed25519DeriveChild(
  parentKey: Uint8Array,
  parentChainCode: Uint8Array,
  index: number,
): { key: Uint8Array; chainCode: Uint8Array } {
  const hardenedIndex = (index | 0x80000000) >>> 0;
  const data = new Uint8Array(1 + 32 + 4);
  data[0] = 0x00;
  data.set(parentKey, 1);
  // Big-endian uint32.
  data[33] = (hardenedIndex >>> 24) & 0xff;
  data[34] = (hardenedIndex >>> 16) & 0xff;
  data[35] = (hardenedIndex >>> 8) & 0xff;
  data[36] = hardenedIndex & 0xff;
  const out = hmac(sha512, parentChainCode, data);
  return { key: out.slice(0, 32), chainCode: out.slice(32, 64) };
}

/**
 * SLIP-10 Ed25519 path derivation from a BIP39 seed.
 * Returns just the final 32-byte private key (Ed25519 seed).
 */
function slip10Ed25519DerivePath(seed: Uint8Array, path: number[]): Uint8Array {
  // "ed25519 seed" is the canonical SLIP-10 master HMAC key for Ed25519.
  const master = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  let key: Uint8Array = master.slice(0, 32);
  let chainCode: Uint8Array = master.slice(32, 64);
  for (const idx of path) {
    const child = slip10Ed25519DeriveChild(key, chainCode, idx);
    key = child.key;
    chainCode = child.chainCode;
  }
  return key;
}

/** Ed25519 public key → tz1 address. */
function tezosAddressFromEd25519PublicKey(publicKey: Uint8Array): string {
  // 20-byte Blake2b hash, then versioned with the tz1 prefix.
  const hash = blake2b(publicKey, { dkLen: 20 });
  const versioned = new Uint8Array(TEZOS_TZ1_PREFIX.length + hash.length);
  versioned.set(TEZOS_TZ1_PREFIX, 0);
  versioned.set(hash, TEZOS_TZ1_PREFIX.length);
  return base58check(versioned);
}

/**
 * Derive a Tezos tz1 key+address from an Ed25519 seed.
 * The seed comes from either SLIP-10 or the BIP32-bytes variant.
 */
function tezosKeyFromSeed(seed: Uint8Array): {
  address: string;
  privateKey: string;
  publicKey: string;
} {
  const publicKey = ed25519.getPublicKey(seed);
  return {
    address: tezosAddressFromEd25519PublicKey(publicKey),
    privateKey: bytesToHex(seed),
    publicKey: bytesToHex(publicKey),
  };
}

/**
 * Derive both Tezos variants from the BIP39 master seed + HDKey.
 * The seed is needed for SLIP-10 (which derives directly from it,
 * bypassing @scure/bip32's secp256k1-only API); the masterKey is
 * used for the BIP32 variant to stay consistent with how Solana /
 * Bittensor derive in this codebase.
 */
function deriveTezosKey(seed: Uint8Array, masterKey: HDKey): ChainKeys['tezos'] {
  // SLIP-10 variant.
  const slip10Seed = slip10Ed25519DerivePath(seed, TEZOS_SLIP10_PATH);
  const slip10 = tezosKeyFromSeed(slip10Seed);

  // BIP32 variant — mirror the Solana pattern: derive via @scure/bip32
  // then use the first 32 bytes of the derived private key as the
  // Ed25519 seed. Path matches the SLIP-10 one for consistency.
  const path = `m/44'/${COIN_TYPE_TEZOS}'/0'/0'`;
  const derived = masterKey.derive(path);
  if (!derived.privateKey) {
    throw new Error('Failed to derive Tezos BIP32 key');
  }
  const bip32 = tezosKeyFromSeed(derived.privateKey.slice(0, 32));

  return { slip10, bip32 };
}

/** Validate any Tezos public-key-hash address (tz1, tz2, tz3). */
export function isValidTezosAddress(address: string): boolean {
  try {
    const decoded = bs58.decode(address);
    // 3-byte prefix + 20-byte hash + 4-byte checksum = 27 bytes.
    if (decoded.length !== 27) return false;
    const checksum = sha256(sha256(decoded.slice(0, 23))).slice(0, 4);
    for (let i = 0; i < 4; i++) {
      if (checksum[i] !== decoded[23 + i]) return false;
    }
    return (
      address.startsWith('tz1') ||
      address.startsWith('tz2') ||
      address.startsWith('tz3')
    );
  } catch {
    return false;
  }
}

/**
 * Validate a Bittensor SS58 address
 */
export function isValidBittensorAddress(address: string): boolean {
  try {
    const decoded = bs58.decode(address);
    if (decoded.length < 3) return false;

    // Check prefix byte
    const prefix = decoded[0];
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
 * Validate an Ethereum address
 */
export function isValidEthereumAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Validate a Bitcoin address (P2PKH, P2SH, or Bech32)
 */
export function isValidBitcoinAddress(address: string): boolean {
  // P2PKH (starts with 1)
  if (/^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return true;
  // P2SH (starts with 3)
  if (/^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return true;
  // Bech32 (starts with bc1)
  if (/^bc1[a-z0-9]{39,59}$/.test(address)) return true;
  return false;
}

/**
 * Validate a Solana address
 */
export function isValidSolanaAddress(address: string): boolean {
  try {
    const decoded = bs58.decode(address);
    return decoded.length === 32;
  } catch {
    return false;
  }
}

/**
 * Shorten an address for display
 */
export function shortenAddress(address: string, chars: number = 4): string {
  if (address.length <= chars * 2 + 2) return address;
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}
