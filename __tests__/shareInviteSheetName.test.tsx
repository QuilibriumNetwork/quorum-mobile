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
 * The conversation row's `primary_username` field ('alice') is never actually
 * read by the screen — it comes along on the mock conversation only because
 * that is what a real row looks like, and the screen's own resolution is
 * entirely independent of it (see `ShareInviteSheet.tsx`'s comment on why
 * `useConversationsWithQnsNames`'s claim output is discarded). What this file
 * pins is: the screen resolves through `identity/`
 * (`useResolvedName`, `enrich: true`), which re-verifies the claim for itself
 * via a real `IdentityScopeProvider` rather than trusting the row's claim
 * directly. The two NETWORK seams that provider depends on are mocked, the
 * same way `identityProviderVerification.test.tsx` and `useNameResolver.test.tsx`
 * already do it — but the CRYPTO predicate that turns a claim into a `.q`
 * (`claimedNameBelongsTo`) is deliberately left real. A test that stubbed that
 * predicate too would only prove the screen renders whatever
 * `verifiedQnsNames` already contains, not that a verified claim is what
 * lands there. See the second test below for the negative half of that proof.
 */

import React from 'react';
import { screen, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';

// A genuine ed448 key/address pair, reused verbatim from
// `identityProviderVerification.test.tsx` rather than generated fresh —
// `deriveAddress(KEY) === PARTNER`, real math, not a placeholder. Needed
// because `claimedNameBelongsTo` (`@quilibrium/quorum-shared`) is the ONE
// predicate that turns a claim into a `.q`, and it runs for real here (no
// mock on it below): a non-derivable placeholder address would make every
// claim fail verification, which is a different, wrong test.
const PARTNER = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
// An impersonator address, unrelated to KEY — never anything but a fixed
// placeholder in this file, same convention as `identityProviderVerification.test.tsx`'s
// `OTHER`. Used only by the mismatched-claim RED proof below.
const IMPOSTOR = 'QmThemThemThemThemThemThemThemThemThemThemThem';

/**
 * The partner as the picker will see them: an older global name on the row, and
 * an elected `.q` that must outrank it.
 *
 * `let`, not `const`, and `mock`-prefixed: `jest.mock` factories are hoisted
 * above every other statement in the file, so they may only close over
 * variables jest recognises as test doubles by that naming convention — and
 * the impersonation test below reassigns this to a row claiming the same name
 * from a DIFFERENT address, read fresh by the mock on each render.
 */
let mockConversation = {
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

// `@/hooks/chat/useConversationsWithQnsNames` is NOT mocked: `ShareInviteSheet`
// only imports its pure, React-free `qnsLookupAddresses` export and the
// `MAX_QNS_LOOKUPS` constant (to bound `enrich` fan-out) — never the hook
// itself, which is never called from this screen. The real module's own
// dependencies (`getQuorumClient`, `resolveBatch`) are already mocked above,
// so importing it for real here is safe and needs no stub of its own.

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

// `claimedNameBelongsTo` (from `@quilibrium/quorum-shared`) is deliberately NOT
// mocked. It is the ONE predicate (`identity/identityProvider.tsx`'s `verifiedQnsNames`
// computation) that decides whether a claim becomes a `.q`, and letting it run
// for real — against the genuine KEY/PARTNER pair above — is what makes this
// test prove a VERIFIED claim renders `alice.q`, rather than merely proving
// the screen renders whatever `verifiedQnsNames` already contains. Mocking
// this predicate would make the test blind to a wrong comparison, the wrong
// argument order, or a dropped check at that exact call site.

import { IdentityScopeProvider } from '@/identity/identityProvider';
import ShareInviteSheet from '@/components/ShareInviteSheet';

let queryClient: QueryClient;

function renderSheet() {
  return renderWithProviders(
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
}

describe('ShareInviteSheet — the contact picker resolves names', () => {
  beforeEach(() => {
    // Reset to the baseline row before every test; the impersonation test
    // below overrides this locally, and without a reset that override would
    // leak into whichever test runs next.
    mockConversation = {
      conversationId: 'conv-1',
      address: PARTNER,
      displayName: 'Alice Smith',
      primary_username: 'alice',
      type: 'direct',
      source: 'quorum',
      timestamp: 1_700_000_000_000,
      icon: undefined,
    };
    mockGetPublicProfile = jest.fn().mockResolvedValue({
      display_name: 'Alice Smith',
      primary_username: 'alice',
      profile_image: '',
      bio: '',
      timestamp: 0,
      signature: '',
    });
    // `resolveKey: KEY` — the genuine key, so `claimedNameBelongsTo` (running
    // for real, unmocked) derives PARTNER and the claim verifies. The
    // impersonation test reuses this SAME record: KEY derives to PARTNER only,
    // so the identical record fails to verify against IMPOSTOR without any
    // change to this mock.
    mockResolveBatch = jest.fn().mockResolvedValue([
      {
        header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
        address: '0xrecord',
        resolveKey: KEY,
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
    renderSheet();

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    expect(screen.queryByText('Alice Smith')).toBeNull();
  });

  it('does not grant a .q to an impersonator whose claim resolves to someone else', async () => {
    // IMPOSTOR claims 'alice' too, but the resolver's record for 'alice'
    // (unchanged from the mock above) derives back to PARTNER via KEY, not
    // IMPOSTOR — the exact forgery `claimedNameBelongsTo` exists to catch.
    // This is the CRITICAL-finding proof: with the crypto genuinely running
    // (no mock on `claimedNameBelongsTo`), a claim that resolves to the
    // wrong address must render the global name, never a `.q`.
    mockConversation = { ...mockConversation, conversationId: 'conv-2', address: IMPOSTOR };

    renderSheet();

    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeTruthy());
    expect(screen.queryByText('alice.q')).toBeNull();
  });
});
