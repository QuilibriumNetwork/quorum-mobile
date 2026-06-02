/**
 * socialGraph — the viewer's follow set and block set, fetched from the
 * network and cached locally in MMKV so we don't refetch on every render.
 *
 *   • Follows come from hypersnap's hub (`/v1/linksByFid?link_type=follow`),
 *     which returns the raw LINK_ADD messages — we only keep `targetFid`.
 *   • Blocks come from the farcaster.xyz legacy public API
 *     (`api.farcaster.xyz/fc/blocked-users?blockerFid=N`), which is public
 *     (no auth) and keyed by the blocker's FID.
 *
 * Both lists are paginated; we walk every page (bounded by MAX_PAGES as a
 * runaway guard). The fetched FID arrays are persisted under
 * `follows:<fid>` / `blocks:<fid>` with a fetched-at timestamp so a cold
 * start can render with the last-known graph while the network refresh
 * runs in the background.
 */

import { createMMKV, type MMKV } from 'react-native-mmkv';
import { DEFAULT_HYPERSNAP_BASE_URL, logger } from '@quilibrium/quorum-shared';

const STORE_ID = 'quorum-social-graph';
const K_FOLLOWS_PREFIX = 'follows:';
const K_BLOCKS_PREFIX = 'blocks:';
const K_MUTES_PREFIX = 'mutes:';

/** Stop paging after this many requests — a guard against an endpoint that
 *  never stops handing back a cursor. 50 pages × ~1000/page covers very
 *  large follow graphs. */
const MAX_PAGES = 50;

// Farcaster legacy client API. There's no protocol-level mute/block, so
// these all go through the same web-client endpoints the official app uses
// (Bearer-authed). `limit-visibility` covers both: block=false is a mute,
// block=true is a full block; DELETE removes either restriction.
const FARCASTER_CLIENT_API = 'https://client.farcaster.xyz';
const LIMIT_VISIBILITY_PATH = '/v2/limit-visibility';
const GET_BLOCKED_USERS_PATH = '/v2/get-blocked-users';
const GET_MUTED_USERS_PATH = '/v2/get-muted-users';

function authHeaders(token: string, withBody = false): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    origin: 'https://farcaster.xyz',
    referer: 'https://farcaster.xyz/',
  };
  if (withBody) h['content-type'] = 'application/json';
  return h;
}

let store: MMKV | null = null;
function getStore(): MMKV {
  if (!store) store = createMMKV({ id: STORE_ID });
  return store;
}

interface PersistedGraph {
  fids: number[];
  fetchedAt: number;
}

function load(key: string): number[] | null {
  const raw = getStore().getString(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedGraph;
    return Array.isArray(parsed.fids) ? parsed.fids : null;
  } catch {
    return null;
  }
}

function save(key: string, fids: number[]): void {
  const payload: PersistedGraph = { fids, fetchedAt: Date.now() };
  getStore().set(key, JSON.stringify(payload));
}

// -------------------------------------------------------------------------
// Follows
// -------------------------------------------------------------------------

/** Last-known set of FIDs `fid` follows, or null if never fetched. */
export function loadFollowingFids(fid: number): number[] | null {
  return load(`${K_FOLLOWS_PREFIX}${fid}`);
}

export function saveFollowingFids(fid: number, fids: number[]): void {
  save(`${K_FOLLOWS_PREFIX}${fid}`, fids);
}

interface LinksByFidResponse {
  messages?: {
    data?: {
      linkBody?: {
        type?: string;
        targetFid?: number;
      };
    };
  }[];
  nextPageToken?: string;
}

/**
 * Fetch the full set of FIDs `fid` follows from the hypersnap hub. Pages
 * via `nextPageToken` until exhausted. Returns a de-duplicated array; throws
 * on transport failure so React Query can surface/retry (the caller keeps
 * the persisted set in the meantime).
 */
