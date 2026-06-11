/**
 * apexCache — synchronous MMKV cache for the current user's Apex
 * subscription so the gold-ring status survives a cold start without
 * waiting on the network. Mirrors the farcasterFeedCache pattern: the
 * payload is read synchronously on mount via React Query `initialData`,
 * and carries `updatedAt` for `initialDataUpdatedAt` so staleness logic
 * still applies to the restored value.
 *
 * `data: null` is a meaningful cached value ("known not subscribed") and
 * is distinct from a missing cache entry (`undefined` — never fetched).
 */

import { mmkvStorage } from '@/services/offline/storage';

/** Mirror of the server record (see quorumClient.getApexSubscription). */
export interface ApexSubscriptionRecord {
  address: string;
  token: 'wQUIL' | 'SNAP' | 'USDC';
  tx_hash: string;
  space_addresses: string[];
  /** Unix ms. */
  period_start: number;
  /** Unix ms. */
  period_end: number;
  /** Unix ms — period_start of the user's first-ever subscription. */
  subscribed_since: number;
}

export interface CachedApexSubscription {
  data: ApexSubscriptionRecord | null;
  updatedAt: number;
}

const subscriptionKey = (address: string) => `apex-subscription-cache:v1:${address}`;

export function getCachedApexSubscription(
  address: string
): CachedApexSubscription | undefined {
  try {
    const raw = mmkvStorage.getItem(subscriptionKey(address));
    if (!raw) return undefined;
    const cached = JSON.parse(raw) as CachedApexSubscription;
    if (typeof cached?.updatedAt !== 'number') return undefined;
    return cached;
  } catch {
    return undefined;
  }
}

export function setCachedApexSubscription(
  address: string,
  data: ApexSubscriptionRecord | null
): void {
  try {
    const payload: CachedApexSubscription = { data, updatedAt: Date.now() };
    mmkvStorage.setItem(subscriptionKey(address), JSON.stringify(payload));
  } catch {
    // best-effort cache; ignore write failures
  }
}
