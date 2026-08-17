/**
 * AppTabBar's own avatar must derive its initials from the SAME verified
 * ladder every other member resolves through, not from the live auth
 * profile's `primaryUsername`/`displayName` trusted directly.
 *
 * ## History
 *
 * This file originally pinned a narrower fix (row 3 of the identity
 * migration): the ladder was inverted (`displayName || primaryUsername`,
 * ranking the global name above the `.q`), and the fix at the time adopted
 * `resolveSelfName` — the SAME already-correct order `HeaderAvatar.tsx` used,
 * but still trusting `user.primaryUsername` unconditionally. `HeaderAvatar.tsx`
 * and `UnifiedProfileHeader.tsx` were later merged onto `@/identity`'s
 * verified ladder (row 23), and this surface — the third and last self
 * surface — follows here, so the tab bar's own avatar can no longer disagree
 * with the profile header about who you are.
 *
 * ## The defect this pins now
 *
 * `resolveSelfName` trusted `user.primaryUsername` unconditionally — electing
 * a QNS name locally was treated as proof of owning it. Every other member's
 * claim is verified against a published public profile before it earns a `.q`
 * (`identity/identityProvider.tsx`'s `verifiedQnsNames`); your own was the one
 * name in the app exempt from that check. A name elected and then transferred
 * away (or never actually published) kept rendering as though still owned.
 *
 * ## Why initials, not a `.q` string
 *
 * `AppTabBar` never renders a name as text — the avatar is icon-only chrome.
 * The only observable trace of the ladder is which name the fallback
 * INITIALS are derived from, so that is what this file asserts on.
 *
 * ## What is real, what is mocked
 *
 * `IdentityScopeProvider` is real, and `claimedNameBelongsTo` is NOT
 * mocked: `claimedNameBelongsTo` runs for real against a genuine derivable
 * ed448 key/address pair, reused verbatim from `shareInviteSheetName.test.tsx`.
 * Only the two network seams it depends on (`getPublicProfile`, `resolveBatch`)
 * are stubbed.
 */
import React from 'react';
import { screen, waitFor, cleanup, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { IdentityScopeProvider } from '@/identity/identityProvider';

// See ReactionDetailsModal.test.tsx / SpaceSettingsModal.test.tsx for why this
// is required: notifyManager defers subscriber notifications through a real
// setTimeout(0), which lands IdentityScopeProvider's useQueries-driven
// re-render outside whatever act() scope wrapped the render call otherwise.
notifyManager.setNotifyFunction((callback) => {
  act(callback);
});

// A genuine ed448 key/address pair, reused verbatim from
// `shareInviteSheetName.test.tsx` — deriveAddress(KEY) === TARGET, real math,
// not a placeholder. Needed because `claimedNameBelongsTo` runs for real here.
const TARGET = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
// An impersonator address, unrelated to KEY — same fixed placeholder used by
// `shareInviteSheetName.test.tsx` / `HeaderAvatar.test.tsx`. Used below as the
// SELF address in the unverified-claim test: KEY derives to TARGET only, so a
// device claiming 'gatto' from this address never verifies.
const IMPOSTOR = 'QmThemThemThemThemThemThemThemThemThemThemThem';

let mockUser: { address: string; displayName?: string; primaryUsername?: string; profileImage?: string } | null;

jest.mock('@/context', () => ({
  useAuth: () => ({ user: mockUser }),
}));

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  usePathname: () => '/messages',
}));

// AppTabBar's file-level import of useUnifiedNotifications (for the
// notification-bell tab, not rendered here) reaches @/context/AuthContext
// DIRECTLY — a different module path than the @/context barrel mocked above
// — which requires the real native QuorumCrypto module at import time and
// cannot run under jest at all. Stubbed wholesale; AvatarButton never calls
// this hook itself.
jest.mock('@/hooks/useUnifiedNotifications', () => ({
  useUnifiedNotifications: () => ({ unreadCount: 0 }),
}));

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

import { AvatarButton } from '@/components/ui/AppTabBar';

let queryClient: QueryClient;

function renderAvatar(locallyKnownNames: Record<string, string> = {}) {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider
        rostersBySpace={{}}
        selfAddress={mockUser?.address ?? null}
        locallyKnownNames={locallyKnownNames}
      >
        <AvatarButton />
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

describe('AppTabBar — the avatar resolves own initials through the verified ladder', () => {
  it('derives initials from the verified QNS name, not the global display name', async () => {
    mockUser = { address: TARGET, primaryUsername: 'gatto', displayName: 'GattoPardo Mobile' };
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

    renderAvatar({ [TARGET]: 'GattoPardo Mobile' });

    // resolveWithFallback's bare name ('gatto' -> 'G'), not the global
    // display name's initials ('GattoPardo Mobile' -> 'GM').
    await waitFor(() => expect(screen.getByText('G')).toBeTruthy());
    expect(screen.queryByText('GM')).toBeNull();
  });

  it('does not derive a verified initial from a claim that never resolves back to this device', async () => {
    // IMPOSTOR's public profile claims 'gatto' too, but the resolver's record
    // for 'gatto' (KEY) derives to TARGET, never IMPOSTOR — the same forgery
    // `claimedNameBelongsTo` exists to catch, now against SELF's own claim.
    // `resolveSelfName` (this surface's previous seam) trusted this claim
    // unconditionally; this is the wrong-NAME proof that the new ladder does
    // not — the exact case that used to make this surface disagree with
    // `HeaderAvatar`/`UnifiedProfileHeader`.
    mockUser = { address: IMPOSTOR, primaryUsername: 'gatto', displayName: 'GattoPardo Mobile' };
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

    renderAvatar({ [IMPOSTOR]: 'GattoPardo Mobile' });

    await waitFor(() => expect(screen.getByText('GM')).toBeTruthy());
    expect(screen.queryByText('G')).toBeNull();
  });

  it('renders the live auth profile name synchronously, with no network call resolved yet', () => {
    // The fresh-Space case: a public-profile fetch that never settles during
    // this test (never resolved/rejected) proves the name did not come from
    // it — only `locallyKnownNames`, sourced from the live auth profile with
    // no round trip, can have produced it this fast.
    mockUser = { address: TARGET, displayName: 'GattoPardo Mobile' };
    mockGetPublicProfile = jest.fn(() => new Promise(() => {}));
    mockResolveBatch = jest.fn(() => new Promise(() => {}));

    renderAvatar({ [TARGET]: 'GattoPardo Mobile' });

    // No `await waitFor` — asserted immediately after render.
    expect(screen.getByText('GM')).toBeTruthy();
  });

  it('shows the neutral placeholder, not an address-derived initial, when no tier has a name', async () => {
    mockUser = { address: TARGET };
    mockGetPublicProfile = jest.fn().mockResolvedValue(null);
    mockResolveBatch = jest.fn().mockResolvedValue([]);

    renderAvatar({});

    // '?' — DefaultAvatar's neutral glyph for an empty name. Never a letter
    // sliced off the truncated address.
    await waitFor(() => expect(screen.getByText('?')).toBeTruthy());
  });
});
