/**
 * profilePrefs — persistent preferences for the profile tab.
 *
 * Key: `profile.splitMode` — when `true`, the user edits Quorum and Farcaster
 * profiles independently. When `false`, edits to unified fields (displayName,
 * pfp, bio) fan out to both systems. Default: `true`.
 */

import { useCallback, useEffect, useState } from 'react';
import { createMMKV } from 'react-native-mmkv';

const storage = createMMKV({ id: 'quorum-profile-prefs' });

const SPLIT_MODE_KEY = 'profile.splitMode';
const SPLIT_MODE_DECIDED_KEY = 'profile.splitModeDecided';

export function getProfileSplitMode(): boolean {
  const raw = storage.getString(SPLIT_MODE_KEY);
  if (raw == null) return true;
  try {
    return JSON.parse(raw) === true;
  } catch {
    return true;
  }
}

export function setProfileSplitMode(split: boolean): void {
  storage.set(SPLIT_MODE_KEY, JSON.stringify(split));
  storage.set(SPLIT_MODE_DECIDED_KEY, JSON.stringify(true));
}

export function hasDecidedSplitMode(): boolean {
  const raw = storage.getString(SPLIT_MODE_DECIDED_KEY);
  if (raw == null) return false;
  try {
    return JSON.parse(raw) === true;
  } catch {
    return false;
  }
}

export function useProfileSplitMode(): [boolean, (split: boolean) => void] {
  const [value, setLocal] = useState<boolean>(() => getProfileSplitMode());

  // Re-read when another screen changes it (this used to poll every 2s).
  useEffect(() => {
    const sync = () => {
      const next = getProfileSplitMode();
      setLocal((prev) => (prev === next ? prev : next));
    };
    sync();
    const listener = storage.addOnValueChangedListener((changed) => {
      if (changed === SPLIT_MODE_KEY) sync();
    });
    return () => listener.remove();
  }, []);

  const setValue = useCallback((next: boolean) => {
    setLocal(next);
    setProfileSplitMode(next);
  }, []);

  return [value, setValue];
}
