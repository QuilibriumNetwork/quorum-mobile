/**
 * DirectMessagesList must not fall back to a stored placeholder or a
 * hand-rolled truncated address for a Quorum DM row.
 *
 * ## The defect this pins
 *
 * `DMConversationItem` used to compute its label as
 * `item.displayName || truncateAddress(item.address, 'long') || 'Unknown'` —
 * two fallbacks of its own, layered in front of the resolver's:
 *
 * - `'Unknown'` is a stored placeholder rendered verbatim. It is worse than
 *   the resolver's own fallback because it reads as though the app genuinely
 *   has no idea who this is, when the resolver could still answer from a
 *   published profile even though nothing was ever stored on the row.
 * - `truncateAddress(item.address, 'long')` is a stored raw ADDRESS rendered
 *   as if it were a name — the same class one step further along, and it
 *   even disagrees with the resolver's own fallback FORMAT (`'long'`, 8+6
 *   chars, vs the resolver's `'medium'`, 6+4), so the two would show visibly
 *   different truncations for the identical unresolved address.
 *
 * ## No per-space-nickname case
 *
 * The general recipe's second case (a per-space nickname, no `.q`) does not
 * apply here: this surface is DM-only — there is no space a DM row could ever
 * carry a roster entry in — and the migration passes `global: true`
 * explicitly, which bypasses the roster tier regardless of any ambient scope.
 * A nickname scenario would not exercise anything this component could ever
 * disagree with.
 *
 * ## Farcaster rows are a different identity namespace and stay untouched
 *
 * A Farcaster conversation's `address` field is a synthetic `fid:<n>` string
 * (see `hooks/chat/useFarcasterDirectCasts.ts`), never a Quorum address — a
 * different namespace with no roster and no `.q`. Routing it through the
 * identity resolver would look up a Quorum profile for a string that names
 * nobody. Farcaster rows keep their own already-resolved `displayName` field;
 * only a Quorum row's raw field routes through `useResolvedName`.
 */
import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import { DarkTheme } from '@/theme';
import type { Conversation } from '@/hooks/chat';

// A genuine ed448 key/address pair, reused verbatim from
// identityProviderVerification.test.tsx / shareInviteSheetName.test.tsx rather
// than generated fresh — deriveAddress(KEY) === PARTNER, real math.
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

// `claimedNameBelongsTo` is deliberately NOT mocked, same as
// identityProviderVerification.test.tsx: the verified case below must prove a
// genuinely verified claim renders `.q`, not merely that the screen trusts
// whatever `verifiedQnsNames` already contains.

import { DirectMessagesList } from '@/components/Chat/DirectMessagesList';

const publicProfile = (over: Record<string, unknown> = {}) => ({
  display_name: 'Alice Smith',
  profile_image: '',
  bio: '',
  timestamp: 0,
  signature: '',
  ...over,
});

const nameRecord = (over: Record<string, unknown> = {}) => ({
  header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
  address: '0xrecord',
  resolveKey: KEY,
  metadata: null,
  ...over,
});

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  conversationId: 'conv-1',
  address: PARTNER,
  // Nothing stored on the row itself — every case in this file is about what
  // the RESOLVER contributes, not what the row already carries.
  displayName: '',
  icon: '',
  type: 'direct',
  source: 'quorum',
  timestamp: 1_700_000_000_000,
  ...over,
});

let queryClient: QueryClient;

function renderRows(conversations: Conversation[]) {
  return render(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={{}} selfAddress={null}>
        <DirectMessagesList
          conversations={conversations}
          onSelectConversation={() => {}}
          theme={DarkTheme}
        />
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );
}

describe('DirectMessagesList — no placeholder, no hand-rolled truncation', () => {
  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockGetPublicProfile = jest.fn().mockResolvedValue(publicProfile({ primary_username: 'alice' }));
    mockResolveBatch = jest.fn().mockResolvedValue([nameRecord()]);
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it('renders a Quorum row under its verified .q — the follow-global default state', async () => {
    renderRows([conversation()]);

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
  });

  it('renders the published global name instead of the stored "Unknown" placeholder', async () => {
    // Nothing was ever stored on the conversation row, but the resolver still
    // has something to say: a published profile with a global display name.
    // The old code's own `|| 'Unknown'` could not see that; the resolver can.
    mockGetPublicProfile.mockResolvedValue(publicProfile({ primary_username: undefined }));
    mockResolveBatch.mockResolvedValue([]);

    renderRows([conversation()]);

    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeTruthy());
    expect(screen.queryByText('Unknown')).toBeNull();
  });

  it('falls back to the resolver\'s own truncated address, not a hand-rolled one, when nothing resolves', async () => {
    // No public profile at all (a legitimate "no profile" answer, not a
    // pending fetch) and no claim to verify.
    mockGetPublicProfile.mockResolvedValue(null);
    mockResolveBatch.mockResolvedValue([]);

    renderRows([conversation()]);

    // The resolver's own fallback: truncateAddress(address) with no mode
    // argument, i.e. 'medium' (6+4 chars) — not DMConversationItem's old
    // hand-rolled truncateAddress(address, 'long') (8+6 chars), which would
    // have rendered "QmRxwsciKW…ogXDYW" instead.
    await waitFor(() => expect(screen.getByText('QmRxwsci…XDYW')).toBeTruthy());
    expect(screen.queryByText('QmRxwsciKW…ogXDYW')).toBeNull();
    expect(screen.queryByText('Unknown')).toBeNull();
  });
});
