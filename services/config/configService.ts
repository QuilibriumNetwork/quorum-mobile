// Encrypted config sync: AES-GCM + Ed448 signatures, timestamp-based conflict resolution.

import { base64ToHex, numberArrayToBase64 } from '@/utils/encoding';
import { InteractionManager } from 'react-native';
import { sha512 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/webcrypto.js';
import { createMMKV, type MMKV } from 'react-native-mmkv';
import { getQuorumClient } from '../api/quorumClient';
import { mmkvStorage } from '../offline/storage';
import { getPrivateKey, getPublicKey } from '../onboarding/secureStorage';
import { NativeCryptoProvider } from '../crypto/native-provider';
import {
  type UserConfig,
  type Bookmark,
  type NavItem,
  type EncryptionState,
  BOOKMARKS_CONFIG,
  int64ToBytes,
  hexToBytes,
  bytesToHex,
} from '@quilibrium/quorum-shared';
import { getAllSpaces, getSpaceKey, getSpaceKeys, saveSpaceKey, clearSpaceStorage } from './spaceStorage';
import { getMMKVAdapter } from '../storage/mmkvAdapter';
import { encryptionStateStorage } from '../crypto/encryption-state-storage';
import type { SpaceKeyInfo } from './spaceSyncService';

// Storage for user config
const configStorage: MMKV = createMMKV({ id: 'quorum-config' });

// Storage for bookmarks (separate for efficiency)
const bookmarkStorage: MMKV = createMMKV({ id: 'quorum-bookmarks' });

const CONFIG_KEY_PREFIX = 'user_config:';
const BOOKMARKS_KEY_PREFIX = 'bookmarks:';
const DELETED_BOOKMARKS_KEY = 'deleted_bookmark_ids:';

// NavItems Validation

const MAX_FOLDERS = 20;
const MAX_SPACES_PER_FOLDER = 100;
function validateItems(items: NavItem[]): NavItem[] {
  let folderCount = 0;
  return items.filter((item) => {
    if (item.type === 'folder') {
      if (folderCount >= MAX_FOLDERS) {
        return false;
      }
      folderCount++;
      // Limit spaces per folder
      if (item.spaceIds.length > MAX_SPACES_PER_FOLDER) {
        item.spaceIds = item.spaceIds.slice(0, MAX_SPACES_PER_FOLDER);
      }
    }
    return true;
  });
}

// Bookmark Storage

export function getLocalBookmarks(address: string): Bookmark[] {
  const key = `${BOOKMARKS_KEY_PREFIX}${address}`;
  const data = bookmarkStorage.getString(key);
  if (!data) return [];
  try {
    return JSON.parse(data) as Bookmark[];
  } catch {
    return [];
  }
}

function saveLocalBookmarks(address: string, bookmarks: Bookmark[]): void {
  const key = `${BOOKMARKS_KEY_PREFIX}${address}`;
  // Enforce max bookmarks limit
  const limitedBookmarks = bookmarks.slice(0, BOOKMARKS_CONFIG.MAX_BOOKMARKS);
  bookmarkStorage.set(key, JSON.stringify(limitedBookmarks));
}

export function addBookmark(address: string, bookmark: Bookmark): void {
  const bookmarks = getLocalBookmarks(address);
  // Check for duplicate messageId
  const existingIndex = bookmarks.findIndex((b) => b.messageId === bookmark.messageId);
  if (existingIndex >= 0) {
    // Replace if newer
    if (bookmark.createdAt > bookmarks[existingIndex].createdAt) {
      bookmarks[existingIndex] = bookmark;
    }
  } else {
    bookmarks.unshift(bookmark); // Add to beginning (newest first)
  }
  saveLocalBookmarks(address, bookmarks);
}

export function removeBookmark(address: string, bookmarkId: string): void {
  const bookmarks = getLocalBookmarks(address);
  const filtered = bookmarks.filter((b) => b.bookmarkId !== bookmarkId);
  saveLocalBookmarks(address, filtered);

  // Add to deleted tombstones
  const deletedIds = getDeletedBookmarkIds(address);
  if (!deletedIds.includes(bookmarkId)) {
    deletedIds.push(bookmarkId);
    saveDeletedBookmarkIds(address, deletedIds);
  }
}

function getDeletedBookmarkIds(address: string): string[] {
  const key = `${DELETED_BOOKMARKS_KEY}${address}`;
  const data = bookmarkStorage.getString(key);
  if (!data) return [];
  try {
    return JSON.parse(data) as string[];
  } catch {
    return [];
  }
}

function saveDeletedBookmarkIds(address: string, ids: string[]): void {
  const key = `${DELETED_BOOKMARKS_KEY}${address}`;
  bookmarkStorage.set(key, JSON.stringify(ids));
}

function clearDeletedBookmarkIds(address: string): void {
  const key = `${DELETED_BOOKMARKS_KEY}${address}`;
  bookmarkStorage.remove(key);
}

// Last-write-wins merge with tombstone tracking; deduplicates by messageId.
function mergeBookmarks(
  local: Bookmark[],
  remote: Bookmark[],
  deletedIds: string[]
): Bookmark[] {
  const bookmarkMap = new Map<string, Bookmark>();
  const messageIdToBookmarkId = new Map<string, string>();

  const addBookmark = (bookmark: Bookmark) => {
    if (deletedIds.includes(bookmark.bookmarkId)) return;

    // Check for existing bookmark pointing to same message
    const existingBookmarkId = messageIdToBookmarkId.get(bookmark.messageId);
    const existing = existingBookmarkId ? bookmarkMap.get(existingBookmarkId) : undefined;

    if (!existing || bookmark.createdAt > existing.createdAt) {
      // Remove old duplicate if exists
      if (existingBookmarkId) {
        bookmarkMap.delete(existingBookmarkId);
      }
      bookmarkMap.set(bookmark.bookmarkId, bookmark);
      messageIdToBookmarkId.set(bookmark.messageId, bookmark.bookmarkId);
    }
  };

  // Add local and remote bookmarks with deduplication
  local.forEach(addBookmark);
  remote.forEach(addBookmark);

  // Convert back to array and sort by creation time (newest first)
  return Array.from(bookmarkMap.values()).sort((a, b) => b.createdAt - a.createdAt);
}

// Default Config

function getDefaultUserConfig(address: string): UserConfig {
  return {
    address,
    spaceIds: [],
    items: [],
    allowSync: false,
    nonRepudiable: true,
    timestamp: 0,
    notificationSettings: {},
    bookmarks: [],
    deletedBookmarkIds: [],
  };
}

export function getLocalUserConfig(address: string): UserConfig | null {
  const key = `${CONFIG_KEY_PREFIX}${address}`;
  const data = configStorage.getString(key);
  if (!data) return null;
  try {
    return JSON.parse(data) as UserConfig;
  } catch {
    return null;
  }
}

export function saveLocalUserConfig(config: UserConfig): void {
  const key = `${CONFIG_KEY_PREFIX}${config.address}`;
  configStorage.set(key, JSON.stringify(config));
}

// AES-256 key = SHA-512(private_key)[0:32]
const derivedKeyCache = new Map<string, Uint8Array>();

function deriveConfigKey(privateKeyHex: string): Uint8Array {
  const cached = derivedKeyCache.get(privateKeyHex);
  if (cached) return cached;

  const privateKeyBytes = hexToBytes(privateKeyHex);
  const hash = sha512(new Uint8Array(privateKeyBytes));
  const key = hash.slice(0, 32);
  derivedKeyCache.set(privateKeyHex, key);
  return key;
}

// Returns hex(ciphertext + IV)
function encryptConfig(config: UserConfig, key: Uint8Array): string {
  const iv = randomBytes(12);
  const configJson = JSON.stringify(config);
  const encoded = new TextEncoder().encode(configJson);

  const cipher = gcm(key, iv);
  const ciphertext = cipher.encrypt(encoded);

  // Concatenate ciphertext + IV as hex
  const ciphertextHex = bytesToHex(ciphertext);
  const ivHex = bytesToHex(iv);
  return ciphertextHex + ivHex;
}

// Input: hex(ciphertext + IV), IV is last 24 hex chars (12 bytes)
function decryptConfig(encryptedHex: string, key: Uint8Array): UserConfig {
  // Extract IV from last 24 hex chars (12 bytes)
  const ivHex = encryptedHex.slice(-24);
  const ciphertextHex = encryptedHex.slice(0, -24);

  const iv = new Uint8Array(hexToBytes(ivHex));
  const ciphertext = new Uint8Array(hexToBytes(ciphertextHex));

  const cipher = gcm(key, iv);
  const decrypted = cipher.decrypt(ciphertext);

  const decoded = new TextDecoder().decode(decrypted);
  return JSON.parse(decoded) as UserConfig;
}

// Signs: encrypted_config_bytes + timestamp_bytes
async function signConfigData(
  encryptedConfig: string,
  timestamp: number,
  privateKeyHex: string
): Promise<string> {
  const cryptoProvider = new NativeCryptoProvider();

  // Build data to sign: UTF-8 bytes of encrypted string + timestamp bytes
  const configBytes = new TextEncoder().encode(encryptedConfig);
  const timestampBytes = int64ToBytes(timestamp);

  const dataToSign = new Uint8Array([...configBytes, ...timestampBytes]);

  // Convert to base64 for native module
  const privateKeyBase64 = btoa(
    String.fromCharCode(...hexToBytes(privateKeyHex))
  );
  const messageBase64 = numberArrayToBase64(Array.from(dataToSign));

  const signatureBase64 = await cryptoProvider.signEd448(privateKeyBase64, messageBase64);
  return base64ToHex(signatureBase64);
}

async function verifyConfigSignature(
  encryptedConfig: string,
  timestamp: number,
  signature: string,
  publicKeyHex: string
): Promise<boolean> {
  const cryptoProvider = new NativeCryptoProvider();

  // Build data that was signed
  const configBytes = new TextEncoder().encode(encryptedConfig);
  const timestampBytes = int64ToBytes(timestamp);
  const dataToVerify = new Uint8Array([...configBytes, ...timestampBytes]);

  // Convert to base64 for native module
  const publicKeyBase64 = btoa(
    String.fromCharCode(...hexToBytes(publicKeyHex))
  );
  const messageBase64 = numberArrayToBase64(Array.from(dataToVerify));
  const signatureBase64 = btoa(
    String.fromCharCode(...hexToBytes(signature))
  );

  try {
    // Use native verify - QuorumCrypto.verifyEd448 returns 'true' or 'false' string
    const result = await (await import('../../modules/quorum-crypto/src')).verifyEd448(
      publicKeyBase64,
      messageBase64,
      signatureBase64
    );
    return result;
  } catch (error) {
    return false;
  }
}

// Returns remote config if newer than local, otherwise local config.
export async function getConfig(address: string): Promise<UserConfig> {
  const client = getQuorumClient();
  const privateKey = await getPrivateKey();
  const publicKey = await getPublicKey();

  if (!privateKey || !publicKey) {
    return getLocalUserConfig(address) ?? getDefaultUserConfig(address);
  }

  // Try to fetch remote config
  let remoteConfig: { user_config: string; timestamp: number; signature: string } | undefined;
  try {
    remoteConfig = (await client.getUserSettings(address)) ?? undefined;
  } catch {
    // Network failure — fall through to local config
  }

  const localConfig = getLocalUserConfig(address);

  // If no remote config, return local or default
  if (!remoteConfig || !remoteConfig.user_config) {
    if (!localConfig) {
      return getDefaultUserConfig(address);
    }
    return localConfig;
  }

  // Check timestamp - if local is newer, use local
  if (remoteConfig.timestamp < (localConfig?.timestamp ?? 0)) {
    return localConfig!;
  }

  // If timestamps match, use local (no update needed)
  if (remoteConfig.timestamp === localConfig?.timestamp) {
    return localConfig;
  }

  // Verify signature
  const signatureValid = await verifyConfigSignature(
    remoteConfig.user_config,
    remoteConfig.timestamp,
    remoteConfig.signature,
    publicKey
  );

  if (!signatureValid) {
    return localConfig ?? getDefaultUserConfig(address);
  }

  // Decrypt config
  try {
    const key = deriveConfigKey(privateKey);
    const decryptedConfig = decryptConfig(remoteConfig.user_config, key);

    // Validate NavItems
    if (decryptedConfig.items) {
      decryptedConfig.items = validateItems(decryptedConfig.items);
    }

    // Merge bookmarks from remote with local
    if (decryptedConfig.bookmarks && decryptedConfig.bookmarks.length > 0) {
      const localBookmarks = getLocalBookmarks(address);
      const mergedBookmarks = mergeBookmarks(
        localBookmarks,
        decryptedConfig.bookmarks,
        decryptedConfig.deletedBookmarkIds ?? []
      );
      saveLocalBookmarks(address, mergedBookmarks);
    }

    // Sync spaces from spaceKeys - defer to after animations complete
    if (decryptedConfig.spaceKeys && decryptedConfig.spaceKeys.length > 0) {
      // Schedule space sync after UI interactions complete to avoid jank
      const spaceKeysToSync = decryptedConfig.spaceKeys;
      const userInfo = {
        address,
        displayName: decryptedConfig.name,
        profileImage: decryptedConfig.profile_image,
      };
      InteractionManager.runAfterInteractions(async () => {
        try {
          const { syncSpacesFromConfig } = await import('./spaceSyncService');
          await syncSpacesFromConfig(
            spaceKeysToSync,
            userInfo,
            // WebSocket listen callback - will be handled by caller if needed
            undefined
          );
        } catch {
          // Space sync is best-effort during config load — spaces will sync on next app launch
        }
      });
    }

    // Save to local storage
    // IMPORTANT: Preserve name and profile_image fields from remote config
    const configWithTimestamp: UserConfig = {
      ...decryptedConfig,
      timestamp: remoteConfig.timestamp,
      // Include merged bookmarks in the stored config
      bookmarks: getLocalBookmarks(address),
      // Ensure profile fields are preserved
      name: decryptedConfig.name,
      profile_image: decryptedConfig.profile_image,
      bio: (decryptedConfig as any).bio,
      isProfilePublic: (decryptedConfig as any).isProfilePublic,
      // Explicitly carry the synced muted-DM list so an incoming config can't
      // silently drop it (the failure mode that hit primaryUsername). The spread
      // above should include it, but mute relies on this round-trip, so list it.
      mutedConversations: (decryptedConfig as any).mutedConversations,
      // Same round-trip guard for the synced channel/space notification mute
      // (mutedChannels[spaceId] and notificationSettings[spaceId].isMuted) so an
      // incoming config can't silently drop a mute toggled on another device.
      mutedChannels: (decryptedConfig as any).mutedChannels,
      notificationSettings: (decryptedConfig as any).notificationSettings,
      // Synced personal block list (per-space viewer-side hide).
      blockedUsers: (decryptedConfig as any).blockedUsers,
    } as UserConfig;
    saveLocalUserConfig(configWithTimestamp);

    return configWithTimestamp;
  } catch (error) {
    return localConfig ?? getDefaultUserConfig(address);
  }
}

// Only includes spaces with valid encryption state (matches desktop).
function collectSpaceKeysForSync(): SpaceKeyInfo[] {
  const spaces = getAllSpaces();
  const spaceKeyInfos: SpaceKeyInfo[] = [];

  for (const space of spaces) {
    // Get all keys for this space
    const keys = getSpaceKeys(space.spaceId);
    if (keys.length === 0) continue;

    // Get encryption state for this space
    // Space conversations use conversationId = spaceId/spaceId
    const conversationId = `${space.spaceId}/${space.spaceId}`;
    const encryptionStates = encryptionStateStorage.getEncryptionStates(conversationId);

    if (encryptionStates.length === 0) {
      continue;
    }

    // Use the first (and typically only) encryption state
    const state = encryptionStates[0];

    spaceKeyInfos.push({
      spaceId: space.spaceId,
      encryptionState: {
        conversationId: state.conversationId,
        inboxId: state.inboxId,
        state: state.state,
        timestamp: state.timestamp,
      },
      keys: keys.map((k) => ({
        keyId: k.keyId,
        address: k.address,
        publicKey: k.publicKey,
        privateKey: k.privateKey,
        spaceId: k.spaceId,
      })),
    });
  }

  return spaceKeyInfos;
}

/**
 * Migration for spaces that predate the signing-key split: promote the local
 * inbox key to the 'signing' slot so it rides into the config blob and the
 * user's other devices can adopt it (their control messages are dropped
 * fleet-wide until they sign with the join-bound key).
 *
 * Promote only when the local self member row binds THIS inbox key's address —
 * on the create/join device that row was written by the join flow with this
 * exact key, so the check passes; a device holding only a device-local mailbox
 * key whose row says otherwise must not publish it. Known fail-soft limit: a
 * device that synced the space BEFORE the split also self-bound its own fresh
 * key, so it can pass this check and publish the wrong key — receivers of the
 * blob adopt-if-absent, so the outcome is at worst today's already-broken
 * state for the losing devices, never a regression, and it self-corrects when
 * the join device's blob write is the one a device adopts first.
 */
async function promoteSpaceSigningKeys(userAddress: string): Promise<void> {
  const adapter = getMMKVAdapter();
  for (const space of getAllSpaces()) {
    if (getSpaceKey(space.spaceId, 'signing')) continue;
    const inboxKey = getSpaceKey(space.spaceId, 'inbox');
    if (!inboxKey?.address || !inboxKey.privateKey || !inboxKey.publicKey) continue;
    const selfRow = await adapter.getSpaceMember(space.spaceId, userAddress);
    if (!selfRow?.inbox_address || selfRow.inbox_address !== inboxKey.address) continue;
    saveSpaceKey({
      spaceId: space.spaceId,
      keyId: 'signing',
      address: inboxKey.address,
      publicKey: inboxKey.publicKey,
      privateKey: inboxKey.privateKey,
    });
  }
}

// Syncs to server if config.allowSync is true.
export async function saveConfig(config: UserConfig): Promise<void> {
  const privateKey = await getPrivateKey();
  const publicKey = await getPublicKey();

  const ts = Date.now();
  config.timestamp = ts;

  // Include current bookmarks and deleted bookmark IDs in config for sync
  const address = config.address;
  config.bookmarks = getLocalBookmarks(address);
  config.deletedBookmarkIds = getDeletedBookmarkIds(address);

  // Sync to server if allowed
  if (config.allowSync && privateKey && publicKey) {
    try {
      // Promote pre-split signing keys, then collect space keys before
      // encryption (matches desktop behavior). The 'signing' entries ride
      // along in spaceKeys like any other key.
      await promoteSpaceSigningKeys(address);
      const spaceKeys = collectSpaceKeysForSync();
      config.spaceKeys = spaceKeys;

      // Ensure spaceIds and items only include spaces that have encryption keys
      // This prevents server validation errors
      const validSpaceIds = new Set(spaceKeys.map((sk) => sk.spaceId));
      config.spaceIds = (config.spaceIds ?? []).filter((id) => validSpaceIds.has(id));

      if (config.items) {
        config.items = config.items.filter((item) => {
          if (item.type === 'space') {
            return validSpaceIds.has(item.id);
          } else {
            // For folders, filter out spaces without encryption keys
            item.spaceIds = item.spaceIds.filter((id) => validSpaceIds.has(id));
            // Remove empty folders
            return item.spaceIds.length > 0;
          }
        });
      }

      const key = deriveConfigKey(privateKey);
      const encryptedConfig = encryptConfig(config, key);
      const signature = await signConfigData(encryptedConfig, ts, privateKey);

      const client = getQuorumClient();
      await client.postUserSettings(config.address, {
        user_address: config.address,
        user_public_key: publicKey,
        user_config: encryptedConfig,
        timestamp: ts,
        signature,
      });

      // Clear deleted bookmark tombstones after successful sync
      clearDeletedBookmarkIds(address);
      config.deletedBookmarkIds = [];
    } catch (error) {
      // Continue to save locally even if sync fails
    }
  }

  // Always save locally
  saveLocalUserConfig(config);
}

export function clearConfigStorage(): void {
  configStorage.clearAll();
  bookmarkStorage.clearAll();
  clearSpaceStorage();
}

export async function updateConfig(
  address: string,
  updates: Partial<UserConfig>
): Promise<UserConfig> {
  const currentConfig = getLocalUserConfig(address) ?? getDefaultUserConfig(address);
  const updatedConfig = { ...currentConfig, ...updates };
  await saveConfig(updatedConfig);
  return updatedConfig;
}

export function getDisplayName(address: string): string | undefined {
  const config = getLocalUserConfig(address);
  return config?.name;
}

export function getProfileImage(address: string): string | undefined {
  const config = getLocalUserConfig(address);
  return config?.profile_image;
}

// Muted DM conversations — config-backed so they sync across devices (the
// "bookmark pattern": stored in UserConfig, read straight back from the local
// MMKV config, never routed through the in-memory `user` object). Matches
// desktop, which also stores mute in UserConfig.mutedConversations.

export function getLocalMutedConversations(address: string): string[] {
  const config = getLocalUserConfig(address);
  return config?.mutedConversations ?? [];
}

/** Persist the muted list locally and sync outbound when allowSync is on. */
export async function setMutedConversations(
  address: string,
  mutedConversations: string[]
): Promise<void> {
  const current = getLocalUserConfig(address) ?? getDefaultUserConfig(address);
  const updated: UserConfig = { ...current, mutedConversations };
  // Persist locally first so the value survives even if the sync below fails.
  saveLocalUserConfig(updated);
  try {
    if (updated.allowSync) {
      await saveConfig(updated);
    }
  } catch {
    // Config sync is best-effort — the mute change is already saved locally.
  }
}

// Resolve the muted list for the CURRENT user without the caller needing the
// address. Used by the notification gate + unread-count paths, which run
// outside React (no useAuth) and only have a conversationId. Reads the signed-in
// address from the same MMKV key AuthContext writes (`auth:user`).
function getCurrentUserAddressFromStorage(): string | null {
  try {
    const json = mmkvStorage.getItem('auth:user');
    if (!json) return null;
    const u = JSON.parse(json) as { address?: string };
    return u?.address ?? null;
  } catch {
    return null;
  }
}

/** True when `conversationId` is muted for the currently signed-in user. */
export function isConversationMutedForCurrentUser(conversationId: string): boolean {
  const address = getCurrentUserAddressFromStorage();
  if (!address) return false;
  return getLocalMutedConversations(address).includes(conversationId);
}

// --- Channel / Space notification mute (synced via UserConfig) ---
//
// Per-channel mute lives in `UserConfig.mutedChannels[spaceId]: string[]` and
// per-space mute in `UserConfig.notificationSettings[spaceId].isMuted` — the same
// fields desktop uses, so the setting syncs cross-device via the encrypted config
// blob. Write the field, persist locally, let `saveConfig` carry it, read back
// from local config.
//
// `notificationSettings[spaceId].isMuted` is accessed via `(config as any)` because
// the pinned shared `NotificationSettings` type does not declare `isMuted` yet; it
// rides the untyped JSON config blob correctly regardless.
// TODO: drop the `as any` once the shared NotificationSettings.isMuted type is published + pinned.

export function getLocalMutedChannels(address: string, spaceId: string): string[] {
  const config = getLocalUserConfig(address);
  return config?.mutedChannels?.[spaceId] ?? [];
}

/** Persist the muted-channel list for a space locally and sync outbound. */
export async function setMutedChannels(
  address: string,
  spaceId: string,
  mutedChannelIds: string[]
): Promise<void> {
  const current = getLocalUserConfig(address) ?? getDefaultUserConfig(address);
  const updated: UserConfig = {
    ...current,
    mutedChannels: { ...(current.mutedChannels ?? {}), [spaceId]: mutedChannelIds },
  };
  saveLocalUserConfig(updated);
  try {
    if (updated.allowSync) {
      await saveConfig(updated);
    }
  } catch {
    // Best-effort sync — the mute change is already saved locally.
  }
}

export function getLocalSpaceMuted(address: string, spaceId: string): boolean {
  const config = getLocalUserConfig(address);
  const settings = config?.notificationSettings?.[spaceId] as
    | { isMuted?: boolean }
    | undefined;
  return settings?.isMuted ?? false;
}

/** Persist the per-space mute flag locally and sync outbound. */
export async function setSpaceMuted(
  address: string,
  spaceId: string,
  muted: boolean
): Promise<void> {
  const current = getLocalUserConfig(address) ?? getDefaultUserConfig(address);
  const prevSettings = current.notificationSettings ?? {};
  const updated: UserConfig = {
    ...current,
    notificationSettings: {
      ...prevSettings,
      // Preserve any existing per-space notification settings; add isMuted, which
      // the pinned shared type doesn't declare yet (rides the untyped config blob).
      [spaceId]: { ...(prevSettings[spaceId] ?? {}), isMuted: muted } as any,
    },
  };
  saveLocalUserConfig(updated);
  try {
    if (updated.allowSync) {
      await saveConfig(updated);
    }
  } catch {
    // Best-effort sync — the mute change is already saved locally.
  }
}

// --- Per-space notification TYPE settings (synced via UserConfig) ---
//
// Which mention/reply types notify the user, per space. Lives in
// `UserConfig.notificationSettings[spaceId].enabledNotificationTypes` — the same
// field desktop uses (SpaceNotificationTypeId[]), so it syncs cross-device via
// the encrypted config blob. Accessed via `as any` because the pinned shared
// `NotificationSettings` type (in user.ts) doesn't declare
// `enabledNotificationTypes` — the richer `SpaceNotificationSettings` shape rides
// the untyped JSON blob correctly. Shares the per-space object with isMuted.
// TODO: drop the `as any` once the shared type is published + pinned.

export type SpaceNotificationTypeId =
  | 'mention-you'
  | 'mention-everyone'
  | 'mention-roles'
  | 'reply';

/** All four types enabled — the desktop default when a space has no saved settings. */
export const DEFAULT_NOTIFICATION_TYPES: SpaceNotificationTypeId[] = [
  'mention-you',
  'mention-everyone',
  'mention-roles',
  'reply',
];

/**
 * Enabled notification types for a space. Returns the all-enabled default when
 * the space has no saved settings (matches desktop's getDefaultNotificationSettings).
 */
export function getLocalNotificationTypes(
  address: string,
  spaceId: string
): SpaceNotificationTypeId[] {
  const config = getLocalUserConfig(address);
  const settings = config?.notificationSettings?.[spaceId] as
    | { enabledNotificationTypes?: SpaceNotificationTypeId[] }
    | undefined;
  return settings?.enabledNotificationTypes ?? DEFAULT_NOTIFICATION_TYPES;
}

/** Persist the enabled notification types for a space locally and sync outbound. */
export async function setNotificationTypes(
  address: string,
  spaceId: string,
  enabledNotificationTypes: SpaceNotificationTypeId[]
): Promise<void> {
  const current = getLocalUserConfig(address) ?? getDefaultUserConfig(address);
  const prevSettings = current.notificationSettings ?? {};
  const updated: UserConfig = {
    ...current,
    notificationSettings: {
      ...prevSettings,
      // Preserve isMuted + spaceId; add/overwrite enabledNotificationTypes.
      [spaceId]: {
        ...(prevSettings[spaceId] ?? {}),
        spaceId,
        enabledNotificationTypes,
      } as any,
    },
  };
  saveLocalUserConfig(updated);
  try {
    if (updated.allowSync) {
      await saveConfig(updated);
    }
  } catch {
    // Best-effort sync — the change is already saved locally.
  }
}

// --- Personal "Block" (viewer-side hide, synced via UserConfig) ---
//
// Blocking a user hides all of their messages from YOUR own rendered stream,
// per space. Purely viewer-side: no moderation effect, no permission, doesn't
// touch the user for anyone else — distinct from the role-gated moderation mute.
// State lives in `UserConfig.blockedUsers[spaceId]: string[]` (the same field
// desktop uses) so it syncs cross-device via the config blob.
//
// Accessed via `(config as any).blockedUsers` because the field isn't in the
// pinned shared UserConfig type yet (lands typed in a later shared publish).
// TODO: drop the `as any` once the shared blockedUsers type is published + pinned.

export function getLocalBlockedUsers(address: string, spaceId: string): string[] {
  const config = getLocalUserConfig(address);
  return ((config as any)?.blockedUsers as Record<string, string[]> | undefined)?.[spaceId] ?? [];
}

/** Persist the per-space blocked-users list locally and sync outbound. */
export async function setBlockedUsers(
  address: string,
  spaceId: string,
  blockedUserIds: string[]
): Promise<void> {
  const current = getLocalUserConfig(address) ?? getDefaultUserConfig(address);
  const prevBlocked = ((current as any).blockedUsers as Record<string, string[]> | undefined) ?? {};
  const updated: UserConfig = {
    ...current,
    blockedUsers: { ...prevBlocked, [spaceId]: blockedUserIds },
  } as any;
  saveLocalUserConfig(updated);
  try {
    if (updated.allowSync) {
      await saveConfig(updated);
    }
  } catch {
    // Best-effort sync — the block change is already saved locally.
  }
}
