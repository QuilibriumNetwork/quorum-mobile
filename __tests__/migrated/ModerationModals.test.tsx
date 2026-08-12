/**
 * BlockUserModal, KickUserModal and MuteUserModal must resolve their OWN
 * display name from the target's address, rather than trusting a
 * caller-supplied `userName` string verbatim.
 *
 * ## Why this is a real row despite every live caller already resolving
 *
 * `UserProfileModal` passes `user.userName` (built by
 * `toDisplayMessage`/`formatResolvedName(resolveMemberName(...))`) and
 * `SpaceSettingsModal` passes `identity.label` (`resolveMemberIdentity`,
 * same file) — both already ladder-resolved through the OLD
 * `utils/resolveMemberName` seam. So these three modals were not rendering a
 * WRONG name today. The defect is architectural: a future caller has no way
 * to be forced to resolve first, and `.q` verification now lives in
 * `@/identity`, not the old seam. Taking `address` (+ `spaceId`) and
 * resolving internally makes the guarantee part of the component instead of
 * a convention every caller must remember.
 *
 * Each modal already carried a mandatory `userAddress` prop, so the address
 * was always available — this migration removes `userName` entirely rather
 * than adding a second prop alongside it.
 *
 * ## Scope: space (per-space nickname ranks first)
 *
 * All three actions are space-scoped (block-in-this-space, kick-from-space,
 * mute-in-space), so `spaceId` is passed WITHOUT `global: true` — a per-space
 * nickname, if the target has one, outranks their `.q` and global name here,
 * matching `resolveMemberName`'s existing space-ladder behaviour that these
 * modals' callers already relied on.
 *
 * ## What each test asserts
 *
 * BlockUserModal is the only one of the three whose confirmation COPY (not
 * just the row) names the target (`"You won't see any of <name>'s
 * messages..."`), so its test covers both the row and the sentence.
 * KickUserModal and MuteUserModal's confirmation copy is generic ("This user
 * will be removed/muted...", no name) — only their user-row Text carries the
 * name, so that is what those two tests pin.
 */
import React from 'react';
import { screen, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { IdentityScopeProvider } from '@/identity/identityProvider';

// Same genuine ed448 key/address pair as DMSettingsSheet.test.tsx /
// shareInviteSheetName.test.tsx — deriveAddress(KEY) === TARGET, real math.
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

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// The kick/mute mutation hooks reach real services (WebSocket, space
// registration rekeying) that are not under test here and are not mockable
// through a shallow chain — plain stubs, same reasoning as
// DMSettingsSheet.test.tsx's `resetDMSession` stub.
jest.mock('@/hooks/chat/useUserKicking', () => ({
  useUserKicking: () => ({ kicking: false, kickUserFromSpace: jest.fn() }),
}));
jest.mock('@/hooks/chat/useModMuteUser', () => ({
  useModMuteUser: () => ({ muteUser: jest.fn(), unmuteUser: jest.fn() }),
}));

// `@/utils/verifyQnsClaim` is deliberately NOT mocked — the verified case
// must prove a genuinely verified claim renders `.q`, not merely that the
// modal trusts whatever `verifiedQnsNames` already contains.

import { BlockUserModal } from '@/components/BlockUserModal';
import { KickUserModal } from '@/components/KickUserModal';
import { MuteUserModal } from '@/components/MuteUserModal';

let queryClient: QueryClient;

function renderWithScope(ui: React.ReactElement, rostersBySpace: Record<string, Record<string, { display_name?: string; global_display_name?: string }>> = {}) {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={rostersBySpace} selfAddress={null}>
        {ui}
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

describe('BlockUserModal — resolves its own name, including confirmation copy', () => {
  it('renders the target under their verified .q, in the row and the confirmation sentence', async () => {
    renderWithScope(
      <BlockUserModal
        visible
        onClose={() => {}}
        onConfirm={() => {}}
        userAddress={TARGET}
        spaceId={SPACE_ID}
      />,
    );

    await waitFor(() => expect(screen.getAllByText('alice.q').length).toBeGreaterThan(0));
    expect(
      screen.getByText(/You won't see any of alice\.q's messages in this space/),
    ).toBeTruthy();
    expect(screen.queryByText('Alice Smith')).toBeNull();
    expect(screen.queryByText(/You won't see any of Alice Smith's messages/)).toBeNull();
  });

  it('renders a per-space nickname instead, with no .q, when the target has one', async () => {
    renderWithScope(
      <BlockUserModal
        visible
        onClose={() => {}}
        onConfirm={() => {}}
        userAddress={TARGET}
        spaceId={SPACE_ID}
      />,
      { [SPACE_ID]: { [TARGET]: { display_name: 'Bob Nickname' } } },
    );

    await waitFor(() => expect(screen.getAllByText('Bob Nickname').length).toBeGreaterThan(0));
    expect(
      screen.getByText(/You won't see any of Bob Nickname's messages in this space/),
    ).toBeTruthy();
    expect(screen.queryByText(/alice\.q/)).toBeNull();
  });
});

describe('KickUserModal — resolves its own name', () => {
  it('renders the target under their verified .q in the user row', async () => {
    renderWithScope(
      <KickUserModal
        visible
        onClose={() => {}}
        spaceId={SPACE_ID}
        userAddress={TARGET}
      />,
    );

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    expect(screen.queryByText('Alice Smith')).toBeNull();
  });

  it('renders a per-space nickname instead, with no .q, when the target has one', async () => {
    renderWithScope(
      <KickUserModal
        visible
        onClose={() => {}}
        spaceId={SPACE_ID}
        userAddress={TARGET}
      />,
      { [SPACE_ID]: { [TARGET]: { display_name: 'Bob Nickname' } } },
    );

    await waitFor(() => expect(screen.getByText('Bob Nickname')).toBeTruthy());
    expect(screen.queryByText(/alice\.q/)).toBeNull();
  });
});

describe('MuteUserModal — resolves its own name', () => {
  it('renders the target under their verified .q in the user row', async () => {
    renderWithScope(
      <MuteUserModal
        visible
        onClose={() => {}}
        spaceId={SPACE_ID}
        channelId="channel-1"
        userAddress={TARGET}
      />,
    );

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    expect(screen.queryByText('Alice Smith')).toBeNull();
  });

  it('renders a per-space nickname instead, with no .q, when the target has one', async () => {
    renderWithScope(
      <MuteUserModal
        visible
        onClose={() => {}}
        spaceId={SPACE_ID}
        channelId="channel-1"
        userAddress={TARGET}
      />,
      { [SPACE_ID]: { [TARGET]: { display_name: 'Bob Nickname' } } },
    );

    await waitFor(() => expect(screen.getByText('Bob Nickname')).toBeTruthy());
    expect(screen.queryByText(/alice\.q/)).toBeNull();
  });
});
