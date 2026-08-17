/**
 * UnifiedProfileHeader's own-name display (the account screen's big profile
 * card) must resolve through the SAME verified ladder every other member
 * resolves through, not through `resolveSelfName` trusting the live auth
 * profile's `primaryUsername` directly.
 *
 * ## The defect this pins
 *
 * `resolveSelfName` trusted `user.primaryUsername` unconditionally — electing
 * a QNS name locally was treated as proof of owning it, with no check against
 * a published public profile. Every other member's claim goes through
 * exactly that check (`identity/identityProvider.tsx`'s `verifiedQnsNames`);
 * your own was exempt. This file covers `QuorumOnlyHeader`, the branch
 * rendered whenever the account has no linked Farcaster identity — the most
 * common case, and structurally identical to `HeaderAvatar.tsx`'s fix.
 *
 * ## What is real, what is mocked
 *
 * `IdentityScopeProvider` is real, and `claimedNameBelongsTo` is NOT
 * mocked — `claimedNameBelongsTo` runs for real against a genuine derivable
 * ed448 key/address pair, reused verbatim from `shareInviteSheetName.test.tsx`.
 * Only the two network seams it depends on are stubbed.
 */
import React from 'react';
import { screen, waitFor, cleanup, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import type { UserInfo } from '@/context/AuthContext';

// See ReactionDetailsModal.test.tsx / SpaceSettingsModal.test.tsx for why this
// is required: notifyManager defers subscriber notifications through a real
// setTimeout(0), which lands IdentityScopeProvider's useQueries-driven
// re-render outside whatever act() scope wrapped the render call otherwise.
notifyManager.setNotifyFunction((callback) => {
  act(callback);
});

// A genuine ed448 key/address pair, reused verbatim from
// `shareInviteSheetName.test.tsx` — deriveAddress(KEY) === TARGET, real math,
// not a placeholder.
const TARGET = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
// An impersonator address, unrelated to KEY — same fixed placeholder used by
// `shareInviteSheetName.test.tsx`. KEY derives to TARGET only, so a device
// claiming 'gatto' from this address never verifies.
const IMPOSTOR = 'QmThemThemThemThemThemThemThemThemThemThemThem';

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

// `claimedNameBelongsTo` is deliberately NOT mocked — see the file header.

import UnifiedProfileHeader from '@/components/UnifiedProfileHeader';

let queryClient: QueryClient;

function baseUser(overrides: Partial<UserInfo> = {}): UserInfo {
  return {
    address: TARGET,
    quilibriumAddress: '0xquilibrium',
    publicKey: '0xpublickey',
    privacyLevel: 'standard',
    ...overrides,
  };
}

function renderHeader(user: UserInfo, locallyKnownNames: Record<string, string> = {}) {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider
        rostersBySpace={{}}
        selfAddress={user.address}
        locallyKnownNames={locallyKnownNames}
      >
        <UnifiedProfileHeader
          user={user}
          splitMode={false}
          identityTab="quorum"
          onIdentityTabChange={() => {}}
        />
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe('UnifiedProfileHeader (QuorumOnlyHeader) — own name resolves through the verified ladder', () => {
  it('renders the verified QNS name, not the global display name', async () => {
    const user = baseUser({ primaryUsername: 'gatto', displayName: 'GattoPardo Mobile' });
    mockGetPublicProfile = jest.fn().mockResolvedValue({
      display_name: 'GattoPardo Mobile',
      primary_username: 'gatto',
      profile_image: '',
      bio: '',
      timestamp: 0,
      signature: '',
    });
    mockResolveBatch = jest.fn().mockResolvedValue([
      {
        header: { authorityKey: '0xabc', name: 'gatto', parent: null, createdAt: 0, updatedAt: 0 },
        address: '0xrecord',
        resolveKey: KEY,
        metadata: null,
      },
    ]);

    renderHeader(user, { [TARGET]: 'GattoPardo Mobile' });

    await waitFor(() => expect(screen.getByText('gatto.q')).toBeTruthy());
    expect(screen.queryByText('GattoPardo Mobile')).toBeNull();
  });

  it('does not render a .q from a claim that never resolves back to this device', async () => {
    // IMPOSTOR's public profile claims 'gatto' too, but the resolver's record
    // for 'gatto' (KEY) derives to TARGET, never IMPOSTOR. The previous
    // `resolveSelfName` seam trusted `user.primaryUsername` unconditionally;
    // this is the wrong-NAME proof that the new ladder does not.
    const user = baseUser({ address: IMPOSTOR, primaryUsername: 'gatto', displayName: 'GattoPardo Mobile' });
    mockGetPublicProfile = jest.fn().mockResolvedValue({
      display_name: 'GattoPardo Mobile',
      primary_username: 'gatto',
      profile_image: '',
      bio: '',
      timestamp: 0,
      signature: '',
    });
    mockResolveBatch = jest.fn().mockResolvedValue([
      {
        header: { authorityKey: '0xabc', name: 'gatto', parent: null, createdAt: 0, updatedAt: 0 },
        address: '0xrecord',
        resolveKey: KEY,
        metadata: null,
      },
    ]);

    renderHeader(user, { [IMPOSTOR]: 'GattoPardo Mobile' });

    await waitFor(() => expect(screen.getByText('GattoPardo Mobile')).toBeTruthy());
    expect(screen.queryByText('gatto.q')).toBeNull();
  });

  it('renders the live auth profile name synchronously, with no network call resolved yet', () => {
    // The fresh-Space case: a public-profile fetch that never settles during
    // this test proves the name did not come from it — only
    // `locallyKnownNames`, sourced from the live auth profile with no round
    // trip, can have produced it this fast.
    const user = baseUser({ displayName: 'GattoPardo Mobile' });
    mockGetPublicProfile = jest.fn(() => new Promise(() => {}));
    mockResolveBatch = jest.fn(() => new Promise(() => {}));

    renderHeader(user, { [TARGET]: 'GattoPardo Mobile' });

    // No `await waitFor` — asserted immediately after render.
    expect(screen.getByText('GattoPardo Mobile')).toBeTruthy();
  });
});
