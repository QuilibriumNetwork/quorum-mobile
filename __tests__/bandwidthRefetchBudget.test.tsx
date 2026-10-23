/**
 * Background refetching stays within budget: nothing re-downloads on every
 * network flap, the bell doesn't pull the whole notifications page every
 * minute, and live audio-room cards stop polling behind other tabs.
 *
 * ## The regressions this pins
 *
 * Users reported heavy data usage. Among the causes:
 *
 * - `refetchOnReconnect` was left on, so every offline→online flip refetched
 *   every stale query with an observer, every page of every infinite query,
 *   hidden tabs included.
 * - The notifications list (25 rows, each with a full cast and author, about
 *   80 KB before compression) was refetched every minute by each of its
 *   observers, changed or not.
 * - Audio-room embeds polled every 20 s while live, from feed, thread and
 *   profile cells that stay mounted behind other tabs.
 *
 * ## What is asserted
 *
 * - The app's QueryClient doesn't refetch on reconnect.
 * - The bell polls a 5-row probe; the list is refetched only when the probe
 *   has something newer, and not at all once it holds more than one page.
 * - An audio-room embed doesn't poll while its screen isn't focused.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { NavigationContext } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useHaatzNotifications, useHaatzNotificationsPoll } from '@/hooks/useHaatzNotifications';
import { renderWithProviders } from '../jest/renderWithProviders';
import { AudioSpaceEmbed } from '@/components/SocialFeed/content/AudioSpaceEmbed';

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { farcaster: { fid: 42 } }, farcasterAuthToken: 'session' }),
}));
const mockFetchAudioRoom = jest.fn(async () => ({ id: 'room', state: 'live', host: { fid: 7, username: 'h' } }));
jest.mock('@/services/spaces/spacesClient', () => ({
  fetchAudioRoom: (...args: unknown[]) => mockFetchAudioRoom(...(args as [])),
}));
jest.mock('@/context/AudioSpaceContext', () => ({ useAudioSpace: () => ({ join: jest.fn() }) }));
jest.mock('@/hooks/useFarcasterUserPersistent', () => ({ useFarcasterUserPersistent: () => ({ data: undefined }) }));

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  jest.useRealTimers();
});

it('the app’s QueryClient doesn’t refetch on reconnect', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', '_layout.tsx'), 'utf8');
  const defaults = source.slice(source.indexOf('new QueryClient('), source.indexOf('PERSISTED_QUERY_ROOTS) {'));
  expect(defaults).toMatch(/refetchOnReconnect:\s*false/);
});

// --- notifications -------------------------------------------------------------

function notification(minute: number) {
  return {
    type: 'likes',
    timestamp: new Date(Date.UTC(2026, 9, 23, 12, minute)).toISOString(),
    user: { fid: 7, username: 'u7' },
    cast: { hash: `0x${String(minute).padStart(40, '0')}`, text: 'mine', author: { fid: 42 } },
  };
}

describe('the notifications poll', () => {
  let newestMinute = 1;
  const requests: URL[] = [];
  beforeEach(() => {
    newestMinute = 1;
    requests.length = 0;
    (globalThis as { fetch: unknown }).fetch = jest.fn(async (input: string) => {
      const url = new URL(input);
      requests.push(url);
      const limit = Number(url.searchParams.get('limit'));
      const rows = Array.from({ length: Math.min(limit, newestMinute) }, (_, i) => notification(newestMinute - i));
      const body = { notifications: rows, next: { cursor: null } };
      return { ok: true, status: 200, json: async () => body } as Response;
    });
  });

  const limits = () => requests.map((u) => Number(u.searchParams.get('limit')));

  it('polls a 5-row probe, and refetches the list only when there’s something new', async () => {
    jest.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The bell: the list (for the badge) plus the poll.
    renderHook(
      () => {
        useHaatzNotifications();
        useHaatzNotificationsPoll();
      },
      { wrapper: wrapper(client) },
    );
    await act(async () => void (await jest.advanceTimersByTimeAsync(10)));
    expect(limits().sort()).toEqual([25, 5]);

    // A minute with nothing new: only the probe.
    requests.length = 0;
    await act(async () => void (await jest.advanceTimersByTimeAsync(60_000)));
    expect(limits()).toEqual([5]);

    // Something new: the probe sees it and the list is refetched once.
    requests.length = 0;
    newestMinute = 2;
    await act(async () => void (await jest.advanceTimersByTimeAsync(60_000)));
    await waitFor(() => expect(limits()).toEqual([5, 25]));
  });

  it('the list itself isn’t polled, however many screens show it', async () => {
    jest.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(
      () => {
        useHaatzNotifications(); // the bell
        useHaatzNotifications(); // the panel
      },
      { wrapper: wrapper(client) },
    );
    await act(async () => void (await jest.advanceTimersByTimeAsync(10)));
    requests.length = 0;
    await act(async () => void (await jest.advanceTimersByTimeAsync(5 * 60_000)));
    expect(requests).toHaveLength(0);
  });
});

// --- audio rooms ---------------------------------------------------------------

describe('a live audio-room embed', () => {
  function navigation(focused: boolean) {
    return { isFocused: () => focused, addListener: () => () => {} };
  }

  async function polls(focused: boolean) {
    jest.useFakeTimers();
    mockFetchAudioRoom.mockClear();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithProviders(
      <QueryClientProvider client={client}>
        <NavigationContext.Provider value={navigation(focused) as never}>
          <AudioSpaceEmbed spaceId="room" castHash="0xabc" />
        </NavigationContext.Provider>
      </QueryClientProvider>,
    );
    await act(async () => void (await jest.advanceTimersByTimeAsync(10)));
    expect(mockFetchAudioRoom).toHaveBeenCalledTimes(1);
    await act(async () => void (await jest.advanceTimersByTimeAsync(60_000)));
    return mockFetchAudioRoom.mock.calls.length - 1;
  }

  it('polls while its screen is in view', async () => {
    expect(await polls(true)).toBeGreaterThanOrEqual(2);
  });

  it('doesn’t poll while its screen is hidden', async () => {
    expect(await polls(false)).toBe(0);
  });
});
