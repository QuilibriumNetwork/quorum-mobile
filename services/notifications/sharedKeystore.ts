/**
 * sharedKeystore — mirrors a small catalog (space hub-address → space
 * name, DM conversation inbox-address → remote display name) into the
 * App Group container so the iOS Notification Service Extension can
 * rewrite incoming push titles before display.
 *
 * Privacy posture: this file lives only in the device's App Group
 * sandbox, never leaves the device. The NSE reads it synchronously on
 * push receipt, never writes.
 *
 * Iteration 1 scope (what this file actually delivers): DM sender
 * display name + space name. NO message body — that would require
 * decryption, which would require coordinating Triple/Double Ratchet
 * state with the main app. See feedback memory + push-design notes for
 * why that's deferred.
 */

import { Platform } from 'react-native';
import { truncateAddress } from '@/utils/formatAddress';
import { getAllSpaces, getSpaceKey } from '@/services/config/spaceStorage';
import { encryptionStateStorage } from '@/services/crypto/encryption-state-storage';
import { storage as mmkv } from '@/services/offline/storage';

// Android doesn't have the App Group concept and doesn't need a shared
// catalog file — its notification handler runs in the same JS context
// and reads MMKV directly. So we lazy-import expo-file-system + the
// native module only on iOS to avoid pulling in code that might
// surprise us on Android.
type AppGroupModule = { getAppGroupPath?: () => string | null };
type FileSystemLegacy = {
  writeAsStringAsync: (uri: string, content: string, options: { encoding: string }) => Promise<void>;
  moveAsync: (params: { from: string; to: string }) => Promise<void>;
  EncodingType: { UTF8: string };
};

export interface CatalogEntryDM {
  /** Display name to show as the push title when this inbox receives a DM. */
  display_name: string;
}

export interface CatalogEntrySpace {
  /** Space name to show as the push title when this inbox receives a hub-log. */
  name: string;
}

export interface NotificationCatalog {
  version: 1;
  /** Last write time, ms epoch — useful to debug stale state. */
  updated_at: number;
  /** keyed by inbox address (DM-side conversation inbox). */
  dms: Record<string, CatalogEntryDM>;
  /** keyed by hub address. */
  spaces: Record<string, CatalogEntrySpace>;
  /** API base URL the NSE should hit when fetching hub-log entries
   *  for decryption (see HubLogClassifier.swift). Mirrors the JS
   *  side's getApiConfig().baseUrl so dev-vs-prod toggle propagates
   *  automatically without the NSE needing its own Info.plist entry. */
  api_base_url: string;
}

const CATALOG_FILENAME = 'notification-catalog.json';
let cachedAppGroupPath: string | null | undefined;

function getAppGroupPath(): string | null {
  if (cachedAppGroupPath !== undefined) return cachedAppGroupPath;
  if (Platform.OS !== 'ios') {
    cachedAppGroupPath = null;
    return null;
  }
  try {
    // Lazy import — avoids loading the iOS native module shape on
    // Android (where it has no getAppGroupPath member). The require
    // is wrapped so a missing module at runtime can't kill the
    // registration pipeline.

    const mod: AppGroupModule | undefined =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../modules/quorum-crypto/src/QuorumCryptoModule').default;
    const path = mod?.getAppGroupPath?.();
    cachedAppGroupPath = typeof path === 'string' && path.length > 0 ? path : null;
  } catch {
    cachedAppGroupPath = null;
  }
  return cachedAppGroupPath;
}

function catalogPath(): string | null {
  const root = getAppGroupPath();
  return root ? `${root}/${CATALOG_FILENAME}` : null;
}

/**
 * Conversation metadata in MMKV is keyed by conversationId, with the
 * inbox address living inside the keypair record. This builds a
 * one-pass map of (inboxAddress -> remote display name) by joining
 * stored conversations with stored conversation inbox keypairs and the
 * member catalog. Gracefully no-ops on any missing piece.
 */
