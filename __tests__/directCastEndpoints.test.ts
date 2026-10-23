/**
 * Direct casts use Quilcast's endpoints and token.
 *
 * ## The change this pins
 *
 * DMs used the farcaster.xyz session token on `/v2/direct-cast-conversation-list`,
 * `/v2/direct-cast-send` and `/v2/direct-cast-read`, and polled. Quilcast's DMs
 * work better for users, so ours now match it: a direct-cast-only token (the
 * custody key signs farcaster.xyz's authorization, `/v2/get-dc-auth-token`
 * exchanges it), the inbox at `/v2/direct-cast-inbox`, text and replies through
 * `/fc/message`, and `/v2/direct-cast-mark-read`. A message with an image and
 * reactions still use the session token on the older endpoints, as
 * farcaster.xyz itself does.
 *
 * ## What is asserted
 *
 * - The token is minted from a nonce and farcaster.xyz's own authorization text,
 *   signed (EIP-191) by the custody key, and kept per FID.
 * - Inbox, messages, mark-read and text sends carry it; a rejected one is
 *   replaced once, and the call made again.
 * - Images and reactions carry the session token.
 * - The inbox's shape (unread and muted in `viewerContext`, participants not
 *   always there) is read right; it stops paging when farcaster.xyz's cursor
 *   comes round again, and nothing polls.
 */
import fs from 'fs';
import path from 'path';
import { AppState } from 'react-native';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  addDirectCastReaction,
  getDirectCastConversations,
  getDirectCastMessages,
  markDirectCastRead,
  sendDirectCast,
  sendDirectCastWithMedia,
} from '@/services/farcasterClient';
import { __resetDirectCastAuth, directCastAuthMessage } from '@/services/farcaster/directCastAuth';
import { nextInboxCursor, toUnifiedConversation, useDirectCastToken } from '@/hooks/chat/useFarcasterDirectCasts';
import { planFarcasterPings } from '@/services/notifications/farcasterPingPlan';

const CUSTODY_KEY = 'ab'.repeat(32);

const mockStore: { fid: number | null; custody: string | null; dc: { fid: number; token: string } | null } = {
  fid: 42,
  custody: CUSTODY_KEY,
  dc: null,
};
jest.mock('@/services/onboarding/secureStorage', () => ({
  getFarcasterFid: async () => mockStore.fid,
  getFarcasterCustodyKey: async () => mockStore.custody,
  getFarcasterDirectCastToken: async () => mockStore.dc,
  storeFarcasterDirectCastToken: async (value: { fid: number; token: string }) => {
    mockStore.dc = value;
  },
  deleteFarcasterDirectCastToken: async () => {
    mockStore.dc = null;
  },
}));
jest.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { farcaster: { fid: 42 } } }) }));
jest.mock('@/utils/stripImageMetadata', () => ({ stripImageMetadata: async (uri: string) => uri }));
jest.mock('@/services/farcaster/farcasterDMCache', () => ({
  getCachedDMConversations: () => undefined,
  setCachedDMConversations: () => {},
  getCachedDMMessages: () => undefined,
  setCachedDMMessages: () => {},
}));

// --- farcaster.xyz ----------------------------------------------------------

type Call = { url: URL; method: string; auth?: string; origin?: string; body?: Record<string, unknown> };
let calls: Call[] = [];
let mints = 0;
/** Tokens farcaster.xyz answers 401 to. */
const rejected = new Set<string>();

const mockFetch = jest.fn(async (input: string, init: RequestInit = {}) => {
  const url = new URL(input);
  const headers = (init.headers ?? {}) as Record<string, string>;
  const call: Call = {
    url,
    method: init.method ?? 'GET',
    auth: headers.authorization,
    origin: headers.origin,
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
  };
  calls.push(call);
  const answer = (status: number, body: unknown = {}) =>
    ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

  if (url.pathname === '/v2/get-dc-nonce') return answer(200, { result: { nonce: 'n1' } });
  if (url.pathname === '/v2/get-dc-auth-token') return answer(200, { result: { token: `dc-${++mints}` } });
  if (call.auth && rejected.has(call.auth.replace('Bearer ', ''))) {
    return answer(401, { errors: [{ message: 'Unauthorized' }] });
  }
  switch (url.pathname) {
    case '/v2/direct-cast-inbox':
      return answer(200, { result: { conversations: [], requestsCount: 0 }, next: {} });
    case '/v2/direct-cast-conversation-messages':
      return answer(200, { result: { messages: [] }, next: {} });
    case '/fc/message':
      return answer(200, { result: { messageId: 'm-1' } });
    case '/v2/direct-cast-send':
      return answer(200, { result: { success: true } });
    default:
      return answer(200);
  }
});

