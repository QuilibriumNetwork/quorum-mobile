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
 * Neither test supplies a `displayName` at all (the prop no longer exists):
 * both render the sheet from an `address` only. Two separate `it` blocks,
 * deliberately not one — an earlier version of this file gated the
 * confirmation-copy test on the header's `alice.q` text appearing first, as
 * a "wait for the fetch to settle" signal. Against pre-migration code that
 * signal never fires at all (no `displayName` was ever passed, so `alice.q`
 * never renders anywhere), which meant the test failed on that unrelated
 * precondition and never actually reached the confirmation-copy assertion —
 * pinning nothing about the row's actual defect. Splitting the two apart, and
 * having the confirmation-copy test retry the press itself instead of
 * waiting on the header, is what makes each test fail for the reason it
 * claims to.
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

// `claimedNameBelongsTo` is deliberately NOT mocked — the verified case
// must prove a genuinely verified claim renders `.q`, not merely that the
// sheet trusts whatever `verifiedQnsNames` already contains.

import { DMSettingsSheet } from '@/components/Chat/DMSettingsSheet';

let queryClient: QueryClient;

function renderSheet(opts: { showRecipientHeader?: boolean } = {}) {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={{}} selfAddress={null}>
        <DMSettingsSheet
          visible
          onClose={() => {}}
          conversationId="conv-1"
          address={PARTNER}
          showRecipientHeader={opts.showRecipientHeader}
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

  it('renders the partner under their verified .q in the recipient header, when shown', async () => {
    renderSheet({ showRecipientHeader: true });

    await waitFor(() => expect(screen.getAllByText('alice.q').length).toBeGreaterThan(0));
    expect(screen.queryByText('Alice Smith')).toBeNull();
  });

  it('names the partner under their verified .q in the delete-confirmation copy', async () => {
    // Deliberately does NOT gate on the header (or on anything else) settling
    // first. `useConfirmDialog`'s `confirm()` snapshots its `message` into
    // React state at the moment "Delete Conversation" is pressed — it is not
    // reactive, so a press before the enrich fetch resolves would freeze in
    // a stale name forever, no matter how long a `waitFor` afterward runs.
    // The only reliable way to observe the RESOLVED value in the confirm
    // copy is to keep re-opening the dialog until a press catches the
    // fetch already settled: `waitFor` here retries the press itself, not
    // just the assertion, so each attempt re-reads whatever `recipientName`
    // the CURRENT render closes over. This also means the test needs no
    // signal that pre-migration code might never produce (the header used
    // to gate on `alice.q` appearing, which pre-migration code — given no
    // `displayName` prop — never renders at all, hiding this row's actual
    // defect behind an unrelated timeout instead of exercising it).
    //
    // IMPORTANT: if this retry-press pattern is ever changed, the RED must
    // be re-captured. A `waitFor` gating on an unrelated precondition can
    // make the test fail for the WRONG reason (the precondition never
    // settling) while looking, from the failure output alone, similar to
    // the right one (a wrong name in the confirm copy) — that exact
    // confusion is why this test was rewritten.
    renderSheet();

    await waitFor(() => {
      // Once the dialog is open, ITS OWN title is also "Delete Conversation"
      // (the `confirm({ title: ... })` call below), so a second press must
      // target the ActionRow specifically — it renders first in the tree,
      // ahead of `{confirmDialog}`, so index 0 is always the row.
      fireEvent.press(screen.getAllByText('Delete Conversation')[0]);
      expect(
        screen.getByText(/This will delete the conversation with alice\.q from your device only/),
      ).toBeTruthy();
    });

    expect(
      screen.queryByText(/This will delete the conversation with Alice Smith from your device only/),
    ).toBeNull();
    expect(
      screen.queryByText(/This will delete the conversation with QmRxwsci/),
    ).toBeNull();
  });
});
