/**
 * useHypersnapSignerLifecycle — keeps a Hypersnap signer provisioned for the
 * signed-in Farcaster account, silently. There is no prompt and no setting:
 * every Farcaster write is signed with this signer.
 *
 * Runs when a FID appears (sign-in, account import), on every return to the
 * foreground, and on a backoff after a failed attempt. Each run provisions,
 * replaces or renews as needed (see `ensureHypersnapSigner`). Failures are
 * logged only; a write that finds no signer provisions one itself before
 * giving up (`getHypersnapSignerFor`).
 *
 * Mounted once, for the whole signed-in app (`app/(tabs)/_layout.tsx`).
 */

import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { ensureHypersnapSigner } from '@/services/farcaster/hypersnapProvision';

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;

export function useHypersnapSignerLifecycle(fid: number | undefined): void {
  useEffect(() => {
    if (!fid) return;
    let cancelled = false;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const result = await ensureHypersnapSigner(fid);
      if (cancelled) return;
      if (result.status === 'failed') {
        failures += 1;
        const delay = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
        retryTimer = setTimeout(() => void run(), delay);
      } else {
        failures = 0;
      }
    };

    void run();
    const sub = AppState.addEventListener('change', (status: AppStateStatus) => {
      if (status === 'active') void run();
    });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      sub.remove();
    };
  }, [fid]);
}