beforeEach(() => {
  (globalThis as { fetch: unknown }).fetch = mockFetch;
  __resetDirectCastAuth();
  mockStore.fid = 42;
  mockStore.custody = CUSTODY_KEY;
  mockStore.dc = null;
  calls = [];
  mints = 0;
  rejected.clear();
});

const to = (pathname: string) => calls.filter((c) => c.url.pathname === pathname);

// --- the token ----------------------------------------------------------------

describe('the direct-cast token', () => {
  it('is minted by signing farcaster.xyz’s authorization with the custody key', async () => {
    await getDirectCastConversations();

    expect(to('/v2/get-dc-nonce')).toHaveLength(1);
    const [exchange] = to('/v2/get-dc-auth-token');
    const message = exchange.url.searchParams.get('message')!;
    const issuedAt = /Issued At: (.+)$/.exec(message)![1];
    expect(message).toBe(directCastAuthMessage(42, 'n1', issuedAt));
    expect(message).toContain('Direct cast authorization for Farcaster FID 42');

    // EIP-191, signed by the custody key, with an Ethereum recovery byte.
    const signature = exchange.url.searchParams.get('signature')!;
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    const bytes = new TextEncoder().encode(message);
    const digest = keccak_256(new TextEncoder().encode(`\x19Ethereum Signed Message:\n${bytes.length}${message}`));
    const sigBytes = hexToBytes(signature.slice(2));
    const recovered = secp256k1.Signature.fromBytes(sigBytes.slice(0, 64), 'compact')
      .addRecoveryBit(sigBytes[64] - 27)
      .recoverPublicKey(digest)
      .toBytes(false);
    expect(bytesToHex(recovered)).toBe(bytesToHex(secp256k1.getPublicKey(hexToBytes(CUSTODY_KEY), false)));

    expect(exchange.origin).toBe('https://farcaster.xyz');
  });

  it('is kept, and another is minted for a different account', async () => {
    await getDirectCastConversations();
    await getDirectCastMessages({ conversationId: '7-42' });
    expect(mints).toBe(1);
    expect(mockStore.dc).toEqual({ fid: 42, token: 'dc-1' });

    mockStore.fid = 43;
    await getDirectCastConversations();
    expect(mints).toBe(2);
    expect(to('/v2/get-dc-auth-token')[1].url.searchParams.get('message')).toContain('FID 43');
    expect(to('/v2/direct-cast-inbox').at(-1)!.auth).toBe('Bearer dc-2');
  });

  it('is replaced once when farcaster.xyz rejects it, and the call made again', async () => {
    await getDirectCastConversations();
    // Past the minute in which a fresh token isn't replaced.
    const later = Date.now() + 61_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(later);
    rejected.add('dc-1');

    await getDirectCastConversations();
    expect(mints).toBe(2);
    expect(to('/v2/direct-cast-inbox').map((c) => c.auth)).toEqual(['Bearer dc-1', 'Bearer dc-1', 'Bearer dc-2']);

    // Rejected again straight away: no third token, and the call fails.
    rejected.add('dc-2');
    await expect(getDirectCastConversations()).rejects.toThrow('Unauthorized');
    expect(mints).toBe(2);
    now.mockRestore();
  });

  it('isn’t minted without a custody key', async () => {
    mockStore.custody = null;
    await expect(getDirectCastConversations()).rejects.toThrow("Couldn't open your messages");
    expect(to('/v2/get-dc-auth-token')).toHaveLength(0);
  });

  it('is tried again when the app comes back to the front, if minting failed', async () => {
    let onAppState: ((state: string) => void) | undefined;
    const listen = jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, handler: (s: string) => void) => {
      onAppState = handler;
      return { remove: () => (onAppState = undefined) };
    }) as never);
    mockStore.custody = null;
    const { result } = renderHook(() => useDirectCastToken());
    await act(async () => {});
    expect(result.current).toBeNull();

    mockStore.custody = CUSTODY_KEY;
    await act(async () => onAppState?.('active'));
    await waitFor(() => expect(result.current).toBe('dc-1'));
    // Once there's a token it stops listening.
    expect(onAppState).toBeUndefined();
    listen.mockRestore();
  });
});

// --- the endpoints ------------------------------------------------------------

