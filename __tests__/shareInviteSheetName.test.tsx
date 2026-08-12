/**
 * The invite contact picker must render a partner's RESOLVED name.
 *
 * ## Why this test exists, and why it is a RENDER test
 *
 * This is the first component-render test in the repo, and it is deliberately
 * pointed at a bug that is already known and already filed.
 *
 * The point is not the bug. The point is that mobile's ~60 existing tests were
 * ALL green while this shipped, and could not have been otherwise: they exercise
 * `resolveMemberName` directly, and `resolveMemberName` is correct. The defect
 * was that `ShareInviteSheet` never called any resolver at all — it read
 * `conv.displayName` raw. A function-level test cannot see a function that is
 * not called.
 *
 * That is the whole argument for this instrument. Verify it by reverting the
 * fix and watching THIS file go red while everything else stays green (done
 * during development; see the task report for the transcript).
 *
 * ## What is asserted
 *
 * A DM partner who has elected the QNS name `alice` must be listed as `alice.q`,
 * not under the older global name still sitting on their conversation row. A
 * `.q` outranks a global display name everywhere else in the app; this surface
 * is the exception, and it should not be.
 *
 * The conversation row is mocked as ALREADY carrying the QNS name — `alice` on
 * `primary_username` — because `useConversationsWithQnsNames` is mocked as an
 * identity passthrough below; that hook's own job (attaching a partner's claim
 * to the row at all) has its own coverage elsewhere. What this file pins is
 * the SECOND half: the screen now resolves through `identity/`
 * (`useResolvedName`, `enrich: true`), which re-verifies the claim for itself
 * via a real `IdentityScopeProvider` rather than trusting the row's claim
 * directly — so the network seams that provider depends on are mocked too, the
 * same way `identityProviderVerification.test.tsx` and `useNameResolver.test.tsx`
 * already do it.
 */

import React from 'react';
import { screen, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';

const PARTNER = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

/**
 * The partner as the picker will see them: an older global name on the row, and
 * an elected `.q` that must outrank it.
 *
 * `mock`-prefixed because `jest.mock` factories are hoisted above every other
 * statement in the file, so they may only close over variables jest recognises
 * as test doubles by that naming convention.
 */
const mockConversation = {
  conversationId: 'conv-1',
  address: PARTNER,
  displayName: 'Alice Smith',
  primary_username: 'alice',
  type: 'direct' as const,
  source: 'quorum' as const,
  timestamp: 1_700_000_000_000,
  icon: undefined,
};

jest.mock('@/hooks/chat/useConversations', () => ({
  useConversations: () => ({
    data: { pages: [{ conversations: [mockConversation] }] },
    isLoading: false,
  }),
}));

// Identity passthrough: the picker now routes conversations through this
// hook, but ITS job (attaching a partner's claim to the row) is covered by
// its own tests. Mocked here so this file stays about the SECOND half —
// rendering an already-claimed row through the resolver — regardless of how
// the first half is implemented.
jest.mock('@/hooks/chat/useConversationsWithQnsNames', () => ({
  useConversationsWithQnsNames: (rows: unknown[]) => rows,
}));

jest.mock('@/hooks/chat/useInviteManagement', () => ({
  useShareInvite: () => ({ mutateAsync: jest.fn() }),
}));

jest.mock('@/hooks/chat/useSendDirectMessage', () => ({
  useSendDirectMessage: () => ({ mutateAsync: jest.fn() }),
}));

jest.mock('@/context/ToastContext', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// The screen now resolves through `identity/`, which needs a real
// `IdentityScopeProvider` above it (thrown, uncaught, otherwise — see
// `identityProvider.tsx`). That provider does its own network round trip to
// verify a claim, so the two network seams are mocked the same way
// `identityProviderVerification.test.tsx` and `useNameResolver.test.tsx`
// already do it, rather than inventing a second pattern.
//
// `mock`-prefixed so the jest.mock factories below (hoisted above these
// declarations) may close over them, per the convention those two files use.
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

// `claimedNameBelongsTo` compares an address DERIVED from a real ed448 key
// against the claimant's address (`utils/verifyQnsClaim.ts`). PARTNER above is
// a repo-convention placeholder with no real keypair behind it — by design,
// per the identity-guard rule against writing a genuinely derivable
// address/key pair into a fixture for an invented person. The derivation
// itself is exercised for real elsewhere (`identityProviderVerification.test.tsx`,
// `verifyQnsClaim.test.ts`); this test is about the SCREEN wiring a verified
// claim through to the right text, not about re-proving the crypto.
jest.mock('@/utils/verifyQnsClaim', () => ({
  claimedNameBelongsTo: (_record: unknown, address: string) => address === PARTNER,
}));

import { IdentityScopeProvider } from '@/identity/identityProvider';
import ShareInviteSheet from '@/components/ShareInviteSheet';

let queryClient: QueryClient;

describe('ShareInviteSheet — the contact picker resolves names', () => {
  beforeEach(() => {
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
        resolveKey: 'deadbeef',
        metadata: null,
      },
    ]);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it('lists a partner under their .q, not their older global name', async () => {
    renderWithProviders(
      <QueryClientProvider client={queryClient}>
        <IdentityScopeProvider rostersBySpace={{}} selfAddress={null}>
          <ShareInviteSheet
            visible
            onClose={() => {}}
            inviteLink="https://example.invalid/invite/abc"
            spaceName="Test Space"
          />
        </IdentityScopeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    expect(screen.queryByText('Alice Smith')).toBeNull();
  });
});
