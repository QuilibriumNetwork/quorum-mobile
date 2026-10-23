/**
 * A reply that lands refetches the thread it's in, not every thread held.
 *
 * ## The regression this pins
 *
 * Once a pending cast reached the network, the queue invalidated every
 * `farcaster-thread` query, twice. Stacked thread screens and chat cast cards
 * stay mounted, so each post re-downloaded every one of those whole threads
 * (a 199-cast thread is about 70 KB compressed). A top-level post doesn't
 * belong to any of them at all.
 *
 * ## What is asserted
 *
 * - A landed reply invalidates the thread holding its parent and leaves the
 *   others alone.
 * - A landed top-level post invalidates no thread.
 */
import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setDefaultHypersnapClient, type HypersnapClient } from '@quilibrium/quorum-shared';
import { useFeedOptimisticActions } from '@/context/FeedOptimisticContext';
import * as store from '@/services/feed/optimisticFeedStore';
import { CONFIRM_POLL_MS } from '@/services/feed/castConfirmation';

const hashFor = (n: number) => '0x' + String(n).padStart(40, '0');

let mockSubmits = 0;
jest.mock('@/hooks/useFarcasterSubmitCast', () => ({
  useFarcasterSubmitCast: () => ({
    submitCast: async () => ({ hash: '0x' + String(1000 + ++mockSubmits).padStart(40, '0') }),
  }),
}));
jest.mock('@/services/farcaster/hypersnapWrites', () => ({
  removeOwnCast: jest.fn(),
  setCastReaction: jest.fn(),
  setFollowing: jest.fn(),
}));
jest.mock('@/context/ToastContext', () => ({ useToast: () => ({ showToast: jest.fn() }) }));
jest.mock('@/hooks/useFarcasterFeed', () => ({ prependNewestToFeed: async () => {} }));
jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { farcaster: { fid: 42, username: 'me' }, displayName: 'Me' } }),
}));

const THREAD_A = ['farcaster-thread', 'alice', hashFor(1)] as const;
const THREAD_B = ['farcaster-thread', 'bob', hashFor(2)] as const;
let queryClient: QueryClient;

beforeEach(() => {
  jest.useFakeTimers();
  store.__resetOptimisticFeed();
  mockSubmits = 0;
  // Every submitted cast is on the network at once.
  setDefaultHypersnapClient({ getCastByHash: async (_fid: number, hash: string) => ({ hash }) } as unknown as HypersnapClient);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  // Two threads held: A holds the cast being replied to, B doesn't.
  queryClient.setQueryData(THREAD_A, [
    { hash: hashFor(1), threadHash: hashFor(1) },
    { hash: hashFor(11), threadHash: hashFor(1), parentHash: hashFor(1) },
  ]);
  queryClient.setQueryData(THREAD_B, [{ hash: hashFor(2), threadHash: hashFor(2) }]);
});

afterEach(() => {
  cleanup();
  store.__resetOptimisticFeed();
  queryClient.clear();
  jest.useRealTimers();
});

function mount() {
  return renderHook(() => useFeedOptimisticActions(), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}
const advance = (ms: number) => act(async () => void (await jest.advanceTimersByTimeAsync(ms)));
const invalidated = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated ?? false;

it('a landed reply refetches the thread holding its parent, and no other', async () => {
  const { result } = mount();
  act(() => {
    result.current.postReply({ threadHash: hashFor(1), parentHash: hashFor(11), text: 'reply' });
  });
  await advance(1); // submitted
  await advance(CONFIRM_POLL_MS); // found on the network
  await advance(6000); // both refetch kicks

  expect(invalidated(THREAD_A)).toBe(true);
  expect(invalidated(THREAD_B)).toBe(false);
});

it('a landed top-level post refetches no thread', async () => {
  const { result } = mount();
  act(() => {
    result.current.postTop({ text: 'hello' });
  });
  await advance(1);
  await advance(CONFIRM_POLL_MS);
  await advance(6000);

  expect(store.pendingTopLevel()[0]?.status).toBe('sent');
  expect(invalidated(THREAD_A)).toBe(false);
  expect(invalidated(THREAD_B)).toBe(false);
});
