/**
 * The invite contact picker must not turn a long DM list into an unbounded
 * fetch storm.
 *
 * ## Why this is a separate file from `shareInviteSheetName.test.tsx`
 *
 * That file is about WHICH name renders, with exactly one conversation on
 * screen. This one is about HOW MANY network requests opening the sheet
 * issues, which only shows up with a list longer than the cap — a different
 * setup (many rows, a `jest.fn` return value nobody inspects) for a different
 * property. Splitting them keeps each file's fixture obviously matched to
 * what it asserts.
 *
 * ## The bug this pins
 *
 * `ShareInviteSheet`'s list is a plain, non-windowed `ScrollView`
 * (`components/ShareInviteSheet.tsx`) — every cached conversation mounts a
 * `ConversationRow` at once, not just the ones on screen. `useConversations`
 * shares its query key with the Messages tab, so the cached list can be every
 * page the user has ever scrolled this session. Before the bound below
 * existed, `enrich: true` was passed unconditionally, so opening the sheet
 * with N cached conversations issued N `getPublicProfile` calls — MEASURED at
 * 60 calls for 60 conversations, transcript in the Task 7 fix-round report.
 *
 * The fix bounds `enrich` to the same `MAX_QNS_LOOKUPS` cap
 * `useConversationsWithQnsNames` already uses for the identical conversation
 * list, applied to the most-recent-first `MAX_QNS_LOOKUPS` addresses via the
 * shared `qnsLookupAddresses` helper.
 */
import React from 'react';
import { screen, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { MAX_QNS_LOOKUPS } from '@/hooks/chat/useConversationsWithQnsNames';

/** More conversations than the cap, so the bound has something to cut. Each
 *  gets a distinct address and a distinct, increasing timestamp — the screen
 *  sorts most-recent-first, so index 0 (oldest) is the one expected to fall
 *  OUTSIDE the bound and index `TOTAL - 1` (newest) the one expected inside. */
const TOTAL = 60;

// `mock`-prefixed (jest.mock factories may only close over `mock`-prefixed
// names) even though this builds fixture data rather than a spy.
function mockMakeConversations() {
  return Array.from({ length: TOTAL }, (_, i) => ({
    conversationId: `conv-${i}`,
    // Clearly synthetic bulk fixture data, not a real or plausible account
    // address — only used here to give `useQueries` a distinct cache key per
    // row, never rendered as a claim or asserted on by name.
    address: `QmFetchBoundTest${String(i).padStart(3, '0')}${'A'.repeat(24)}`,
    displayName: `Bulk Contact ${i}`,
    type: 'direct' as const,
    source: 'quorum' as const,
    timestamp: 1_700_000_000_000 + i,
    icon: undefined,
  }));
}

jest.mock('@/hooks/chat/useConversations', () => ({
  useConversations: () => ({
    data: { pages: [{ conversations: mockMakeConversations() }] },
    isLoading: false,
  }),
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

// `mock`-prefixed so the jest.mock factory below (hoisted above this
// declaration) may close over it, same convention as `shareInviteSheetName.test.tsx`.
// Resolves to `null` — nobody asserts on a rendered NAME in this file, only on
// how many times this function was called.
let mockGetPublicProfile: jest.Mock;

jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    getPublicProfile: (address: string) => mockGetPublicProfile(address),
  }),
}));

// A `getPublicProfile` that resolves `null` carries no `primary_username`, so
// no claim is ever produced and `resolveBatch` is never called with a
// non-empty name list — this mock exists only so importing the real
// `useConversationsWithQnsNames`/`identityProvider` module graph resolves.
jest.mock('@/services/api/qnsClient', () => ({
  resolveBatch: jest.fn().mockResolvedValue([]),
}));

import { IdentityScopeProvider } from '@/identity/identityProvider';
import ShareInviteSheet from '@/components/ShareInviteSheet';

let queryClient: QueryClient;

describe('ShareInviteSheet — bounded fetch fan-out', () => {
  beforeEach(() => {
    mockGetPublicProfile = jest.fn().mockResolvedValue(null);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it(`issues at most ${MAX_QNS_LOOKUPS} profile requests for ${TOTAL} cached conversations`, async () => {
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

    // Every row renders regardless of the bound (the ScrollView is not
    // windowed) — the empty-state text must NOT appear, confirming all
    // `TOTAL` rows genuinely mounted rather than the list rendering empty for
    // an unrelated reason and vacuously issuing zero requests.
    expect(screen.queryByText('No direct messages yet.')).toBeNull();

    // Every profile fetch here is triggered within the same synchronous
    // render/effect pass (each row's `enrich` effect fires once, on mount),
    // so `waitFor` settling on the exact expected count — not merely
    // "at least" — is enough to know no further call is still in flight.
    await waitFor(() => expect(mockGetPublicProfile).toHaveBeenCalledTimes(MAX_QNS_LOOKUPS));
  });
});
