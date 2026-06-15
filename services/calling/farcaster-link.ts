import type { FarcasterLink } from '@quilibrium/quorum-shared';
import { getFarcasterCustodyKey } from '@/services/onboarding/secureStorage';
import { ensurePrivateKey } from '@/services/onboarding/keyService';
import { NativeCryptoProvider } from '@/services/crypto/native-provider';
import { hexToBytes } from '@quilibrium/quorum-shared';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

/**
 * Generate a bidirectional Farcaster ↔ Quorum identity link.
 *
 * Produces two signatures:
 * 1. Farcaster custody wallet (secp256k1) signs the Quorum address
 *    → proves the Farcaster account owner controls this Quorum identity
 * 2. Quorum Ed448 key signs the Farcaster custody address
 *    → proves the Quorum identity acknowledges this Farcaster account
 *
 * Both signatures together form a bidirectional proof. A verifier checks
 * both to confirm the link is mutual (not forged by a third party).
 */
export async function generateFarcasterLink(
  fid: number,
  custodyAddress: string,
  quorumAddress: string,
): Promise<FarcasterLink | null> {
  const custodyKeyHex = await getFarcasterCustodyKey();
  const quorumKeyHex = await ensurePrivateKey();

  if (!custodyKeyHex || !quorumKeyHex) return null;

  // 1. Farcaster custody wallet signs the Quorum address
  // EIP-191 personal sign: keccak256("\x19Ethereum Signed Message:\n" + len + message)
  const fcMessage = `quorum:link:${quorumAddress}`;
  const fcMessageBytes = new TextEncoder().encode(fcMessage);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${fcMessageBytes.length}`);
  const prefixed = new Uint8Array(prefix.length + fcMessageBytes.length);
  prefixed.set(prefix);
  prefixed.set(fcMessageBytes, prefix.length);
  const fcHash = keccak_256(prefixed);

  const fcSig = secp256k1.sign(fcHash, custodyKeyHex);
  const farcasterSignature = fcSig.toCompactHex() + (fcSig.recovery === 0 ? '1b' : '1c');

  // 2. Quorum Ed448 key signs the Farcaster custody address
  const crypto = new NativeCryptoProvider();
  const quorumMessage = `farcaster:link:${custodyAddress}`;
  const quorumKeyBytes = hexToBytes(quorumKeyHex);
  const quorumKeyBase64 = btoa(String.fromCharCode(...quorumKeyBytes));
  const quorumMsgBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(quorumMessage)));
  const quorumSigBase64 = await crypto.signEd448(quorumKeyBase64, quorumMsgBase64);

  const quorumSigBinary = atob(quorumSigBase64);
  let quorumSignature = '';
  for (let i = 0; i < quorumSigBinary.length; i++) {
    quorumSignature += quorumSigBinary.charCodeAt(i).toString(16).padStart(2, '0');
  }

  return {
    fid,
    custodyAddress,
    farcasterSignature,
    quorumSignature,
  };
}