function buildDMCatalog(): Record<string, CatalogEntryDM> {
  const out: Record<string, CatalogEntryDM> = {};

  // (inbox_address) -> conversationId
  const inboxToConvId = new Map<string, string>();
  for (const kp of encryptionStateStorage.getAllConversationInboxKeypairs()) {
    if (kp?.inboxAddress && kp.conversationId) {
      inboxToConvId.set(kp.inboxAddress, kp.conversationId);
    }
  }
  if (inboxToConvId.size === 0) return out;

  // Read the conversation rows from the same MMKV the storage adapter
  // uses. Format mirrors MMKVAdapter.saveConversation: one JSON blob
  // per conversationId under "conversation:<id>".
  for (const [inboxAddress, conversationId] of inboxToConvId) {
    const raw = mmkv.getString(`conversation:${conversationId}`);
    if (!raw) continue;
    let conv: { participants?: string[]; metadata?: { displayName?: string } };
    try {
      conv = JSON.parse(raw);
    } catch {
      continue;
    }
    // For 1:1 DMs, the metadata.displayName is the simplest correct
    // answer — the chat surface uses it as the conversation title.
    const display =
      conv?.metadata?.displayName ||
      // Fallback: if metadata isn't populated, show the truncated
      // remote address rather than the inbox address.
      (conv?.participants?.[0] ? truncateAddress(conv.participants[0]) : 'Direct message');
    out[inboxAddress] = { display_name: display };
  }
  return out;
}

function buildSpaceCatalog(): Record<string, CatalogEntrySpace> {
  const out: Record<string, CatalogEntrySpace> = {};
  for (const space of getAllSpaces()) {
    // Space.hubAddress is the canonical mapping. Falling back to the
    // saved key record is defensive in case an older space row didn't
    // serialize hubAddress.
    const hubAddr = space.hubAddress || getSpaceKey(space.spaceId, 'hub')?.address;
    if (!hubAddr) continue;
    out[hubAddr] = { name: space.spaceName || 'Space' };
  }
  return out;
}

let lastSerialized: string | null = null;

/**
 * Snapshot the current catalog and write it to the App Group container,
 * atomically (write to .tmp, rename). Skips the disk write entirely
 * when the serialized JSON hasn't changed since the last write.
 *
 * Cheap to call on every push registration, app foreground, space
 * join/leave, and conversation create. No-op on Android (the
 * BackgroundMessageService runs in the same JS context and reads MMKV
 * directly, no shared file needed).
 */
export async function writeNotificationCatalog(): Promise<void> {
  // Hard guard: this is iOS-only. Android has no App Group and reads
  // straight from MMKV in its own JS handler.
  if (Platform.OS !== 'ios') return;

  const path = catalogPath();
  if (!path) return;

  let catalog: NotificationCatalog;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getApiConfig } = require('@/services/api/config') as typeof import('@/services/api/config');
    catalog = {
      version: 1,
      updated_at: Date.now(),
      dms: buildDMCatalog(),
      spaces: buildSpaceCatalog(),
      api_base_url: getApiConfig().baseUrl,
    };
  } catch {
    // Defensive — if any storage read throws we'd rather skip the
    // snapshot than crash the registration pipeline.
    return;
  }
  const serialized = JSON.stringify(catalog);

  const fingerprint = JSON.stringify({ ...catalog, updated_at: 0 });
  if (fingerprint === lastSerialized) return;
  lastSerialized = fingerprint;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs: FileSystemLegacy = require('expo-file-system/legacy');
    const tmp = `${path}.tmp`;
    await fs.writeAsStringAsync(`file://${tmp}`, serialized, {
      encoding: fs.EncodingType.UTF8,
    });
    await fs.moveAsync({ from: `file://${tmp}`, to: `file://${path}` });
  } catch {
    // App Group container may not exist before prebuild has been
    // re-run with entitlements, or the legacy module may have moved.
    // Either way: catalog is best-effort, the fallback ships.
  }
}