describe('the endpoints', () => {
  it('reads the inbox, 100 at a time, without requests', async () => {
    await getDirectCastConversations({ cursor: 'c2' });
    const [inbox] = to('/v2/direct-cast-inbox');
    expect(Object.fromEntries(inbox.url.searchParams)).toEqual({ category: 'default', limit: '100', cursor: 'c2' });
    expect(inbox.auth).toBe('Bearer dc-1');
    expect(to('/v2/direct-cast-conversation-list')).toHaveLength(0);
  });

  it('sends text and replies through /fc/message: a 1:1 to the other FID, a group by its id', async () => {
    const sent = await sendDirectCast({ conversationId: '7-42', isGroup: false, recipientFid: 7, message: 'hi', inReplyToId: 'm-0' });
    await sendDirectCast({ conversationId: 'g123', isGroup: true, message: 'all' });

    expect(sent).toEqual({ messageId: 'm-1' });
    const [one, group] = to('/fc/message');
    expect([one.method, one.auth, one.body]).toEqual(['PUT', 'Bearer dc-1', { recipientFid: 7, message: 'hi', inReplyToId: 'm-0' }]);
    expect(group.body).toEqual({ groupId: 'g123', message: 'all' });
    expect(to('/v2/direct-cast-send')).toHaveLength(0);
  });

  it('marks read through /v2/direct-cast-mark-read', async () => {
    await markDirectCastRead({ conversationId: '7-42' });
    const [read] = to('/v2/direct-cast-mark-read');
    expect([read.method, read.auth, read.body]).toEqual(['POST', 'Bearer dc-1', { conversationId: '7-42' }]);
  });

  it('sends an image and reactions with the session token, as farcaster.xyz does', async () => {
    const metadata = { medias: [{ height: 1, width: 1, staticRaster: 'https://img/x', version: '2' }] };
    await sendDirectCastWithMedia({ token: 'session', conversationId: '7-42', recipientFids: [7], message: 'https://img/x', metadata });
    await addDirectCastReaction({ token: 'session', conversationId: '7-42', messageId: 'm-1', reaction: '👍' });

    const [send] = to('/v2/direct-cast-send');
    expect([send.auth, send.body?.metadata]).toEqual(['Bearer session', metadata]);
    expect(to('/v2/direct-cast-message-reaction')[0].auth).toBe('Bearer session');
    expect(mints).toBe(0);
  });
});

// --- paging and polling -------------------------------------------------------

describe('the inbox', () => {
  const convo = (id: string) => ({ conversationId: `farcaster:${id}` }) as never;

  it('stops paging when the cursor comes round again or a page brings nothing new', () => {
    const first = { conversations: [convo('a'), convo('b')], nextCursor: 'c2' };
    expect(nextInboxCursor(first, [first], undefined, [undefined])).toBe('c2');

    const repeat = { conversations: [convo('c')], nextCursor: 'c2' };
    expect(nextInboxCursor(repeat, [first, repeat], 'c2', [undefined, 'c2'])).toBeUndefined();

    const nothingNew = { conversations: [convo('a')], nextCursor: 'c3' };
    expect(nextInboxCursor(nothingNew, [first, nothingNew], 'c2', [undefined, 'c2'])).toBeUndefined();
  });

  it('reads unread, muted and the other person from viewerContext, with or without participants', () => {
    const fromInbox = {
      conversationId: '7-42',
      isGroup: false,
      lastMessage: { serverTimestamp: 5000, senderFid: 7, message: 'hey' },
      viewerContext: { category: 'default', unreadCount: 3, muted: true, counterParty: { fid: 7, displayName: 'Seven' } },
    } as never;

    expect(toUnifiedConversation(fromInbox, 42)).toMatchObject({
      unreadCount: 3,
      farcasterFid: 7,
      farcasterParticipantFids: [7],
      displayName: 'Seven',
    });
    // Muted on farcaster.xyz: no background ping.
    expect(planFarcasterPings([fromInbox], 0).conversations).toHaveLength(0);
  });

  it('doesn’t poll, or refetch on focus or every mount: the socket keeps it current', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'chat', 'useFarcasterDirectCasts.ts'), 'utf8');
    expect(source).not.toMatch(/\brefetchInterval\s*:/);
    // The socket's catch-up on reconnect covers coming back to the app.
    expect(source).not.toMatch(/\brefetchOnWindowFocus\s*:\s*true/);
    expect(source).not.toMatch(/\brefetchOnMount\s*:\s*'always'/);
  });
});
