/**
 * A failed REFETCH must not keep serving the last verified records.
 *
 * ## The bug this pins
 *
 * `staleTime` on the claim-records query is a SECURITY bound, not a performance
 * one: it is how long a `.q` name transferred to somebody else can still verify
 * for its previous owner. One hour, deliberately.
 *
 * React Query does not clear `data` when a query errors — its reducer spreads
 * the previous state and only flips `status`. So once a name set has resolved
 * successfully, a failed refetch leaves the last successful `Map` in place and
 * `data instanceof Map` stays true. Reading `data` alone therefore serves the
 * stale, still-verifying records for as long as refetches keep failing, which
 * removes the bound entirely — the previous owner keeps rendering the name with
 * no upper limit, and (with `retry: false` and no logging on that path) nothing
 * anywhere records that it is happening.
 *
 * This was introduced, not inherited. The previous implementation caught
 * resolver errors and returned an empty `Map`, which RESOLVED — so React Query
 * replaced the cache with it and the path failed closed by accident. Changing it
 * to reject is correct (a resolved empty map is cached as a success, pinning
 * "nobody owns anything" for the full hour after one blip), but on its own it
 * flipped this case from fail-closed to fail-OPEN. Both halves have to hold.
 *
 * MEASURED 2026-08-17, same probe against both implementations: after a failed
 * refetch the records map retained `size = 1` on the rejecting version and
 * `size = 0` on the swallowing one.
 *
 * ## Why this asserts on the rendered name
 *
 * The cache is the mechanism; what a viewer sees is the property. Asserting on
 * the rendered text is what makes this a test of the security outcome rather
 * than of React Query's internals, which are free to change.
 *
 * `waitFor` rather than a bare read: the value settles a tick after the query
 * state changes, and reading synchronously makes this flaky in BOTH directions —
 * it reported a false pass during development before the retry was added.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockResolveBatch = jest.fn();
jest.mock('@/services/api/qnsClient', () => ({
  resolveBatch: (names: string[]) => mockResolveBatch(names),
}));

import { useVerifiedQnsNamesInMap } from '@/hooks/useVerifiedQnsNames';

/** Invented ed448-shaped public key (57 bytes), and the address it derives to.
 *  Not anyone's real key — same fixture as `verifyQnsClaim.test.ts`. */
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
const ADDR = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';

/** The record `/resolve/batch` returns for a name this address genuinely owns. */
const RECORD = {
  header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
  address: '0xsomethingelse',
  resolveKey: KEY,
  metadata: null,
};

const MEMBERS = {
  [ADDR]: { address: ADDR, display_name: 'Alice', primary_username: 'alice' },
};

function Probe() {
  const settled = useVerifiedQnsNamesInMap(MEMBERS);
  return <Text testID="qns">{settled[ADDR]?.primary_username ?? 'none'}</Text>;
}

let queryClient: QueryClient;

afterEach(() => {
  cleanup();
  queryClient.clear();
  mockResolveBatch.mockReset();
});

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

const renderProbe = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  );

/** Refetch inside `act`, so the resulting state update flushes before we look. */
const refetch = async () => {
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: ['qns-verify-claims'] });
  });
};

describe('useClaimRecords — a refetch that fails', () => {
  it('stops verifying, rather than serving the last good records forever', async () => {
    mockResolveBatch.mockResolvedValueOnce([RECORD]);
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('alice'));

    // The name is transferred away, and the refetch that would have noticed
    // fails. The suffix must drop; it must not survive on the strength of a
    // lookup that succeeded before the transfer.
    mockResolveBatch.mockRejectedValue(new Error('offline'));
    await refetch();

    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('none'));
  });

  it('recovers on the next successful refetch', async () => {
    // The whole argument for rejecting instead of caching an empty result is
    // that recovery is fast. If a failure left the query permanently unable to
    // verify, this fix would have traded one silent bug for another.
    mockResolveBatch.mockResolvedValueOnce([RECORD]);
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('alice'));

    mockResolveBatch.mockRejectedValueOnce(new Error('offline'));
    await refetch();
    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('none'));

    mockResolveBatch.mockResolvedValue([RECORD]);
    await refetch();
    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('alice'));
  });

  it('CONTROL: a verified name renders while nothing is failing', async () => {
    // Without this arm, a hook hard-wired to return NO_RECORDS would pass the
    // test above while having disabled verification entirely.
    mockResolveBatch.mockResolvedValue([RECORD]);
    renderProbe();

    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('alice'));
  });
});
