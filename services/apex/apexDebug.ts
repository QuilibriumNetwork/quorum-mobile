/**
 * DEV-ONLY Apex debug state.
 *
 * Lets a developer activate a fake Apex subscription on the simulator
 * without paying (or without the backend existing at all). The record is
 * stored under its own MMKV key and read by useApexSubscription's queryFn
 * BEFORE the server call — so it survives refetches that would otherwise
 * overwrite the cache with the server's 404/null.
 *
 * Every entry point no-ops in release builds (`__DEV__` guard), so this
 * cannot leak into production behavior even if a call site forgets to
 * gate itself.
 */

import { mmkvStorage } from '@/services/offline/storage';
import type { ApexSubscriptionRecord } from '@/services/offline/apexCache';
import type { ApexToken } from './config';

const DEBUG_SUB_KEY = 'apex.debugSubscription';

export function getDebugApexSubscription(): ApexSubscriptionRecord | null {
  if (!__DEV__) return null;
  try {
    const raw = mmkvStorage.getItem(DEBUG_SUB_KEY);
    return raw ? (JSON.parse(raw) as ApexSubscriptionRecord) : null;
  } catch {
    return null;
  }
}

export function setDebugApexSubscription(params: {
  address: string;
  token: ApexToken;
  spaceAddresses: string[];
  /** When true the period is set in the past, for testing the expired UI. */
  expired?: boolean;
}): ApexSubscriptionRecord | null {
  if (!__DEV__) return null;
  const now = Date.now();
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const record: ApexSubscriptionRecord = {
    address: params.address,
    token: params.token,
    tx_hash: `0xdebug${now.toString(16).padStart(58, '0')}`,
    space_addresses: params.spaceAddresses.slice(0, 4),
    period_start: params.expired ? now - 2 * THIRTY_DAYS : now,
    period_end: params.expired ? now - THIRTY_DAYS : now + THIRTY_DAYS,
    subscribed_since: params.expired ? now - 2 * THIRTY_DAYS : now,
  };
  mmkvStorage.setItem(DEBUG_SUB_KEY, JSON.stringify(record));
  return record;
}

export function clearDebugApexSubscription(): void {
  if (!__DEV__) return;
  mmkvStorage.removeItem(DEBUG_SUB_KEY);
}

/**
 * Mock eligible spaces shown in the slot picker when the server has no
 * apex-configs yet. Payout addresses are deliberately NOT valid ETH
 * addresses so the real payment path rejects them loudly — they exist
 * only to exercise the slot-selection UI and the debug activation.
 */
export const DEBUG_APEX_SPACES = [1, 2, 3, 4, 5].map((i) => ({
  spaceAddress: `debug-space-${i}`,
  name: `Debug Space ${i}`,
  payoutAddress: `debug-payout-${i}`,
}));

export function isDebugSpaceAddress(spaceAddress: string): boolean {
  return spaceAddress.startsWith('debug-space-');
}
