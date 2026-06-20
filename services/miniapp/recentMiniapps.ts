/**
 * Device-local most-recently-used list of miniapps, for the launcher's
 * "Recently used" tab. Distinct from `addedMiniapps` (the user's explicit
 * saves): this is implicit usage history, recorded every time a miniapp is
 * opened. Keyed by domain (origin host), newest first, capped.
 */

import { createMMKV } from 'react-native-mmkv';

const storage = createMMKV({ id: 'miniapps.recent.v1' });
const KEY = 'list';
const MAX_ENTRIES = 30;

export interface RecentMiniapp {
  domain: string;
  url: string;
  lastUsedAt: number;
  name?: string;
  iconUrl?: string;
}

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function readList(): RecentMiniapp[] {
  const raw = storage.getString(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeList(list: RecentMiniapp[]): void {
  storage.set(KEY, JSON.stringify(list));
}

/** Recently-used miniapps, newest first. */
export function getRecentMiniapps(): RecentMiniapp[] {
  return readList().sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/**
 * Record that a miniapp was opened. Upserts by domain (bumps lastUsedAt and
 * refreshes name/icon), trims to the most recent MAX_ENTRIES. No-op for URLs
 * without a parseable host (e.g. non-http q-native schemes).
 */
export function recordMiniappUse(entry: { url: string; name?: string; iconUrl?: string }): void {
  const domain = domainOf(entry.url);
  if (!domain) return;
  const list = readList();
  const prev = list.find((m) => m.domain === domain);
  const rest = list.filter((m) => m.domain !== domain);
  rest.push({
    domain,
    url: entry.url,
    lastUsedAt: Date.now(),
    // Preserve previously-known metadata when this call omits it — opening
    // via the overlay only carries a URL, so we don't want it to wipe the
    // name/icon a launcher tap recorded.
    name: entry.name ?? prev?.name,
    iconUrl: entry.iconUrl ?? prev?.iconUrl,
  });
  rest.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  writeList(rest.slice(0, MAX_ENTRIES));
}

export function clearRecentMiniapps(): void {
  writeList([]);
}
