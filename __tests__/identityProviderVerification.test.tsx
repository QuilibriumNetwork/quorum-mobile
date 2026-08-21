/**
 * Claim verification, exercised through the real provider rather than read
 * off the source.
 *
 * `verifyQnsClaim.test.ts` pins the predicate in isolation, and
 * `verifiedQnsNames.test.ts` pins the strip/promote logic that runs it. Ne
 * ither one MOUNTS `IdentityScopeProvider`, so neither could catch a wiring
 * bug where the provider fetches a profile, sees a claim, and never actually
 * calls the predicate against it — the most security-critical path in the
 * task would ship with nothing that could fail if that wiring broke. Reading
 * the code is not verification.
 *
 * This renders the provider for real, mocks its two network seams (the
 * public-profile fetch and the QNS batch resolver), and asserts on what
 * lands in `sources.verifiedQnsNames` — the only route to a `.q` tier
 * anywhere downstream, per `identityFromMaps`.
 */
import React from 'react';
import { Text } from 'react-native';
import { screen, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';

// A genuine ed448 key/address pair, shared with verifiedQnsNames.test.ts:
// `deriveAddress(KEY) === ADDRESS`, and never anything else. Real math, not a
// placeholder — the negative case below depends on the derivation genuinely
// disagreeing with the impersonator's address.
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
const ADDRESS = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const OTHER = 'QmThemThemThemThemThemThemThemThemThemThemThem';

// `mock`-prefixed so the jest.mock factories below (hoisted above these
// declarations) are allowed to close over them — same convention as
// shareInviteSheetName.test.tsx. Both are only read inside a NESTED function
// that runs later, when the provider actually calls it, by which point
// `beforeEach` has already assigned a fresh jest.fn().
let mockGetPublicProfile: jest.Mock;
let mockResolveClaimedNames: jest.Mock;

jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    getPublicProfile: (address: string) => mockGetPublicProfile(address),
  }),
}));

jest.mock('@/services/api/qnsClient', () => ({
  resolveClaimedNames: (names: string[]) => mockResolveClaimedNames(names),
}));

import { IdentityScopeProvider, useIdentityContext } from '@/identity/identityProvider';

const publicProfile = (over: Record<string, unknown> = {}) => ({
  display_name: 'Claimant',
  profile_image: '',
  bio: '',
  timestamp: 0,
  signature: '',
  ...over,
});

const nameRecord = (over: Record<string, unknown> = {}) => ({
  header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
  address: '0xrecord',
  resolveKey: KEY,
  metadata: null,
  ...over,
});

function VerifiedQnsProbe({ address }: { address: string }) {
  const { sources } = useIdentityContext();
  return <Text testID="verified">{sources.verifiedQnsNames[address] ?? ''}</Text>;
}

// Module-scoped rather than local to `renderProvider`, so `afterEach` can
// reach the SAME instance to clear it. The provider's queries use a 24h
// `gcTime`, which schedules a real (non-`unref`'d) Node timer once a query's
// last observer unmounts; clearing it here is good hygiene even though it
// does not fully silence Jest's "did not exit" notice in this environment
// (see the afterEach below).
let queryClient: QueryClient;

function renderProvider(selfAddress: string) {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      {/* selfAddress alone is enough to trigger a fetch: the provider
          requests it on mount via its own effect, so the test does not need
          to reach into `request()` directly. */}
      <IdentityScopeProvider rostersBySpace={{}} selfAddress={selfAddress}>
        <VerifiedQnsProbe address={selfAddress} />
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );
}

describe('IdentityScopeProvider — claim verification (SECURITY)', () => {
  beforeEach(() => {
    mockGetPublicProfile = jest.fn();
    mockResolveClaimedNames = jest.fn();
    // Fresh client per test: nothing here should share cache across tests.
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    // `cleanup()` first, so the tree unmounts and each query's last observer
    // drops before `clear()` destroys the cache — RTL's own auto-cleanup runs
    // in an OUTER, later-firing afterEach (the opposite order), so without
    // this the cache would still be clearing a mounted tree.
    //
    // This does not make the suite fully silent, and that is a known,
    // pre-existing property of this test environment rather than a defect in
    // this file: MEASURED with a throwaway test mounting nothing but a bare
    // `useQuery` in a fresh `QueryClient` (no mocks, no provider code from
    // this repo at all), which reproduced the identical "Jest did not exit"
    // notice for a single-file run. Confirmed harmless for the actual gate —
    // `npx jest` (whole suite) exits 0, because Jest force-exits whichever
    // worker is left holding the handle; only a SOLO invocation of this file
    // has no worker to do that and must be killed externally (e.g. `timeout`
    // when iterating locally).
    cleanup();
    queryClient.clear();
  });

  it('verifies a claim that resolves back to the claiming address', async () => {
    mockGetPublicProfile.mockResolvedValue(publicProfile({ primary_username: 'alice' }));
    mockResolveClaimedNames.mockResolvedValue({
      alice: nameRecord(),
    });

    renderProvider(ADDRESS);

    await waitFor(() => expect(screen.getByTestId('verified').props.children).toBe('alice'));
  });

  it('never verifies a claim that resolves to a DIFFERENT address (impersonation)', async () => {
    // OTHER claims 'alice', but the resolver's record for 'alice' derives back
    // to ADDRESS, not OTHER. This is the forgery the whole feature exists to
    // catch: withholding a `.q` from its rightful owner is invisible and
    // self-correcting, but granting one to an impersonator is not.
    mockGetPublicProfile.mockResolvedValue(publicProfile({ primary_username: 'alice' }));
    mockResolveClaimedNames.mockResolvedValue({
      alice: nameRecord(),
    });

    renderProvider(OTHER);

    await waitFor(() => expect(mockResolveClaimedNames).toHaveBeenCalled());
    expect(screen.getByTestId('verified').props.children).toBe('');
  });

  it('leaves a claim unverified while its lookup is still in flight', async () => {
    // Unproven includes NOT-YET-KNOWN. A `.q` shown for even the instant
    // before a lookup lands is the whole attack, because a screenshot of
    // that instant does not expire.
    mockGetPublicProfile.mockResolvedValue(publicProfile({ primary_username: 'alice' }));
    let releaseBatch: (records: Record<string, unknown>) => void = () => {};
    mockResolveClaimedNames.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseBatch = resolve;
        }),
    );

    renderProvider(ADDRESS);

    await waitFor(() => expect(mockResolveClaimedNames).toHaveBeenCalled());
    expect(screen.getByTestId('verified').props.children).toBe('');

    // Prove the pending state was genuinely pending, not permanently broken:
    // releasing the SAME lookup lets the SAME claim verify afterwards.
    releaseBatch({ alice: nameRecord() });
    await waitFor(() => expect(screen.getByTestId('verified').props.children).toBe('alice'));
  });
});
