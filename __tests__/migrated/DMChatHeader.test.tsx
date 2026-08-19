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
// mock on `claimedNameBelongsTo`).
const PARTNER = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';

let mockGetPublicProfile: jest.Mock;
let mockResolveBatch: jest.Mock;
let mockGetUserByFarcasterFid: jest.Mock;

jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    getPublicProfile: (address: string) => mockGetPublicProfile(address),
    getUserByFarcasterFid: (fid: number) => mockGetUserByFarcasterFid(fid),
  }),
}));

jest.mock('@/services/api/qnsClient', () => ({
  resolveBatch: (names: string[]) => mockResolveBatch(names),
}));

// `claimedNameBelongsTo` is deliberately NOT mocked — same reasoning as
// shareInviteSheetName.test.tsx: the verified case must prove a genuinely
// verified claim renders `.q`, not merely that the header trusts whatever
// `verifiedQnsNames` already contains.

import { DMChatHeader } from '@/components/Chat/DMChatHeader';

let queryClient: QueryClient;

function renderHeader(
  overrides: Partial<React.ComponentProps<typeof DMChatHeader>> = {},
) {
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
          {...overrides}
        />
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );
}

// Top level, NOT inside a describe. A per-describe `beforeEach` leaves every
// later block sharing whatever QueryClient the previous one last built, and a
// react-query cache outlives a mock reassignment: a query already resolved
// under the old mock is still FRESH (this one holds for 30 minutes), so it
// never refetches and the new mock is never consulted. That produced a test
// that failed for a reason that had nothing to do with the code under test.
beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Address-AWARE, deliberately. A blanket `mockResolvedValue` answers for any
  // argument, including a Farcaster fid — so under a reverted fix the ladder
  // resolved a fid to "Alice Smith" and the Farcaster tests passed/failed for
  // the wrong reason, pinning "the routing changed" rather than "the raw fid
  // reached the screen". The server has no profile for a fid; this says so.
  mockGetPublicProfile = jest.fn(async (address: string) =>
    address?.startsWith('Qm') ? {
    display_name: 'Alice Smith',
    primary_username: 'alice',
    profile_image: '',
    bio: '',
    timestamp: 0,
    signature: '',
    } : null,
  );
  mockResolveBatch = jest.fn().mockResolvedValue([
    {
      header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
      address: '0xrecord',
      resolveKey: KEY,
      metadata: null,
    },
  ]);
  // Default: this fid has no linked Quorum identity — the common case, and
  // what the endpoint answers with for most Farcaster users.
  mockGetUserByFarcasterFid = jest.fn().mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe('DMChatHeader — resolves its own name from the address prop', () => {
  it('renders the partner under their verified .q — the follow-global default state', async () => {
    renderHeader();

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    expect(screen.queryByText('Alice Smith')).toBeNull();
  });
});

/**
 * The Farcaster half of the same bar — a second identity namespace that the
 * ladder must not be pointed at, and the linked-Quorum badge that is the
 * ONLY sanctioned way a `.q` reaches this screen.
 *
 * ## The defect the first test pins
 *
 * A Farcaster conversation's `address` is a synthetic `fid:<n>` string. The
 * header resolved it like any other address; no tier matched; the truncating
 * fallback returned the short string unchanged, and the bar read
 * "fid:9999001" where a name belongs. Nothing threw and nothing logged — the
 * conversation LIST beside it went on showing the right name the whole time,
 * because it branches on `source === 'farcaster'` and this bar did not.
 *
 * ## Why the badge is a badge and not the name
 *
 * The link runs fid → server `/users/by-fid/:fid` → Quorum address → ladder.
 * The `.q` that comes back belongs to the Quorum account, and is shown BESIDE
 * the Farcaster name, never in place of it: the person's Farcaster identity is
 * what this conversation is actually with, and replacing it would hide which
 * account is being messaged. Same rule the feed surfaces already follow.
 */