export async function fetchFollowingFids(fid: number): Promise<number[]> {
  const out = new Set<number>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      fid: String(fid),
      link_type: 'follow',
      pageSize: '1000',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${DEFAULT_HYPERSNAP_BASE_URL}/v1/linksByFid?${params.toString()}`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`linksByFid failed (${res.status})`);
    }
    const json = (await res.json()) as LinksByFidResponse;
    for (const msg of json.messages ?? []) {
      const target = msg.data?.linkBody?.targetFid;
      if (typeof target === 'number') out.add(target);
    }
    pageToken = json.nextPageToken || undefined;
    if (!pageToken) break;
  }
  logger.log(`[socialGraph] follows for fid ${fid}: ${out.size}`);
  return Array.from(out);
}

// -------------------------------------------------------------------------
// Blocks & mutes (visibility restrictions)
// -------------------------------------------------------------------------

/** Last-known set of FIDs `fid` has blocked, or null if never fetched. */
export function loadBlockedFids(fid: number): number[] | null {
  return load(`${K_BLOCKS_PREFIX}${fid}`);
}

export function saveBlockedFids(fid: number, fids: number[]): void {
  save(`${K_BLOCKS_PREFIX}${fid}`, fids);
}

/** Last-known set of FIDs `fid` has muted, or null if never fetched. */
export function loadMutedFids(fid: number): number[] | null {
  return load(`${K_MUTES_PREFIX}${fid}`);
}

export function saveMutedFids(fid: number, fids: number[]): void {
  save(`${K_MUTES_PREFIX}${fid}`, fids);
}

interface RestrictedUsersResponse {
  result?: {
    blockedUsers?: { blockedFid?: number }[];
    mutedUsers?: { mutedFid?: number }[];
  };
  next?: { cursor?: string | null };
}

/**
 * Page a cursor-paginated authed list endpoint, pulling one FID field out of
 * each row. Shared by the blocked + muted fetchers.
 */
async function fetchRestrictedFids(
  token: string,
  path: string,
  pick: (row: { blockedFid?: number; mutedFid?: number }) => number | undefined,
  rows: (r: RestrictedUsersResponse) => { blockedFid?: number; mutedFid?: number }[],
): Promise<number[]> {
  const out = new Set<number>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const url = `${FARCASTER_CLIENT_API}${path}?${params.toString()}`;
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) throw new Error(`${path} failed (${res.status})`);
    const json = (await res.json()) as RestrictedUsersResponse;
    const list = rows(json);
    for (const row of list) {
      const fid = pick(row);
      if (typeof fid === 'number') out.add(fid);
    }
    cursor = json.next?.cursor || undefined;
    if (!cursor || list.length === 0) break;
  }
  return Array.from(out);
}

/** Fetch all FIDs the viewer has blocked (authed). */
export async function fetchBlockedFids(token: string): Promise<number[]> {
  const fids = await fetchRestrictedFids(
    token,
    GET_BLOCKED_USERS_PATH,
    (r) => r.blockedFid,
    (j) => j.result?.blockedUsers ?? [],
  );
  logger.log(`[socialGraph] blocked: ${fids.length}`);
  return fids;
}

/** Fetch all FIDs the viewer has muted (authed). */
export async function fetchMutedFids(token: string): Promise<number[]> {
  const fids = await fetchRestrictedFids(
    token,
    GET_MUTED_USERS_PATH,
    (r) => r.mutedFid,
    (j) => j.result?.mutedUsers ?? [],
  );
  logger.log(`[socialGraph] muted: ${fids.length}`);
  return fids;
}

/**
 * Apply a visibility restriction on `targetFid`. `block=false` mutes (hide
 * their replies but they can still see you), `block=true` blocks. Same
 * endpoint the official client uses — there's no protocol-level support.
 */
export async function limitUserVisibility(
  token: string,
  targetFid: number,
  block: boolean,
): Promise<void> {
  const res = await fetch(`${FARCASTER_CLIENT_API}${LIMIT_VISIBILITY_PATH}`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({ targetFid, block }),
  });
  if (!res.ok) {
    throw new Error(`limit-visibility failed (${res.status})`);
  }
}

/** Remove any visibility restriction (unmute / unblock) on `targetFid`. */
export async function removeUserVisibilityRestriction(
  token: string,
  targetFid: number,
): Promise<void> {
  const res = await fetch(`${FARCASTER_CLIENT_API}${LIMIT_VISIBILITY_PATH}`, {
    method: 'DELETE',
    headers: authHeaders(token, true),
    body: JSON.stringify({ targetFid }),
  });
  if (!res.ok) {
    throw new Error(`limit-visibility delete failed (${res.status})`);
  }
}
