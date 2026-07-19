import { type MMKV } from 'react-native-mmkv';
import { createMirroredMMKV } from '@/services/storage/mirroredMMKV';
import { type Space } from '@quilibrium/quorum-shared';

// Storage instance for spaces
const spaceStorage: MMKV = createMirroredMMKV({ id: 'quorum-spaces' });

// Storage keys
const SPACE_PREFIX = 'space:';
const SPACE_KEY_PREFIX = 'space_key:';
const SPACE_IDS_KEY = 'space_ids';

// Key types: config (manifest decryption), hub (hub signing), inbox (receiving space messages)
export interface SpaceKey {
  spaceId: string;
  keyId: string;
  address?: string;
  publicKey: string;
  privateKey: string;
  /**
   * How this device came to hold the key (LOCAL-only — deliberately not
   * serialized into the config blob; collectSpaceKeysForSync maps explicit
   * fields). Only meaningful for keyId 'signing':
   * - 'origin': created by THIS device's create/join flow — provably the
   *   join-bound identity; never replaced by a synced value.
   * - 'adopted': taken from the config blob (another device published it).
   * - 'promoted': self-promoted by the pre-split migration oracle, which can
   *   misfire on devices that synced the space before the split — treated as
   *   a guess and replaced by whatever the blob offers.
   */
  provenance?: 'origin' | 'adopted' | 'promoted';
}

export function getSpaceIds(): string[] {
  const data = spaceStorage.getString(SPACE_IDS_KEY);
  if (!data) return [];
  try {
    return JSON.parse(data) as string[];
  } catch {
    return [];
  }
}

function saveSpaceIds(ids: string[]): void {
  spaceStorage.set(SPACE_IDS_KEY, JSON.stringify(ids));
}

export function getSpace(spaceId: string): Space | null {
  const key = `${SPACE_PREFIX}${spaceId}`;
  const data = spaceStorage.getString(key);
  if (!data) return null;
  try {
    return JSON.parse(data) as Space;
  } catch {
    return null;
  }
}

export function getAllSpaces(): Space[] {
  const ids = getSpaceIds();
  const spaces: Space[] = [];
  for (const id of ids) {
    const space = getSpace(id);
    if (space) {
      spaces.push(space);
    }
  }
  return spaces;
}

export function saveSpace(space: Space): void {
  const key = `${SPACE_PREFIX}${space.spaceId}`;
  spaceStorage.set(key, JSON.stringify(space));

  // Update space IDs list
  const ids = getSpaceIds();
  if (!ids.includes(space.spaceId)) {
    ids.push(space.spaceId);
    saveSpaceIds(ids);
  }
}

export function deleteSpace(spaceId: string): void {
  const key = `${SPACE_PREFIX}${spaceId}`;
  spaceStorage.remove(key);

  // Remove from space IDs list
  const ids = getSpaceIds();
  const index = ids.indexOf(spaceId);
  if (index !== -1) {
    ids.splice(index, 1);
    saveSpaceIds(ids);
  }

  // Delete all keys for this space
  deleteSpaceKeys(spaceId);
}

export function hasSpace(spaceId: string): boolean {
  const key = `${SPACE_PREFIX}${spaceId}`;
  return spaceStorage.contains(key);
}

function getSpaceKeyStorageKey(spaceId: string, keyId: string): string {
  return `${SPACE_KEY_PREFIX}${spaceId}:${keyId}`;
}

export function getSpaceKey(spaceId: string, keyId: string): SpaceKey | null {
  const key = getSpaceKeyStorageKey(spaceId, keyId);
  const data = spaceStorage.getString(key);
  if (!data) {
    return null;
  }
  try {
    return JSON.parse(data) as SpaceKey;
  } catch (e) {
    return null;
  }
}

/**
 * The key a device must SIGN space messages with. Distinct from the per-device
 * 'inbox' (mailbox/transport) key: receive-side verified-signer authorization
 * resolves the signer via the member table, which binds the inbox address from
 * the user's original JOIN broadcast — one key per user per space. The
 * 'signing' slot holds that original join-time keypair on every device (synced
 * through the user-config blob). Falls back to 'inbox' for the join/create
 * device (where the two are the same keypair) and for spaces synced before the
 * signing slot existed.
 */
export function getSpaceSigningKey(spaceId: string): SpaceKey | null {
  return getSpaceKey(spaceId, 'signing') ?? getSpaceKey(spaceId, 'inbox');
}

export function getSpaceKeys(spaceId: string): SpaceKey[] {
  const keys: SpaceKey[] = [];
  const allKeys = spaceStorage.getAllKeys();

  const prefix = `${SPACE_KEY_PREFIX}${spaceId}:`;
  for (const key of allKeys) {
    if (key.startsWith(prefix)) {
      const data = spaceStorage.getString(key);
      if (data) {
        try {
          keys.push(JSON.parse(data) as SpaceKey);
        } catch {
          // Skip malformed entries
        }
      }
    }
  }

  return keys;
}

export function saveSpaceKey(spaceKey: SpaceKey): void {
  const key = getSpaceKeyStorageKey(spaceKey.spaceId, spaceKey.keyId);
  spaceStorage.set(key, JSON.stringify(spaceKey));
}

export function deleteSpaceKey(spaceId: string, keyId: string): void {
  const key = getSpaceKeyStorageKey(spaceId, keyId);
  spaceStorage.remove(key);
}

export function deleteSpaceKeys(spaceId: string): void {
  const allKeys = spaceStorage.getAllKeys();
  const prefix = `${SPACE_KEY_PREFIX}${spaceId}:`;

  for (const key of allKeys) {
    if (key.startsWith(prefix)) {
      spaceStorage.remove(key);
    }
  }
}

export function clearSpaceStorage(): void {
  spaceStorage.clearAll();
}

export function getSpaceByHubAddress(hubAddress: string): Space | null {
  const spaces = getAllSpaces();
  for (const space of spaces) {
    const hubKey = getSpaceKey(space.spaceId, 'hub');
    if (hubKey && hubKey.address === hubAddress) {
      return space;
    }
  }
  return null;
}

export function getSpaceInboxAddress(spaceId: string): string | null {
  const inboxKey = getSpaceKey(spaceId, 'inbox');
  return inboxKey?.address ?? null;
}

export function getAllSpaceInboxAddresses(): string[] {
  const addresses: string[] = [];
  const ids = getSpaceIds();

  for (const spaceId of ids) {
    const address = getSpaceInboxAddress(spaceId);
    if (address) {
      addresses.push(address);
    }
  }

  return addresses;
}

// Returns Map<inboxAddress, spaceId> for O(1) routing of incoming messages.
export function getInboxToSpaceMap(): Map<string, string> {
  const map = new Map<string, string>();
  const ids = getSpaceIds();

  for (const spaceId of ids) {
    const address = getSpaceInboxAddress(spaceId);
    if (address) {
      map.set(address, spaceId);
    }
  }

  return map;
}
