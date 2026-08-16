/**
 * SpaceSettingsModal's member list must render a member's verified name,
 * including the `.q` suffix — and it must do so WITHOUT ever fetching a
 * public profile itself.
 *
 * ## Why this row is inverted from every other migrated surface
 *
 * Every other bounded surface in this migration (`MessagesList`,
 * `ReactionDetailsModal`, `UserProfileModal`, …) enriches: it calls
 * `request()`/`enrich` for the addresses it renders, because its cardinality
 * is bounded by a viewport or a reaction count. A Space's member list is not
 * bounded that way — its cardinality is the size of the whole community — so
 * this file must NEVER enrich. Desktop MEASURED 200 concurrent profile
 * requests from a 200-member sidebar that resolved eagerly; that is the
 * failure this row exists to avoid repeating.
 *
 * The consequence for THIS test: a "cached and verified" `.q` cannot come
 * from this screen calling `enrich` itself (it must not). It comes from
 * `@/identity`'s single, app-wide `IdentityScopeProvider` already having
 * verified that address, because some OTHER already-migrated surface (chat,
 * a reaction list, …) requested it earlier in the same session. `Enricher`
 * below plays that other surface's part: it mounts alongside the modal,
 * inside the SAME provider, and is the only thing in this file allowed to
 * call `enrich`.
 *
 * `useMembersWithCachedQns` is GONE — it only ever attached a verified
 * `primary_username` to each row, and nothing in this file has read that
 * field since names moved onto `@/identity`. Keeping it would have meant a
 * real `resolveBatch` network call, every render a member claims a name, for
 * a value nobody looked at; it and its cache-and-verify pass were removed. The
 * AVATAR/BIO ladder (`resolveMemberAvatar`/`resolveMemberBio`, untouched by
 * this migration — `@/identity` resolves names, never pictures) now reads
 * straight off each row's `*_image`/`*_bio` slots, with `selfIdentity` as the
 * self-only fallback.
 *
 * ## What is mocked, and why
 *
 * `@/context` — the real `AuthContext`/`WebSocketContext` reach
 * `requireNativeModule('QuorumCrypto')` at import time, the STANDING
 * LIMITATION every Phase D render test works around. `@/services/storage/mmkvAdapter`,
 * `@/services/space/spaceMessageService` — touched by an effect that fires on
 * every mount (loading/saving the viewer's own space profile), unrelated to
 * member-list rendering. `@/hooks/useApex` — same transitive reach into
 * `AuthContext` that `MessagesList.test.tsx` already documented (this file
 * imports two of its OTHER exports directly). `@/hooks/useWalletSelection` —
 * only used by the Apex config section, which this test never mounts (the
 * General tab, owner-only, is not exercised), but the import still executes.
 * `@/components/KickUserModal`, `@/components/ShareInviteSheet`,
 * `@/components/Chat/ChannelSettingsSheet`, `@/components/SpaceChannelBindingPicker`,
 * `@/components/SpaceSettings/DraggableChannelGroup` — mounted unconditionally
 * (or nearly so) by this screen but irrelevant to the member list; stubbed to
 * keep their own, unrelated dependency graphs (gesture handler drag, Farcaster
 * channel search, …) out of this file. `KickUserModal` itself already resolves
 * its own name via `@/identity` (see `__tests__/migrated/ModerationModals.test.tsx`
 * — not re-proven here); this file's job is only to confirm it is handed an
 * address, which is checked by reading the source, not by rendering it.
 * `react-native-safe-area-context` — reached by the always-mounted `BaseModal`.
 * `IdentityScopeProvider` is real — the whole point is proving the real
 * `useNameResolver` wiring, not a stand-in for it.
 */
