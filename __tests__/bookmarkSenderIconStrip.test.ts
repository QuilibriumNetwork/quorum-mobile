/**
 * A bookmark must never carry an embedded sender avatar into the config blob.
 *
 * The encrypted `UserConfig` blob is the only cross-device transport for every
 * synced setting, and it fails quietly: a device that cannot publish keeps
 * working, looks correct locally, and simply stops telling any other device
 * anything. Measured on a real desktop account 2026-08-05, bookmarks were
 * 656 KB of an 873 KB blob against a ~1 MB working ceiling, and 94% of that was
 * `cachedPreview.senderIcon` — a full base64 avatar copied into EVERY bookmark.
 *
 * Mobile never wrote that field itself, so this is sync hygiene rather than a
 * user-visible fix: what it prevents is mobile re-inflating the blob for the
 * whole account by adopting fat bookmarks from a desktop on an older build and
 * publishing them straight back.
 *
 * Only the boundaries are mocked (storage, network, native crypto). The real
 * strip, merge, encryption and upload logic runs, and the uploaded blob is
 * DECRYPTED here rather than inspected at some earlier layer — that ciphertext
 * is literally what leaves the device.
 */

// Stores hang off globalThis rather than a module-scope const: jest hoists the
// factory above every declaration, and configService creates its MMKV
// instances at import time, while a const would still be in its TDZ.
type MemoryStores = Map<string, Map<string, string>>;
const memoryStores = (): MemoryStores =>
  ((globalThis as Record<string, unknown>).__mmkv ??= new Map()) as MemoryStores;

/** Every `set`, as `<storeId>:<key>` — the instrument for "did this write?". */
const writeLog = (): string[] =>
  ((globalThis as Record<string, unknown>).__mmkvWrites ??= []) as string[];

jest.mock('react-native-mmkv', () => ({
  createMMKV: ({ id }: { id: string }) => {
    const stores = ((globalThis as Record<string, unknown>).__mmkv ??=
      new Map()) as Map<string, Map<string, string>>;
    if (!stores.has(id)) stores.set(id, new Map());
    const store = stores.get(id)!;
    return {
      getString: (k: string) => store.get(k),
      set: (k: string, v: string) => {
        ((globalThis as Record<string, unknown>).__mmkvWrites ??= [] as string[]);
        ((globalThis as Record<string, unknown>).__mmkvWrites as string[]).push(`${id}:${k}`);
        store.set(k, v);
      },
      remove: (k: string) => store.delete(k),
      delete: (k: string) => store.delete(k),
      clearAll: () => store.clear(),
      getAllKeys: () => Array.from(store.keys()),
      contains: (k: string) => store.has(k),
    };
  },
}));

const mockGetPrivateKey = jest.fn<Promise<string | null>, []>();
const mockGetPublicKey = jest.fn<Promise<string | null>, []>();
jest.mock('../services/onboarding/secureStorage', () => ({
  getPrivateKey: () => mockGetPrivateKey(),
  getPublicKey: () => mockGetPublicKey(),
}));

