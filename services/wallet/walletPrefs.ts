/**
 * walletPrefs — persistent UI preferences + recency data for the wallet tab.
 *
 * Everything lives in one MMKV instance (`quorum-wallet-prefs`) as JSON.
 *
 * Exports:
 *   - `useWalletPref<T>(key, defaultValue)` — React hook, re-read when the key
 *     changes in storage, so cross-screen updates reflect.
 *   - `loadPref / savePref` — standalone read/write (for non-React callers).
 *   - Recent-recipient helpers: `addRecentRecipient`, `getRecentRecipients`.
 *   - Favorite-token helpers: `isFavoriteToken`, `toggleFavoriteToken`,
 *     `getFavoriteTokens`.
 *
 * Storage layout is flat — individual keys rather than a single blob — so
 * writes to one preference don't contend with unrelated ones.
 */

import { useCallback, useEffect, useState } from 'react';
import { createMMKV } from 'react-native-mmkv';

const storage = createMMKV({ id: 'quorum-wallet-prefs' });

// Raw pref read/write

export function loadPref<T>(key: string, fallback: T): T {
  const raw = storage.getString(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function savePref<T>(key: string, value: T): void {
  storage.set(key, JSON.stringify(value));
}

/**
 * React hook bound to a single pref key. Re-reads when the key changes in
 * storage, so if another screen updates the value, this one sees it. (It used
 * to poll every 2s, seven of them at once on the wallet screen.) Calls to
 * `setValue` are synchronous local updates AND persisted to storage.
 */
export function useWalletPref<T>(
  key: string,
  defaultValue: T,
): [T, (value: T) => void] {
  const [value, setLocal] = useState<T>(() => loadPref<T>(key, defaultValue));

  useEffect(() => {
    const sync = () => {
      const next = loadPref<T>(key, defaultValue);
      // Cheap string compare — both are JSON-serializable scalars/records
      setLocal((prev) =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
      );
    };
    sync();
    const listener = storage.addOnValueChangedListener((changed) => {
      if (changed === key) sync();
    });
    return () => listener.remove();
  }, [key, defaultValue]);

  const setValue = useCallback(
    (next: T) => {
      setLocal(next);
      savePref(key, next);
    },
    [key],
  );

  return [value, setValue];
}

// Recent recipients (per-chain, deduped, capped)

export interface RecentRecipient {
  address: string;
  label?: string;
  ts: number;
}

const RECENTS_KEY = (chain: string) => `recent:recipients:${chain}`;
const RECENTS_MAX = 10;

export function getRecentRecipients(chain: string): RecentRecipient[] {
  return loadPref<RecentRecipient[]>(RECENTS_KEY(chain), []);
}

export function addRecentRecipient(
  chain: string,
  address: string,
  label?: string,
): void {
  if (!chain || !address) return;
  const normalized = address.trim();
  if (!normalized) return;

  const existing = getRecentRecipients(chain);
  const filtered = existing.filter(
    (r) => r.address.toLowerCase() !== normalized.toLowerCase(),
  );
  const next: RecentRecipient[] = [
    { address: normalized, label, ts: Date.now() },
    ...filtered,
  ].slice(0, RECENTS_MAX);
  savePref(RECENTS_KEY(chain), next);
}

export function clearRecentRecipients(chain: string): void {
  savePref(RECENTS_KEY(chain), [] as RecentRecipient[]);
}

// Favorite tokens (cross-chain list, capped)

export interface FavoriteToken {
  chain: string;
  symbol: string;
  contractAddress?: string;
}

const FAV_TOKENS_KEY = 'fav:tokens';
const FAV_TOKENS_MAX = 20;

function tokenKey(t: Pick<FavoriteToken, 'chain' | 'symbol' | 'contractAddress'>): string {
  return `${t.chain}|${t.symbol.toUpperCase()}|${(t.contractAddress ?? '').toLowerCase()}`;
}

export function getFavoriteTokens(): FavoriteToken[] {
  return loadPref<FavoriteToken[]>(FAV_TOKENS_KEY, []);
}

export function isFavoriteToken(token: FavoriteToken): boolean {
  const target = tokenKey(token);
  return getFavoriteTokens().some((t) => tokenKey(t) === target);
}

export function toggleFavoriteToken(token: FavoriteToken): boolean {
  const target = tokenKey(token);
  const current = getFavoriteTokens();
  const exists = current.some((t) => tokenKey(t) === target);
  const next = exists
    ? current.filter((t) => tokenKey(t) !== target)
    : [token, ...current].slice(0, FAV_TOKENS_MAX);
  savePref(FAV_TOKENS_KEY, next);
  return !exists; // returns new favorited state
}

export function useFavoriteTokens(): FavoriteToken[] {
  const [favorites, setFavorites] = useState<FavoriteToken[]>(() =>
    getFavoriteTokens(),
  );
  useEffect(() => {
    const sync = () => {
      const next = getFavoriteTokens();
      setFavorites((prev) =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
      );
    };
    sync();
    const listener = storage.addOnValueChangedListener((changed) => {
      if (changed === FAV_TOKENS_KEY) sync();
    });
    return () => listener.remove();
  }, []);
  return favorites;
}

// Well-known pref keys

export const WALLET_PREF_KEYS = {
  chainFilter: 'pref:chainFilter',
  activeTab: 'pref:activeTab',
  showLowValueAssets: 'pref:showLowValueAssets',
  showZeroValueAssets: 'pref:showZeroValueAssets',
  hideBalances: 'pref:hideBalances',
  btcFormatsExpanded: 'pref:btcFormatsExpanded',
} as const;
