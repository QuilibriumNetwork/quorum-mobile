/**
 * The three self surfaces — `AppTabBar`'s avatar, `HeaderAvatar`, and
 * `UnifiedProfileHeader` — must render the SAME identity for the SAME
 * account, because all three now resolve through the same `@/identity` call
 * (`useMemberIdentity`/`useResolvedMemberName`) rather than three separate
 * copies of the ladder.
 *
 * This is deliberately a cross-check, not three more copies of what
 * `AppTabBar.test.tsx`/`HeaderAvatar.test.tsx`/`UnifiedProfileHeader.test.tsx`
 * already pin individually. Those three files prove each surface is correct
 * in isolation; this one mounts all three together, under ONE
 * `IdentityScopeProvider`, and asserts they land on the identical answer —
 * which is what "the same rules everywhere" actually means, and the kind of
 * disagreement three separate suites can each pass while still disagreeing
 * with each other (a copy-paste error in one file's expected string would
 * not show up as a failure anywhere else).
 *
 * Two cases, matching the two that distinguish the migration from the old
 * `resolveSelfName` seam:
 *
 * 1. A verified `.q` — the common case, and the one where the old and new
 *    code happen to agree (a genuinely-owned claim renders identically
 *    either way).
 * 2. A claim that never resolves back to this device — the STALE-CLAIM case.
 *    This is the one where the three surfaces used to be able to disagree:
 *    before this fix, `AppTabBar` (still on `resolveSelfName`, which trusts
 *    `user.primaryUsername` unconditionally) would have shown initials from
 *    the unverified `.q` while `HeaderAvatar`/`UnifiedProfileHeader` (already
 *    on `@/identity`) showed the verified global name instead.
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
// not a placeholder.
const TARGET = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
// An impersonator address, unrelated to KEY — same fixed placeholder used
// elsewhere in this migration. KEY derives to TARGET only, so a device
// claiming 'gatto' from this address never verifies.
const IMPOSTOR = 'QmThemThemThemThemThemThemThemThemThemThemThem';

let mockUser: { address: string; displayName?: string; primaryUsername?: string; profileImage?: string } | null;

jest.mock('@/context', () => ({
  useAuth: () => ({ user: mockUser }),
}));

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  usePathname: () => '/messages',
}));

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

// `claimedNameBelongsTo` is deliberately NOT mocked — the whole point of
// this file is that all three surfaces run the SAME real verification.

import { AvatarButton } from '@/components/ui/AppTabBar';
import { HeaderAvatar } from '@/components/HeaderAvatar';
import UnifiedProfileHeader from '@/components/UnifiedProfileHeader';

let queryClient: QueryClient;

function renderAllThree(locallyKnownNames: Record<string, string> = {}) {
  const user = {
    address: mockUser!.address,
    quilibriumAddress: '0xquilibrium',
    publicKey: '0xpublickey',
    privacyLevel: 'standard' as const,
    displayName: mockUser!.displayName,
    primaryUsername: mockUser!.primaryUsername,
  };
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider
        rostersBySpace={{}}
        selfAddress={mockUser?.address ?? null}
        locallyKnownNames={locallyKnownNames}
      >
        <AvatarButton />
        <HeaderAvatar />
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

describe('the three self surfaces agree on the same identity', () => {
  it('all show the verified QNS name — three "G" avatar initials, one "gatto.q" header text', async () => {
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

    renderAllThree({ [TARGET]: 'GattoPardo Mobile' });

    // All three avatars (AppTabBar, HeaderAvatar, and UnifiedProfileHeader's
    // own) derive "G" (the bare QNS name's initial), never "GM" (the global
    // name's initials).
    await waitFor(() => expect(screen.getAllByText('G')).toHaveLength(3));
    expect(screen.queryAllByText('GM')).toHaveLength(0);
    // UnifiedProfileHeader's TEXT: the full formatted name, consistent with
    // the "G" all three avatars derived from the same qns name.
    expect(screen.getByText('gatto.q')).toBeTruthy();
    expect(screen.queryByText('GattoPardo Mobile')).toBeNull();
  });

  it('all three degrade together for a claim that never resolves back to this device — the stale-claim case', async () => {
    // Before this fix, this was the one case the three surfaces could
    // disagree on: AppTabBar (still on resolveSelfName) trusted this claim
    // unconditionally and would have shown "G"; HeaderAvatar and
    // UnifiedProfileHeader (already migrated) showed "GM"/"GattoPardo Mobile"
    // instead. All three must now agree on the LATTER.
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

    renderAllThree({ [IMPOSTOR]: 'GattoPardo Mobile' });

    // All three avatars derive "GM" (the global name's initials), never "G"
    // (the unverified claim's initial).
    await waitFor(() => expect(screen.getAllByText('GM')).toHaveLength(3));
    expect(screen.queryAllByText('G')).toHaveLength(0);
    // UnifiedProfileHeader's TEXT: the full global name, consistent with the
    // "GM" all three avatars derived from that same name.
    expect(screen.getByText('GattoPardo Mobile')).toBeTruthy();
    expect(screen.queryByText('gatto.q')).toBeNull();
  });
});
