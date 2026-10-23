/**
 * The viewer's follow set and reaction window aren't downloaded whole on every
 * launch.
 *
 * ## The regressions this pins
 *
 * - The follow set is the whole list as signed messages (about 110 KB
 *   compressed per 1,000 follows). It counted as fresh from every launch for
 *   30 minutes, then refetched on the next profile open, so a long session
 *   downloaded it again every half hour; follows made in the app weren't
 *   applied to it.
 * - The reaction window, 700 reaction messages (about 100 KB compressed), was
 *   kept only in memory and downloaded on every cold start.
 *
 * ## What is asserted
 *
 * - The follow set's age is when it was last downloaded: a saved set younger
 *   than 6 hours isn't fetched, an older one is. A follow made here updates it
 *   at once and keeps its age.
 * - The reaction window is kept on the phone; a refresh fetches the newest 50
 *   and puts the new ones on top, and downloads the whole window only once a
 *   day, or when the newest 50 don't reach what's kept.
 */
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FOLLOWING_STALE_MS, useFollowingFids } from '@/hooks/useFollowingFids';
import {
  loadFollowingFidsEntry,
  recordFollowChange,
  saveFollowingFids,
} from '@/services/farcaster/socialGraph';
import {
  VIEWER_LIKES_WINDOW,
  VIEWER_REACTIONS_FULL_MS,
  mergeNewestReactions,
  refreshViewerReactions,
  type ViewerReactions,
} from '@/services/farcaster/viewerReactions';

jest.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { farcaster: { fid: 42 } } }) }));

const requests: URL[] = [];
/** Newest first, per reaction type. */
let likesOnServer: string[] = [];
let recastsOnServer: string[] = [];
const hex = (n: number) => n.toString(16).padStart(40, '0');

beforeEach(() => {
  requests.length = 0;
  likesOnServer = [];
  recastsOnServer = [];
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (input: string) => {
    const url = new URL(input);
    requests.push(url);
    let body: unknown = {};
    if (url.pathname === '/v1/linksByFid') {
      body = { messages: [{ data: { linkBody: { targetFid: 7 } } }, { data: { linkBody: { targetFid: 8 } } }] };
    } else if (url.pathname === '/v1/reactionsByFid') {
      const all = url.searchParams.get('reaction_type') === 'Like' ? likesOnServer : recastsOnServer;
      const page = all.slice(0, Number(url.searchParams.get('pageSize')));
      body = {
        messages: page.map((hash) => ({
          data: { type: 'MESSAGE_TYPE_REACTION_ADD', reactionBody: { targetCastId: { hash } } },
        })),
      };
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  });
});
afterEach(() => jest.restoreAllMocks());

function wrapper() {
  // No gc timers left running after the test.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

// --- follows -------------------------------------------------------------------

describe('the follow set', () => {
  const linkRequests = () => requests.filter((u) => u.pathname === '/v1/linksByFid');

  it('isn’t downloaded while the saved set is younger than 6 hours', async () => {
    saveFollowingFids(42, [7]);
    const { result } = renderHook(() => useFollowingFids(), { wrapper: wrapper() });
    await act(async () => {});
    expect(result.current.fids.has(7)).toBe(true);
    expect(linkRequests()).toHaveLength(0);
  });

  it('is downloaded when the saved set is older', async () => {
    // Saved just over 6 hours ago.
    const savedAt = Date.now() - FOLLOWING_STALE_MS - 1000;
    const clock = jest.spyOn(Date, 'now').mockReturnValueOnce(savedAt);
    saveFollowingFids(42, [7]);
    clock.mockRestore();
    expect(loadFollowingFidsEntry(42)!.fetchedAt).toBe(savedAt);
    const { result } = renderHook(() => useFollowingFids(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.fids.has(8)).toBe(true));
    expect(linkRequests()).toHaveLength(1);
  });

  it('takes a follow made here at once, keeping its age', async () => {
    saveFollowingFids(42, [7]);
    const savedAt = loadFollowingFidsEntry(42)!.fetchedAt;
    const { result } = renderHook(() => useFollowingFids(), { wrapper: wrapper() });
    await act(async () => {});

    act(() => recordFollowChange(42, 99, true));
    await waitFor(() => expect(result.current.fids.has(99)).toBe(true));
    expect(loadFollowingFidsEntry(42)!.fetchedAt).toBe(savedAt);

    act(() => recordFollowChange(42, 7, false));
    await waitFor(() => expect(result.current.fids.has(7)).toBe(false));
    expect(linkRequests()).toHaveLength(0);
  });
});

// --- reactions -----------------------------------------------------------------

describe('the reaction window', () => {
  const pageSizes = () => requests.filter((u) => u.pathname === '/v1/reactionsByFid').map((u) => Number(u.searchParams.get('pageSize')));

  it('merges the newest few on top of what’s kept', () => {
    expect(mergeNewestReactions(['c', 'b', 'a'], ['e', 'd', 'c', 'b'], 10)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(mergeNewestReactions(['c', 'b'], ['c', 'b'], 10)).toEqual(['c', 'b']);
    expect(mergeNewestReactions(['b', 'a'], ['d', 'c', 'b'], 3)).toEqual(['d', 'c', 'b']);
    // A full page with nothing kept: there may be a gap.
    const page = Array.from({ length: 50 }, (_, i) => `n${i}`);
    expect(mergeNewestReactions(['old'], page, 500)).toBeNull();
  });

  it('downloads the whole window when nothing is kept', async () => {
    likesOnServer = [hex(2), hex(1)];
    const next = await refreshViewerReactions(42, null, 1000);
    expect(pageSizes().sort((a, b) => a - b)).toEqual([200, VIEWER_LIKES_WINDOW]);
    expect(next).toMatchObject({ likes: [`0x${hex(2)}`, `0x${hex(1)}`], fullAt: 1000 });
  });

  it('then fetches only the newest 50, and the whole window again a day later', async () => {
    const kept: ViewerReactions = { likes: [`0x${hex(1)}`], recasts: [], fullAt: 1000, fetchedAt: 1000 };
    likesOnServer = [hex(3), hex(2), hex(1)];

    const next = await refreshViewerReactions(42, kept, 2000);
    expect(pageSizes()).toEqual([50, 50]);
    expect(next).toEqual({ likes: [`0x${hex(3)}`, `0x${hex(2)}`, `0x${hex(1)}`], recasts: [], fullAt: 1000, fetchedAt: 2000 });

    requests.length = 0;
    await refreshViewerReactions(42, next, 1000 + VIEWER_REACTIONS_FULL_MS);
    expect(pageSizes().sort((a, b) => a - b)).toEqual([200, VIEWER_LIKES_WINDOW]);
  });

  it('downloads the whole window when the newest 50 don’t reach what’s kept', async () => {
    const kept: ViewerReactions = { likes: [`0x${hex(1)}`], recasts: [], fullAt: 1000, fetchedAt: 1000 };
    likesOnServer = Array.from({ length: 60 }, (_, i) => hex(100 + i));
    await refreshViewerReactions(42, kept, 2000);
    expect(pageSizes()).toEqual([50, 50, VIEWER_LIKES_WINDOW, 200]);
  });
});
