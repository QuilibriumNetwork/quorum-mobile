/**
 * DMSettingsSheet must resolve its OWN display name from the counterparty's
 * address — in the header AND, more importantly, inside destructive-action
 * confirmation copy.
 *
 * ## The defect this pins
 *
 * The sheet used to take a caller-resolved `displayName: string` prop and
 * render it verbatim, including inside the "Delete Conversation" and "Fix
 * Encryption" confirm-dialog messages. A user confirming "delete the
 * conversation with <name>" is being asked to approve something against a
 * name they cannot independently verify — the confirmation copy is the
 * surface that actually matters here, not just the header text above it.
 *
 * This test never supplies a `displayName` at all (the prop no longer
 * exists): it renders the sheet from an `address` only, opens the delete
 * confirmation, and proves the message names the partner under their
 * verified `.q` — pulled from `@/identity`, not from anything the caller
 * handed in.
 *
 * No per-space-nickname case: a DM has no space of its own, and the
 * migration passes `global: true` explicitly, which bypasses the roster tier
 * regardless of any ambient scope. Same reasoning as
 * `DirectMessagesList.test.tsx`.
 */
import React from 'react';
import { screen, waitFor, fireEvent, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { IdentityScopeProvider } from '@/identity/identityProvider';

// Same genuine ed448 key/address pair as DMChatHeader.test.tsx /
// shareInviteSheetName.test.tsx — deriveAddress(KEY) === PARTNER, real math.
const PARTNER = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';

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

// `resetDMSession` transitively imports StorageContext -> mmkvAdapter ->
// configService -> the native-provider, which reaches `requireNativeModule
// ('QuorumCrypto')` at import time and crashes under jest. The sheet only
// calls this from the (untested-here) "Fix Encryption" row; a plain stub is
// enough to let the module graph load.
jest.mock('@/hooks/chat/useSendDirectMessage', () => ({
  resetDMSession: jest.fn(),
}));

// `@/utils/verifyQnsClaim` is deliberately NOT mocked — the verified case
// must prove a genuinely verified claim renders `.q`, not merely that the
// sheet trusts whatever `verifiedQnsNames` already contains.

import { DMSettingsSheet } from '@/components/Chat/DMSettingsSheet';

let queryClient: QueryClient;

function renderSheet() {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={{}} selfAddress={null}>
        <DMSettingsSheet
          visible
          onClose={() => {}}
          conversationId="conv-1"
          address={PARTNER}
          // Shows the header's name text too, so the test has an on-screen
          // signal that the async enrich fetch has settled before it presses
          // "Delete Conversation" — the confirm dialog snapshots its message
          // at press time, so pressing before the fetch resolves would (like
          // the OLD caller-supplied-prop code) show a still-resolving name.
          // That is a real, pre-existing property of a confirm dialog
          // capturing state at open time, not something this migration
          // introduces or is meant to fix, so the test waits it out rather
          // than racing it.
          showRecipientHeader
          theme={require('@/theme').DarkTheme}
        />
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );
}

describe('DMSettingsSheet — resolves its own name, including confirmation copy', () => {
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

  it('names the partner under their verified .q in the delete-confirmation copy', async () => {
    renderSheet();

    // Wait for the enrich fetch to settle (visible via the header's own
    // resolved name) before pressing Delete — see renderSheet()'s comment.
    await waitFor(() => expect(screen.getAllByText('alice.q').length).toBeGreaterThan(0));

    fireEvent.press(screen.getByText('Delete Conversation'));

    await waitFor(() =>
      expect(
        screen.getByText(/This will delete the conversation with alice\.q from your device only/),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByText(/This will delete the conversation with Alice Smith from your device only/),
    ).toBeNull();
    expect(
      screen.queryByText(/This will delete the conversation with QmRxwsci/),
    ).toBeNull();
  });
});
