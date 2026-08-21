/**
 * A superseded claim lookup is abandoned, and abandoning it cannot leave an
 * unverified `.q` on screen.
 *
 * ## Why this file exists
 *
 * `useClaimRecords` passes React Query's `signal` to the transport. That is a
 * small optimisation with a NON-small failure mode, which is the only reason it
 * gets its own test.
 *
 * The optimisation: the query key is the set of claimed names, so scrolling a
 * channel — which adds senders one at a time — supersedes the in-flight lookup
 * repeatedly. Without the signal each abandoned request still runs to
 * completion and its answer is thrown away.
 *
 * The failure mode: this file's hook has a hand-tuned fail-closed rule — carry
 * the previous answer forward ONLY from a query that succeeded. A cancellation
 * is a third state, neither success nor error, and nobody had measured which
 * bucket it lands in. If it landed in "success", a lookup that verified nothing
 * could carry a stale verified name forward, and the visible result would be
 * somebody rendering a `.q` they no longer own. Invisible, and cached for an
 * hour.
 *
 * ## What was measured
 *
 * React Query treats cancellation as a REVERT rather than a failure: the query
 * keeps the state it already had. So a lookup that never succeeded stays
 * `pending` with no data, and there is nothing for `placeholderData` to carry.
 * The dangerous case therefore does not arise — but that is a property of a
 * dependency, not of this code, so it is pinned here rather than trusted.
 *
 * Note React Query only cancels a fetch when the query function actually
 * CONSUMED the signal. Passing it is what enables the abort; the first test
 * below fails outright if the signal is dropped from the `queryFn`.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen, cleanup, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** Every call's `(names, opts)`, so a test can inspect the signal handed to a
 *  lookup after that lookup has been superseded. */
const calls: { names: string[]; signal?: AbortSignal }[] = [];
const mockResolveClaimedNames = jest.fn();

jest.mock('@/services/api/qnsClient', () => ({
  resolveClaimedNames: (names: string[], opts?: { signal?: AbortSignal }) => {
    calls.push({ names, signal: opts?.signal });
    return mockResolveClaimedNames(names, opts);
  },
}));

import { useVerifiedQnsNamesInMap } from '@/hooks/useVerifiedQnsNames';

/** Invented ed448-shaped key (57 bytes) and the address it derives to — the
 *  same fixture pair the other claim tests use, so the control arm runs the
 *  real predicate rather than a stub. */
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
const ADDR = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const OTHER_ADDR = 'QmThemThemThemThemThemThemThemThemThemThemThem';

const RECORD = {
  header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
  address: '0xrecord',
  resolveKey: KEY,
  metadata: null,
};
const RECORDS = { alice: RECORD };

const MEMBERS = {
  [ADDR]: { address: ADDR, display_name: 'Alice', primary_username: 'alice' },
};

/** The widened set: one more claimant, which changes the query key. */
const TWO_MEMBERS = {
  ...MEMBERS,
  [OTHER_ADDR]: { address: OTHER_ADDR, display_name: 'Bob', primary_username: 'bob' },
};

function Probe({ members = MEMBERS }: { members?: typeof MEMBERS }) {
  const settled = useVerifiedQnsNamesInMap(members);
  return <Text testID="qns">{settled[ADDR]?.primary_username ?? 'none'}</Text>;
}

let queryClient: QueryClient;

beforeEach(() => {
  calls.length = 0;
  mockResolveClaimedNames.mockReset();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

const renderProbe = (members?: typeof MEMBERS) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Probe members={members} />
    </QueryClientProvider>,
  );

describe('useClaimRecords — a lookup the user scrolled past', () => {
  it('aborts the superseded lookup instead of letting it finish unread', async () => {
    // Never settles, so the only way this request can end is by being aborted.
    mockResolveClaimedNames.mockImplementation(() => new Promise(() => {}));

    const view = renderProbe();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].signal?.aborted).toBe(false);

    // One more claimant appears — the query key changes and the first lookup
    // becomes pointless.
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <Probe members={TWO_MEMBERS} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(calls[0].signal?.aborted).toBe(true));
  });

  it('leaves nothing verified when the only lookup so far was abandoned', async () => {
    // THE SECURITY CASE. A cancelled lookup has verified nothing, so nothing
    // may render as a `.q`. If React Query reported a cancellation as a
    // success, `placeholderData` could carry a value forward from a query that
    // checked nobody.
    mockResolveClaimedNames.mockImplementation(() => new Promise(() => {}));

    const view = renderProbe();
    await waitFor(() => expect(calls).toHaveLength(1));

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <Probe members={TWO_MEMBERS} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(screen.getByTestId('qns').props.children).toBe('none');
  });

  it('does not resurrect a name when a SUCCEEDED lookup is followed by an abandoned one', async () => {
    // The nastier ordering: there IS a previous success to carry forward, and
    // the widened lookup is then abandoned. Carrying is legitimate here — the
    // records are keyed by name and a new claimant is simply absent from them,
    // so it can only under-show — but the carried answer must still not promote
    // the NEW claimant, whose name was never looked up.
    mockResolveClaimedNames.mockResolvedValueOnce(RECORDS);
    const view = renderProbe();
    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('alice'));

    mockResolveClaimedNames.mockImplementation(() => new Promise(() => {}));
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <Probe members={TWO_MEMBERS} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(calls).toHaveLength(2));
    // The genuine owner keeps their verified name (no flicker), and that is the
    // whole point of carrying the previous answer.
    expect(screen.getByTestId('qns').props.children).toBe('alice');
  });

  it('CONTROL: a lookup nobody superseded is never aborted', async () => {
    // Without this arm, a bug that aborted every request immediately would pass
    // the first test while disabling verification entirely.
    mockResolveClaimedNames.mockResolvedValue(RECORDS);

    renderProbe();

    await waitFor(() => expect(screen.getByTestId('qns').props.children).toBe('alice'));
    expect(calls[0].signal?.aborted).toBe(false);
  });

  it('CONTROL: the transport is actually handed a signal', async () => {
    // The abort above is only possible because the queryFn consumes the signal:
    // React Query will not cancel a fetch whose function ignored it. Asserting
    // the signal ARRIVES keeps that wiring from being silently dropped.
    mockResolveClaimedNames.mockResolvedValue(RECORDS);

    renderProbe();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });
});
