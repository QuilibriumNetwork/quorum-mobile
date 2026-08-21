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
 * successfully, a failed refetch leaves the last successful records in place and
 * a shape check on them still passes. Reading `data` alone therefore serves the
 * stale, still-verifying records for as long as refetches keep failing, which
 * removes the bound entirely — the previous owner keeps rendering the name with
 * no upper limit, and (with `retry: false` and no logging on that path) nothing
 * anywhere records that it is happening.
 *
 * This was introduced, not inherited. An earlier implementation caught resolver
 * errors and returned an empty result, which RESOLVED — so React Query replaced
 * the cache with it and the path failed closed by accident. Changing it to
 * reject is correct (a resolved empty result is cached as a success, pinning
 * "nobody owns anything" for the full hour after one blip), but on its own it
 * flipped this case from fail-closed to fail-OPEN. Both halves have to hold.
 *
 * MEASURED 2026-08-17, same probe against both implementations: after a failed
 * refetch the records retained the one verifying entry on the rejecting version
 * and none on the swallowing one.
 *
 * The container has since changed from a `Map` to the plain object shared's
 * `resolveNamesBatch` returns. That moved which line does the shape check, and
 * nothing about what this file pins — `status` is still the gate, and these
 * assertions are on the rendered name, not on the cache.
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

const mockResolveClaimedNames = jest.fn();
jest.mock('@/services/api/qnsClient', () => ({
  resolveClaimedNames: (names: string[]) => mockResolveClaimedNames(names),
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

/** A successful answer: the record keyed by the name it is for, which is the
 *  shape `resolveNamesBatch` returns. */
const RECORDS = { alice: RECORD };

const MEMBERS = {
  [ADDR]: { address: ADDR, display_name: 'Alice', primary_username: 'alice' },
};

/** A second claimant, so a WIDENING claim set can be simulated. Owns nothing. */
const OTHER_ADDR = 'QmThemThemThemThemThemThemThemThemThemThemThem';
const TWO_MEMBERS = {
  ...MEMBERS,
  [OTHER_ADDR]: { address: OTHER_ADDR, display_name: 'Bob', primary_username: 'bob' },
};

function Probe({ members = MEMBERS }: { members?: typeof MEMBERS }) {
  const settled = useVerifiedQnsNamesInMap(members);
  return <Text testID="qns">{settled[ADDR]?.primary_username ?? 'none'}</Text>;
}

let queryClient: QueryClient;

afterEach(() => {
  cleanup();
  queryClient.clear();
  mockResolveClaimedNames.mockReset();
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
    mockResolveClaimedNames.mockResolvedValueOnce(RECORDS);
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('alice'));

    // The name is transferred away, and the refetch that would have noticed
    // fails. The suffix must drop; it must not survive on the strength of a
    // lookup that succeeded before the transfer.
    mockResolveClaimedNames.mockRejectedValue(new Error('offline'));
    await refetch();

    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('none'));
  });

  it('recovers on the next successful refetch', async () => {
    // The whole argument for rejecting instead of caching an empty result is
    // that recovery is fast. If a failure left the query permanently unable to
    // verify, this fix would have traded one silent bug for another.
    mockResolveClaimedNames.mockResolvedValueOnce(RECORDS);
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('alice'));

    mockResolveClaimedNames.mockRejectedValueOnce(new Error('offline'));
    await refetch();
    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('none'));

    mockResolveClaimedNames.mockResolvedValue(RECORDS);
    await refetch();
    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('alice'));
  });

  it('CONTROL: a verified name renders while nothing is failing', async () => {
    // Without this arm, a hook hard-wired to return NO_RECORDS would pass the
    // test above while having disabled verification entirely.
    mockResolveClaimedNames.mockResolvedValue(RECORDS);
    renderProbe();

    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('alice'));
  });

  it('does not resurrect stale records when the set widens AFTER a failure', async () => {
    // The hole the original fix left open, found on the desktop side and
    // checked here because the two hooks are the same shape.
    //
    // React Query picks a query's `placeholderData` source by "last query that
    // had defined data", and an ERRORED query still qualifies — the error
    // reducer never clears `data`. It then reports the carried value as
    // `status: 'success'`, so the status gate passes it. One new claimant is
    // therefore enough to bring back a map that had correctly stopped
    // verifying, through a query that has verified nothing.
    //
    // Routine rather than exotic: scrolling a channel adds claimants one at a
    // time, and that is exactly what changes the query key. With `retry: false`
    // the errored query never re-attempts, so the resurrected answer never
    // expires on its own.
    mockResolveClaimedNames.mockResolvedValueOnce(RECORDS);
    const view = renderProbe();
    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('alice'));

    mockResolveClaimedNames.mockRejectedValue(new Error('offline'));
    await refetch();
    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('none'));

    // The widened lookup never settles, so anything rendering `alice` below is
    // stale by construction — nothing could have re-verified it.
    mockResolveClaimedNames.mockImplementation(() => new Promise(() => {}));
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <Probe members={TWO_MEMBERS} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(mockResolveClaimedNames).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId('qns').props.children).toBe('none');
  });

  it('CONTROL: a widening claim set still carries a HEALTHY previous answer', async () => {
    // The opposite over-correction. Carrying the previous map across a widening
    // set is what stops every name on screen flickering whenever a new claimant
    // appears, and it must survive the fix above. Without this arm, disabling
    // `placeholderData` outright would look like a clean pass.
    mockResolveClaimedNames.mockResolvedValueOnce(RECORDS);
    const view = renderProbe();
    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('alice'));

    mockResolveClaimedNames.mockImplementation(() => new Promise(() => {}));
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <Probe members={TWO_MEMBERS} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(mockResolveClaimedNames).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('qns').props.children).toBe('alice');
  });
});
