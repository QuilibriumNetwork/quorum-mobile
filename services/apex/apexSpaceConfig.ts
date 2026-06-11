/**
 * Owner-signed Apex space config.
 *
 * A space's Apex config (accepted token + ETH payout address) determines
 * where 1/5 of every subscriber payment goes, so publishing it must be
 * provably authorized by the space owner. Only the owner's device holds the
 * space's Ed448 owner key (the same key that signs space manifests — see
 * services/space/broadcastSpaceUpdate.ts), so we sign a canonical message
 * with it and the API verifies the signature against the owner public key
 * in the space registration.
 *
 * Canonical signed message (UTF-8 bytes):
 *   apex-config:{space_address}:{token}:{lowercase payout_address}:{timestamp}
 *
 * The server MUST rebuild this exact string from the POSTed fields, verify
 * the Ed448 signature against the space registration's owner public key,
 * and reject stale timestamps (e.g. older than 10 minutes) to prevent
 * replays of an old config.
 */

import { getSpaceKey } from '@/services/config/spaceStorage';
import { NativeCryptoProvider } from '@/services/crypto/native-provider';
import { hexToBytes } from '@quilibrium/quorum-shared';
import { base64ToHex, numberArrayToBase64 } from '@/utils/encoding';
import type { ApexToken } from './config';

export interface SignedApexConfig {
  token: ApexToken;
  payout_address: string;
  timestamp: number;
  owner_public_key: string;
  owner_signature: string;
}

/**
 * Build and sign the Apex config payload for a space. Throws if this device
 * doesn't hold the space's owner key (i.e. the user isn't the owner).
 */
export async function signSpaceApexConfig(
  spaceAddress: string,
  token: ApexToken,
  payoutAddress: string
): Promise<SignedApexConfig> {
  const ownerKey = getSpaceKey(spaceAddress, 'owner');
  if (!ownerKey) {
    throw new Error('Only the space owner can publish Apex settings');
  }

  const timestamp = Date.now();
  const message = `apex-config:${spaceAddress}:${token}:${payoutAddress.toLowerCase()}:${timestamp}`;
  const payloadBase64 = numberArrayToBase64(
    Array.from(new TextEncoder().encode(message))
  );

  const cryptoProvider = new NativeCryptoProvider();
  const ownerPrivateKeyBase64 = numberArrayToBase64(
    Array.from(hexToBytes(ownerKey.privateKey))
  );
  const signatureBase64 = await cryptoProvider.signEd448(
    ownerPrivateKeyBase64,
    payloadBase64
  );

  return {
    token,
    payout_address: payoutAddress,
    timestamp,
    owner_public_key: ownerKey.publicKey,
    owner_signature: base64ToHex(signatureBase64),
  };
}