import React from 'react';
import { screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import { useResolvedName } from '@/identity';
import type { Space, SpaceMember } from '@quilibrium/quorum-shared';

// react-query's notifyManager defers every subscriber notification through a
// real `setTimeout(0)`, so `IdentityScopeProvider`'s `useQueries`-driven
// re-render lands on its own macrotask outside whatever `act()` scope wrapped
// the render call. Same fix the other four newest migrated suites use — see
// `notifyManager.setNotifyFunction`'s own docstring.
notifyManager.setNotifyFunction((callback) => {
  act(callback);
});

// Same genuine ed448 key/address pair reused across this migration —
// deriveAddress(KEY) === TARGET, real math, not a placeholder.
const TARGET = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
const SPACE_ID = 'space-1';
const SELF = 'QmMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMe';

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

jest.mock('@/context', () => ({
  useAuth: () => ({ user: { address: SELF } }),
  useWebSocket: () => ({ enqueueOutbound: jest.fn() }),
}));

jest.mock('@/services/storage/mmkvAdapter', () => ({
  getMMKVAdapter: () => ({
    getSpaceMember: jest.fn().mockResolvedValue(null),
    saveSpaceMember: jest.fn(),
  }),
}));

jest.mock('@/services/space/spaceMessageService', () => ({
  maybeSendUpdateProfileMessage: jest.fn(),
}));

jest.mock('@/hooks/chat/useInviteManagement', () => ({
  useGenerateInvite: () => ({ mutateAsync: jest.fn() }),
  useGeneratePublicInvite: () => ({ mutateAsync: jest.fn() }),
}));

jest.mock('@/hooks/chat/useRoleManagement', () => ({
  useRoles: () => ({ data: [] }),
  useAddRole: () => ({ mutateAsync: jest.fn() }),
  useUpdateRole: () => ({ mutateAsync: jest.fn() }),
  useDeleteRole: () => ({ mutateAsync: jest.fn() }),
}));

jest.mock('@/hooks/chat', () => ({
  useAddGroup: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useMoveChannel: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useReorderChannels: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

jest.mock('@/hooks/chat/useSpaces', () => ({
  useSpaceMembers: (..._args: unknown[]) => ({ data: mockRosterMembers }),
}));

jest.mock('@/hooks/chat/useStartDirectMessage', () => ({
  useStartDirectMessage: () => jest.fn(),
}));

jest.mock('@/hooks/chat/useBlockUser', () => ({
  useBlockUser: () => ({
    blockedUsers: new Set<string>(),
    toggleBlockUser: jest.fn(),
    isUserBlocked: () => false,
  }),
}));

jest.mock('@/hooks/chat/useSpaceSettings', () => ({
  useDeleteSpace: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useLeaveSpace: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useUpdateSpace: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

// Transitively reaches `@/context/AuthContext` (`useApexStatusForAddresses`),
// the same STANDING LIMITATION `MessagesList.test.tsx` already documented.
// `useSpaceApexConfig`/`useSetSpaceApexConfig` are this file's own imports,
// but only read inside the (owner-only) General tab this test never mounts.
jest.mock('@/hooks/useApex', () => ({
  useApexStatusForAddresses: () => new Set<string>(),
  useSpaceApexConfig: () => ({ data: undefined, isLoading: false }),
  useSetSpaceApexConfig: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock('@/hooks/useWalletSelection', () => ({
  useWalletSelection: () => ({ builtinWallet: undefined }),
}));

jest.mock('@/hooks/chat/useChannelMute', () => ({
  useChannelMute: () => ({
    isSpaceMuted: () => false,
    mutedChannels: new Set<string>(),
    toggleSpaceMute: jest.fn(),
    toggleChannelMute: jest.fn(),
  }),
}));

jest.mock('@/hooks/chat/useSpaceNotificationTypes', () => ({
  useSpaceNotificationTypes: () => ({
    enabledTypes: [],
    isEnabled: () => true,
    toggleType: jest.fn(),
  }),
}));

jest.mock('@/services/config/spaceStorage', () => ({
  getSpace: (spaceId: string) => mockSpace(spaceId),
  getSpaceKey: () => undefined,
  // Non-owner: the default tab is 'account', keeping the tab bar to
  // Account/Members and avoiding every owner-only mock (roles, channels,
  // invites, Apex, danger).
  holdsSpaceOwnerKey: () => false,
}));

jest.mock('@/hooks/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: jest.fn(), confirmDialog: null }),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(),
}));

// Irrelevant to the member list; stubbed to keep their own dependency graphs
// (gesture-handler drag reordering, Farcaster channel search, the invite
// contact picker) out of this file entirely.
jest.mock('@/components/KickUserModal', () => ({
  KickUserModal: () => null,
}));
jest.mock('@/components/ShareInviteSheet', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/Chat/ChannelSettingsSheet', () => ({
  ChannelSettingsSheet: () => null,
}));
jest.mock('@/components/SpaceChannelBindingPicker', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/SpaceSettings/DraggableChannelGroup', () => ({
  DraggableChannelGroup: () => null,
}));

// `@/utils/verifyQnsClaim` is deliberately NOT mocked — the verified case must
// prove a genuinely verified claim renders `.q`, not merely that the row
// trusts whatever `verifiedQnsNames` already contains.

import SpaceSettingsModal from '@/components/SpaceSettingsModal';

let queryClient: QueryClient;
let mockRosterMembers: SpaceMember[] = [];

function mockSpace(spaceId: string): Space {
  return {
    spaceId,
    spaceName: 'Test Space',
    description: '',
    vanityUrl: '',
    inviteUrl: '',
    iconUrl: '',
    bannerUrl: '',
    defaultChannelId: 'general',
    hubAddress: '',
    createdDate: 0,
    modifiedDate: 0,
    isRepudiable: true,
    isPublic: false,
    groups: [],
    roles: [],
    emojis: [],
    stickers: [],
  };
}

function member(overrides: Partial<SpaceMember> & { address: string }): SpaceMember {
  return {
    inbox_address: overrides.address,
    ...overrides,
  } as SpaceMember;
}

/** Plays the part of "some other already-migrated surface enriched this
 *  address earlier in the session" — the only thing in this file allowed to
 *  call `enrich`. `SpaceSettingsModal` itself must never do this. */
function Enricher({ address }: { address: string }) {
  useResolvedName(address, { spaceId: SPACE_ID, enrich: true });
  return null;
}

function renderModal(
  roster: SpaceMember[],
  rostersBySpace: Record<string, Record<string, { display_name?: string; global_display_name?: string }>> = {},
  enrichAddress?: string,
) {
  mockRosterMembers = roster;
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={rostersBySpace} selfAddress={null}>
        {enrichAddress ? <Enricher address={enrichAddress} /> : null}
        <SpaceSettingsModal visible spaceId={SPACE_ID} onClose={() => {}} />
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );
}

async function openMembersTab() {
  const pill = await screen.findByText('Members');
  fireEvent.press(pill);
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
  mockRosterMembers = [];
});

describe('SpaceSettingsModal — the member list resolves through @/identity, without enriching', () => {
  it('renders a member under their verified .q once some other surface has already cached it', async () => {
    renderModal(
      [member({ address: TARGET, global_display_name: 'Alice Smith' })],
      {},
      TARGET, // the Enricher plays the part of chat having already fetched TARGET
    );

    await openMembersTab();

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    expect(screen.queryByText('Alice Smith')).toBeNull();
  });

  it('renders a per-space nickname instead, with no .q, when the member has one', async () => {
    const NICKNAME_MEMBER = 'QmPeerANicknameNicknameNicknameNicknameNickna';
    renderModal(
      [member({ address: NICKNAME_MEMBER, global_display_name: 'Global Name' })],
      { [SPACE_ID]: { [NICKNAME_MEMBER]: { display_name: 'Bob Nickname', global_display_name: 'Global Name' } } },
    );

    await openMembersTab();

    await waitFor(() => expect(screen.getByText('Bob Nickname')).toBeTruthy());
    expect(screen.queryByText(/\.q/)).toBeNull();
    expect(screen.queryByText('Global Name')).toBeNull();
  });
});

/**
 * The point of this row: the fetch count MUST be zero, at any membership
 * size. Not "few". Zero.
 */
function fakeAddress(i: number): string {
  return `QmPeerA${i.toString().padStart(3, '0')}${'x'.repeat(38)}`;
}

describe('SpaceSettingsModal — the member list NEVER enriches, at any size', () => {
  it('requests zero public profiles for a 200-member roster', async () => {
    const roster = Array.from({ length: 200 }, (_, i) =>
      member({ address: fakeAddress(i), global_display_name: `Member ${i}` }),
    );
    // The global name tier reads `rostersBySpace`, the root scope's own LOCAL
    // roster read (`useMultiSpaceRosters`, an MMKV read with no network cost)
    // — not the `useSpaceMembers` mock above, which only feeds this screen's
    // own state. Mirroring both is what makes 200 rows resolve real names
    // while genuinely requesting nothing.
    const rostersBySpace = {
      [SPACE_ID]: Object.fromEntries(
        roster.map((m) => [m.address, { global_display_name: m.global_display_name }]),
      ),
    };

    renderModal(roster, rostersBySpace);

    await openMembersTab();
    await waitFor(() => expect(screen.getByText('Member 0')).toBeTruthy());
    // Every row rendered — this is not a claim about an unrendered list.
    expect(screen.getByText('Member 199')).toBeTruthy();

    expect(mockGetPublicProfile).toHaveBeenCalledTimes(0);
    // Give any stray extra scheduling a chance to land, then confirm it
    // never crept above zero.
    await new Promise((r) => setTimeout(r, 10));
    expect(mockGetPublicProfile).toHaveBeenCalledTimes(0);
  });
});
