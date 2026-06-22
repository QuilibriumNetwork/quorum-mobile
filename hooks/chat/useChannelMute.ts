/**
 * useChannelMute — channel/space notification mute that syncs across devices.
 *
 * Mute state lives in `UserConfig.mutedChannels[spaceId]` (per-channel) and
 * `UserConfig.notificationSettings[spaceId].isMuted` (per-space), so a mute
 * toggled on one device shows up on the user's other devices via the encrypted
 * config sync. The value is read straight back from the local config, never
 * through the in-memory `user` object.
 *
 * Two layers:
 *   - Source of truth + sync: UserConfig (this hook).
 *   - Local mirror for the native gates: the `quorum-notification-prefs` MMKV
 *     store (+ iOS App-Group mirror), which `shouldNotifyForContext` and the NSE
 *     read unchanged. The mirror is kept in lockstep with UserConfig here — on
 *     first load (migrating any legacy device-local mutes), on inbound sync, and
 *     on every toggle.
 *
 * In-memory state is a module-level store exposed via useSyncExternalStore so
 * every consumer (settings sheet, channel-list row) updates instantly on a
 * toggle; a per-hook useState copy would not propagate.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '@/context';
import {
  getLocalMutedChannels,
  setMutedChannels as persistMutedChannels,
  getLocalSpaceMuted,
  setSpaceMuted as persistSpaceMuted,
} from '@/services/config';
import {
  mirrorSpaceMuteState,
  readLegacyMutesForSpace,
} from '@/services/notifications/notificationPrefs';

// --- Module-level shared store (one source of truth across all hook instances) ---
//
// Keyed by spaceId so a screen showing one space doesn't churn another's state.
// `mutedChannels` is the set of muted channel ids per space; `spaceMuted` is the
// per-space flag. A space is loaded lazily the first time it's seen.

type SpaceMuteState = { mutedChannels: Set<string>; spaceMuted: boolean };

let store: Record<string, SpaceMuteState> = {};
let loadedForAddress: string | null = null;
const loadedSpaces = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Record<string, SpaceMuteState> {
  return store;
}

const EMPTY: SpaceMuteState = { mutedChannels: new Set(), spaceMuted: false };

/** Reset everything when the address changes (login/logout). */
function resetForAddress(address: string | null): void {
  if (loadedForAddress === address) return;
  loadedForAddress = address;
  store = {};
  loadedSpaces.clear();
  emit();
}

/**
 * Load one space's mute state from UserConfig (once), migrating any legacy
 * device-local MMKV mutes into the config on first run, then writing the mirror
 * so the native gates reflect the config-backed state.
 */
function ensureSpaceLoaded(address: string, spaceId: string): void {
  if (loadedSpaces.has(spaceId)) return;
  loadedSpaces.add(spaceId);

  let mutedChannels = getLocalMutedChannels(address, spaceId);
  let spaceMuted = getLocalSpaceMuted(address, spaceId);

  // One-time migration: if the config has no mute state for this space yet but
  // the legacy MMKV store does, seed the config from it. (Idempotent: after the
  // config is authoritative, the mirror is rewritten FROM it below, so the legacy
  // reads converge to the same values and re-seeding is a no-op.)
  if (mutedChannels.length === 0 && !spaceMuted) {
    const legacy = readLegacyMutesForSpace(spaceId);
    if (legacy.mutedChannelIds.length > 0 || legacy.spaceMuted) {
      mutedChannels = legacy.mutedChannelIds;
      spaceMuted = legacy.spaceMuted;
      void persistMutedChannels(address, spaceId, mutedChannels);
      void persistSpaceMuted(address, spaceId, spaceMuted);
    }
  }

  store = {
    ...store,
    [spaceId]: { mutedChannels: new Set(mutedChannels), spaceMuted },
  };
  // Keep the native-gate mirror in lockstep with the config-backed truth.
  mirrorSpaceMuteState(spaceId, mutedChannels, spaceMuted);
  emit();
}

