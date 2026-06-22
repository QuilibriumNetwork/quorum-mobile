/**
 * notificationPrefs — persisted notification opt-out state.
 *
 * Three levels of granularity:
 *   1. Global on/off (user settings toggle).
 *   2. Per-space on/off (any member, not just admins).
 *   3. Per-channel on/off within a space.
 *
 * Resolution order at presentation time: global → space → channel.
 * If the global is off, nothing else matters. If the space is off,
 * channel-level "on" doesn't re-enable. (Standard mute-mention rules.)
 *
 * Storage: small dedicated MMKV instance to avoid coupling with the
 * encryption store. Keys are namespaced so future per-DM opt-outs can
 * live here too without collision.
 *
 * The store is mirrored to the iOS App Group so the NSE can apply the
 * same global/space/channel gates to OS-rendered pushes (see the store
 * comment below). The global + per-space toggles are ALSO synced to
 * quorum-api (pushPrefsSync) so the server filters ALERT pushes before
 * they ever reach the device; per-channel stays device-side because
 * the server can't see channel ids inside encrypted envelopes.
 */

import { type MMKV } from 'react-native-mmkv';
import { createMirroredMMKV } from '@/services/storage/mirroredMMKV';

const STORE_ID = 'quorum-notification-prefs';
const K_GLOBAL = 'global:enabled';
const K_SPACE_PREFIX = 'space:';
const K_CHANNEL_PREFIX = 'channel:';

// Mirrored to the App Group container on iOS so the NSE can read
// global / per-space / per-channel mute state and apply it to
// lock-screen notification suppression. Read happens in
// HubLogClassifier.swift via the same MMKV id at the App Group path.
let store: MMKV | null = null;
function getStore(): MMKV {
  if (!store) store = createMirroredMMKV({ id: STORE_ID });
  return store;
}

// Server sync — fire-and-forget after every server-relevant pref
// write. Dynamic import breaks the cycle (pushPrefsSync reads prefs
// from this module). The sync itself debounces and persists a retry
// flag, so dropping the promise here is safe.
function scheduleServerPrefsSync(): void {
  import('./pushPrefsSync')
    .then(({ syncPushPrefsWithQuorum }) => syncPushPrefsWithQuorum())
    .catch(() => {});
}

function spaceKey(spaceId: string): string {
  return `${K_SPACE_PREFIX}${spaceId}`;
}

function channelKey(spaceId: string, channelId: string): string {
  return `${K_CHANNEL_PREFIX}${spaceId}:${channelId}`;
}

// Global

/** True (default) when the user has push notifications enabled overall. */
export function getGlobalNotificationsEnabled(): boolean {
  const v = getStore().getBoolean(K_GLOBAL);
  return v === undefined ? true : v;
}

export function setGlobalNotificationsEnabled(enabled: boolean): void {
  getStore().set(K_GLOBAL, enabled);
  scheduleServerPrefsSync();
}

// Per-space

/** True (default) when this space is allowed to notify the user. */
export function getSpaceNotificationsEnabled(spaceId: string): boolean {
  const v = getStore().getBoolean(spaceKey(spaceId));
  return v === undefined ? true : v;
}

export function setSpaceNotificationsEnabled(spaceId: string, enabled: boolean): void {
  getStore().set(spaceKey(spaceId), enabled);
  scheduleServerPrefsSync();
}

/**
 * SpaceIds the user has explicitly muted (per-space toggle off).
 * Spaces default to enabled, so only explicit `false` entries count.
 * Used by pushPrefsSync to build the server-side muted_hubs list.
 */
export function getMutedSpaceIds(): string[] {
  const store = getStore();
  const out: string[] = [];
  for (const key of store.getAllKeys()) {
    if (!key.startsWith(K_SPACE_PREFIX)) continue;
    if (store.getBoolean(key) === false) {
      out.push(key.slice(K_SPACE_PREFIX.length));
    }
  }
  return out;
}

// Per-channel

/** True (default) when this channel is allowed to notify the user. */
export function getChannelNotificationsEnabled(spaceId: string, channelId: string): boolean {
  const v = getStore().getBoolean(channelKey(spaceId, channelId));
  return v === undefined ? true : v;
}

