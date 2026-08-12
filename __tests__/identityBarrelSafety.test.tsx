/**
 * `identity/index.ts` is meant to be the ONLY public entry point into the
 * identity module — every future call site imports from `@/identity`, not
 * from an internal file. That makes THIS barrel's own import graph load-
 * bearing: anything it transitively pulls in loads for every one of those
 * ~26 future call sites' render tests, whether or not that surface has
 * anything to do with the thing pulled in.
 *
 * `RootIdentityScope` (re-exported here) previously imported `useAuth` from
 * the `@/context` barrel and `useSpaces` from the `@/hooks/chat` barrel.
 * Both of those barrels transitively value-import `react-native-webrtc` (via
 * `CallProvider`/`SpaceCallProvider`, and via several `hooks/chat/*` modules
 * that themselves import `@/context`), which throws a native
 * `NativeEventEmitter` invariant under jest with no mock — the exact hazard
 * `RootIdentityScope` was extracted out of `app/_layout.tsx` to avoid, one
 * module further up. This test is the instrument that would have caught it:
 * it exercises `@/identity` the way every future call site will.
 */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemberName, IdentityScopeProvider } from '@/identity';

const ADDR = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

let queryClient: QueryClient;

describe('the @/identity barrel', () => {
  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it('imports and renders through the barrel, with no native module reached at import time', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <IdentityScopeProvider
          rostersBySpace={{}}
          selfAddress={null}
          locallyKnownNames={{ [ADDR]: 'Alice' }}
        >
          <MemberName address={ADDR} />
        </IdentityScopeProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Alice')).toBeTruthy();
  });
});
