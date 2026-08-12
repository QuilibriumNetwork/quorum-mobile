/**
 * UserProfileModal must render ONE resolved name, not two hand-composed
 * pieces.
 *
 * ## The defect this pins
 *
 * The header used to render `user.userName` (a caller-resolved display name)
 * and, on its own line below, `@{user.primaryUsername}` — an UNVERIFIED
 * claim straight off whatever the caller happened to pass, with no check
 * that the claimed name actually belongs to this address. That is the same
 * defect class as the badge row earlier in this migration: a surface
 * assembling its own version of the ladder instead of rendering the one
 * verified answer `@/identity` produces.
 *
 * After the fix there is exactly one name on screen: the ladder's resolved
 * string, `.q`-suffixed only when the claim verifies for real (this test
 * does not mock `@/utils/verifyQnsClaim`, so the real predicate runs).
 *
 * ## Scope: context (space, when the modal is opened with one)
 *
 * `UserProfileModal` is opened from both Space screens (with a `spaceId`)
 * and DM screens (without one), so it resolves with whatever `spaceId` its
 * caller passes — a per-space nickname, when present, ranks above the `.q`.
 *
 * ## What is deliberately NOT exercised here
 *
 * Kick/Mute/Block are omitted from every render below (no `isSpaceOwner`,
 * no `onBlockUser`, no `channelId`) so none of those three child modals
 * mount — they are covered by their own migration
 * (`__tests__/migrated/ModerationModals.test.tsx`) and mounting them here
 * would only add unrelated hook mocks for a scope this file isn't about.
 */
import React from 'react';
import { screen, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { IdentityScopeProvider } from '@/identity/identityProvider';

// Same genuine ed448 key/address pair as the other migrated render tests —
// deriveAddress(KEY) === TARGET, real math, so the unmocked verification
// predicate (`@/utils/verifyQnsClaim`) genuinely has something to verify.
const TARGET = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
const SPACE_ID = 'space-1';

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

// `@/context`'s real AuthContext reaches `requireNativeModule('QuorumCrypto')`
// at import time — not renderable under jest at all. Only `useAuth` is used
// by this component.
jest.mock('@/context', () => ({
  useAuth: () => ({ user: { address: 'self-address' } }),
}));
jest.mock('@/context/ToastContext', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}));
jest.mock('@/hooks/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: jest.fn(), confirmDialog: null }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(),
}));
// Every hook this screen pulls from the `@/hooks/chat` barrel — none of
// their real implementations are under test here (roles/mute/kick are
// deliberately not exercised, see the file header).
jest.mock('@/hooks/chat', () => ({
  useAssignRole: () => ({ mutateAsync: jest.fn() }),
  useRemoveFromRole: () => ({ mutateAsync: jest.fn() }),
  useSpaces: () => ({ data: [] }),
  useHasPermission: () => false,
  useSpaceMembers: () => ({ data: [] }),
}));
jest.mock('@/hooks/chat/useIsUserMuted', () => ({
  useIsUserMuted: () => ({ isUserMuted: () => false }),
}));
// `UserProfileModal` imports KickUserModal/MuteUserModal/BlockUserModal
// eagerly (not lazily), and the first two transitively reach
// `@/context/WebSocketContext` -> ... -> `requireNativeModule('QuorumCrypto')`
// at IMPORT time, which crashes under jest regardless of whether either
// modal is ever visible. Plain stubs, same reasoning as
// ModerationModals.test.tsx.
jest.mock('@/hooks/chat/useUserKicking', () => ({
  useUserKicking: () => ({ kicking: false, kickUserFromSpace: jest.fn() }),
}));
jest.mock('@/hooks/chat/useModMuteUser', () => ({
  useModMuteUser: () => ({ muteUser: jest.fn(), unmuteUser: jest.fn() }),
}));

// `@/utils/verifyQnsClaim` is deliberately NOT mocked — see the file header.

import UserProfileModal, { type UserProfileInfo } from '@/components/UserProfileModal';

let queryClient: QueryClient;

function renderModal(
  user: UserProfileInfo,
  rostersBySpace: Record<string, Record<string, { display_name?: string; global_display_name?: string }>> = {},
) {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={rostersBySpace} selfAddress={null}>
        <UserProfileModal
          visible
          onClose={() => {}}
          user={user}
          spaceId={SPACE_ID}
        />
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockGetPublicProfile = jest.fn().mockResolvedValue({
    display_name: 'Alice Smith',
    primary_username: 'alice',
    profile_image: '',
    bio: '',
    timestamp: 0,
    signature: '',
  });
  mockResolveBatch = jest.fn().mockResolvedValue([
    {
      header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
      address: '0xrecord',
      resolveKey: KEY,
      metadata: null,
    },
  ]);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe('UserProfileModal — renders one resolved name, not two hand-composed pieces', () => {
  it('renders the target under their verified .q as a single name, no separate @handle line', async () => {
    // No `primaryUsername` in the fixture at all — `UserProfileInfo` no
    // longer carries the field. The `.q` below must come entirely from the
    // modal's own resolution of `userId`, not from anything the caller claims.
    renderModal({
      userId: TARGET,
      userName: 'Alice Smith',
    });

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    // No second, separately-rendered "@alice" line alongside the resolved name.
    expect(screen.queryByText('@alice')).toBeNull();
    expect(screen.queryByText('Alice Smith')).toBeNull();
  });

  it('renders a per-space nickname instead, with no .q, when the target has one', async () => {
    renderModal(
      {
        userId: TARGET,
        userName: 'Alice Smith',
      },
      { [SPACE_ID]: { [TARGET]: { display_name: 'Bob Nickname' } } },
    );

    await waitFor(() => expect(screen.getByText('Bob Nickname')).toBeTruthy());
    expect(screen.queryByText(/alice\.q/)).toBeNull();
    expect(screen.queryByText('@alice')).toBeNull();
  });
});
