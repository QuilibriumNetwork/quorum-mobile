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
 * is that `ShareInviteSheet` never calls it — it reads `conv.displayName` raw at
 * line 173. A function-level test cannot see a function that is not called.
 *
 * That is the whole argument for this instrument. Verify it by deleting the
 * `.q` fix later and watching THIS file go red while everything else stays
 * green.
 *
 * ## What is asserted
 *
 * A DM partner who has elected the QNS name `alice` must be listed as `alice.q`,
 * not under the older global name still sitting on their conversation row. A
 * `.q` outranks a global display name everywhere else in the app; this surface
 * is the exception, and it should not be.
 *
 * The conversation row is mocked as ALREADY carrying the QNS name, because the
 * fix has two halves and this test pins the second one. The first half (running
 * the rows through `useConversationsWithQnsNames`, so the name is present at
 * all) is a separate concern with its own coverage; what is pinned here is that
 * once the name IS present, the screen renders it through the resolver instead
 * of reading a raw field. Mocking both hooks keeps the test honest whichever
 * hook the fix ends up calling.
 */

import React from 'react';
import { screen } from '@testing-library/react-native';
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

// Mocked even though the picker does not import it today: the fix is expected
// to route through this hook, and a test that only mocks the CURRENT data path
// would start failing for the wrong reason the moment the fix lands.
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

import ShareInviteSheet from '@/components/ShareInviteSheet';

describe('ShareInviteSheet — the contact picker resolves names', () => {
  /**
   * `it.failing` — this test is EXPECTED to fail, and jest reports it green
   * while it does. The bug is real, filed, and not yet fixed; committing a
   * plainly red test instead would turn the whole suite red and train everyone
   * to ignore it.
   *
   * The property that makes this worth doing rather than skipping: the moment
   * somebody fixes the picker, THIS LINE starts failing, because a `.failing`
   * test that passes is an error. So the fix cannot land silently — jest asks
   * for the marker to be removed. A `skip` would just rot quietly.
   *
   * When the picker is migrated: delete `.failing`, leaving a plain `it`.
   */
  it.failing('lists a partner under their .q, not their older global name', () => {
    renderWithProviders(
      <ShareInviteSheet
        visible
        onClose={() => {}}
        inviteLink="https://example.invalid/invite/abc"
        spaceName="Test Space"
      />,
    );

    expect(screen.getByText('alice.q')).toBeTruthy();
    expect(screen.queryByText('Alice Smith')).toBeNull();
  });
});
