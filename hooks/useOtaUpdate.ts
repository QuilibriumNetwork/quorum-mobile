/**
 * useOtaUpdate — thin wrapper around expo-updates' useUpdates() that adds
 * automatic re-checks on app foreground and at a fixed interval, plus a
 * single-call applyUpdate() that fetches if needed and reloads.
 *
 * In dev builds, expo-updates is a no-op — currentlyRunning has dummy IDs
 * and isUpdateAvailable is always false. The badge / settings UI renders
 * the same code path; it just won't fire in dev.
 */

import { useCallback, useEffect } from 'react';
import { Alert, AppState } from 'react-native';
import * as Updates from 'expo-updates';

const PERIODIC_CHECK_MS = 10 * 60 * 1000; // 10 minutes

// In dev, expo-updates is a no-op — checks return false forever and there's
// no embedded update ID. Inject a fake "available" update so we can
// preview the badge + Settings UI without shipping a build first.
const DEV_MOCK_UPDATE = {
  updateId: 'dev-preview',
  createdAt: new Date(),
  runtimeVersion: 'dev-preview',
  manifest: null as unknown,
};

export function useOtaUpdate() {
  const updates = Updates.useUpdates();

  const checkNow = useCallback(async () => {
    try {
      await Updates.checkForUpdateAsync();
    } catch {
      // Network or env-missing — non-fatal. State is unchanged on failure.
    }
  }, []);

  // Re-check whenever the app returns to foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkNow();
    });
    return () => sub.remove();
  }, [checkNow]);

  // Periodic check while app is open.
  useEffect(() => {
    const id = setInterval(checkNow, PERIODIC_CHECK_MS);
    return () => clearInterval(id);
  }, [checkNow]);

  const applyUpdate = useCallback(async () => {
    if (__DEV__) {
      Alert.alert('Dev Preview', 'OTA update would be applied here in production.');
      return;
    }
    if (updates.isUpdatePending) {
      // Already downloaded, just reload.
      await Updates.reloadAsync();
      return;
    }
    if (updates.isUpdateAvailable) {
      await Updates.fetchUpdateAsync();
      await Updates.reloadAsync();
    }
  }, [updates.isUpdatePending, updates.isUpdateAvailable]);

  // In dev, force the "update available" state so the badge + settings
  // section render the production look. Real expo-updates state is
  // returned unchanged in production builds.
  return {
    isUpdateAvailable: __DEV__ ? true : updates.isUpdateAvailable,
    isUpdatePending: updates.isUpdatePending,
    isChecking: updates.isChecking,
    isDownloading: updates.isDownloading,
    currentlyRunning: updates.currentlyRunning,
    availableUpdate: __DEV__ ? DEV_MOCK_UPDATE : updates.availableUpdate,
    checkError: updates.checkError ?? updates.downloadError ?? null,
    checkNow,
    applyUpdate,
  };
}
