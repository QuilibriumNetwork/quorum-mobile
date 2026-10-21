/**
 * channelBindings — per-user local bindings between a Quorum space (or
 * space-channel) and one or more Farcaster channels.
 *
 * The binding is purely a UI affordance: when the user opens a bound space's
 * channel, the UI offers to surface the linked Farcaster channel feed
 * alongside the chat. Bindings are stored locally because they're a personal
 * preference and don't need to be synced via the space metadata for the
 * feature to work.
 *
 * Keys:
 *   space:<spaceId>             → channelKey[] (linked Farcaster channels)
 *   space:<spaceId>:<channelId> → channelKey[] (override for a specific
 *                                 space-channel)
 *
 * The most-specific key wins when looking up.
 */

import { useCallback, useEffect, useState } from 'react';
import { createMMKV } from 'react-native-mmkv';
import type { Space } from '@quilibrium/quorum-shared';
import { getSpace, saveSpace } from '../config/spaceStorage';

const storage = createMMKV({ id: 'quorum-space-channel-bindings' });

/**
 * Update the space's linked Farcaster channels AND propagate the change to
 * every member via the space manifest. Members who receive the manifest
 * mirror the field back into their local MMKV store, so the picker stays
 * in sync across devices.
 *
 * Caller supplies `enqueueOutbound` from `useWebSocket()` so the manifest
 * control message actually goes out on the wire — broadcastSpaceUpdate
 * uploads via HTTP, but live notification to other members requires the
 * WS envelope it returns.
 *
 * Local MMKV is updated synchronously so the picker UI reflects the
 * change immediately even if the network call lags.
 */
export function updateSpaceBindings(
  spaceId: string,
  channelKeys: string[],
  enqueueOutbound: (prepare: () => Promise<string[]>) => void,
): void {
  setSpaceBindings(spaceId, channelKeys);

  const space = getSpace(spaceId);
  if (!space) return;

  const updated = { ...space, linkedFarcasterChannels: channelKeys } as Space & {
    linkedFarcasterChannels: string[];
  };
  saveSpace(updated);

  enqueueOutbound(async () => {
    const { broadcastSpaceUpdate } = await import('./broadcastSpaceUpdate');
    const result = await broadcastSpaceUpdate(updated);
    return result ? [result.wsEnvelope] : [];
  });
}

function spaceKey(spaceId: string): string {
  return `space:${spaceId}`;
}

function spaceChannelKey(spaceId: string, channelId: string): string {
  return `space:${spaceId}:${channelId}`;
}

function readArray(key: string): string[] {
  const raw = storage.getString(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeArray(key: string, value: string[]): void {
  storage.set(key, JSON.stringify(value));
}

/** Bindings for a whole space (apply to every channel in the space). */
export function getSpaceBindings(spaceId: string): string[] {
  return readArray(spaceKey(spaceId));
}

export function setSpaceBindings(spaceId: string, channelKeys: string[]): void {
  writeArray(spaceKey(spaceId), channelKeys);
}

/** Bindings for a specific space-channel (override the space-level list). */
export function getChannelBindings(spaceId: string, channelId: string): string[] {
  return readArray(spaceChannelKey(spaceId, channelId));
}

export function setChannelBindings(spaceId: string, channelId: string, channelKeys: string[]): void {
  writeArray(spaceChannelKey(spaceId, channelId), channelKeys);
}

/**
 * Effective bindings for a space-channel: the channel's overrides if any,
 * otherwise the space-level bindings.
 */
export function getEffectiveBindings(spaceId: string, channelId: string): string[] {
  const channelLevel = getChannelBindings(spaceId, channelId);
  if (channelLevel.length > 0) return channelLevel;
  return getSpaceBindings(spaceId);
}

/** Add or remove a single channel key in the space-level bindings. */
export function toggleSpaceBinding(spaceId: string, channelKey: string): string[] {
  const current = getSpaceBindings(spaceId);
  const next = current.includes(channelKey)
    ? current.filter((k) => k !== channelKey)
    : [...current, channelKey];
  setSpaceBindings(spaceId, next);
  return next;
}

/** Same shape as `useWalletPref` — re-read when the bindings change in
 *  storage, for cross-screen updates (this used to poll every 2s). */
export function useEffectiveBindings(spaceId: string, channelId: string): string[] {
  const [value, setValue] = useState<string[]>(() => getEffectiveBindings(spaceId, channelId));
  useEffect(() => {
    // Sync immediately when keys change (initial mount or route param resolves
    // from undefined to the real id), then on every change to this store: the
    // effective value depends on both the channel and the space keys.
    const sync = () => {
      const next = getEffectiveBindings(spaceId, channelId);
      setValue((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    sync();
    const listener = storage.addOnValueChangedListener(sync);
    return () => listener.remove();
  }, [spaceId, channelId]);
  return value;
}

export function useSpaceBindings(spaceId: string): [string[], (next: string[]) => void] {
  const [value, setValueLocal] = useState<string[]>(() => getSpaceBindings(spaceId));
  useEffect(() => {
    const sync = () => {
      const next = getSpaceBindings(spaceId);
      setValueLocal((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    sync();
    const listener = storage.addOnValueChangedListener(sync);
    return () => listener.remove();
  }, [spaceId]);
  const setValue = useCallback(
    (next: string[]) => {
      setValueLocal(next);
      setSpaceBindings(spaceId, next);
    },
    [spaceId],
  );
  return [value, setValue];
}