const mockPostUserSettings = jest.fn();
const mockGetUserSettings = jest.fn();
jest.mock('../services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    postUserSettings: (...a: unknown[]) => mockPostUserSettings(...a),
    getUserSettings: (...a: unknown[]) => mockGetUserSettings(...a),
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

// getConfig verifies the pulled blob's signature through this native module.
jest.mock('../modules/quorum-crypto/src', () => ({ verifyEd448: async () => true }));

jest.mock('../services/offline/storage', () => ({
  mmkvStorage: { getItem: () => null, setItem: jest.fn(), removeItem: jest.fn() },
}));

import { sha512 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import {
  addBookmark,
  getLocalBookmarks,
  getLocalUserConfig,
  removeBookmark,
  saveConfig,
} from '../services/config/configService';
import {
  hexToBytes,
  type Bookmark,
  type LegacyBookmark,
  type UserConfig,
} from '@quilibrium/quorum-shared';

const ADDRESS = 'QmUserAddress';
const PRIVATE_KEY = 'aa'.repeat(57);
const PUBLIC_KEY = 'bb'.repeat(57);
const BOOKMARKS_KEY = `bookmarks:${ADDRESS}`;

/**
 * A recognisable stand-in for a base64 avatar, sized like a real one (~8 KB).
 * Distinctive enough that a substring search over the whole decrypted blob
 * proves absence, not just that one field happens to be undefined.
 */
const AVATAR = `data:image/png;base64,${'QUJDRA'.repeat(1400)}`;

/** A bookmark as an older desktop build wrote it — avatar embedded. */
const legacyBookmark = (id: string, sender: string): LegacyBookmark => ({
  bookmarkId: id,
  messageId: `msg-${id}`,
  conversationId: 'QmCounterparty',
  sourceType: 'dm',
  createdAt: 1_700_000_000_000 + Number(id.slice(-1)),
  cachedPreview: {
    senderAddress: sender,
    senderName: 'Someone',
    senderIcon: AVATAR,
    textSnippet: 'the message body',
    messageDate: 1_700_000_000_000,
    sourceName: 'DM',
    contentType: 'text',
    imageUrl: 'https://example.invalid/i.png',
  },
});

const bookmarkStore = () => memoryStores().get('quorum-bookmarks')!;

/** Write straight past the strip, the way a pre-fix build left the store. */
const seedLegacyBookmarks = (bookmarks: LegacyBookmark[]) =>
  bookmarkStore().set(BOOKMARKS_KEY, JSON.stringify(bookmarks));

const rawStoredBookmarks = () => bookmarkStore().get(BOOKMARKS_KEY) ?? '';

// Mirrors configService's own derivation; the test decrypts the real payload
// rather than trusting an intermediate value.
const configKey = () => sha512(new Uint8Array(hexToBytes(PRIVATE_KEY))).slice(0, 32);

const decryptBlob = (encryptedHex: string): string => {
  const iv = new Uint8Array(hexToBytes(encryptedHex.slice(-24)));
  const ciphertext = new Uint8Array(hexToBytes(encryptedHex.slice(0, -24)));
  return new TextDecoder().decode(gcm(configKey(), iv).decrypt(ciphertext));
};

/** The JSON that actually left the device, decrypted. */
const uploadedBlobJson = (): string => {
  expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
  const [, body] = mockPostUserSettings.mock.calls[0] as [string, { user_config: string }];
  return decryptBlob(body.user_config);
};

const baseConfig = (): UserConfig =>
  ({
    address: ADDRESS,
    allowSync: true,
    timestamp: 1000,
    spaceIds: [],
    items: [],
  }) as unknown as UserConfig;

describe('bookmarks never carry an embedded sender avatar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    memoryStores().forEach((s) => s.clear());
    writeLog().length = 0;
    mockGetPrivateKey.mockResolvedValue(PRIVATE_KEY);
    mockGetPublicKey.mockResolvedValue(PUBLIC_KEY);
    mockPostUserSettings.mockResolvedValue({});
    mockGetUserSettings.mockResolvedValue(null);
  });

  describe('sync OUT — the uploaded blob', () => {
    it('carries no avatar even when local storage still holds legacy rows', async () => {
      seedLegacyBookmarks([legacyBookmark('bm-1', 'QmSenderAlpha'), legacyBookmark('bm-2', 'QmSenderBeta')]);

      await saveConfig(baseConfig());

      const json = uploadedBlobJson();
      // Substring, not a field check: this is the whole payload, so it also
      // catches an avatar smuggled through any other key.
      expect(json).not.toContain(AVATAR);
      expect(json).not.toContain('senderIcon');
    });

    it('still carries the bookmarks themselves, and the address they resolve from', async () => {
      seedLegacyBookmarks([legacyBookmark('bm-1', 'QmSenderAlpha'), legacyBookmark('bm-2', 'QmSenderBeta')]);

      await saveConfig(baseConfig());

      const uploaded = JSON.parse(uploadedBlobJson()) as UserConfig;
      expect(uploaded.bookmarks).toHaveLength(2);
      // senderAddress is what the avatar is resolved FROM at render. Losing it
      // would turn a size fix into a data loss, so it is pinned explicitly.
      expect(uploaded.bookmarks!.map((b) => b.cachedPreview.senderAddress)).toEqual([
        'QmSenderAlpha',
        'QmSenderBeta',
      ]);
      expect(uploaded.bookmarks![0]).toMatchObject({
        bookmarkId: 'bm-1',
        messageId: 'msg-bm-1',
        sourceType: 'dm',
        cachedPreview: {
          senderName: 'Someone',
          textSnippet: 'the message body',
          sourceName: 'DM',
          contentType: 'text',
          imageUrl: 'https://example.invalid/i.png',
        },
      });
    });

    it('leaves the locally persisted config copy clean too', async () => {
      seedLegacyBookmarks([legacyBookmark('bm-1', 'QmSenderAlpha')]);

      await saveConfig(baseConfig());

      // saveConfig persists locally as well as publishing; a fat local copy
      // would be re-read and re-uploaded by the next caller that builds its
      // object from getLocalUserConfig.
      expect(JSON.stringify(getLocalUserConfig(ADDRESS))).not.toContain('senderIcon');
    });
  });

  describe('sync IN — storing bookmarks that came from another device', () => {
    // The inbound blob is adopted by getConfig, which merges the remote
    // bookmarks and hands the result to saveLocalBookmarks. getConfig itself
    // cannot run here — it verifies the blob signature through a dynamic
    // `import()` of the native crypto module, which Node refuses inside jest's
    // CJS VM — so the adopt path is covered at that store boundary instead,
    // through addBookmark, which reaches the identical function.
    it('drops the avatar from a bookmark that arrives carrying one', () => {
      addBookmark(ADDRESS, legacyBookmark('bm-remote', 'QmSenderAlpha') as unknown as Bookmark);

      // Without this, one sibling device on an old build keeps re-inflating
      // this one, and the migration never converges on either.
      expect(rawStoredBookmarks()).not.toContain('senderIcon');
      expect(rawStoredBookmarks()).not.toContain(AVATAR);
    });

    it('keeps the stored bookmark otherwise intact', () => {
      addBookmark(ADDRESS, legacyBookmark('bm-remote', 'QmSenderAlpha') as unknown as Bookmark);

      const stored = JSON.parse(rawStoredBookmarks()) as Bookmark[];
      expect(stored).toHaveLength(1);
      expect(stored[0].bookmarkId).toBe('bm-remote');
      expect(stored[0].messageId).toBe('msg-bm-remote');
      expect(stored[0].cachedPreview.senderAddress).toBe('QmSenderAlpha');
      expect(stored[0].cachedPreview.textSnippet).toBe('the message body');
    });

    it('does not re-upload an avatar that reached local storage', async () => {
      seedLegacyBookmarks([legacyBookmark('bm-remote', 'QmSenderAlpha')]);

      await saveConfig(baseConfig());

      expect(uploadedBlobJson()).not.toContain(AVATAR);
    });
  });

  describe('reading is read-only', () => {
    // Deliberate: desktop reclaims its local copy with a one-shot sweep, and
    // the equivalent here would be a write inside this getter. That is the only
    // line in this change that could LOSE a bookmark, and bookmarks are
    // invisible on mobile — the account would just find them missing on
    // desktop. The store reclaims itself on the first write instead.
    it('does not rewrite the store, however legacy the rows are', () => {
      seedLegacyBookmarks([legacyBookmark('bm-1', 'QmSenderAlpha')]);
      writeLog().length = 0;

      const returned = getLocalBookmarks(ADDRESS);

      expect(writeLog()).toHaveLength(0);
      // Stripped on the way out even though the store still holds the avatar:
      // this is what keeps the upload thin regardless of what is on disk.
      expect(returned[0].cachedPreview).not.toHaveProperty('senderIcon');
      expect(rawStoredBookmarks()).toContain(AVATAR);
    });

    it('creates no entry for an address with no bookmarks', () => {
      writeLog().length = 0;

      expect(getLocalBookmarks('QmNeverBookmarked')).toEqual([]);
      expect(writeLog()).toHaveLength(0);
    });

    it('survives a corrupt store without writing over it', () => {
      bookmarkStore().set(BOOKMARKS_KEY, 'not json');
      writeLog().length = 0;

      expect(getLocalBookmarks(ADDRESS)).toEqual([]);
      expect(writeLog()).toHaveLength(0);
    });

    it('survives valid JSON that is not a list', () => {
      // Stripping maps over the value, so without a guard this getter would
      // throw where it previously returned junk — and saveConfig calls it
      // outside its try/catch, so one bad value would stop the device saving
      // its config at all.
      bookmarkStore().set(BOOKMARKS_KEY, '{"bookmarkId":"bm-1"}');

      expect(() => getLocalBookmarks(ADDRESS)).not.toThrow();
      expect(getLocalBookmarks(ADDRESS)).toEqual([]);
    });

    it('lets saveConfig publish even with a corrupt bookmark store', async () => {
      bookmarkStore().set(BOOKMARKS_KEY, '{"bookmarkId":"bm-1"}');

      await expect(saveConfig(baseConfig())).resolves.toBeUndefined();

      expect(mockPostUserSettings).toHaveBeenCalledTimes(1);
      expect(getLocalUserConfig(ADDRESS)).not.toBeNull();
    });

    it('leaves a bookmark with no avatar completely untouched', () => {
      // The control arm: the strip must be a no-op on the ordinary case, or
      // every assertion above is measuring the wrong thing.
      const clean = legacyBookmark('bm-1', 'QmSenderAlpha');
      delete (clean.cachedPreview as { senderIcon?: string }).senderIcon;
      seedLegacyBookmarks([clean]);

      expect(getLocalBookmarks(ADDRESS)).toEqual([clean]);
    });
  });

  describe('the write path', () => {
    it('drops the avatar from a bookmark handed in by a legacy caller', () => {
      // The type forbids it, but the value can still arrive at runtime — from a
      // stale JS bundle after an OTA update, or from adopted remote data.
      addBookmark(ADDRESS, legacyBookmark('bm-1', 'QmSenderAlpha') as unknown as Bookmark);

      expect(rawStoredBookmarks()).not.toContain('senderIcon');
      expect(JSON.parse(rawStoredBookmarks())[0].bookmarkId).toBe('bm-1');
    });

    it('reclaims the whole stored list, not just the row being written', () => {
      // This is what makes the read-side reclaim unnecessary: any write at all
      // rewrites the entire array through the strip.
      seedLegacyBookmarks([legacyBookmark('bm-1', 'QmSenderAlpha'), legacyBookmark('bm-2', 'QmSenderBeta')]);

      addBookmark(ADDRESS, legacyBookmark('bm-3', 'QmSenderGamma') as unknown as Bookmark);

      expect(rawStoredBookmarks()).not.toContain(AVATAR);
      expect(JSON.parse(rawStoredBookmarks())).toHaveLength(3);
    });

    it('removing a bookmark removes exactly that one', () => {
      // Not a strip test — this is the data-loss guard. Removal reads, filters
      // and writes the whole list, so a mistake in either half of the strip
      // would take the survivors with it. (Its thinness is belt-and-braces:
      // read and write both strip, so it holds with either one removed.)
      seedLegacyBookmarks([legacyBookmark('bm-1', 'QmSenderAlpha'), legacyBookmark('bm-2', 'QmSenderBeta')]);

      removeBookmark(ADDRESS, 'bm-1');

      const stored = JSON.parse(rawStoredBookmarks()) as Bookmark[];
      expect(stored.map((b) => b.bookmarkId)).toEqual(['bm-2']);
      expect(stored[0].cachedPreview.senderAddress).toBe('QmSenderBeta');
      expect(rawStoredBookmarks()).not.toContain(AVATAR);
    });
  });
});
