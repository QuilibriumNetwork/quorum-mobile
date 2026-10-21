/**
 * Every Farcaster protocol write is a message signed with the device's
 * Hypersnap signer and submitted to Hypersnap. None of them reaches
 * farcaster.xyz, and none of them needs the farcaster.xyz token.
 *
 * The signing itself is real (quorum-shared's encoders, ed25519); only the
 * signer store, the hub submit and the network are stubbed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ed25519 } from '@noble/curves/ed25519.js';

const mockSubmitMessage = jest.fn();
const mockFetchCastByUrl = jest.fn();
const mockBuild = jest.fn();

jest.mock('@quilibrium/quorum-shared', () => {
  const actual = jest.requireActual('@quilibrium/quorum-shared');
  return {
    ...actual,
    getDefaultHypersnapClient: () => ({ submitMessage: mockSubmitMessage }),
    fetchFarcasterCastByUrl: (...args: unknown[]) => mockFetchCastByUrl(...args),
    buildSignedMessage: (...args: unknown[]) => {
      mockBuild(...args);
      return actual.buildSignedMessage(...args);
    },
  };
});

const mockGetSigner = jest.fn();
jest.mock('@/services/farcaster/hypersnapProvision', () => ({
  getHypersnapSignerFor: (fid: number) => mockGetSigner(fid),
}));

// eslint-disable-next-line import/first
import { CastType, MessageType, ReactionType, UserDataType } from '@quilibrium/quorum-shared';
// eslint-disable-next-line import/first
import { QueryClient } from '@tanstack/react-query';

type Writes = typeof import('@/services/farcaster/hypersnapWrites');

const OWN_FID = 42;
const AUTHOR_FID = 777;
const FULL_HASH = '0x' + 'ab'.repeat(20);
const HYPERSNAP = 'https://haatz.quilibrium.com';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function signerRecord(fid: number) {
  const { secretKey, publicKey } = ed25519.keygen();
  return {
    fid,
    publicKeyHex: toHex(publicKey),
    privateKeyHex: toHex(secretKey),
    custodyAddress: '0x' + 'cd'.repeat(20),
    registeredAtUnix: Math.floor(Date.now() / 1000),
    ttlSeconds: 90 * 24 * 60 * 60,
    deadlineUnix: Math.floor(Date.now() / 1000) + 3600,
  };
}

/** The MessageData handed to buildSignedMessage on the nth call. */
function built(n = 0): {
  type: MessageType;
  fid: number;
  body: Record<string, any>;
} {
  return mockBuild.mock.calls[n][0];
}

const fetchMock = jest.fn();
let farcasterXyzFetches: string[] = [];

/** Fresh module registry, so the author cache starts empty. */
function load(): Writes {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/services/farcaster/hypersnapWrites') as Writes;
}

