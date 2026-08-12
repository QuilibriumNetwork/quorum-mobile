/**
 * A component rendered with no provider of its own still resolves.
 *
 * This is the crash class desktop shipped: providers mounted surface by
 * surface, so an app-level modal host sat outside all of them and threw. The
 * root scope is what makes that unrepresentable.
 */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import { MemberName } from '@/identity/MemberName';

const ADDR = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

// IdentityScopeProvider calls useQueries unconditionally, so every mount
// needs a QueryClient ancestor — same fresh-client-per-test shape as
// memberName.test.tsx and identityProviderVerification.test.tsx.
let queryClient: QueryClient;

describe('the root identity scope', () => {
  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it('resolves a member for a descendant that mounts no provider of its own', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <IdentityScopeProvider
          rostersBySpace={{ 'space-1': { [ADDR]: { global_display_name: 'Alice' } } }}
          selfAddress={null}
        >
          <MemberName address={ADDR} spaceId="space-1" />
        </IdentityScopeProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Alice')).toBeTruthy();
  });

  it('does not leak a per-space nickname into a DM-shaped resolution', () => {
    // defaultSpaceId is NOT merged. The root carries every space's rosters, so
    // without that rule a DM would inherit a nickname from an unrelated space —
    // invisible to anyone who has never set one, which is most testing.
    render(
      <QueryClientProvider client={queryClient}>
        <IdentityScopeProvider
          rostersBySpace={{ 'space-1': { [ADDR]: { display_name: 'Mod Alice', global_display_name: 'Alice' } } }}
          selfAddress={null}
          locallyKnownNames={{ [ADDR]: 'Alice' }}
        >
          <MemberName address={ADDR} />
        </IdentityScopeProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.queryByText('Mod Alice')).toBeNull();
  });
});