export function setChannelNotificationsEnabled(
  spaceId: string,
  channelId: string,
  enabled: boolean,
): void {
  getStore().set(channelKey(spaceId, channelId), enabled);
}

// --- UserConfig mirror ---
//
// The cross-device source of truth for channel/space mute is `UserConfig`
// (configService + useChannelMute). This MMKV store is a fast local mirror so
// the non-React notification gates (shouldNotifyForContext, the iOS NSE's
// HubLogClassifier.swift via the App-Group mirror) keep reading the same keys.
// The mirror is derived from UserConfig and rewritten on every change.
//
// Semantics bridge: UserConfig stores MUTED state; this store uses ENABLED
// booleans (muted ⟺ enabled === false).

/**
 * Overwrite this space's mirror keys to match the config-backed muted state.
 * `mutedChannelIds` are the channels muted in this space; `spaceMuted` is the
 * whole-space mute flag. Channels NOT in the list are set back to enabled, so
 * an unmute synced from another device clears the gate too.
 */
export function mirrorSpaceMuteState(
  spaceId: string,
  mutedChannelIds: string[],
  spaceMuted: boolean,
  knownChannelIds?: string[],
): void {
  const store = getStore();
  // Space-level gate (also fed to the server via pushPrefsSync).
  setSpaceNotificationsEnabled(spaceId, !spaceMuted);
  const muted = new Set(mutedChannelIds);
  // Set every muted channel's gate off.
  for (const channelId of muted) {
    store.set(channelKey(spaceId, channelId), false);
  }
  // Re-enable channels that are no longer muted. We can only re-enable channels
  // we know about: the explicitly-muted set is covered above; for the rest,
  // clear any stale `false` keys for this space that aren't in the muted set.
  const prefix = `${K_CHANNEL_PREFIX}${spaceId}:`;
  for (const key of store.getAllKeys()) {
    if (!key.startsWith(prefix)) continue;
    const channelId = key.slice(prefix.length);
    if (!muted.has(channelId)) store.set(key, true);
  }
  // If the caller passed the full channel list, make sure none are left muted
  // that shouldn't be (defensive; the loop above already covers existing keys).
  if (knownChannelIds) {
    for (const channelId of knownChannelIds) {
      if (!muted.has(channelId)) store.set(channelKey(spaceId, channelId), true);
    }
  }
}

/**
 * Read existing device-local mutes so they can be migrated into UserConfig once.
 * Returns the muted channel ids for the space and whether the space is muted.
 * Does not clear anything; migration is idempotent.
 */
export function readLegacyMutesForSpace(spaceId: string): {
  mutedChannelIds: string[];
  spaceMuted: boolean;
} {
  const store = getStore();
  const spaceMuted = store.getBoolean(spaceKey(spaceId)) === false;
  const prefix = `${K_CHANNEL_PREFIX}${spaceId}:`;
  const mutedChannelIds: string[] = [];
  for (const key of store.getAllKeys()) {
    if (!key.startsWith(prefix)) continue;
    if (store.getBoolean(key) === false) {
      mutedChannelIds.push(key.slice(prefix.length));
    }
  }
  return { mutedChannelIds, spaceMuted };
}

// Resolution

/**
 * Top-level "should this notification be shown?" gate. Global wins
 * outright; otherwise space + channel both need to be enabled. Pass
 * `spaceId`/`channelId` when the context is known (e.g. when a
 * hub-log push is being processed). Omit for context-less paths like
 * the generic "you have new messages" wake notification — those still
 * respect the global toggle but can't filter by space.
 */
export function shouldNotifyForContext(params: {
  spaceId?: string;
  channelId?: string;
}): boolean {
  if (!getGlobalNotificationsEnabled()) return false;
  if (params.spaceId) {
    if (!getSpaceNotificationsEnabled(params.spaceId)) return false;
    if (params.channelId && !getChannelNotificationsEnabled(params.spaceId, params.channelId)) {
      return false;
    }
  }
  return true;
}