beforeEach(() => {
  mockSubmitMessage.mockReset().mockResolvedValue({});
  mockFetchCastByUrl.mockReset();
  mockBuild.mockReset();
  mockGetSigner.mockReset().mockImplementation(async (fid: number) => signerRecord(fid));
  farcasterXyzFetches = [];
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    if (/farcaster\.xyz|warpcast\.com/.test(url)) farcasterXyzFetches.push(url);
    if (url.startsWith(`${HYPERSNAP}/v2/farcaster/cast?`)) {
      return { ok: true, json: async () => ({ cast: { author: { fid: AUTHOR_FID } } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  (globalThis as any).fetch = fetchMock;
});

afterEach(() => {
  expect(farcasterXyzFetches).toEqual([]);
});

describe('casts', () => {
  it('publishes a CAST_ADD, submitted to Hypersnap, and returns its hash', async () => {
    const { publishCast } = load();

    const hash = await publishCast({ fid: OWN_FID, text: 'gm' });

    expect(mockSubmitMessage).toHaveBeenCalledTimes(1);
    expect(built()).toMatchObject({ type: MessageType.CAST_ADD, fid: OWN_FID });
    expect(built().body.castAddBody).toMatchObject({ text: 'gm', type: CastType.CAST });
    expect(hash).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it.each([
    ['exactly 320 bytes', 'a'.repeat(320), CastType.CAST],
    ['321 bytes', 'a'.repeat(321), CastType.LONG_CAST],
    ['exactly 1024 bytes', 'a'.repeat(1024), CastType.LONG_CAST],
    ['1025 bytes', 'a'.repeat(1025), CastType.TEN_K_CAST],
    ['161 two-byte characters (322 bytes, 161 chars)', 'é'.repeat(161), CastType.LONG_CAST],
  ])('picks the cast type by byte length: %s', async (_label, text, type) => {
    const { castTypeForText, publishCast } = load();
    expect(castTypeForText(text)).toBe(type);
    await publishCast({ fid: OWN_FID, text });
    expect(built().body.castAddBody.type).toBe(type);
  });

  it('replies with the parent author the caller already has, without a lookup', async () => {
    const { publishCast } = load();

    await publishCast({ fid: OWN_FID, text: 'reply', parent: { castHash: FULL_HASH, fid: 9 } });

    const parent = built().body.castAddBody.parent;
    expect(parent.castId.fid).toBe(9);
    expect(toHex(parent.castId.hash)).toBe('ab'.repeat(20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('looks up a hash-only parent on Hypersnap, once per cast', async () => {
    const { publishCast } = load();

    await publishCast({ fid: OWN_FID, text: 'one', parent: { castHash: FULL_HASH } });
    await publishCast({ fid: OWN_FID, text: 'two', parent: { castHash: FULL_HASH } });

    expect(built(0).body.castAddBody.parent.castId.fid).toBe(AUTHOR_FID);
    expect(built(1).body.castAddBody.parent.castId.fid).toBe(AUTHOR_FID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${HYPERSNAP}/v2/farcaster/cast?identifier=${'ab'.repeat(20)}&type=hash`,
    );
  });

  it('refuses a reply whose parent Hypersnap does not know, and submits nothing', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    const { publishCast, FarcasterWriteError } = load();

    await expect(
      publishCast({ fid: OWN_FID, text: 'x', parent: { castHash: FULL_HASH } }),
    ).rejects.toBeInstanceOf(FarcasterWriteError);
    expect(mockSubmitMessage).not.toHaveBeenCalled();
  });

  it('posts into a channel by its parent URL', async () => {
    const { publishCast } = load();
    await publishCast({ fid: OWN_FID, text: 'hi', parent: { url: 'https://warpcast.com/~/channel/q' } });
    expect(built().body.castAddBody.parent).toEqual({ url: 'https://warpcast.com/~/channel/q' });
  });

  it('deletes with a CAST_REMOVE targeting the hash', async () => {
    const { removeOwnCast } = load();
    await removeOwnCast({ fid: OWN_FID, castHash: FULL_HASH });
    expect(built().type).toBe(MessageType.CAST_REMOVE);
    expect(toHex(built().body.castRemoveBody.targetHash)).toBe('ab'.repeat(20));
  });
});

describe('reactions and follows', () => {
  it.each([
    ['like', true, MessageType.REACTION_ADD, ReactionType.LIKE],
    ['like', false, MessageType.REACTION_REMOVE, ReactionType.LIKE],
    ['recast', true, MessageType.REACTION_ADD, ReactionType.RECAST],
    ['recast', false, MessageType.REACTION_REMOVE, ReactionType.RECAST],
  ] as const)('%s active=%s → message %s, reaction %s', async (kind, active, type, reaction) => {
    const { setCastReaction } = load();

    await setCastReaction({ fid: OWN_FID, castHash: FULL_HASH, kind, active });

    expect(built().type).toBe(type);
    expect(built().body.reactionBody.type).toBe(reaction);
    expect(built().body.reactionBody.target.castId.fid).toBe(AUTHOR_FID);
  });

  it('uses an author seeded by rememberCastAuthor without a lookup', async () => {
    const { rememberCastAuthor, setCastReaction } = load();
    rememberCastAuthor(FULL_HASH.toUpperCase().replace('0X', '0x'), 5);

    await setCastReaction({ fid: OWN_FID, castHash: FULL_HASH, kind: 'like', active: true });

    expect(built().body.reactionBody.target.castId.fid).toBe(5);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [true, MessageType.LINK_ADD],
    [false, MessageType.LINK_REMOVE],
  ])('following=%s sends a %s "follow" link', async (following, type) => {
    const { setFollowing } = load();
    await setFollowing({ fid: OWN_FID, targetFid: 99, following });
    expect(built().type).toBe(type);
    expect(built().body.linkBody).toEqual({ type: 'follow', targetFid: 99 });
  });
});

describe('profile', () => {
  it('sets each supplied field as its own USER_DATA_ADD', async () => {
    const { setProfileFields } = load();

    await setProfileFields({
      fid: OWN_FID,
      fields: { displayName: 'Ada', bio: 'hi', pfp: 'https://img/x.png' },
    });

    expect(mockBuild.mock.calls.map((c) => c[0].body.userDataBody)).toEqual([
      { type: UserDataType.DISPLAY, value: 'Ada' },
      { type: UserDataType.BIO, value: 'hi' },
      { type: UserDataType.PFP, value: 'https://img/x.png' },
    ]);
    expect(mockBuild.mock.calls.every((c) => c[0].type === MessageType.USER_DATA_ADD)).toBe(true);
  });

  it('updates text fields with no farcaster.xyz token', async () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { updateFarcasterProfile } = require('@/services/farcaster/updateProfile');

    const res = await updateFarcasterProfile({ fid: OWN_FID, token: null, fields: { displayName: 'Ada', bio: '' } });

    expect(res).toEqual({ ok: true, uploadedPfpUrl: undefined });
    expect(mockSubmitMessage).toHaveBeenCalledTimes(2);
  });

  it('needs the token only to upload a new local picture, and submits nothing without it', async () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { updateFarcasterProfile } = require('@/services/farcaster/updateProfile');

    const res = await updateFarcasterProfile({
      fid: OWN_FID,
      token: undefined,
      fields: { displayName: 'Ada', pfp: 'file:///tmp/me.jpg' },
    });

    expect(res.ok).toBe(false);
    expect(mockSubmitMessage).not.toHaveBeenCalled();
  });
});

describe('failures', () => {
  it('fails with FarcasterWriteError, submitting nothing, when no signer can be had', async () => {
    mockGetSigner.mockResolvedValue(null);
    const { setFollowing, FarcasterWriteError } = load();

    await expect(setFollowing({ fid: OWN_FID, targetFid: 1, following: true })).rejects.toBeInstanceOf(
      FarcasterWriteError,
    );
    expect(mockSubmitMessage).not.toHaveBeenCalled();
  });

  it('surfaces the hub rejection as FarcasterWriteError', async () => {
    mockSubmitMessage.mockRejectedValue(new Error('Hypersnap 400: invalid signer'));
    const { publishCast, FarcasterWriteError } = load();

    const err = await publishCast({ fid: OWN_FID, text: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(FarcasterWriteError);
    expect(err.message).toBe('Hypersnap 400: invalid signer');
  });

  it('refuses a write without a Farcaster account', async () => {
    const { publishCast, FarcasterWriteError } = load();
    await expect(publishCast({ fid: 0, text: 'x' })).rejects.toBeInstanceOf(FarcasterWriteError);
    expect(mockGetSigner).not.toHaveBeenCalled();
  });
});

describe('cast-link embeds', () => {
  type Embeds = typeof import('@/services/farcaster/embedTranslation');
  const loadEmbeds = (): Embeds => {
    load();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@/services/farcaster/embedTranslation') as Embeds;
  };

  it.each([
    `https://warpcast.com/alice/${FULL_HASH}`,
    `https://farcaster.xyz/alice/${FULL_HASH}`,
  ])('resolves a full-hash link (%s) through Hypersnap', async (url) => {
    const { translateEmbedUrls } = loadEmbeds();

    const [embed] = await translateEmbedUrls([url], new QueryClient());

    expect(embed).toMatchObject({ castId: { fid: AUTHOR_FID } });
    expect(toHex((embed as { castId: { hash: Uint8Array } }).castId.hash)).toBe('ab'.repeat(20));
    expect(mockFetchCastByUrl).not.toHaveBeenCalled();
  });

  it('resolves a short-prefix warpcast.com link by its URL (no Hypersnap prefix lookup exists)', async () => {
    mockFetchCastByUrl.mockResolvedValue({ hash: FULL_HASH, author: { fid: 3 } });
    const { translateEmbedUrls } = loadEmbeds();

    const [embed] = await translateEmbedUrls(['https://warpcast.com/alice/0xabababab'], new QueryClient());

    expect(mockFetchCastByUrl).toHaveBeenCalledWith('alice', '0xabababab');
    expect(embed).toMatchObject({ castId: { fid: 3 } });
  });

  it('keeps any other URL as a URL embed', async () => {
    const { translateEmbedUrls } = loadEmbeds();
    expect(await translateEmbedUrls(['https://example.com/a'], new QueryClient())).toEqual([
      { url: 'https://example.com/a' },
    ]);
  });
});

describe('Audio Space chat', () => {
  it('replies to the space cast through publishCast', async () => {
    load();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { submitSpaceChatReply } = require('@/services/farcaster/spaceChatFetch');

    const hash = await submitSpaceChatReply(FULL_HASH, 'hello room', OWN_FID);

    expect(hash).toMatch(/^0x[0-9a-f]{40}$/);
    expect(built().body.castAddBody).toMatchObject({ text: 'hello room' });
    expect(built().body.castAddBody.parent.castId.fid).toBe(AUTHOR_FID);
  });
});

describe('Farcaster Pro', () => {
  it('folds tier purchases the way the hub does', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { proExpiresAt } = require('@/services/farcaster/hypersnapUsers');
    const day = 24 * 60 * 60;
    expect(proExpiresAt([])).toBe(0);
    // Back-to-back purchases stack; a lapsed one restarts from its block time.
    expect(
      proExpiresAt([
        { blockTimestamp: 1000, tier_purchase_event_body: { for_days: 30, tier_type: 'Pro' } },
        { blockTimestamp: 2000, tier_purchase_event_body: { for_days: 30, tier_type: 'Pro' } },
      ]),
    ).toBe(1000 + 60 * day);
    expect(
      proExpiresAt([
        { blockTimestamp: 1000, tier_purchase_event_body: { for_days: 1, tier_type: 'Pro' } },
        { blockTimestamp: 1000 + 10 * day, tier_purchase_event_body: { for_days: 1, tier_type: 'Pro' } },
      ]),
    ).toBe(1000 + 11 * day);
    expect(
      proExpiresAt([{ blockTimestamp: 1000, tier_purchase_event_body: { for_days: 30, tier_type: 'Other' } }]),
    ).toBe(0);
  });
});

describe('no farcaster.xyz write endpoint is called from app code', () => {
  const root = path.resolve(__dirname, '..');
  const ALLOWED = new Set(['services/farcasterClient.ts']);
  // Path fragments of farcaster.xyz's cast, like, recast, follow and profile
  // write endpoints. Hypersnap signs all of these now.
  const WRITE_ENDPOINTS = [
    /\/v2\/casts\b/,
    /\/v2\/me\b/,
    /\/cast-likes\b/,
    /~api\/v2\/recasts\b|\}\/recasts`/,
    /~api\/v2\/follows\b|\}\/follows`/,
  ];

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  /** Drop block and line comments, keeping `https://` inside strings. */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

  it('finds none outside the legacy client module', () => {
    const offenders: string[] = [];
    for (const dir of ['app', 'components', 'context', 'hooks', 'services']) {
      for (const file of sourceFiles(path.join(root, dir))) {
        const rel = path.relative(root, file);
        if (ALLOWED.has(rel)) continue;
        const code = stripComments(fs.readFileSync(file, 'utf8'));
        for (const re of WRITE_ENDPOINTS) {
          if (re.test(code)) offenders.push(`${rel} ~ ${re}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
