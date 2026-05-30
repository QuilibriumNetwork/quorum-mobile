/**
 * Mobile-side glue for provisioning + renewing the Hypersnap signer.
 *
 * Combines:
 *   - SecureStore-backed signer record (hypersnapAdapters.ts)
 *   - SecureStore-stored Farcaster custody secp256k1 key
 *   - MMKV-tracked last-used custody nonce per FID
 *   - quorum-shared's signer-lifecycle helpers
 */

import { getFarcasterCustodyKey } from '@/services/onboarding/secureStorage';
import { mmkvStorage } from '@/services/offline/storage';
import { hypersnapSignerStore } from './hypersnapAdapters';
import {
  getDefaultHypersnapClient,
  provisionSigner as sharedProvisionSigner,
  renewIfNearExpiry as sharedRenewIfNearExpiry,
  type SignerRecord,
} from '@quilibrium/quorum-shared';

const NONCE_KEY_PREFIX = 'hypersnap.nonce.v1:';

function nonceKey(fid: number): string {
  return `${NONCE_KEY_PREFIX}${fid}`;
}

/**
 * Resolve the next strictly-monotonic custody nonce. We persist the last
 * nonce we used per FID so subsequent provisions/renews never collide. If
 * no value is stored, seed from current unix seconds — a sane starting
 * point that already beats any prior nonce that this client wrote.
 */
async function nextNonce(fid: number): Promise<number> {
  const raw = mmkvStorage.getItem(nonceKey(fid));
  const prev = raw ? parseInt(raw, 10) : 0;
  const candidate = Math.max(prev + 1, Math.floor(Date.now() / 1000));
  mmkvStorage.setItem(nonceKey(fid), String(candidate));
  return candidate;
}

function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.toLowerCase().startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function loadCustodyBytes(): Promise<Uint8Array | null> {
  const hex = await getFarcasterCustodyKey();
  if (!hex) return null;
  return hexToBytes(hex);
}

/** Provision a new Hypersnap signer for the given FID, persisting it
 *  to SecureStore on success. Throws on hard failure. */
export async function provisionHypersnapSigner(fid: number): Promise<SignerRecord> {
  const custody = await loadCustodyBytes();
  if (!custody) {
    throw new Error('provisionHypersnapSigner: no Farcaster custody key available');
  }
  const nonce = await nextNonce(fid);
  const { record } = await sharedProvisionSigner({
    fid,
    custodyPrivateKey: custody,
    nonce,
  });
  await hypersnapSignerStore.save(record);
  return record;
}

/** Cheap foreground check — pulls custody only if a renew is actually needed. */
export async function renewHypersnapSignerIfNeeded(): Promise<SignerRecord | null> {
  return sharedRenewIfNearExpiry({
    store: hypersnapSignerStore,
    custodyPrivateKey: () => loadCustodyBytes(),
    nextNonce,
  });
}

/** Delete the local signer record. The on-chain KEY_REMOVE is a separate
 *  concern (we'd want a confirmation modal); this just clears the device. */
export async function forgetHypersnapSigner(): Promise<void> {
  await hypersnapSignerStore.clear();
}

/**
 * Verify the locally-stored signer's pubkey is one of the Ed25519
 * keys hypersnap currently considers valid for its FID. Returns:
 *   - `'present'`  → local pubkey is in the registered signer list
 *   - `'absent'`   → the FID has registered signers but ours isn't
 *                    among them (stale record; reprovision required)
 *   - `'unknown'`  → couldn't fetch the list (hub error). The caller
 *                    should NOT wipe the local record on `unknown`;
 *                    transient failures shouldn't trigger destructive
 *                    cleanup.
 *
 * NOTE: this checks Snapchain's native signer state (KEY_ADD messages
 * registered through `submitMessage`), NOT Optimism's KeyRegistry
 * contract. The two are distinct signer sets.
 */
export async function verifyOnChainSignerPresence(
  record: SignerRecord,
): Promise<'present' | 'absent' | 'unknown'> {
  const localPub = record.publicKeyHex.toLowerCase().replace(/^0x/, '');
  try {
    const registered = await getDefaultHypersnapClient().listSnapchainSignersByFid(record.fid);
    // Empty list = either the FID legitimately has no registered
    // signers, or the lookup silently failed. Conservatively treat
    // that as `unknown` so we don't wipe a valid local record.
    if (registered.length === 0) return 'unknown';
    return registered.includes(localPub) ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}
