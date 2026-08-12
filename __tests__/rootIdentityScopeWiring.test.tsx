/**
 * `RootIdentityScope` is the concrete component mounted in `app/_layout.tsx`.
 * `rootIdentityScope.test.tsx` pins `IdentityScopeProvider`/`MemberName`
 * directly with hand-built fixtures — it never imports `RootIdentityScope`
 * or `useMultiSpaceRosters`, so it cannot catch a wiring regression: auth,
 * spaces or rosters silently not reaching the provider, or a future refactor
 * that re-nests `RootIdentityScope` inside one of the app-level overlays
 * instead of wrapping all three as siblings — the exact shape of bug desktop
 * shipped, which is why this component exists. This file pins the WIRING
 * itself: that `RootIdentityScope`, given real hook data, produces a working
 * ladder for a descendant that mounts no provider of its own.
 *
 * `RootIdentityScope` lives in `identity/RootIdentityScope.tsx` rather than
 * inline in `app/_layout.tsx` specifically so it CAN be imported here:
 * importing `app/_layout.tsx` pulls in `components/Call` -> `react-native-webrtc`,
 * which throws `NativeEventEmitter requires a non-null argument` under jest.
 */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const ADDR = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const SELF_ADDR = 'QmMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMe';

type MockUser = { address: string; displayName?: string } | null;
let mockUser: MockUser;
let mockSpaces: Array<{ spaceId: string }>;
let mockRosters: Record<string, Record<string, { display_name?: string; global_display_name?: string }>>;

jest.mock('@/context', () => ({
  useAuth: () => ({ user: mockUser }),
}));
jest.mock('@/hooks/chat', () => ({
  useSpaces: () => ({ data: mockSpaces }),
}));
jest.mock('@/hooks/useMultiSpaceRosters', () => ({
  useMultiSpaceRosters: () => mockRosters,
}));

import { RootIdentityScope } from '@/identity/RootIdentityScope';
import { MemberName } from '@/identity/MemberName';

let queryClient: QueryClient;

function renderInScope(ui: React.ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <RootIdentityScope>{ui}</RootIdentityScope>
    </QueryClientProvider>,
  );
}

describe('RootIdentityScope', () => {
  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockUser = null;
    mockSpaces = [];
    mockRosters = {};
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it('resolves a member for a descendant that mounts no provider of its own', () => {
    // The load-bearing assertion: RootIdentityScope, wired to real (mocked)
    // hook data, is enough on its own — nothing else needs to mount a
    // provider for MemberName to resolve.
    mockSpaces = [{ spaceId: 'space-1' }];
    mockRosters = { 'space-1': { [ADDR]: { global_display_name: 'Alice' } } };

    renderInScope(<MemberName address={ADDR} spaceId="space-1" />);

    expect(screen.getByText('Alice')).toBeTruthy();
  });

  it('seeds the device\'s own name from auth as the last global tier', () => {
    // Nothing else knows SELF_ADDR — no roster, no profile — so this only
    // resolves if RootIdentityScope actually threads `user.displayName`
    // through `selfLocalNameEntry` into the provider.
    mockUser = { address: SELF_ADDR, displayName: 'Selfy' };

    renderInScope(<MemberName address={SELF_ADDR} />);

    expect(screen.getByText('Selfy')).toBeTruthy();
  });
});
