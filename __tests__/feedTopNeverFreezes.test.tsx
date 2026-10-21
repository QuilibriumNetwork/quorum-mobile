/**
 * The top of the feed never freezes in the past.
 *
 * ## The regression this pins
 *
 * Users reported a feed days out of date that pull-to-refresh didn't fix. The
 * home feed held at most six pages (`maxPages: 6`) and only pages older. The
 * seventh page dropped the first, the page after it took its place, and an
 * infinite query refetches from the first page param it holds: that page's
 * cursor. From then on every refresh fetched casts older than that cursor, so
 * the newest casts were never asked for again. The persister wrote that state
 * to disk, so it survived restarts while the app was opened daily.
 * Notifications, profiles and search had the same cap.
 *
 * Separately, `refreshIfStale` read `query.isStale` from the last render, so a
 * feed fetched just before the app was backgrounded still read fresh when it
 * came back days later, and the feed only refreshed on return if the feed tab
 * was the one on screen.
 *
 * ## What is asserted
 *
 * - After scrolling eight pages, a refresh asks for the newest page (no
 *   cursor) and shows the new cast first. Same for notifications.
 * - No query that pages one way declares `maxPages`.
 * - `refreshIfStale` refreshes a feed that went stale without re-rendering, and
 *   leaves a fresh one alone.
 * - The feed refreshes on coming into view or the app returning when it's at
 *   the top; scrolled down, it waits until the list is back at the top, once.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { AppState } from 'react-native';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// jest.mock calls below are hoisted above these imports by babel-jest.
import { useFarcasterFeed } from '@/hooks/useFarcasterFeed';
import { useHaatzNotifications } from '@/hooks/useHaatzNotifications';
import { FEED_TOP_THRESHOLD_PX, useFeedRefreshOnReturn } from '@/hooks/useFeedRefreshOnReturn';

// --- network ------------------------------------------------------------------

const requested: string[] = [];
let newestCast: string | undefined;

const hashFor = (n: number | string) => '0x' + String(n).padStart(40, '0');
const NEW_HASH = hashFor('ffff');

function user(fid: number) {
  return { object: 'user', fid, username: `u${fid}`, display_name: `U${fid}`, pfp_url: '', profile: {} };
}
function cast(hash: string, minutesAgo: number) {
  return {
    object: 'cast',
    hash: hash.replace(/^0x/, ''),
    author: user(7),
    text: 'x',
    timestamp: new Date(Date.UTC(2026, 9, 20) - minutesAgo * 60_000).toISOString(),
    embeds: [],
    type: 'cast',
    reactions: { likes_count: 0, recasts_count: 0, likes: [], recasts: [] },
    replies: { count: 0 },
    mentioned_profiles: [],
    mentioned_profiles_ranges: [],
    mentioned_channels: [],
    mentioned_channels_ranges: [],
    parent_author: { fid: null },
  };
}

/** Eight pages of one item each, `cursor=p<n>` for page n; page 1 has none. */
function pageOf(url: string): number {
  const match = /cursor=p(\d+)/.exec(url);
  return match ? Number(match[1]) : 1;
}

const mockFetch = jest.fn(async (input: unknown) => {
  const url = String(input);
  requested.push(url);
  const n = pageOf(url);
  const next = { cursor: n < 8 ? `p${n + 1}` : null };
  let body: unknown = {};
  if (url.includes('/v2/farcaster/feed/following')) {
    const casts = [cast(hashFor(n), n * 10)];
    if (n === 1 && newestCast) casts.unshift(cast(newestCast, 0));
    body = { casts, next };
  } else if (url.includes('/v2/farcaster/notifications')) {
    const notification = (hash: string, minutesAgo: number) => ({
      type: 'likes',
      timestamp: new Date(Date.UTC(2026, 9, 20) - minutesAgo * 60_000).toISOString(),
      user: user(7),
      cast: { hash, text: 'mine', author: user(42) },
    });
    const notifications = [notification(hashFor(n), n * 10)];
    if (n === 1 && newestCast) notifications.unshift(notification(newestCast, 0));
    body = { notifications, next };
  }
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
});
// Installed before quorum-shared builds its default Hypersnap client, which
// captures `fetch` on construction.
(globalThis as { fetch: unknown }).fetch = mockFetch;

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
  useAuth: () => ({ user: { farcaster: { fid: 42 } }, farcasterAuthToken: null }),
}));
jest.mock('@/hooks/useFollowingFids', () => ({
  useFollowingFids: () => ({ fids: new Set([7]), isLoaded: true }),
}));
jest.mock('@/hooks/useFarcasterUsersPrefetch', () => ({ useFarcasterUsersPrefetch: () => {} }));

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  // Each test starts from a cold cache: no feed page restored from disk.
  (globalThis as { __mockMmkv?: Map<string, string> }).__mockMmkv?.clear();
  requested.length = 0;
  newestCast = undefined;
  mockFetch.mockClear();
});
afterEach(() => jest.restoreAllMocks());

