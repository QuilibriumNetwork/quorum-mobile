/**
 * useHypersnapSignerLifecycle — first-time opt-in prompt, automatic
 * provision after opt-in, and background renew-if-near-expiry.
 *
 * Mount once at the root of the post-auth tree where the user is likely
 * to see provisioning feedback (the feed view).
 */

import { useCallback, useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  getHypersnapOptInChoice,
  hasShownHypersnapPrompt,
  markHypersnapPromptShown,
} from '@/services/farcaster/hypersnapOptIn';
import {
  hypersnapSignerStore,
} from '@/services/farcaster/hypersnapAdapters';
import {
  provisionHypersnapSigner,
  renewHypersnapSignerIfNeeded,
  verifyOnChainSignerPresence,
} from '@/services/farcaster/hypersnapProvision';
import { logger } from '@quilibrium/quorum-shared';

interface UseHypersnapSignerLifecycleOptions {
  fid: number | undefined;
}

export type ProvisionState = 'idle' | 'pending' | 'success' | 'error';

interface UseHypersnapSignerLifecycleResult {
  /** True when the modal should be visible — Farcaster is linked but the
   *  user hasn't been asked yet, OR a prior provision attempt failed and
   *  we surfaced the prompt for retry. */
  promptVisible: boolean;
  dismissPrompt: () => void;
  /** Manually open the prompt — useful from Settings or after a failure. */
  openPrompt: () => void;
  /** Current provisioning state. 'error' means the user is opted-in but
   *  the most recent provision attempt threw. */
  provisionState: ProvisionState;
  /** Last provision error message (only set when provisionState === 'error'). */
  provisionError: string | null;
  /** Re-run the provision attempt. Safe to call repeatedly. */
  retryProvision: () => void;
}

export function useHypersnapSignerLifecycle({
  fid,
}: UseHypersnapSignerLifecycleOptions): UseHypersnapSignerLifecycleResult {
  const [promptVisible, setPromptVisible] = useState(false);
  const [provisionState, setProvisionState] = useState<ProvisionState>('idle');
  const [provisionError, setProvisionError] = useState<string | null>(null);
  // Bumping this triggers the provision effect to re-run on demand.
  const [retryNonce, setRetryNonce] = useState(0);

  // First-time prompt: Farcaster linked, no prior choice persisted.
  useEffect(() => {
    if (!fid) return;
    if (hasShownHypersnapPrompt()) return;
    setPromptVisible(true);
  }, [fid]);

  // Provision after opt-in. Runs on mount, on fid change, on prompt
  // dismiss, and on explicit retry. Idempotent: if a record already
  // exists this just renews-if-near-expiry.
  useEffect(() => {
    if (!fid) return;
    let cancelled = false;
    void (async () => {
      const choice = getHypersnapOptInChoice();
      if (choice !== 'opted-in') return;
      const existing = await hypersnapSignerStore.get();
      if (existing && existing.fid === fid) {
        // We have a local record — before assuming it's still valid,
        // confirm the pubkey is actually registered as a signer on
        // chain. The local record can drift if a previous provision
        // attempt's KEY_ADD never landed (rate-limited, dropped, or
        // hypersnap-accepted-but-not-broadcast), leaving us with an
        // orphan keypair that the network will reject. Re-checking
        // here avoids the user finding out at cast-submit time.
        const presence = await verifyOnChainSignerPresence(existing);
        if (presence === 'present' || presence === 'unknown') {
          // Either confirmed-good, or the hub lookup failed (we
          // refuse to wipe a record on transient network errors).
          setProvisionState('success');
          logger.log(
            `[hypersnap] signer already provisioned for fid=${fid}, pub=${existing.publicKeyHex.slice(0, 16)}…, ttl=${existing.ttlSeconds}s, onChain=${presence}`,
          );
          renewHypersnapSignerIfNeeded().catch((e) => {
            logger.warn('[hypersnap] background renew failed', e);
          });
          return;
        }
        // 'absent' — the FID has signers but ours isn't one. Local
        // record is stale; wipe it and fall through to the provision
        // branch below.
        logger.warn(
          `[hypersnap] local signer not registered on chain (pub=${existing.publicKeyHex.slice(0, 16)}…, fid=${fid}); clearing and re-provisioning`,
        );
        try { await hypersnapSignerStore.clear(); } catch { /* ignore */ }
      }
      if (cancelled) return;
      setProvisionState('pending');
      setProvisionError(null);
      logger.log(`[hypersnap] provisioning signer for fid=${fid}`);
      try {
        const record = await provisionHypersnapSigner(fid);
        if (!cancelled) {
          setProvisionState('success');
          setProvisionError(null);
          logger.log(
            `[hypersnap] signer provisioned: fid=${record.fid}, pub=${record.publicKeyHex.slice(0, 16)}…, ttl=${record.ttlSeconds}s, custody=${record.custodyAddress.slice(0, 10)}…`,
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn('[hypersnap] signer provision failed', msg);
        if (!cancelled) {
          setProvisionState('error');
          setProvisionError(msg);
          // Re-surface the prompt so the user knows something went wrong
          // and can retry without digging into Settings.
          setPromptVisible(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [fid, retryNonce]);

  // Foreground renew check — independent of provisioning since the user
  // may have provisioned weeks ago and now just needs the sliding TTL refreshed.
  useEffect(() => {
    if (!fid) return;
    const tick = () => {
      renewHypersnapSignerIfNeeded().catch((e) => {
        logger.warn('[hypersnap] foreground renew failed', e);
      });
    };
    tick();
    const sub = AppState.addEventListener('change', (status: AppStateStatus) => {
      if (status === 'active') tick();
    });
    return () => sub.remove();
  }, [fid]);

  const dismissPrompt = useCallback(() => {
    setPromptVisible(false);
    markHypersnapPromptShown();
  }, []);

  const openPrompt = useCallback(() => {
    setPromptVisible(true);
  }, []);

  const retryProvision = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  return {
    promptVisible,
    dismissPrompt,
    openPrompt,
    provisionState,
    provisionError,
    retryProvision,
  };
}
