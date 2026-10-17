/**
 * Per-account Farcaster data read straight from Hypersnap's hub API, for the
 * fields its `/v2/farcaster/user` object leaves out: banner, URL, location,
 * the protocol primary ETH address, and Farcaster Pro status. No auth.
 */

import { DEFAULT_HYPERSNAP_BASE_URL, getDefaultHypersnapClient } from '@quilibrium/quorum-shared';

/** The USER_DATA types this app reads, keyed by the hub's JSON enum names. */
export interface HubUserData {
  banner?: string;
  url?: string;
  location?: string;
  primaryEthAddress?: string;
}

const USER_DATA_FIELDS: Record<string, keyof HubUserData> = {
  USER_DATA_TYPE_BANNER: 'banner',
  USER_DATA_TYPE_URL: 'url',
  USER_DATA_TYPE_LOCATION: 'location',
  USER_DATA_PRIMARY_ADDRESS_ETHEREUM: 'primaryEthAddress',
};

interface UserDataMessage {
  data?: { userDataBody?: { type?: string; value?: string } };
}

/** Every USER_DATA value this app uses for `fid`. Throws on network failure. */
export async function fetchHubUserData(fid: number): Promise<HubUserData> {
  const res = await fetch(`${DEFAULT_HYPERSNAP_BASE_URL}/v1/userDataByFid?fid=${fid}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Hypersnap userDataByFid ${res.status}`);
  const json = (await res.json()) as { messages?: UserDataMessage[] };
  const out: HubUserData = {};
  for (const m of json.messages ?? []) {
    const body = m.data?.userDataBody;
    const field = body?.type ? USER_DATA_FIELDS[body.type] : undefined;
    if (field && body?.value) out[field] = body.value;
  }
  return out;
}

/**
 * The address to send a tip to: the account's protocol primary ETH address,
 * else its first verified ETH address. Null when it has neither.
 */
export async function fetchPrimaryEthAddress(fid: number): Promise<string | null> {
  try {
    const { primaryEthAddress } = await fetchHubUserData(fid);
    if (primaryEthAddress) return primaryEthAddress;
  } catch {
    // Fall through to the verifications on the user object.
  }
  const user = await getDefaultHypersnapClient().getUserByFid(fid);
  return user.verified_addresses?.eth_addresses?.[0] ?? null;
}

interface TierPurchaseEvent {
  blockTimestamp?: number;
  tier_purchase_event_body?: { for_days?: number; tier_type?: string };
}

/**
 * When a Farcaster Pro subscription ends (unix seconds; 0 if there was never
 * one), from the account's tier-purchase events. Each purchase extends from the
 * later of its own block time and the running expiry, in block order: the same
 * rule Hypersnap validates 10k casts with.
 */
export function proExpiresAt(events: TierPurchaseEvent[]): number {
  const purchases = events
    .filter((e) => e.tier_purchase_event_body?.tier_type === 'Pro')
    .sort((a, b) => (a.blockTimestamp ?? 0) - (b.blockTimestamp ?? 0));
  let expiresAt = 0;
  for (const e of purchases) {
    const days = e.tier_purchase_event_body?.for_days ?? 0;
    expiresAt = Math.max(e.blockTimestamp ?? 0, expiresAt) + days * 24 * 60 * 60;
  }
  return expiresAt;
}

/** {@link proExpiresAt} for `fid`, read from Hypersnap. Throws on network failure. */
export async function fetchProExpiry(fid: number): Promise<number> {
  const res = await fetch(
    `${DEFAULT_HYPERSNAP_BASE_URL}/v1/onChainEventsByFid?fid=${fid}&event_type=EVENT_TYPE_TIER_PURCHASE`,
    { headers: { accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`Hypersnap onChainEventsByFid ${res.status}`);
  const json = (await res.json()) as { events?: TierPurchaseEvent[] };
  return proExpiresAt(json.events ?? []);
}

/** True while the account's Farcaster Pro subscription is active. */
export async function isProUser(fid: number): Promise<boolean> {
  return (await fetchProExpiry(fid)) >= Math.floor(Date.now() / 1000);
}
