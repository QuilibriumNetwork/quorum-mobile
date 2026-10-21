/**
 * Farcaster reads go to Hypersnap, need no farcaster.xyz token, and never fall
 * back to farcaster.xyz where Hypersnap serves the data.
 *
 * Every request goes through one mocked `fetch`, so each test asserts on the
 * exact URLs the code asked for. Covered: the home feed (and what refreshing
 * it refetches), a thread by full hash
 * and by share-link prefix, cast and user search, username → FID, notifications, the
 * profile, and the tip-recipient address.
 */

import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// jest.mock calls below are hoisted above these imports by babel-jest.
import { prependNewestToFeed, useFarcasterFeed } from '@/hooks/useFarcasterFeed';
import { useFarcasterThread } from '@/hooks/useFarcasterThread';
import { useFeedThreadAncestors } from '@/hooks/useFeedThreadAncestors';
import { useFarcasterProfile } from '@/hooks/useFarcasterProfile';
import { useSearchCasts, useSearchUsers } from '@/hooks/useFarcasterSearch';
import { lookupFidByUsername } from '@/services/farcaster/mentionExtraction';
import { fetchHaatzNotifications } from '@/services/farcaster/haatzNotifications';
import { fetchPrimaryEthAddress } from '@/services/farcaster/hypersnapUsers';
import { getCachedFeed } from '@/services/offline/farcasterFeedCache';
import { mmkvStorage } from '@/services/offline/storage';

// --- network ------------------------------------------------------------------

type Route = (url: string) => { status?: number; body: unknown } | undefined;
let mockRoutes: Route[] = [];
const requested: string[] = [];

const mockFetch = jest.fn(async (input: unknown) => {
  const url = String(input);
  requested.push(url);
  for (const route of mockRoutes) {
    const hit = route(url);
    if (hit) {
      const status = hit.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => hit.body,
        text: async () => JSON.stringify(hit.body),
      } as unknown as Response;
    }
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response;
});
// Installed before quorum-shared builds its default Hypersnap client, which
// captures `fetch` on construction.
(globalThis as { fetch: unknown }).fetch = mockFetch;

const HAATZ = 'https://haatz.quilibrium.com';
const VIEWER_FID = 42;

