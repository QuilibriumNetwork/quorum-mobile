/**
 * <MemberName> is the only name-rendering API, and it owns the `.q`.
 *
 * NOTE ON WHAT THIS CANNOT SEE: this test mounts its own provider with its own
 * data, so it proves the component resolves correctly GIVEN a provider. It is
 * blind to whether the real tree mounts a provider above this component at all,
 * which is a different bug class that shipped eight times on desktop with a
 * green suite. Task 11 covers that; do not read this file as coverage of it.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import { MemberName } from '@/identity/MemberName';

const ADDR = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

// `IdentityScopeProvider` calls `useQueries` unconditionally (it has to: the
// hook count cannot depend on whether anything was ever `request()`-ed), so
// every mount needs a QueryClient ancestor even though none of the cases below
// ever call `request`. Same fresh-client-per-test shape as
// identityProviderVerification.test.tsx.
let queryClient: QueryClient;

const wrap = (ui: React.ReactNode, sources: {
  rosters?: Record<string, Record<string, { display_name?: string; global_display_name?: string }>>;
  local?: Record<string, string>;
  spaceId?: string;
}) =>
  render(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider
        spaceId={sources.spaceId}
        rostersBySpace={sources.rosters ?? {}}
        selfAddress={null}
        locallyKnownNames={sources.local ?? {}}
      >
        {ui}
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );

describe('MemberName', () => {
  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it('renders a deliberate per-space nickname with no .q', () => {
    wrap(<MemberName address={ADDR} />, {
      spaceId: 'space-1',
      rosters: { 'space-1': { [ADDR]: { display_name: 'Mod Alice', global_display_name: 'Alice' } } },
    });
    expect(screen.getByText('Mod Alice')).toBeTruthy();
    expect(screen.queryByText(/\.q/)).toBeNull();
  });

  it('renders a locally-known DM name rather than an address', () => {
    // Design constraint 5: a DM partner who never published a profile must
    // still render as a name, from local data, with no fetch.
    wrap(<MemberName address={ADDR} />, { local: { [ADDR]: 'Alice' } });
    expect(screen.getByText('Alice')).toBeTruthy();
  });

  it('falls back to a truncated address when nothing knows the member', () => {
    wrap(<MemberName address={ADDR} />, {});
    expect(screen.getByText(/Qm/)).toBeTruthy();
  });

  it('never renders a .q from an unverified claim', () => {
    // There is no way to inject one: the provider only writes verifiedQnsNames
    // after a claim resolves back to its address, and nothing else feeds that
    // tier. This asserts the absence rather than a mechanism, deliberately.
    wrap(<MemberName address={ADDR} />, { local: { [ADDR]: 'Alice' } });
    expect(screen.queryByText(/\.q/)).toBeNull();
  });
});
