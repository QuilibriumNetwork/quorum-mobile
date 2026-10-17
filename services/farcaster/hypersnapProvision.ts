/**
 * Mobile-side glue for provisioning + renewing the Hypersnap signer.
 *
 * Every account with a Farcaster custody key on the device gets a signer,
 * without asking: all Farcaster writes (casts, reactions, follows, profile
 * edits, deletes) are signed with it and submitted to Hypersnap. Use
 * `ensureHypersnapSigner` to get one; the other exports are its parts.
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
  logger,
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

export type EnsureSignerResult =
  /** A signer for this FID is stored and not known to be stale. */
  | { status: 'ready'; record: SignerRecord }
  /** No custody key on this device, so no signer can be made. Re-importing the
   *  Farcaster account restores the key. */
  | { status: 'no-custody-key' }
  /** Provisioning failed (network, hub rejection). Safe to retry. */
  | { status: 'failed'; error: string };

const inflightEnsure = new Map<number, Promise<EnsureSignerResult>>();
/** Signer public keys confirmed registered on Hypersnap this session. */
const confirmedOnHub = new Set<string>();

/**
 * Make sure this device holds a working Hypersnap signer for `fid`, creating
 * one if needed. Never throws. Concurrent calls for the same FID share one run.
 *
 * - A stored signer for `fid` is checked against the hub's signer list once per
 *   session. If the hub says it is not registered, it is replaced; if the hub
 *   cannot be reached, it is kept and checked again on the next call.
 * - A stored signer for a different FID (another account was connected before)
 *   is replaced.
 * - A signer near the end of its TTL is renewed in the background.
 */
export function ensureHypersnapSigner(fid: number): Promise<EnsureSignerResult> {
  const pending = inflightEnsure.get(fid);
  if (pending) return pending;
  const run = ensureSignerOnce(fid).finally(() => inflightEnsure.delete(fid));
  inflightEnsure.set(fid, run);
  return run;
}

async function ensureSignerOnce(fid: number): Promise<EnsureSignerResult> {
  try {
    const existing = await hypersnapSignerStore.get();
    if (existing && existing.fid === fid) {
      const pub = existing.publicKeyHex.toLowerCase();
      let stale = false;
      if (!confirmedOnHub.has(pub)) {
        // The local record can drift from the hub if an earlier KEY_ADD never
        // landed (rate-limited, dropped), leaving a keypair the network rejects.
        const presence = await verifyOnChainSignerPresence(existing);
        if (presence === 'present') confirmedOnHub.add(pub);
        stale = presence === 'absent';
      }
      if (!stale) {
        renewHypersnapSignerIfNeeded().catch((e) => {
          logger.warn('[hypersnap] signer renew failed', e);
        });
        return { status: 'ready', record: existing };
      }
      logger.warn(
        `[hypersnap] stored signer is not registered for fid=${fid} (pub=${pub.slice(0, 16)}…); replacing it`,
      );
      await hypersnapSignerStore.clear();
    }

    if (!(await getFarcasterCustodyKey())) return { status: 'no-custody-key' };

    const record = await provisionHypersnapSigner(fid);
    confirmedOnHub.add(record.publicKeyHex.toLowerCase());
    logger.log(
      `[hypersnap] signer provisioned: fid=${record.fid}, pub=${record.publicKeyHex.slice(0, 16)}…, ttl=${record.ttlSeconds}s`,
    );
    return { status: 'ready', record };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.warn(`[hypersnap] could not provision a signer for fid=${fid}:`, error);
    return { status: 'failed', error };
  }
}

/**
 * The signer to sign a Farcaster write with for `fid`, provisioning one first
 * if the device has none yet. Null when none can be had right now; the caller
 * reports that as a failed write.
 */
export async function getHypersnapSignerFor(fid: number): Promise<SignerRecord | null> {
  const existing = await hypersnapSignerStore.get();
  if (existing && existing.fid === fid) return existing;
  const result = await ensureHypersnapSigner(fid);
  return result.status === 'ready' ? result.record : null;
}
