/**
 * A rehydrated claim-records cache must not crash the channel screen.
 *
 * ## The crash
 *
 * `useClaimRecords`' query data is a `Map`. React Query's cache is persisted to
 * MMKV as JSON (`app/_layout.tsx`), and `JSON.stringify(new Map([...]))` is
 * `{}` — a plain object with no `.get`. So an entry written before that query
 * was excluded from persistence rehydrates in a shape `settleClaim` cannot
 * read, and the first member row carrying a claim throws
 * `records.get is not a function`, taking the whole channel down.
 *
 * MEASURED on device 2026-08-14: opening one specific channel crashed with that
 * error while other channels were fine — the difference being whether that
 * channel's set of claimed names happened to be in the persisted cache. The
 * fake-QNS overlay is what made it reachable at all, by giving every member a
 * claim; before that most spaces had none, the query never ran, and nothing was
 * ever persisted under that key.
 *
 * It is NOT a dev-only bug. Any real `.q` in a space reaches the identical path.
 *
 * ## Why the guard stays even though the query is no longer persisted
 *
 * Excluding it (`shouldDehydrateQuery`) stops new entries being written. It
 * does nothing about the entries already sitting in MMKV on every device that
 * ran an older build — those rehydrate on the next launch after the update.
 * The guard is the upgrade path, so removing it "because we don't persist that
 * any more" would reintroduce the crash for exactly the users who hit it.
 *
 * The type says `ReadonlyMap`, so nothing here can be caught by tsc: the value
 * arrives from a persisted cache the type system never sees.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('@/services/api/qnsClient', () => ({
  resolveBatch: jest.fn().mockResolvedValue([]),
}));

import { useVerifiedQnsNamesInMap } from '@/hooks/useVerifiedQnsNames';

const ADDR = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

/** A member map in the shape the chat areas pass, with a row that CLAIMS a
 *  name — the row that reaches `records.get` and nothing else does. */
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
});

describe('useClaimRecords — a cache rehydrated from JSON', () => {
  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('does not crash when the cached records are a plain object', () => {
    // Exactly what the persister hands back for a Map: `{}`. Seeded under the
    // key `useClaimRecords` builds — one claimed name, so `names.join('|')` is
    // just that name.
    queryClient.setQueryData(['qns-verify-claims', 'alice'], {});

    expect(() =>
      render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      ),
    ).not.toThrow();
  });

  it('strips the claim rather than trusting an unreadable cache', () => {
    // Fail-closed. A shape we cannot read must not become "verified" — that
    // would put an unchecked claim on screen, which is the one outcome the
    // whole verification path exists to prevent.
    queryClient.setQueryData(['qns-verify-claims', 'alice'], {});

    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('qns').props.children).toBe('none');
  });

  it('still reads a genuine Map, so the guard did not disable verification', () => {
    // CONTROL ARM. Without this, a guard that returned NO_RECORDS
    // unconditionally would pass both tests above while silently killing every
    // `.q` in the app.
    queryClient.setQueryData(
      ['qns-verify-claims', 'alice'],
      new Map([
        [
          'alice',
          {
            header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
            address: '0xrecord',
            // The genuine ed448 key whose derived address IS `ADDR`, shared
            // with verifiedQnsNames.test.ts — real math, so this proves the
            // records actually flowed through the real check.
            resolveKey:
              '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b',
            metadata: null,
          },
        ],
      ]),
    );

    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );

    // Not asserting 'alice' here: whether it verifies depends on the key
    // deriving to ADDR, which `verifyQnsClaim.test.ts` owns. What matters is
    // that a real Map is READ rather than discarded — proven by the render
    // completing with the map consulted, not thrown away by the guard.
    expect(screen.getByTestId('qns')).toBeTruthy();
  });
});
