/**
 * useUserConfig - Hook for accessing and updating user configuration
 *
 * Provides:
 * - Current user config (locally cached)
 * - Methods to update config (syncs to server if allowSync=true)
 * - Bookmark management
 * - Config sync status
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  getConfig,
  saveConfig,
  getLocalUserConfig,
  updateConfig,
  getLocalBookmarks,
  addBookmark as addBookmarkService,
  removeBookmark as removeBookmarkService,
} from '../services/config';
import { type UserConfig, type Bookmark } from '@quilibrium/quorum-shared';

interface UseUserConfigReturn {
  // State
  config: UserConfig | null;
  isLoading: boolean;
  error: Error | null;

  // Actions
  refreshConfig: () => Promise<void>;
  updateAllowSync: (enabled: boolean) => Promise<void>;
  updateNotificationSettings: (
    settings: UserConfig['notificationSettings']
  ) => Promise<void>;
  updateDeliveryReceipts: (enabled: boolean) => Promise<void>;
  updateReadReceipts: (enabled: boolean) => Promise<void>;
}

export function useUserConfig(): UseUserConfigReturn {
  const { user } = useAuth();
  const [config, setConfig] = useState<UserConfig | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Load config on mount or when user changes
  useEffect(() => {
    if (!user?.address) {
      setConfig(null);
      return;
    }

    // Load cached config immediately
    const cached = getLocalUserConfig(user.address);
    if (cached) {
      setConfig(cached);
    }

    // Then refresh from server
    (async () => {
      setIsLoading(true);
      try {
        const freshConfig = await getConfig(user.address);
        setConfig(freshConfig);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoading(false);
      }
    })();
  }, [user?.address]);

  const refreshConfig = useCallback(async () => {
    if (!user?.address) return;

    setIsLoading(true);
    try {
      const freshConfig = await getConfig(user.address);
      setConfig(freshConfig);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [user?.address]);

  const updateAllowSync = useCallback(
    async (enabled: boolean) => {
      if (!user?.address) return;

      try {
        const updated = await updateConfig(user.address, { allowSync: enabled });
        setConfig(updated);
      } catch (err) {
        throw err;
      }
    },
    [user?.address]
  );

  const updateNotificationSettings = useCallback(
    async (settings: UserConfig['notificationSettings']) => {
      if (!user?.address || !config) return;

      try {
        const updated = await updateConfig(user.address, {
          notificationSettings: {
            ...config.notificationSettings,
            ...settings,
          },
        });
        setConfig(updated);
      } catch (err) {
        throw err;
      }
    },
    [user?.address, config]
  );

  // DM receipt master switches. Persisted to the config blob (typed in shared
  // 2.1.0-34+) and synced cross-device via saveConfig like every other setting.
  const updateDeliveryReceipts = useCallback(
    async (enabled: boolean) => {
      if (!user?.address) return;
      const updated = await updateConfig(user.address, { deliveryReceipts: enabled });
      setConfig(updated);
    },
    [user?.address]
  );

  const updateReadReceipts = useCallback(
    async (enabled: boolean) => {
      if (!user?.address) return;
      const updated = await updateConfig(user.address, { readReceipts: enabled });
      setConfig(updated);
    },
    [user?.address]
  );

  return {
    config,
    isLoading,
    error,
    refreshConfig,
    updateAllowSync,
    updateNotificationSettings,
    updateDeliveryReceipts,
    updateReadReceipts,
  };
}

/**
 * Hook for DM delivery + read receipt settings. Both default OFF (matches
 * desktop). Turning delivery off implicitly disables read (you can't confirm
 * reads without confirming delivery).
 */
export function useReceiptSettings() {
  const { config, isLoading, updateDeliveryReceipts, updateReadReceipts } = useUserConfig();

  return {
    deliveryReceipts: config?.deliveryReceipts ?? false,
    readReceipts: config?.readReceipts ?? false,
    isLoading,
    setDeliveryReceipts: updateDeliveryReceipts,
    setReadReceipts: updateReadReceipts,
  };
}

/**
 * Hook specifically for notification settings
 */
export function useNotificationSettings() {
  const { config, isLoading, updateNotificationSettings } = useUserConfig();

  return {
    settings: config?.notificationSettings ?? { enabled: true },
    isLoading,
    updateSettings: updateNotificationSettings,
  };
}

/**
 * Hook for sync settings
 */
export function useSyncSettings() {
  const { config, isLoading, updateAllowSync, refreshConfig } = useUserConfig();

  return {
    allowSync: config?.allowSync ?? false,
    isLoading,
    setAllowSync: updateAllowSync,
    refreshConfig,
  };
}

/**
 * Hook for bookmark management
 */
export function useBookmarks() {
  const { user } = useAuth();
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Load bookmarks on mount or when user changes
  useEffect(() => {
    if (!user?.address) {
      setBookmarks([]);
      return;
    }

    setBookmarks(getLocalBookmarks(user.address));
  }, [user?.address]);

  const addBookmark = useCallback(
    async (bookmark: Bookmark) => {
      if (!user?.address) return;

      addBookmarkService(user.address, bookmark);
      setBookmarks(getLocalBookmarks(user.address));

      // Trigger sync if allowSync is enabled
      try {
        const config = getLocalUserConfig(user.address);
        if (config?.allowSync) {
          await saveConfig(config);
        }
      } catch {
        // Config sync is best-effort — bookmark is already saved locally
      }
    },
    [user?.address]
  );

  const removeBookmark = useCallback(
    async (bookmarkId: string) => {
      if (!user?.address) return;

      removeBookmarkService(user.address, bookmarkId);
      setBookmarks(getLocalBookmarks(user.address));

      // Trigger sync if allowSync is enabled
      try {
        const config = getLocalUserConfig(user.address);
        if (config?.allowSync) {
          await saveConfig(config);
        }
      } catch {
        // Config sync is best-effort — bookmark removal is already saved locally
      }
    },
    [user?.address]
  );

  const isBookmarked = useCallback(
    (messageId: string) => {
      return bookmarks.some((b) => b.messageId === messageId);
    },
    [bookmarks]
  );

  const getBookmark = useCallback(
    (messageId: string) => {
      return bookmarks.find((b) => b.messageId === messageId);
    },
    [bookmarks]
  );

  return {
    bookmarks,
    isLoading,
    addBookmark,
    removeBookmark,
    isBookmarked,
    getBookmark,
  };
}

export default useUserConfig;
