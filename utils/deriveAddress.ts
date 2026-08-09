/**
 * Derive a Quorum `Qm…` address from an ed448 public key.
 *
 * SHA-256 the public key, wrap the digest in a multihash, base58-encode it.
 * This is the libp2p peer-id construction, and it is the definition of what a
 * Quorum address IS — so it must exist exactly once.
 *
 * ## Why it lives here rather than in the key service
 *
 * It used to live in `services/onboarding/keyService`, which still re-exports it
 * so no caller had to change. But that module also pulls in mnemonic generation
 * and, transitively, the native Rust crypto module — meaning anything wanting to
 * turn a public key into an address had to load a native module to do it.
 *
 * That weight is why the codebase already contains FIVE hand-rolled copies of
 * this function:
 *
 * - `hooks/chat/useChannelManagement.ts`
 * - `hooks/chat/useSpaceActions.ts`
 * - `services/config/spaceSyncService.ts`
 * - `services/crypto/space-session.ts`
 * - `services/space/spaceService.ts`
 *
 * Each is currently identical; nothing makes them stay that way, and an address
 * derivation that disagrees with itself would mis-address messages rather than
 * fail loudly. All five should come here — deliberately not done in the same
 * change as security work.
 *
 * Count them before trusting this list. An earlier version of this comment said
 * "three" and named the first three, and the tracked cleanup issue makes the
 * same undercount — which is worse than no list, because whoever consolidates
 * the named ones will reasonably believe the job is finished and leave two
 * copies of security-relevant address derivation behind.
 *
 * Depends only on a hash, a multihash encoder and base58. Import it freely.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import * as multihashes from 'multihashes';
import bs58 from 'bs58';

/**
 * @param publicKey Raw bytes, or hex with or without a `0x` prefix.
 * @throws if a hex string is malformed. Callers on a render path must catch.
 */
export function deriveAddress(publicKey: Uint8Array | string): string {
  const keyBytes =
    typeof publicKey === 'string' ? hexToBytes(publicKey.replace('0x', '')) : publicKey;

  const hash = sha256(keyBytes);
  const multihash = multihashes.encode(hash, 'sha2-256');

  return bs58.encode(multihash);
}
