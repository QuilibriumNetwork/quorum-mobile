/**
 * EIP-191 personal sign with a raw secp256k1 key. Its own module, free of
 * bip39, so code that only signs (the direct-cast token) doesn't load the
 * mnemonic tooling; `farcasterService` re-exports it.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

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
  const sigBytes: Uint8Array = (secp256k1 as any).sign(messageHash, privateKey, { lowS: true, prehash: false });

  // Parse signature bytes - r and s are each 32 bytes
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
