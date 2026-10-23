/**
 * A cast link in chat with the full hash loads that one cast, not its thread.
 *
 * ## The regression this pins
 *
 * `FarcasterCastCard` fetched the whole thread (`reply_depth=5`, every reply)
 * for each cast link in a chat, to show one cast. A 199-cast thread is about
 * 70 KB compressed against 2.6 KB for the cast alone.
 *
 * ## What is asserted
 *
 * - A full-hash link makes one `/v2/farcaster/cast` lookup and no thread
 *   request, and the card shows the cast.
 */
import React from 'react';
import { waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '../jest/renderWithProviders';
import { FarcasterCastCard } from '@/components/Chat/FarcasterCastCard';

jest.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { farcaster: { fid: 42 } } }) }));
jest.mock('@/services/offline/storage', () => {
  const store = new Map<string, string>();
  return {
    mmkvStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
});

const HASH = '0x' + 'ab'.repeat(20);
const requests: URL[] = [];

beforeEach(() => {
  requests.length = 0;
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (input: string) => {
    const url = new URL(input);
    requests.push(url);
    const body =
      url.pathname === '/v2/farcaster/cast'
        ? {
            cast: {
              object: 'cast',
              hash: HASH.slice(2),
              author: { object: 'user', fid: 7, username: 'alice', display_name: 'Alice', pfp_url: '', profile: {} },
              text: 'the cast itself',
              timestamp: '2026-10-23T12:00:00.000Z',
              embeds: [],
              type: 'cast',
              reactions: { likes_count: 3, recasts_count: 1, likes: [], recasts: [] },
              replies: { count: 2 },
              mentioned_profiles: [],
              mentioned_profiles_ranges: [],
              mentioned_channels: [],
              mentioned_channels_ranges: [],
              parent_author: { fid: null },
            },
          }
        : {};
    return { ok: true, status: 200, json: async () => body } as Response;
  });
});

it('loads one cast for a full-hash link, without its thread', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = renderWithProviders(
    <QueryClientProvider client={client}>
      <FarcasterCastCard url={`https://farcaster.xyz/alice/${HASH}`} />
    </QueryClientProvider>,
  );

  await waitFor(() => expect(root.getByText('the cast itself')).toBeTruthy());
  expect(requests.map((u) => u.pathname)).toEqual(['/v2/farcaster/cast']);
});