jest.mock('@/services/offline/storage', () => {
  const store = new Map<string, string>();
  (globalThis as { __mockMmkv?: Map<string, string> }).__mockMmkv = store;
  return {
    mmkvStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
});
jest.mock('@/context/AuthContext', () => ({
  // No farcaster.xyz token anywhere: every read here must work without one.
  useAuth: () => ({ user: { farcaster: { fid: 42 } }, farcasterAuthToken: null }),
}));
jest.mock('@/hooks/useFollowingFids', () => ({
  useFollowingFids: () => ({ fids: new Set([7]), isLoaded: true }),
}));
jest.mock('@/hooks/useFarcasterUsersPrefetch', () => ({
  useFarcasterUsersPrefetch: () => {},
}));

// --- fixtures -----------------------------------------------------------------

const HASH_A = '0x' + 'a'.repeat(40);
const HASH_B = '0x' + 'b'.repeat(40);

function user(fid: number, username: string) {
  return {
    object: 'user',
    fid,
    username,
    display_name: username.toUpperCase(),
    custody_address: '0x' + '1'.repeat(40),
    pfp_url: `https://img.example/${username}.png`,
    profile: { bio: { text: `${username} bio` } },
    follower_count: 10,
    following_count: 5,
    verified_addresses: { eth_addresses: ['0x' + 'e'.repeat(40)], sol_addresses: [] },
  };
}

function cast(hash: string, author: ReturnType<typeof user>, over: Record<string, unknown> = {}) {
  return {
    object: 'cast',
    hash: hash.replace(/^0x/, ''),
    author,
    text: `cast ${hash.slice(2, 6)}`,
    timestamp: '2026-10-16T10:00:00.000Z',
    embeds: [],
    type: 'cast',
    reactions: { likes_count: 2, recasts_count: 1, likes: [], recasts: [] },
    replies: { count: 0 },
    mentioned_profiles: [],
    mentioned_profiles_ranges: [],
    mentioned_channels: [],
    mentioned_channels_ranges: [],
    parent_author: { fid: null },
    ...over,
  };
}

const route =
  (match: string, body: unknown, status = 200): Route =>
  (url) =>
    url.includes(match) ? { status, body } : undefined;

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

const farcasterXyzCalls = () =>
  requested.filter((u) => /farcaster\.xyz|warpcast\.com/.test(u));

beforeEach(() => {
  // Each test starts from a cold cache: no restored feed, profile or thread.
  (globalThis as { __mockMmkv?: Map<string, string> }).__mockMmkv?.clear();
  requested.length = 0;
  mockRoutes = [];
  mockFetch.mockClear();
});

// --- tests --------------------------------------------------------------------

describe('home feed', () => {
  it('reads the following feed from Hypersnap with no token', async () => {
    mockRoutes = [
      route('/v2/farcaster/feed/following', {
        casts: [cast(HASH_A, user(7, 'alice'))],
        next: { cursor: 'page-2' },
      }),
    ];
    const { result } = renderHook(() => useFarcasterFeed(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data[0].cast.hash).toBe(HASH_A);
    expect(requested[0]).toContain(`${HAATZ}/v2/farcaster/feed/following?fid=${VIEWER_FID}`);
    expect(farcasterXyzCalls()).toEqual([]);
    expect(result.current.hasNextPage).toBe(true);
  });

  it('shows an empty feed, not an error, for a viewer who follows no one', async () => {
    mockRoutes = [route('/v2/farcaster/feed/following', { casts: [], next: { cursor: null } })];
    const { result } = renderHook(() => useFarcasterFeed(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(farcasterXyzCalls()).toEqual([]);
  });

  it('surfaces a Hypersnap failure instead of falling back to farcaster.xyz', async () => {
    mockRoutes = [route('/v2/farcaster/feed/following', { message: 'down' }, 503)];
    const { result } = renderHook(() => useFarcasterFeed(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(farcasterXyzCalls()).toEqual([]);
  });

  it('never restores a feed page cached by an older build', () => {
    // v1 pages held farcaster.xyz items and numeric cursors.
    mmkvStorage.setItem(
      `fc-feed-cache:v1:${VIEWER_FID}`,
      JSON.stringify({
        data: { pages: [{ items: [{ id: 'x' }], nextCursor: 123 }], pageParams: [null] },
        updatedAt: 1,
      }),
    );
    expect(getCachedFeed(VIEWER_FID)).toBeUndefined();
  });
});

describe('home feed refreshes', () => {
  const HASH_NEW = '0x' + 'c'.repeat(40);
  const followingCalls = () => requested.filter((u) => u.includes('/v2/farcaster/feed/following'));
  // Page 1 is A (cursor page-2), page 2 is B.
  const twoPages: Route = (url) =>
    url.includes('/v2/farcaster/feed/following')
      ? url.includes('cursor=page-2')
        ? { body: { casts: [cast(HASH_B, user(8, 'bob'))], next: { cursor: null } } }
        : { body: { casts: [cast(HASH_A, user(7, 'alice'))], next: { cursor: 'page-2' } } }
      : undefined;

  function clientAndWrapper() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    function Wrapper({ children }: { children: React.ReactNode }) {
      return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    }
    return { qc, Wrapper };
  }

  it('refetches only the first page on pull-to-refresh', async () => {
    mockRoutes = [twoPages];
    const { Wrapper } = clientAndWrapper();
    const { result } = renderHook(() => useFarcasterFeed(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    requested.length = 0;

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.data.map((i) => i.cast.hash)).toEqual([HASH_A]));
    expect(followingCalls()).toHaveLength(1);
  });

  it('pulls a new cast into the top after posting, leaving the pages below alone', async () => {
    mockRoutes = [twoPages];
    const { qc, Wrapper } = clientAndWrapper();
    const { result } = renderHook(() => useFarcasterFeed(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data).toHaveLength(2));

    // The newest page now leads with the viewer's new cast.
    mockRoutes = [
      route('/v2/farcaster/feed/following', {
        casts: [
          cast(HASH_NEW, user(VIEWER_FID, 'me'), { timestamp: '2026-10-16T10:05:00.000Z' }),
          cast(HASH_A, user(7, 'alice')),
        ],
        next: { cursor: 'page-2' },
      }),
    ];
    requested.length = 0;

    await act(async () => {
      await prependNewestToFeed(qc, VIEWER_FID);
    });

    await waitFor(() =>
      expect(result.current.data.map((i) => i.cast.hash)).toEqual([HASH_NEW, HASH_A, HASH_B]),
    );
    expect(followingCalls()).toHaveLength(1);
  });
});

describe('reply ancestors', () => {
  const HASH_P1 = '0x' + 'e'.repeat(40);
  const HASH_P2 = '0x' + 'f'.repeat(40);
  const bare = (h: string) => h.replace(/^0x/, '');
  const castsByHash: Record<string, ReturnType<typeof cast>> = {
    [bare(HASH_P1)]: cast(HASH_P1, user(8, 'bob'), { parent_hash: bare(HASH_P2), parent_author: { fid: 9 } }),
    [bare(HASH_P2)]: cast(HASH_P2, user(9, 'carol')),
  };
  const routes: Route[] = [
    route('/v2/farcaster/feed/following', {
      casts: [cast(HASH_A, user(7, 'alice'), { parent_hash: bare(HASH_P1), parent_author: { fid: 8 } })],
      next: { cursor: null },
    }),
    (url) => {
      if (!url.includes('/v2/farcaster/cast/bulk')) return undefined;
      const hashes = decodeURIComponent(url.split('hashes=')[1] ?? '').split(',');
      return { body: { casts: hashes.map((h) => castsByHash[bare(h)]).filter(Boolean) } };
    },
  ];

  it('resolves a page’s reply ancestors in one bulk request per level, before the page shows', async () => {
    mockRoutes = routes;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const Wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useFarcasterFeed(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    const bulkCalls = requested.filter((u) => u.includes('/v2/farcaster/cast/bulk'));
    expect(bulkCalls).toHaveLength(2);
    expect(requested.some((u) => /\/v2\/farcaster\/cast\?/.test(u))).toBe(false);

    // The card's own hook finds both ancestors cached, and asks for nothing.
    const reply = result.current.data[0].cast;
    requested.length = 0;
    const ancestors = renderHook(
      () => useFeedThreadAncestors({ parentHash: reply.parentHash, parentAuthorFid: reply.parentAuthor?.fid }, true),
      { wrapper: Wrapper },
    );
    expect(ancestors.result.current.ancestors.map((c) => c.hash)).toEqual([HASH_P1, HASH_P2]);
    expect(ancestors.result.current.rootKnown).toBe(true);
    expect(requested).toEqual([]);
  });
});

describe('thread', () => {
  it('loads a full hash from Hypersnap only', async () => {
    mockRoutes = [
      route('/v2/farcaster/cast/conversation', {
        conversation: { cast: { ...cast(HASH_A, user(7, 'alice')), direct_replies: [] } },
      }),
    ];
    const { result } = renderHook(
      () => useFarcasterThread({ username: '', castHashPrefix: HASH_A }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.mainCast?.hash).toBe(HASH_A));
    expect(requested[0]).toContain(`${HAATZ}/v2/farcaster/cast/conversation?identifier=${'a'.repeat(40)}`);
    expect(farcasterXyzCalls()).toEqual([]);
  });

  it('opens a bare-hex hash, the form Hypersnap notifications and pushes carry', async () => {
    mockRoutes = [
      route('/v2/farcaster/cast/conversation', {
        conversation: { cast: { ...cast(HASH_A, user(7, 'alice')), direct_replies: [] } },
      }),
    ];
    const { result } = renderHook(
      () => useFarcasterThread({ username: 'alice', castHashPrefix: 'a'.repeat(40) }),
      { wrapper: wrapper() },
    );

    // The casts come back as `0x…`; matching them against the bare hash used
    // to fail, leaving no main cast and a blank thread screen.
    await waitFor(() => expect(result.current.mainCast?.hash).toBe(HASH_A));
  });

  it('fails on a missing full-hash cast without asking farcaster.xyz', async () => {
    mockRoutes = [route('/v2/farcaster/cast/conversation', { message: 'not found' }, 404)];
    const { result } = renderHook(
      () => useFarcasterThread({ username: 'alice', castHashPrefix: HASH_A }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(farcasterXyzCalls()).toEqual([]);
  });

  it("resolves a share-link prefix from the author's casts on Hypersnap", async () => {
    mockRoutes = [
      route('/v2/farcaster/user/by-username', { user: user(7, 'alice') }),
      route('/v2/farcaster/feed/user/casts', {
        casts: [cast(HASH_B, user(7, 'alice')), cast(HASH_A, user(7, 'alice'))],
        next: { cursor: null },
      }),
      route('/v2/farcaster/cast/conversation', {
        conversation: { cast: { ...cast(HASH_A, user(7, 'alice')), direct_replies: [] } },
      }),
    ];
    const { result } = renderHook(
      () => useFarcasterThread({ username: 'alice', castHashPrefix: '0xaaaaaaaa' }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.mainCast?.hash).toBe(HASH_A));
    expect(farcasterXyzCalls()).toEqual([]);
  });

  it('asks farcaster.xyz only to resolve a prefix Hypersnap cannot find', async () => {
    mockRoutes = [
      route('/v2/farcaster/user/by-username', { user: user(7, 'alice') }),
      route('/v2/farcaster/feed/user/casts', { casts: [], next: { cursor: null } }),
      route('farcaster.xyz/~api/v2/user-thread-casts', {
        result: { casts: [{ hash: HASH_A, author: { fid: 7 } }] },
      }),
      route('/v2/farcaster/cast/conversation', {
        conversation: { cast: { ...cast(HASH_A, user(7, 'alice')), direct_replies: [] } },
      }),
    ];
    const { result } = renderHook(
      () => useFarcasterThread({ username: 'alice', castHashPrefix: '0xaaaaaaaa' }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.mainCast?.hash).toBe(HASH_A));
    // One prefix lookup; the thread itself still comes from Hypersnap.
    expect(farcasterXyzCalls()).toHaveLength(1);
    expect(farcasterXyzCalls()[0]).toContain('user-thread-casts');
  });
});

describe('cast search', () => {
  it('searches Hypersnap with no token', async () => {
    mockRoutes = [
      route('/v2/farcaster/cast/search', {
        result: { casts: [cast(HASH_A, user(7, 'alice'))], next: {} },
      }),
    ];
    const { result } = renderHook(() => useSearchCasts({ q: 'hello' }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.casts).toHaveLength(1));
    expect(result.current.casts[0]).toMatchObject({
      hash: HASH_A,
      author: { fid: 7, username: 'alice', displayName: 'ALICE' },
    });
    expect(requested[0]).toContain(`${HAATZ}/v2/farcaster/cast/search?q=hello`);
    expect(result.current.hasNextPage).toBe(false);
    expect(farcasterXyzCalls()).toEqual([]);
  });
});

describe('user search', () => {
  it('searches Hypersnap with no token', async () => {
    mockRoutes = [
      route('/v2/farcaster/user/search', { users: [user(7, 'alice'), user(8, 'alicia')] }),
    ];
    const { result } = renderHook(() => useSearchUsers({ q: 'ali', limit: 10 }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.users).toHaveLength(2));
    expect(result.current.users[0]).toEqual({
      fid: 7,
      username: 'alice',
      displayName: 'ALICE',
      pfp: { url: 'https://img.example/alice.png' },
      profile: { bio: { text: 'alice bio' } },
      followerCount: 10,
      followingCount: 5,
    });
    expect(requested).toEqual([`${HAATZ}/v2/farcaster/user/search?q=ali&limit=10`]);
    expect(result.current.hasNextPage).toBe(false);
    expect(farcasterXyzCalls()).toEqual([]);
  });

  it('asks nothing for a bare @, which the server would reject', async () => {
    const { result } = renderHook(() => useSearchUsers({ q: '@' }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.users).toEqual([]);
    expect(requested).toEqual([]);
  });
});

describe('username → FID', () => {
  it('resolves an fname through the user lookup', async () => {
    mockRoutes = [route('/v2/farcaster/user/by-username?username=alice', { user: user(7, 'alice') })];
    expect(await lookupFidByUsername('alice')).toBe(7);
    expect(farcasterXyzCalls()).toEqual([]);
  });

  it('resolves an ENS name through the hub username proofs, unmodified', async () => {
    mockRoutes = [route('/v1/userNameProofByName?name=alice.eth', { name: 'alice.eth', fid: 99 })];
    expect(await lookupFidByUsername('alice.eth')).toBe(99);
    // `alice.eth` is never rewritten to `alice`, which can be another account.
    expect(requested.some((u) => u.includes('username=alice&') || u.endsWith('username=alice'))).toBe(false);
    expect(farcasterXyzCalls()).toEqual([]);
  });

  it('returns null for an unknown name', async () => {
    expect(await lookupFidByUsername('nobody')).toBeNull();
    expect(farcasterXyzCalls()).toEqual([]);
  });
});

describe('notifications', () => {
  it('pages through Hypersnap with the actor name and avatar', async () => {
    mockRoutes = [
      route('/v2/farcaster/notifications', {
        notifications: [
          {
            type: 'likes',
            timestamp: '2026-10-16T10:00:00.000Z',
            user: user(7, 'alice'),
            cast: { hash: HASH_A, text: 'mine', author: user(VIEWER_FID, 'me') },
          },
          {
            type: 'reply',
            timestamp: '2026-10-16T09:00:00.000Z',
            user: user(8, 'bob'),
            cast: { hash: HASH_B, text: 'reply', author: user(8, 'bob') },
          },
        ],
        next: { cursor: 'c2' },
      }),
    ];
    const page = await fetchHaatzNotifications(VIEWER_FID, 'c1');

    expect(requested[0]).toBe(`${HAATZ}/v2/farcaster/notifications?fid=42&limit=25&cursor=c1`);
    expect(page.nextCursor).toBe('c2');
    expect(page.notifications[0]).toMatchObject({
      type: 'cast-like',
      actor: { fid: 7, displayName: 'ALICE', pfp: { url: 'https://img.example/alice.png' } },
      content: { cast: { hash: HASH_A, author: { fid: VIEWER_FID, username: 'me' } } },
    });
    // A reply's cast is the actor's own.
    expect(page.notifications[1].content?.cast?.author?.fid).toBe(8);
    expect(farcasterXyzCalls()).toEqual([]);
  });

  it('hands on cast hashes as 0x…, though Hypersnap sends them bare', async () => {
    mockRoutes = [
      route('/v2/farcaster/notifications', {
        notifications: [
          {
            type: 'likes',
            timestamp: '2026-10-16T10:00:00.000Z',
            user: user(7, 'alice'),
            cast: { hash: 'a'.repeat(40), text: 'mine', author: user(VIEWER_FID, 'me') },
          },
        ],
        next: { cursor: null },
      }),
    ];
    const page = await fetchHaatzNotifications(VIEWER_FID);

    expect(page.notifications[0].content?.cast?.hash).toBe(HASH_A);
    // The row id keeps the hash as sent, so ids already marked seen still match.
    expect(page.notifications[0].id).toContain(`:${'a'.repeat(40)}:`);
    expect(page.notifications[0].id).not.toContain(HASH_A);
  });

  it('throws on failure so a query keeps its last good page', async () => {
    mockRoutes = [route('/v2/farcaster/notifications', {}, 500)];
    await expect(fetchHaatzNotifications(VIEWER_FID)).rejects.toThrow();
  });
});

describe('profile', () => {
  it('builds the header and top-level casts from Hypersnap', async () => {
    mockRoutes = [
      route('/v2/farcaster/user?fid=7', { user: user(7, 'alice') }),
      route('/v1/userDataByFid?fid=7', {
        messages: [
          { data: { userDataBody: { type: 'USER_DATA_TYPE_BANNER', value: 'https://img.example/banner.png' } } },
          { data: { userDataBody: { type: 'USER_DATA_TYPE_LOCATION', value: 'geo:37.77,-122.41' } } },
        ],
      }),
      route('/v1/onChainEventsByFid?fid=7', {
        events: [
          {
            blockTimestamp: Math.floor(Date.now() / 1000) - 10,
            tier_purchase_event_body: { for_days: 30, tier_type: 'Pro' },
          },
        ],
      }),
      route('/v2/farcaster/feed/user/casts?fid=7', {
        casts: [
          cast(HASH_A, user(7, 'alice')),
          cast(HASH_B, user(7, 'alice'), { parent_hash: 'c'.repeat(40), parent_author: { fid: 9 } }),
        ],
        next: { cursor: null },
      }),
    ];
    const { result } = renderHook(() => useFarcasterProfile({ fid: 7 }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.author).toBeDefined());
    expect(result.current.author).toMatchObject({
      fid: 7,
      username: 'alice',
      displayName: 'ALICE',
      followerCount: 10,
      profile: {
        bio: { text: 'alice bio' },
        bannerImageUrl: 'https://img.example/banner.png',
        accountLevel: 'pro',
        // A `geo:` coordinate has no place name to show.
        location: undefined,
      },
      // The viewer's follow list contains fid 7.
      viewerContext: { following: true },
    });
    // The reply is left out, as on the profile's Casts tab.
    expect(result.current.casts.map((c) => c.hash)).toEqual([HASH_A]);
    expect(farcasterXyzCalls()).toEqual([]);
  });
});

describe('tip recipient address', () => {
  it("uses the account's protocol primary address", async () => {
    mockRoutes = [
      route('/v1/userDataByFid?fid=7', {
        messages: [
          { data: { userDataBody: { type: 'USER_DATA_PRIMARY_ADDRESS_ETHEREUM', value: '0xPrimary' } } },
        ],
      }),
    ];
    expect(await fetchPrimaryEthAddress(7)).toBe('0xPrimary');
    expect(farcasterXyzCalls()).toEqual([]);
  });

  it('falls back to the first verified address', async () => {
    mockRoutes = [
      route('/v1/userDataByFid?fid=7', { messages: [] }),
      route('/v2/farcaster/user?fid=7', { user: user(7, 'alice') }),
    ];
    expect(await fetchPrimaryEthAddress(7)).toBe('0x' + 'e'.repeat(40));
    expect(farcasterXyzCalls()).toEqual([]);
  });
});

afterAll(() => {
  act(() => {});
});
