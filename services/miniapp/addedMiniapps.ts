/**
 * Persistent list of miniapps the user has explicitly "added" via the
 * SDK's `addMiniApp` action. Backed by MMKV so the launcher / discovery
 * surface can reflect adds across app launches.
 *
 * The set is keyed by domain (origin host) — the same key the bridge
 * uses everywhere else for per-miniapp settings.
 */

import { createMMKV } from 'react-native-mmkv';

const storage = createMMKV({ id: 'miniapps.added.v1' });
const KEY = 'list';

export interface AddedMiniapp {
  domain: string;
  url: string;
  addedAt: number;
  name?: string;
  iconUrl?: string;
}

function readList(): AddedMiniapp[] {
  const raw = storage.getString(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeList(list: AddedMiniapp[]): void {
  storage.set(KEY, JSON.stringify(list));
}

export function getAddedMiniapps(): AddedMiniapp[] {
  return readList();
}

export function isMiniappAdded(domain: string): boolean {
  return readList().some((m) => m.domain === domain);
}

export function addMiniapp(entry: Omit<AddedMiniapp, 'addedAt'>): AddedMiniapp {
  const list = readList();
  const existing = list.find((m) => m.domain === entry.domain);
  if (existing) {
    // Refresh url / name / icon — the most recent metadata wins so a
    // miniapp updating its branding doesn't carry a stale icon forever.
    Object.assign(existing, entry);
    writeList(list);
    return existing;
  }
  const next: AddedMiniapp = { ...entry, addedAt: Date.now() };
  list.push(next);
  writeList(list);
  return next;
}

export function removeMiniapp(domain: string): void {
  writeList(readList().filter((m) => m.domain !== domain));
}

