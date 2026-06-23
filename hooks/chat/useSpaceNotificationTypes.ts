/**
 * useSpaceNotificationTypes — per-space choice of which mention/reply types
 * notify the user (`@you`, `@everyone`, `@roles`, replies), synced across
 * devices via UserConfig.
 *
 * State lives in `UserConfig.notificationSettings[spaceId].enabledNotificationTypes`
 * (the same field desktop uses), so a toggle on one device shows up on the
 * others via the encrypted config blob. Read straight back from local config,
 * never through the in-memory `user`.
 *
 * The RECEIVE side (services/notifications/logMentionOrReply) reads the same
 * value synchronously via `getLocalNotificationTypes` — no React needed there.
 * This hook is just the reactive layer for the settings UI; a module-level
 * store + useSyncExternalStore so every consumer updates instantly on a toggle.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '@/context';
import {
  getLocalNotificationTypes,
  setNotificationTypes as persistNotificationTypes,
  DEFAULT_NOTIFICATION_TYPES,
  type SpaceNotificationTypeId,
} from '@/services/config';

let store: Record<string, SpaceNotificationTypeId[]> = {};
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

function getSnapshot(): Record<string, SpaceNotificationTypeId[]> {
  return store;
}

function resetForAddress(address: string | null): void {
  if (loadedForAddress === address) return;
  loadedForAddress = address;
  store = {};
  loadedSpaces.clear();
  emit();
}

function ensureSpaceLoaded(address: string, spaceId: string): void {
  if (loadedSpaces.has(spaceId)) return;
  loadedSpaces.add(spaceId);
  store = { ...store, [spaceId]: getLocalNotificationTypes(address, spaceId) };
  emit();
}

function setTypes(
  address: string,
  spaceId: string,
  types: SpaceNotificationTypeId[]
): void {
  store = { ...store, [spaceId]: types };
  emit();
  void persistNotificationTypes(address, spaceId, types);
}

/**
 * Re-read a space's notification types from local config. Call after an inbound
 * config sync may have changed them on another device.
 */
export function refreshNotificationTypesFromConfig(address: string, spaceId: string): void {
  store = { ...store, [spaceId]: getLocalNotificationTypes(address, spaceId) };
  emit();
}

export function useSpaceNotificationTypes(spaceId: string): {
  enabledTypes: SpaceNotificationTypeId[];
  isEnabled: (type: SpaceNotificationTypeId) => boolean;
  toggleType: (type: SpaceNotificationTypeId) => void;
} {
  const { user } = useAuth();
  const address = user?.address ?? null;

  useEffect(() => {
    resetForAddress(address);
    if (address && spaceId) ensureSpaceLoaded(address, spaceId);
  }, [address, spaceId]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const enabledTypes = snapshot[spaceId] ?? DEFAULT_NOTIFICATION_TYPES;

  const isEnabled = useCallback(
    (type: SpaceNotificationTypeId) => enabledTypes.includes(type),
    [enabledTypes]
  );

  const toggleType = useCallback(
    (type: SpaceNotificationTypeId) => {
      if (!address || !spaceId) return;
      const next = enabledTypes.includes(type)
        ? enabledTypes.filter((t) => t !== type)
        : [...enabledTypes, type];
      setTypes(address, spaceId, next);
    },
    [address, spaceId, enabledTypes]
  );

  return { enabledTypes, isEnabled, toggleType };
}
