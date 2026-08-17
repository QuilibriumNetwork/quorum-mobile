/**
 * ReactionDetailsModal's reactor list must render a member's verified name,
 * including the `.q` suffix.
 *
 * ## Why this is a real row
 *
 * `ReactionDetailsModal` already imports `@/utils/resolveMemberName` for the
 * reactor rows, so the audit ratchet has always passed it. But that seam
 * resolves off the `members` prop (a `SpaceMember[]` roster) through the OLD,
 * non-React ladder — and `SpaceMember` carries no `primary_username` field at
 * all (only `PublicProfile` does, per `@quilibrium/quorum-shared`'s
 * `user.d.ts`). So a reactor could never show `.q` here no matter how their
 * profile resolves elsewhere in the app: the old seam structurally has no
 * path to the claim, let alone a verified one.
 *
 * ## What is mocked, and why
 *
 * `react-native-safe-area-context` — reached by the always-mounted
 * `BaseModal` this component renders through. `IdentityScopeProvider` is
 * real — the whole point is proving the real `useNameResolver` wiring, not a
 * stand-in for it.
 */
import React from 'react';
import { screen, waitFor, cleanup, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import { MAX_QNS_LOOKUPS } from '@/hooks/chat/useConversationsWithQnsNames';
import type { DisplayReaction } from '@/components/Chat/types';
import type { SpaceMember } from '@quilibrium/quorum-shared';

// react-query's notifyManager defers every subscriber notification through a
// real `setTimeout(0)` (`systemSetTimeoutZero`, deliberately NOT tied to
// promise/microtask timing), so `IdentityScopeProvider`'s `useQueries`-driven
// re-render lands on its own macrotask outside whatever `act()` scope wrapped
// the render call — it warns "not wrapped in act(...)" no matter how long the
// assertion below waits for it. Wrapping the notify callback in `act` is the
// fix the library itself documents for this exact case (see
// `notifyManager.setNotifyFunction`'s docstring: "wrap notifications with
// React.act while running tests"). It makes the state update land where React
// expects it to; it does not change what is asserted.
notifyManager.setNotifyFunction((callback) => {
  act(callback);
});

// Same genuine ed448 key/address pair reused across this migration —
// deriveAddress(KEY) === TARGET, real math, not a placeholder.
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

// `claimedNameBelongsTo` is deliberately NOT mocked — the verified case
// must prove a genuinely verified claim renders `.q`, not merely that the
// row trusts whatever `verifiedQnsNames` already contains.

import { ReactionDetailsModal } from '@/components/Chat/ReactionDetailsModal';

let queryClient: QueryClient;

function baseReaction(overrides: Partial<DisplayReaction> = {}): DisplayReaction {
  return {
    emoji: '👍',
    count: 1,
    memberIds: [TARGET],
    hasReacted: false,
    ...overrides,
  };
}

function renderModal(
  reactions: DisplayReaction[],
  rostersBySpace: Record<string, Record<string, { display_name?: string; global_display_name?: string }>> = {},
  spaceId: string | undefined = SPACE_ID,
  members: SpaceMember[] = [{ address: TARGET, inbox_address: TARGET, global_display_name: 'Alice Smith' } as SpaceMember],
) {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={rostersBySpace} selfAddress={null}>
        <ReactionDetailsModal
          visible
          onClose={() => {}}
          reactions={reactions}
          members={members}
          spaceId={spaceId}
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

describe('ReactionDetailsModal — the reactor list resolves through @/identity', () => {
  it('renders a reactor under their verified .q, the follow-global default state', async () => {
    renderModal([baseReaction()]);

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    expect(screen.queryByText('Alice Smith')).toBeNull();
  });

  it('renders a per-space nickname instead, with no .q, when the reactor has one', async () => {
    renderModal(
      [baseReaction()],
      { [SPACE_ID]: { [TARGET]: { display_name: 'Bob Nickname' } } },
      SPACE_ID,
    );

    await waitFor(() => expect(screen.getByText('Bob Nickname')).toBeTruthy());
    expect(screen.queryByText(/alice\.q/)).toBeNull();
    expect(screen.queryByText('Alice Smith')).toBeNull();
  });
});

/**
 * The `enrich` section of this row's brief: MEASURE the request count, don't
 * argue about it. `QmPeerA<n>...` addresses, the repo's placeholder family —
 * these are synthetic distinct reactors, not derivable/real ones, since this
 * pair of tests only cares about how many `getPublicProfile` calls the
 * distinct-reactor set produces, never about verifying a `.q`.
 */
function fakeAddress(i: number): string {
  return `QmPeerA${i.toString().padStart(3, '0')}${'x'.repeat(38)}`;
}

describe('ReactionDetailsModal — enrichment fan-out is bounded, not per-row', () => {
  it('requests one profile per DISTINCT reactor, not one per reaction row (a reactor can react twice)', async () => {
    // 8 distinct reactors on one emoji, plus one of them reacting a second
    // time with a different emoji — the same address appears twice in `rows`,
    // which must not double the request count.
    const reactors = Array.from({ length: 8 }, (_, i) => fakeAddress(i));
    const reactions: DisplayReaction[] = [
      { emoji: '👍', count: reactors.length, memberIds: reactors, hasReacted: false },
      { emoji: '❤️', count: 1, memberIds: [reactors[0]], hasReacted: false },
    ];

    renderModal(reactions, {}, SPACE_ID, []);

    await waitFor(() => expect(mockGetPublicProfile).toHaveBeenCalledTimes(8));
    // Give any stray extra scheduling a chance to land, then confirm it
    // never crept past the distinct-reactor count.
    await new Promise((r) => setTimeout(r, 10));
    expect(mockGetPublicProfile).toHaveBeenCalledTimes(8);
  });

  it(`caps the fan-out at MAX_QNS_LOOKUPS (${MAX_QNS_LOOKUPS}) for a heavily-reacted message`, async () => {
    // 80 distinct reactors on one popular emoji — over the cap. A popular
    // reaction on an active-space message is exactly this shape: nothing
    // bounds `memberIds` on the wire.
    const reactors = Array.from({ length: 80 }, (_, i) => fakeAddress(i));
    const reactions: DisplayReaction[] = [
      { emoji: '👍', count: reactors.length, memberIds: reactors, hasReacted: false },
    ];

    renderModal(reactions, {}, SPACE_ID, []);

    await waitFor(() => expect(mockGetPublicProfile).toHaveBeenCalledTimes(MAX_QNS_LOOKUPS));
    await new Promise((r) => setTimeout(r, 10));
    expect(mockGetPublicProfile).toHaveBeenCalledTimes(MAX_QNS_LOOKUPS);
  });
});
