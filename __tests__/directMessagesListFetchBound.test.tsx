/**
 * DirectMessagesList must not turn a long conversation list into an
 * unbounded fetch storm.
 *
 * ## Why this is a real row even though the surface is dead code
 *
 * `components/Chat/DirectMessagesList.tsx` has zero call sites — the live DM
 * list is `app/(tabs)/messages/index.tsx`, which already resolves through
 * `useConversationsWithQnsNames`'s capped output. But this branch touched the
 * file (migrating its raw name field onto `@/identity`) and carried the
 * missing cap forward: `DMConversationItem` passed `enrich: !isFarcaster`
 * unconditionally, so a FlashList windowed for on-screen ROWS still let the
 * underlying data list — which is the full filtered/sorted `conversations`
 * prop, not just what is on screen, and grows via `onEndReached` pagination
 * — drive one `getPublicProfile` per distinct Quorum row with no ceiling.
 * Bringing this in line with the established pattern means whoever revives
 * the file inherits the right shape rather than a silent regression.
 *
 * ## What is mocked, and why
 *
 * Same as `__tests__/migrated/DirectMessagesList.test.tsx` — that file's own
 * header explains each mock. `getPublicProfile` here resolves to a profile
 * with NO `primary_username`, so no claim is ever produced and the assertion
 * is purely about COUNT, not content.
 */
import React from 'react';
import { screen, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import { DarkTheme } from '@/theme';
import { MAX_QNS_LOOKUPS } from '@/hooks/chat/useConversationsWithQnsNames';
import type { Conversation } from '@/hooks/chat';

const TOTAL = 60;

let mockGetPublicProfile: jest.Mock;
let mockResolveClaimedNames: jest.Mock;

jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    getPublicProfile: (address: string) => mockGetPublicProfile(address),
  }),
}));

jest.mock('@/services/api/qnsClient', () => ({
  resolveClaimedNames: (names: string[]) => mockResolveClaimedNames(names),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { DirectMessagesList } from '@/components/Chat/DirectMessagesList';
import { renderWithProviders } from '@/jest/renderWithProviders';

// More conversations than the cap, each with a distinct address and a
// distinct, increasing timestamp — `filteredConversations` sorts
// most-recent-first, so index 0 (oldest) is expected to fall OUTSIDE the
// bound and index `TOTAL - 1` (newest) the one expected inside.
function makeConversations(): Conversation[] {
  return Array.from({ length: TOTAL }, (_, i) => ({
    conversationId: `conv-${i}`,
    // Clearly synthetic bulk fixture data, not a real or plausible account
    // address — only used here to give each row a distinct cache key, never
    // rendered as a claim or asserted on by name.
    address: `QmDmFetchBoundTest${String(i).padStart(3, '0')}${'A'.repeat(23)}`,
    displayName: '',
    icon: '',
    type: 'direct' as const,
    source: 'quorum' as const,
    timestamp: 1_700_000_000_000 + i,
  }));
}

let queryClient: QueryClient;

describe('DirectMessagesList — bounded fetch fan-out', () => {
  beforeEach(() => {
    mockGetPublicProfile = jest.fn().mockResolvedValue(null);
    mockResolveClaimedNames = jest.fn().mockResolvedValue({});
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it(`issues at most ${MAX_QNS_LOOKUPS} profile requests for ${TOTAL} conversations`, async () => {
    renderWithProviders(
      <QueryClientProvider client={queryClient}>
        <IdentityScopeProvider rostersBySpace={{}} selfAddress={null}>
          <DirectMessagesList
            conversations={makeConversations()}
            onSelectConversation={() => {}}
            theme={DarkTheme}
          />
        </IdentityScopeProvider>
      </QueryClientProvider>,
    );

    // Every row renders regardless of the bound (FlashList mounts a plain
    // JS array's `renderItem` synchronously in a test environment, no real
    // virtualization) — the empty-state text must NOT appear, confirming
    // all `TOTAL` rows genuinely mounted rather than the list rendering
    // empty for an unrelated reason and vacuously issuing zero requests.
    expect(screen.queryByText('No conversations yet')).toBeNull();

    await waitFor(() => expect(mockGetPublicProfile).toHaveBeenCalledTimes(MAX_QNS_LOOKUPS));
  });
});
