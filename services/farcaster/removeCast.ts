/**
 * removeFarcasterCast — delete a cast the current user authored, preferring the
 * hypersnap `CAST_REMOVE` protocol message when a signer is provisioned, and
 * falling back to the legacy `DELETE /v2/casts` endpoint otherwise. Mirrors the
 * hypersnap-vs-legacy split that `useFarcasterSubmitCast` / `useSubmitCast` use
 * for `CAST_ADD`.
 *
 * Only the cast's author can remove it — the caller is responsible for gating
 * the action on `authorFid === ownFid`; the server also enforces it.
 */

import {
  blake3_20,
  encodeMessageData,
  encodeMessageEnvelope,
  farcasterTimestamp,
  getDefaultHypersnapClient,
  signerFromRecord,
  logger,
} from '@quilibrium/quorum-shared';
import { hypersnapSignerStore } from './hypersnapAdapters';
import { deleteFarcasterCast } from '@/services/farcasterClient';

const MESSAGE_TYPE_CAST_REMOVE = 2;
const NETWORK_MAINNET = 1;
const SIGNATURE_SCHEME_ED25519 = 1;

function hexToBytes(hex: string): Uint8Array {
  const s = hex.toLowerCase().startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(Math.floor(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function removeFarcasterCast(params: {
  castHash: string;
  fid?: number;
  token?: string;
}): Promise<{ source: 'hypersnap' | 'legacy' }> {
  const { castHash, fid, token } = params;

  // Protocol path: a CAST_REMOVE signed by the provisioned signer.
  if (fid && fid > 0) {
    try {
      const record = await hypersnapSignerStore.get();
      if (record && record.fid === fid) {
        const signer = signerFromRecord(record);
        const dataBytes = encodeMessageData({
          type: MESSAGE_TYPE_CAST_REMOVE,
          fid,
          timestamp: farcasterTimestamp(),
          network: NETWORK_MAINNET,
          body: { castRemoveBody: { targetHash: hexToBytes(castHash) } },
        } as Parameters<typeof encodeMessageData>[0]);
        const hash = blake3_20(dataBytes);
        const signature = await signer.sign(hash);
        const envelope = encodeMessageEnvelope({
          dataBytes,
          hash,
          signature,
          signatureScheme: SIGNATURE_SCHEME_ED25519,
          signer: signer.publicKey,
        });
        await getDefaultHypersnapClient().submitMessage(envelope);
        return { source: 'hypersnap' };
      }
    } catch (e) {
      logger.warn(
        '[removeFarcasterCast] hypersnap CAST_REMOVE failed, falling back to legacy:',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // Legacy fallback.
  if (!token) throw new Error('removeFarcasterCast: no signer available and no legacy token');
  await deleteFarcasterCast({ token, castHash });
  return { source: 'legacy' };
}
