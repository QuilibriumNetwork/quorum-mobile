/**
 * `useMultiSpaceRosters` is the MMKV-read -> `RosterNameRow` mapping that
 * feeds `RootIdentityScope` real data instead of empty maps.
 * `rootIdentityScope.test.tsx` and `rootIdentityScopeWiring.test.tsx` pin the
 * ladder ABOVE this hook, mocking it or the provider it feeds — neither one
 * exercises the hook's own mapping, its empty-map-for-an-unresolved-space
 * contract, or its `spaceIds` dedup/sort. This file is that coverage.
 */
import React from 'react';
import { renderHook, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMultiSpaceRosters } from '@/hooks/useMultiSpaceRosters';

const ADDR = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

let mockGetSpaceMembers: jest.Mock;

jest.mock('@/services/storage/mmkvAdapter', () => ({
  getMMKVAdapter: () => ({
    getSpaceMembers: (spaceId: string) => mockGetSpaceMembers(spaceId),
  }),
}));

let queryClient: QueryClient;

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useMultiSpaceRosters', () => {
  beforeEach(() => {
    mockGetSpaceMembers = jest.fn();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it('maps a roster row to its RosterNameRow, and skips a row with no address', async () => {
    mockGetSpaceMembers.mockResolvedValue([
      { address: ADDR, display_name: 'Mod Alice', global_display_name: 'Alice' },
      { display_name: 'No Address' },
    ]);

    const { result } = renderHook(() => useMultiSpaceRosters(['space-1']), { wrapper });

    await waitFor(() => expect(result.current['space-1'][ADDR]).toBeDefined());
    expect(result.current['space-1']).toEqual({
      [ADDR]: { display_name: 'Mod Alice', global_display_name: 'Alice' },
    });
  });

  it('an unresolved space contributes {} and is present as a key, not absent', async () => {
    let releaseMembers: (rows: unknown[]) => void = () => {};
    mockGetSpaceMembers.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseMembers = resolve;
        }),
    );

    const { result } = renderHook(() => useMultiSpaceRosters(['space-1']), { wrapper });

    // Before the MMKV read resolves, the space must already be a KEY with an
    // empty object — the property mergeRostersBySpace relies on to merge per
    // address instead of blanking an ancestor's already-loaded rows.
    expect('space-1' in result.current).toBe(true);
    expect(result.current['space-1']).toEqual({});

    // Prove the pending state was genuinely pending, not permanently stuck:
    // the same space resolves once its read lands.
    releaseMembers([{ address: ADDR, global_display_name: 'Alice' }]);
    await waitFor(() => expect(result.current['space-1'][ADDR]).toBeDefined());
  });

  it('dedupes and sorts spaceIds, and drops a falsy id', () => {
    mockGetSpaceMembers.mockResolvedValue([]);
    // react-query's own QueriesObserver silently de-dupes identical
    // queryKeys (with a console.warn), so a call-count assertion alone
    // cannot tell OUR dedup apart from that safety net. The warning IS the
    // observable signal that a duplicate queryKey reached `useQueries` in
    // the first place — asserting its absence is what actually pins that
    // `ids` was deduped before the query config was built.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useMultiSpaceRosters(['b', 'a', 'a', '', 'c']), {
      wrapper,
    });

    // Sorted order, no key for the falsy id.
    expect(Object.keys(result.current)).toEqual(['a', 'b', 'c']);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
