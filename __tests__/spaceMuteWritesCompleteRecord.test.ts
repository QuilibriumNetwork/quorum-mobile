/**
 * setSpaceMuted must never persist a per-space notification record that omits
 * `enabledNotificationTypes`.
 *
 * The record syncs verbatim to desktop, where every consumer treats that array
 * as guaranteed because the shared `SpaceNotificationSettings` type declares it
 * required. It was not: `{ ...(prev[spaceId] ?? {}), isMuted }` wrote a bare
 * `{ isMuted }` the first time a space was muted. Desktop's
 * `settings ?? getDefaultNotificationSettings()` cannot recover from that (the
 * record is truthy, so the fallback never fires), so the missing array reached
 * NotificationPanel's `selectedTypes.filter(...)` and took down the whole
 * channel route with "the channel could not be loaded". Observed in production
 * 2026-08-21.
 *
 * The first-mute case is the load-bearing one: a space that ALREADY had settings
 * was never broken, because the spread carried the array along.
 *
 * Only storage boundaries are mocked; the real write path runs. `allowSync` is
 * left false so no network leg is involved — the local record IS what syncs.
 */

// Stores hang off globalThis rather than a module-scope const: jest hoists the
// factory above every declaration, and configService creates its MMKV
// instances at import time, while a const would still be in its TDZ.
type MemoryStores = Map<string, Map<string, string>>;
const memoryStores = (): MemoryStores =>
  ((globalThis as Record<string, unknown>).__mmkv ??= new Map()) as MemoryStores;

jest.mock('react-native-mmkv', () => ({
  createMMKV: ({ id }: { id: string }) => {
    const stores = ((globalThis as Record<string, unknown>).__mmkv ??=
      new Map()) as Map<string, Map<string, string>>;
    if (!stores.has(id)) stores.set(id, new Map());
    const store = stores.get(id)!;
    return {
      getString: (k: string) => store.get(k),
      set: (k: string, v: string) => store.set(k, v),
      remove: (k: string) => store.delete(k),
      delete: (k: string) => store.delete(k),
      clearAll: () => store.clear(),
      getAllKeys: () => Array.from(store.keys()),
      contains: (k: string) => store.has(k),
    };
  },
}));

jest.mock('../services/onboarding/secureStorage', () => ({
  getPrivateKey: async () => null,
  getPublicKey: async () => null,
}));

jest.mock('../services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    postUserSettings: jest.fn(),
    getUserSettings: jest.fn(),
  }),
}));

jest.mock('../services/config/spaceStorage', () => ({
  getAllSpaces: () => [],
  getSpaceKeys: () => [],
  getSpaceKey: () => null,
  saveSpaceKey: jest.fn(),
  clearSpaceStorage: jest.fn(),
}));

jest.mock('../services/crypto/encryption-state-storage', () => ({
  encryptionStateStorage: { getEncryptionStates: () => [] },
}));

jest.mock('../services/storage/mmkvAdapter', () => ({
  getMMKVAdapter: () => ({ getSpaceMember: jest.fn().mockResolvedValue(null) }),
}));

jest.mock('../services/crypto/native-provider', () => ({
  NativeCryptoProvider: class {
    async signEd448() {
      return btoa('signature');
    }
  },
}));

jest.mock('../services/offline/storage', () => ({
  mmkvStorage: { getItem: () => null, setItem: jest.fn(), removeItem: jest.fn() },
}));

import {
  setSpaceMuted,
  setNotificationTypes,
  getLocalUserConfig,
  saveLocalUserConfig,
  getLocalSpaceMuted,
  getLocalNotificationTypes,
  DEFAULT_NOTIFICATION_TYPES,
} from '../services/config/configService';
import type { UserConfig } from '@quilibrium/quorum-shared';

const ADDRESS = 'QmUserAddress';
const SPACE_ID = 'space-1';

/** Read the raw per-space record exactly as it would sync to another device. */
const storedRecord = (spaceId = SPACE_ID) =>
  (getLocalUserConfig(ADDRESS) as UserConfig | null)?.notificationSettings?.[
    spaceId
  ] as
    | { spaceId?: string; enabledNotificationTypes?: string[]; isMuted?: boolean }
    | undefined;

const seedConfig = (over: Partial<UserConfig> = {}) => {
  saveLocalUserConfig({
    address: ADDRESS,
    spaceIds: [SPACE_ID],
    allowSync: false,
    notificationSettings: {},
    ...over,
  } as UserConfig);
};

describe('setSpaceMuted — the written record is always complete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    memoryStores().forEach((s) => s.clear());
  });

  it('writes enabledNotificationTypes on the FIRST mute of a space', async () => {
    // Pre-fix this produced `{ isMuted: true }` and nothing else.
    seedConfig();

    await setSpaceMuted(ADDRESS, SPACE_ID, true);

    const record = storedRecord();
    expect(record).toBeDefined();
    expect(Array.isArray(record!.enabledNotificationTypes)).toBe(true);
    expect(record!.enabledNotificationTypes).toEqual(DEFAULT_NOTIFICATION_TYPES);
  });

  it('writes spaceId on the first mute of a space', async () => {
    seedConfig();

    await setSpaceMuted(ADDRESS, SPACE_ID, false);

    expect(storedRecord()!.spaceId).toBe(SPACE_ID);
  });

  it('still records the mute flag itself', async () => {
    // Guards against "fixed the shape, broke the feature".
    seedConfig();

    await setSpaceMuted(ADDRESS, SPACE_ID, true);
    expect(getLocalSpaceMuted(ADDRESS, SPACE_ID)).toBe(true);

    await setSpaceMuted(ADDRESS, SPACE_ID, false);
    expect(getLocalSpaceMuted(ADDRESS, SPACE_ID)).toBe(false);
  });

  it('leaves the record complete after a mute/unmute round trip', async () => {
    // The production account was in the UNMUTED half of this cycle, which is
    // why the space-muted early-returns did not shield it from the crash.
    seedConfig();

    await setSpaceMuted(ADDRESS, SPACE_ID, true);
    await setSpaceMuted(ADDRESS, SPACE_ID, false);

    const record = storedRecord()!;
    expect(record.isMuted).toBe(false);
    expect(record.enabledNotificationTypes).toEqual(DEFAULT_NOTIFICATION_TYPES);
  });

  it('never overwrites an existing selection when muting', async () => {
    // A user who narrowed their notification types then mutes the space must
    // not have that selection reset to all-enabled.
    seedConfig();
    await setNotificationTypes(ADDRESS, SPACE_ID, ['reply']);

    await setSpaceMuted(ADDRESS, SPACE_ID, true);

    expect(storedRecord()!.enabledNotificationTypes).toEqual(['reply']);
    expect(getLocalNotificationTypes(ADDRESS, SPACE_ID)).toEqual(['reply']);
  });

  it('does not disturb other spaces', async () => {
    seedConfig({
      notificationSettings: {
        'space-2': {
          spaceId: 'space-2',
          enabledNotificationTypes: ['mention-you'],
        },
      } as UserConfig['notificationSettings'],
    });

    await setSpaceMuted(ADDRESS, SPACE_ID, true);

    expect(storedRecord('space-2')!.enabledNotificationTypes).toEqual([
      'mention-you',
    ]);
    expect(storedRecord('space-2')!.isMuted).toBeUndefined();
  });
});
