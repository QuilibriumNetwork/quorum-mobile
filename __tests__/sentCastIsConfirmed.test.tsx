/**
 * A cast reads "Posted" only once it's on the network, and a retry can't post
 * it twice.
 *
 * ## The regression this pins
 *
 * A cast read "Posted" as soon as Hypersnap's `/v1/submitMessage` answered,
 * which only means the node's mempool took it. A cast that then never reached a
 * block still said "Posted", and since the 20 s stub expiry it vanished with no
 * error. Users reported posts that "went through" but never appeared.
 *
 * Retrying has to re-sign (the mempool rejects a stale timestamp), so the retry
 * has a new hash and an earlier copy could still land after it.
 *
 * ## What is asserted
 *
 * - An accepted cast is "confirming" (shown as "Sending…") until a lookup by
 *   hash finds it, then "sent".
 * - One that Hypersnap still says isn't there a minute after accepting it is
 *   "failed", so the user can retry; a lookup that errors never fails it.
 * - A retry checks the earlier copy first: if it landed, nothing is re-signed;
 *   if not, it re-signs, and an earlier copy landing later still counts.
 */
import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setDefaultHypersnapClient, type HypersnapClient } from '@quilibrium/quorum-shared';
import { useFeedOptimisticActions } from '@/context/FeedOptimisticContext';
import * as store from '@/services/feed/optimisticFeedStore';
import { CONFIRM_POLL_MS, CONFIRM_TIMEOUT_MS } from '@/services/feed/castConfirmation';

const hashFor = (n: number) => '0x' + String(n).padStart(40, '0');

let submits = 0;
const mockSubmitCast = jest.fn(async (_input: { text: string }) => ({ hash: hashFor(++submits) }));
jest.mock('@/hooks/useFarcasterSubmitCast', () => ({
  useFarcasterSubmitCast: () => ({ submitCast: mockSubmitCast }),
}));
jest.mock('@/services/farcaster/hypersnapWrites', () => ({
  removeOwnCast: jest.fn(),
  setCastReaction: jest.fn(),
  setFollowing: jest.fn(),
}));
jest.mock('@/context/ToastContext', () => ({ useToast: () => ({ showToast: jest.fn() }) }));
const mockPrependNewest = jest.fn(async () => {});
jest.mock('@/hooks/useFarcasterFeed', () => ({
  prependNewestToFeed: (...args: unknown[]) => mockPrependNewest(...(args as [])),
}));
jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { farcaster: { fid: 42, username: 'me' }, displayName: 'Me' } }),
}));

/** Hashes Hypersnap has; any other lookup is a 404, or throws while `offline`. */
const onNetwork = new Set<string>();
let offline = false;
const mockGetCast = jest.fn(async (_fid: number, hash: string) => {
  if (offline) throw Object.assign(new Error('Network request failed'), { status: undefined });
  if (onNetwork.has(hash)) return { hash };
  throw Object.assign(new Error('Cast not found'), { status: 404 });
});

let queryClient: QueryClient;

beforeEach(() => {
  jest.useFakeTimers();
  store.__resetOptimisticFeed();
  submits = 0;
  onNetwork.clear();
  offline = false;
  mockSubmitCast.mockClear();
  mockGetCast.mockClear();
  mockPrependNewest.mockClear();
  setDefaultHypersnapClient({ getCastByHash: mockGetCast } as unknown as HypersnapClient);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

const stub = () => store.pendingTopLevel()[0];
const advance = (ms: number) => act(async () => void (await jest.advanceTimersByTimeAsync(ms)));

async function postAndAccept(result: ReturnType<typeof mount>['result']) {
  act(() => {
    result.current.postTop({ text: 'hello' });
  });
  await advance(0);
  expect(mockSubmitCast).toHaveBeenCalledTimes(1);
}

it('reads as sending until the cast is found on the network, then as sent', async () => {
  const { result } = mount();
  await postAndAccept(result);
  expect(stub()).toMatchObject({ status: 'confirming', realHash: hashFor(1) });

  await advance(CONFIRM_POLL_MS);
  expect(mockGetCast).toHaveBeenCalledWith(42, hashFor(1));
  expect(stub().status).toBe('confirming');

  expect(mockPrependNewest).not.toHaveBeenCalled();

  onNetwork.add(hashFor(1));
  await advance(CONFIRM_POLL_MS);
  expect(stub()).toMatchObject({ status: 'sent', realHash: hashFor(1) });
  expect(mockSubmitCast).toHaveBeenCalledTimes(1);

  // The feed pulls the real cast in once it's there.
  await advance(1500);
  expect(mockPrependNewest).toHaveBeenCalledWith(queryClient, 42);
});

it('fails a cast that still isn’t there after the timeout, so it can be retried', async () => {
  const { result } = mount();
  await postAndAccept(result);

  await advance(CONFIRM_TIMEOUT_MS - CONFIRM_POLL_MS);
  expect(stub().status).toBe('confirming');

  await advance(2 * CONFIRM_POLL_MS);
  expect(stub()).toMatchObject({ status: 'failed', error: "Didn't reach the network" });
});

it('never fails a cast on lookups that error, only on Hypersnap saying it isn’t there', async () => {
  const { result } = mount();
  await postAndAccept(result);

  offline = true;
  await advance(CONFIRM_TIMEOUT_MS * 2);
  expect(stub().status).toBe('confirming');

  offline = false;
  await advance(CONFIRM_POLL_MS);
  expect(stub().status).toBe('failed');
});

describe('a retry', () => {
  async function failedCast(result: ReturnType<typeof mount>['result']) {
    await postAndAccept(result);
    await advance(CONFIRM_TIMEOUT_MS + CONFIRM_POLL_MS);
    expect(stub().status).toBe('failed');
  }

  it('re-signs nothing when the earlier copy has landed since', async () => {
    const { result } = mount();
    await failedCast(result);

    onNetwork.add(hashFor(1));
    act(() => result.current.retryPending(stub().localId));
    await advance(0);

    expect(mockSubmitCast).toHaveBeenCalledTimes(1);
    expect(stub()).toMatchObject({ status: 'sent', realHash: hashFor(1) });
  });

  it('re-signs when it hasn’t, and still counts the earlier copy if that lands first', async () => {
    const { result } = mount();
    await failedCast(result);

    act(() => result.current.retryPending(stub().localId));
    await advance(0);
    expect(mockSubmitCast).toHaveBeenCalledTimes(2);
    expect(stub()).toMatchObject({ status: 'confirming', realHash: hashFor(2), priorHashes: [hashFor(1)] });

    onNetwork.add(hashFor(1));
    await advance(CONFIRM_POLL_MS);
    expect(stub()).toMatchObject({ status: 'sent', realHash: hashFor(1) });
  });

  it('doesn’t re-sign when it can’t tell whether the earlier copy landed', async () => {
    const { result } = mount();
    await failedCast(result);

    offline = true;
    act(() => result.current.retryPending(stub().localId));
    // Each attempt is queued on its own tick; after the last it's failed again.
    for (let tick = 0; tick < 5; tick++) await advance(1);

    expect(mockSubmitCast).toHaveBeenCalledTimes(1);
    expect(stub()).toMatchObject({ status: 'failed', error: "Couldn't check whether it already posted" });
  });
});
