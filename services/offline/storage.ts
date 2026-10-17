import { createMMKV, type MMKV } from 'react-native-mmkv';
import { encryptionStateStorage } from '../crypto/encryption-state-storage';
import { clearConfigStorage } from '../config';

/**
 * MMKV storage instance for query persistence.
 */
const storage: MMKV = createMMKV({ id: 'quorum-cache' });

/**
 * Wallet balance cache storage
 */
const walletCacheStorage: MMKV = createMMKV({ id: 'quorum-wallet-cache' });

/**
 * Storage adapter that matches React Query's persist interface.
 */
export const mmkvStorage = {
  setItem: (key: string, value: string): void => {
    storage.set(key, value);
  },
  getItem: (key: string): string | null => {
    return storage.getString(key) ?? null;
  },
  removeItem: (key: string): void => {
    storage.remove(key);
  },
};

const SCRUB_FILLER_KEY = '__scrub_filler__';

/**
 * Replace `key`'s value and leave no copy of the previous value in the file.
 *
 * A plain `set` is not enough. MMKV is append-only: the old value stays in the
 * file until a compaction, and compaction (`trim()` → full writeback,
 * MMKVCore `MMKV_IO.cpp`) rewrites the live data from the start of the file but
 * does not zero the unused tail behind it. So after compacting, this writes a
 * throwaway filler over that tail (the file is then at most twice the live
 * data, and the filler is longer than that tail), removes it, and compacts
 * again, which leaves only filler bytes behind the live data.
 *
 * Costly (the filler is as large as everything else in this store). Call only
 * when the old value must not survive, never on a routine write.
 */
export function replaceAndScrubFile(key: string, value: string): void {
  storage.set(key, value);
  storage.trim();
  storage.set(SCRUB_FILLER_KEY, '0'.repeat(storage.size + 64 * 1024));
  storage.remove(SCRUB_FILLER_KEY);
  storage.trim();
}

/**
 * Storage for the mutation queue
 */
const mutationStorage: MMKV = createMMKV({ id: 'quorum-mutations' });

export const mutationQueueStorage = {
  setItem: (key: string, value: string): void => {
    mutationStorage.set(key, value);
  },
  getItem: (key: string): string | null => {
    return mutationStorage.getString(key) ?? null;
  },
  removeItem: (key: string): void => {
    mutationStorage.remove(key);
  },
  getAllKeys: (): string[] => {
    return mutationStorage.getAllKeys();
  },
};

/**
 * Clear all MMKV storage data (cache, mutations, encryption states, wallet cache, and config)
 * Used during app reset / sign out.
 *
 * Also clears the SQLite messages database so the previous identity's
 * chat history doesn't leak into a re-onboarded identity on the same
 * device. The messages module is lazy-required to avoid a circular
 * dependency at module load (messagesDb imports `storage` from here).
 */
export function clearAllMMKVStorage(): void {
  storage.clearAll();
  mutationStorage.clearAll();
  walletCacheStorage.clearAll();
  encryptionStateStorage.clearAll();
  clearConfigStorage();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const messagesDb = require('../storage/messagesDb') as typeof import('../storage/messagesDb');
    messagesDb.clearAllMessages();
  } catch {
    // If the messages module hasn't been initialized yet (sign-out before
    // first message read), there's nothing to clear.
  }
}

/**
 * Navigation state storage keys
 */
const NAV_STATE_KEY = 'navigation-state';

export interface NavigationState {
  selectedSpaceId?: string;
  selectedChannelId?: string;
  selectedConversationId?: string;
  isDMsSelected: boolean;
}

/**
 * Save navigation state to storage
 */
export function saveNavigationState(state: NavigationState): void {
  storage.set(NAV_STATE_KEY, JSON.stringify(state));
}

/**
 * Load navigation state from storage
 */
export function loadNavigationState(): NavigationState | null {
  const data = storage.getString(NAV_STATE_KEY);
  if (!data) return null;
  try {
    return JSON.parse(data) as NavigationState;
  } catch {
    return null;
  }
}

/**
 * Clear navigation state
 */
export function clearNavigationState(): void {
  storage.remove(NAV_STATE_KEY);
}

export { storage, mutationStorage };
export default mmkvStorage;