describe('DMChatHeader — a Farcaster conversation is a different namespace', () => {
  const FC_ADDRESS = 'fid:9999001';

  it('renders the Farcaster name, not the synthetic fid address', async () => {
    renderHeader({
      address: FC_ADDRESS,
      displayName: 'Cassie',
      isFarcasterConversation: true,
      farcasterFid: 9999001,
    });

    await waitFor(() => expect(screen.getByText('Cassie')).toBeTruthy());
    // The raw fid — what the ladder's truncating fallback returns for a
    // Farcaster id, and what shipped on screen before the fix.
    expect(screen.queryByText(FC_ADDRESS)).toBeNull();
  });

  it('never resolves the fid against the Quorum ladder', async () => {
    renderHeader({
      address: FC_ADDRESS,
      displayName: 'Cassie',
      isFarcasterConversation: true,
      farcasterFid: 9999001,
    });

    await waitFor(() => expect(screen.getByText('Cassie')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 10));
    // The ladder's enrich pass would have fetched a public profile for the
    // address it was given. The fid→address link endpoint is a DIFFERENT
    // call and is allowed (asserted below).
    expect(mockGetPublicProfile).not.toHaveBeenCalledWith(FC_ADDRESS);
  });

  it('shows the linked Quorum .q as a badge beneath the Farcaster name when the profiles are merged', async () => {
    mockGetUserByFarcasterFid = jest.fn().mockResolvedValue({
      address: PARTNER,
      public_profile: { display_name: 'Alice Smith', primary_username: 'alice' },
    });

    renderHeader({
      address: FC_ADDRESS,
      displayName: 'Cassie',
      isFarcasterConversation: true,
      farcasterFid: 9999001,
    });

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
    // Beside, not instead of — both are on screen at once.
    expect(screen.getByText('Cassie')).toBeTruthy();
    expect(mockGetUserByFarcasterFid).toHaveBeenCalledWith(9999001);
  });

  it('announces the linked identity to a screen reader, not only to sighted users', async () => {
    mockGetUserByFarcasterFid = jest.fn().mockResolvedValue({
      address: PARTNER,
      public_profile: { display_name: 'Alice Smith', primary_username: 'alice' },
    });

    renderHeader({
      address: FC_ADDRESS,
      displayName: 'Cassie',
      isFarcasterConversation: true,
      farcasterFid: 9999001,
    });

    // The badge's text is inside the title's touchable, whose explicit
    // accessibilityLabel suppresses announcement of its descendants — so the
    // label itself has to carry it, or the feature is sighted-only.
    await waitFor(() =>
      expect(
        screen.getByLabelText("Open Cassie's profile. Linked Quorum identity: alice.q"),
      ).toBeTruthy(),
    );
  });

  it('leaves the label alone when there is no linked identity to announce', async () => {
    renderHeader({
      address: FC_ADDRESS,
      displayName: 'Cassie',
      isFarcasterConversation: true,
      farcasterFid: 9999001,
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Open Cassie's profile")).toBeTruthy(),
    );
  });

  it('stays a plain one-line title when the fid has no linked Quorum identity', async () => {
    renderHeader({
      address: FC_ADDRESS,
      displayName: 'Cassie',
      isFarcasterConversation: true,
      farcasterFid: 9999001,
    });

    await waitFor(() => expect(screen.getByText('Cassie')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText(/\.q$/)).toBeNull();
  });

  it('shows no badge for a group, whose counterparty fid describes one member and not the conversation', async () => {
    mockGetUserByFarcasterFid = jest.fn().mockResolvedValue({
      address: PARTNER,
      public_profile: { display_name: 'Alice Smith', primary_username: 'alice' },
    });

    // The screen withholds `farcasterFid` for a group; this proves the header
    // does nothing with a fid it was not given, rather than reaching for one.
    renderHeader({
      address: FC_ADDRESS,
      displayName: 'Founders chat',
      isFarcasterConversation: true,
    });

    await waitFor(() => expect(screen.getByText('Founders chat')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 10));
    expect(mockGetUserByFarcasterFid).not.toHaveBeenCalled();
    expect(screen.queryByText('alice.q')).toBeNull();
  });
});
