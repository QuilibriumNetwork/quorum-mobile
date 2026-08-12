/**
 * DMChatHeader must resolve its OWN display name from the counterparty's
 * address, not trust a name string the caller already computed.
 *
 * ## The defect this pins
 *
 * DMChatHeader used to take a caller-resolved `title: string` prop, filled by
 * the DM screen's own pre-`identity/` computation
 * (`resolveConversationTitle` + `useVerifiedQnsNames` in
 * `app/(tabs)/messages/dm/[id].tsx`) — a separate, older resolution path that
 * also verifies claims, so the two usually agree in practice. But the header
 * component itself never called any resolver: it rendered whatever string it
 * was handed, with no way to tell a genuinely resolved name from one a caller
 * forgot to resolve. This test mounts the header directly, supplies ONLY an
 * address, and proves the header resolves through `@/identity` itself.
 *
 * No per-space-nickname case: a DM has no space of its own (see
 * `DirectMessagesList.test.tsx`'s header comment for the same reasoning), and
 * the migration passes `global: true` explicitly, which bypasses the roster
 * tier regardless of any ambient scope.
 */
import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import { DarkTheme } from '@/theme';

// A genuine ed448 key/address pair, reused verbatim from
// identityProviderVerification.test.tsx / shareInviteSheetName.test.tsx rather
// than generated fresh — deriveAddress(KEY) === PARTNER, real math, not a
// placeholder. Needed because `claimedNameBelongsTo` runs for real below (no
// mock on `@/utils/verifyQnsClaim`).
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

// `@/utils/verifyQnsClaim` is deliberately NOT mocked — same reasoning as
// shareInviteSheetName.test.tsx: the verified case must prove a genuinely
// verified claim renders `.q`, not merely that the header trusts whatever
// `verifiedQnsNames` already contains.

import { DMChatHeader } from '@/components/Chat/DMChatHeader';

let queryClient: QueryClient;

function renderHeader() {
  return render(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={{}} selfAddress={null}>
        <DMChatHeader
          address={PARTNER}
          insetTop={0}
          onBack={() => {}}
          onTitlePress={() => {}}
          isFarcasterConversation={false}
          onVideoCall={() => {}}
          onAudioCall={() => {}}
          onOpenSettings={() => {}}
          theme={DarkTheme}
        />
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );
}

describe('DMChatHeader — resolves its own name from the address prop', () => {
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

  it('renders the partner under their verified .q — the follow-global default state', async () => {
    renderHeader();

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    expect(screen.queryByText('Alice Smith')).toBeNull();
  });
});
