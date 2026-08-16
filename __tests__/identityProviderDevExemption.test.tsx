/**
 * The fake-QNS overlay's exemption, exercised through the real provider.
 *
 * ## Why this test exists
 *
 * `fakeQns.test.ts` pins the overlay's own logic, and `isFakeClaimFor` passed
 * every one of its tests the whole time the instrument was dead in the app.
 * The break was a WIRING break: verification moved into
 * `IdentityScopeProvider`, and the exemption stayed threaded into
 * `stripUnverifiedNames*` — the path the provider replaced. Both halves kept
 * their own tests green while every synthesized `.q` was stripped before it
 * could reach the ladder.
 *
 * The failure mode is what makes this worth a test: the app renders exactly as
 * it did before the overlay existed, with no error anywhere, so the operator
 * doing the manual sweep reads "no surface shows a `.q`" as a finding about the
 * FEATURE. It cost a full manual pass to discover. An instrument that fails
 * silently is worse than no instrument, because it manufactures a confident
 * wrong answer.
 *
 * ## The two control arms are the point
 *
 * A test that only asserted "the fake name verifies" would also pass if the
 * exemption were a global verification-off switch — which would hide the one
 * case the sweep exists to observe (a REAL claim still facing the real check)
 * and would be a security defect if it ever escaped `__DEV__`. So:
 *
 *  - a claim the overlay did NOT synthesize must still be rejected while the
 *    overlay is on, and
 *  - the synthesized claim must be rejected when the overlay is off, which is
 *    the production configuration.
 */
import React from 'react';
import { Text } from 'react-native';
import { screen, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';

jest.mock('react-native-mmkv', () => ({
  createMMKV: ({ id }: { id: string }) => {
    const stores = ((globalThis as Record<string, unknown>).__mmkv ??= new Map()) as Map<
      string,
      Map<string, string>
    >;
    if (!stores.has(id)) stores.set(id, new Map());
    const store = stores.get(id)!;
    return {
      getString: (k: string) => store.get(k),
      set: (k: string, v: string) => store.set(k, v),
      remove: (k: string) => store.delete(k),
      getAllKeys: () => Array.from(store.keys()),
      clearAll: () => store.clear(),
      contains: (k: string) => store.has(k),
    };
  },
}));

const ADDRESS = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';

let mockGetPublicProfile: jest.Mock;
let mockResolveBatch: jest.Mock;

jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    getPublicProfile: (address: string) => mockGetPublicProfile(address),
  }),
}));

jest.mock('@/services/api/qnsClient', () => ({
  resolveBatch: (names: string[]) => mockResolveBatch(names),
}));

import { IdentityScopeProvider, useIdentityContext } from '@/identity/identityProvider';
import { clearFakeQns, deriveFakeQName, setFakeQnsState } from '@/services/dev/fakeQns';

/** What `applyFakeQns` hands back for an address with no real profile: the
 *  synthesized `.q`, and an empty display name because there was none. */
const overlayProfile = (primary_username: string) => ({
  display_name: '',
  profile_image: '',
  bio: '',
  primary_username,
  timestamp: 1,
  signature: '',
});

function VerifiedQnsProbe({ address }: { address: string }) {
  const { sources } = useIdentityContext();
  return <Text testID="verified">{sources.verifiedQnsNames[address] ?? ''}</Text>;
}

let queryClient: QueryClient;

function renderProvider(selfAddress: string) {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={{}} selfAddress={selfAddress}>
        <VerifiedQnsProbe address={selfAddress} />
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );
}

describe('IdentityScopeProvider — fake-QNS exemption wiring', () => {
  beforeEach(() => {
    clearFakeQns();
    mockGetPublicProfile = jest.fn();
    // No real QNS record for anything here: a synthesized name is registered
    // nowhere, so this is what the resolver genuinely returns for one.
    mockResolveBatch = jest.fn().mockResolvedValue([]);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    // cleanup() before clear() — see identityProviderVerification.test.tsx for
    // why this order matters with RTL's outer auto-cleanup.
    cleanup();
    queryClient.clear();
    clearFakeQns();
  });

  it('lets a name the overlay synthesized reach the verified tier', async () => {
    const faked = deriveFakeQName(ADDRESS);
    setFakeQnsState({ enabled: true, giveEveryoneAName: true });
    mockGetPublicProfile.mockResolvedValue(overlayProfile(faked));

    renderProvider(ADDRESS);

    await waitFor(() => expect(screen.getByTestId('verified').props.children).toBe(faked));
  });

  it('still rejects a claim the overlay did NOT synthesize, while it is on', async () => {
    // CONTROL ARM. The exemption is per-name, not a verification-off switch:
    // a real (or impersonated) claim must keep facing the genuine check even
    // during a sweep, or the sweep hides the case it exists to watch.
    setFakeQnsState({ enabled: true, giveEveryoneAName: true });
    mockGetPublicProfile.mockResolvedValue(overlayProfile('notsynthesized'));

    renderProvider(ADDRESS);

    await waitFor(() => expect(mockResolveBatch).toHaveBeenCalled());
    expect(screen.getByTestId('verified').props.children).toBe('');
  });

  it('rejects the synthesized name when the overlay is OFF (production shape)', async () => {
    // CONTROL ARM. Proves the pass above comes from the overlay's state and
    // not from the provider having gone permissive. `enabled: false` is the
    // only configuration a shipped build can be in.
    const faked = deriveFakeQName(ADDRESS);
    setFakeQnsState({ enabled: false, giveEveryoneAName: true });
    mockGetPublicProfile.mockResolvedValue(overlayProfile(faked));

    renderProvider(ADDRESS);

    await waitFor(() => expect(mockResolveBatch).toHaveBeenCalled());
    expect(screen.getByTestId('verified').props.children).toBe('');
  });
});