// --- refetching after a long scroll ---------------------------------------------

describe('after scrolling eight pages', () => {
  it('a feed refresh asks for the newest page and shows the new cast first', async () => {
    const { result } = renderHook(() => useFarcasterFeed(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    for (let page = 2; page <= 8; page++) {
      await act(async () => {
        await result.current.fetchNextPage();
      });
    }
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(result.current.data[0].cast.hash).toBe(hashFor(1));

    newestCast = NEW_HASH;
    requested.length = 0;
    await act(async () => {
      await result.current.refetch();
    });

    expect(requested).toHaveLength(1);
    expect(requested[0]).not.toContain('cursor=');
    await waitFor(() => expect(result.current.data[0].cast.hash).toBe(NEW_HASH));
  });

  it('a notifications refetch starts from the newest page', async () => {
    const { result } = renderHook(() => useHaatzNotifications(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    for (let page = 2; page <= 8; page++) {
      await act(async () => {
        await result.current.fetchNextPage();
      });
    }
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(8));

    newestCast = NEW_HASH;
    requested.length = 0;
    await act(async () => {
      await result.current.refetch();
    });

    expect(requested[0]).not.toContain('cursor=');
    await waitFor(() =>
      expect(result.current.data?.pages[0].notifications[0].content?.cast?.hash).toBe(NEW_HASH),
    );
  });
});

it('no query that pages one way declares maxPages', () => {
  // A dropped first page only comes back through getPreviousPageParam.
  const hooksDir = path.join(__dirname, '..', 'hooks');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(hooksDir);
  const offenders = files.filter((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return /\bmaxPages\s*:/.test(source) && !/\bgetPreviousPageParam\s*:/.test(source);
  });
  expect(offenders.map((f) => path.relative(hooksDir, f))).toEqual([]);
});

// --- staleness ----------------------------------------------------------------

describe('refreshIfStale', () => {
  it('refreshes a feed that went stale without re-rendering, and leaves a fresh one alone', async () => {
    const { result } = renderHook(() => useFarcasterFeed(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    requested.length = 0;

    await act(async () => {
      await result.current.refreshIfStale();
    });
    expect(requested).toHaveLength(0);

    // Three days in the background: no render since the fetch.
    const later = Date.now() + 3 * 24 * 60 * 60 * 1000;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    newestCast = NEW_HASH;
    await act(async () => {
      await result.current.refreshIfStale();
    });

    expect(requested).toHaveLength(1);
    await waitFor(() => expect(result.current.data[0].cast.hash).toBe(NEW_HASH));
  });
});

// --- coming back into view ----------------------------------------------------

describe('useFeedRefreshOnReturn', () => {
  let appStateHandler: ((state: string) => void) | undefined;
  beforeEach(() => {
    appStateHandler = undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_event: string, handler: (s: string) => void) => {
      appStateHandler = handler;
      return { remove: () => (appStateHandler = undefined) };
    }) as never);
  });

  function setup(initial: { inView: boolean; scrollY: number }) {
    const refreshIfStale = jest.fn(async () => {});
    const scrollYRef = { current: initial.scrollY };
    const hook = renderHook(
      ({ inView }: { inView: boolean }) => useFeedRefreshOnReturn({ inView, scrollYRef, refreshIfStale }),
      { initialProps: { inView: initial.inView } },
    );
    return { ...hook, refreshIfStale, scrollYRef };
  }

  it('checks when the feed comes into view, and when the app returns, at the top', () => {
    const { rerender, refreshIfStale } = setup({ inView: false, scrollY: 0 });
    expect(refreshIfStale).not.toHaveBeenCalled();
    expect(appStateHandler).toBeUndefined();

    rerender({ inView: true });
    expect(refreshIfStale).toHaveBeenCalledTimes(1);

    act(() => appStateHandler?.('background'));
    act(() => appStateHandler?.('active'));
    expect(refreshIfStale).toHaveBeenCalledTimes(2);
  });

  it('scrolled down, waits until the list is back at the top, then checks once', () => {
    const { result, refreshIfStale, scrollYRef } = setup({ inView: true, scrollY: 2000 });
    act(() => appStateHandler?.('active'));
    expect(refreshIfStale).not.toHaveBeenCalled();

    act(() => result.current.onScrollY(800));
    expect(refreshIfStale).not.toHaveBeenCalled();
    scrollYRef.current = 0;
    act(() => result.current.onScrollY(FEED_TOP_THRESHOLD_PX - 1));
    expect(refreshIfStale).toHaveBeenCalledTimes(1);

    act(() => result.current.onScrollY(0));
    expect(refreshIfStale).toHaveBeenCalledTimes(1);
  });
});