function setChannelMuted(
  address: string,
  spaceId: string,
  channelId: string,
  muted: boolean,
): void {
  const prev = store[spaceId] ?? EMPTY;
  const next = new Set(prev.mutedChannels);
  if (muted) next.add(channelId);
  else next.delete(channelId);
  store = { ...store, [spaceId]: { ...prev, mutedChannels: next } };
  emit();
  const ids = [...next];
  void persistMutedChannels(address, spaceId, ids);
  mirrorSpaceMuteState(spaceId, ids, store[spaceId].spaceMuted);
}

function setSpaceMutedState(address: string, spaceId: string, muted: boolean): void {
  const prev = store[spaceId] ?? EMPTY;
  store = { ...store, [spaceId]: { ...prev, spaceMuted: muted } };
  emit();
  void persistSpaceMuted(address, spaceId, muted);
  mirrorSpaceMuteState(spaceId, [...prev.mutedChannels], muted);
}

/**
 * Re-read a space's mute state from local config and refresh the mirror. Call
 * when an inbound config sync may have changed it on another device, so the
 * gates + UI reflect the synced state without a remount.
 */
export function refreshChannelMuteFromConfig(address: string, spaceId: string): void {
  const mutedChannels = getLocalMutedChannels(address, spaceId);
  const spaceMuted = getLocalSpaceMuted(address, spaceId);
  store = {
    ...store,
    [spaceId]: { mutedChannels: new Set(mutedChannels), spaceMuted },
  };
  mirrorSpaceMuteState(spaceId, mutedChannels, spaceMuted);
  emit();
}

/**
 * Reactive set of space ids that are muted at the whole-space level, across the
 * given spaces. For list surfaces (the spaces list) that need to mark many
 * spaces at once without a per-space hook. Loads each space's state on first
 * sight (same migration + mirror as the single-space hook).
 */
export function useMutedSpaceIds(spaceIds: string[]): Set<string> {
  const { user } = useAuth();
  const address = user?.address ?? null;

  if (address) {
    for (const id of spaceIds) ensureSpaceLoaded(address, id);
  }

  useEffect(() => {
    if (!address) resetForAddress(null);
  }, [address]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const muted = new Set<string>();
  for (const id of spaceIds) {
    if (snapshot[id]?.spaceMuted) muted.add(id);
  }
  return muted;
}

/**
 * Channel/space mute for one space. Pass the spaceId the screen is showing.
 * Returns reactive `isChannelMuted` / `isSpaceMuted` and the toggles.
 */
export function useChannelMute(spaceId: string | undefined) {
  const { user } = useAuth();
  const address = user?.address ?? null;

  // Load this space's state on first sight so the first render is correct.
  if (address && spaceId) ensureSpaceLoaded(address, spaceId);

  useEffect(() => {
    if (!address) resetForAddress(null);
  }, [address]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const spaceState = (spaceId && snapshot[spaceId]) || EMPTY;

  const isChannelMuted = useCallback(
    (channelId: string): boolean =>
      spaceState.spaceMuted || spaceState.mutedChannels.has(channelId),
    [spaceState],
  );

  const isSpaceMuted = useCallback((): boolean => spaceState.spaceMuted, [spaceState]);

  const toggleChannelMute = useCallback(
    (channelId: string) => {
      if (!address || !spaceId) return;
      setChannelMuted(address, spaceId, channelId, !spaceState.mutedChannels.has(channelId));
    },
    [address, spaceId, spaceState],
  );

  const toggleSpaceMute = useCallback(() => {
    if (!address || !spaceId) return;
    setSpaceMutedState(address, spaceId, !spaceState.spaceMuted);
  }, [address, spaceId, spaceState]);

  return {
    mutedChannels: spaceState.mutedChannels,
    isChannelMuted,
    isSpaceMuted,
    toggleChannelMute,
    toggleSpaceMute,
  };
}
