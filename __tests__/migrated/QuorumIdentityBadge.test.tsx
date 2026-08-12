/**
 * QuorumIdentityBadge must never mint its own `.q`.
 *
 * ## The forgery this pins
 *
 * The badge used to compute `${data.primaryUsername}.q` directly off the raw
 * claim returned by the fid-lookup endpoint (`getUserByFarcasterFid`) — a
 * route with no relationship to the identity provider's own verification
 * path. Any Farcaster account whose linked profile merely CLAIMS a primary
 * name got a `.q` rendered next to it, with nothing checking that the name
 * actually resolves back to that account's address.
 *
 * The fix routes the badge through `<MemberName>`, whose `.q` only ever comes
 * from a claim `claimedNameBelongsTo` has verified — and that predicate runs
 * for REAL here (no mock on `@/utils/verifyQnsClaim`), against a genuine
 * derivable ed448 key/address pair reused verbatim from
 * `shareInviteSheetName.test.tsx` / `identityProviderVerification.test.tsx`.
 *
 * ## Why the positive case alone does not pin this
 *
 * When a claim IS genuinely owned, the forged and the verified implementation
 * render the identical string ("alice.q") — the defect is invisible from the
 * honest case. Only the impersonation case can tell them apart: the old code
 * renders "alice.q" for ANY claim, honest or not, while the fixed code must
 * fall back to the unverified global name. That is the test that actually
 * goes red pre-migration; see the row report for the transcript.
 *
 * A per-space-nickname case (the second case the general recipe calls for) is
 * deliberately not added here: this badge has no spaceId of its own — it is a
 * Farcaster-feed surface, not a space member row — and is migrated with
 * `global` set, which bypasses the roster ladder entirely. A nickname
 * scenario would not exercise anything this file's `<MemberName>` mount could
 * ever disagree with.
 */
import React from 'react';
import { screen, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { DarkTheme } from '@/theme';

// A genuine ed448 key/address pair, reused verbatim from
// identityProviderVerification.test.tsx / shareInviteSheetName.test.tsx rather
// than generated fresh — deriveAddress(KEY) === PARTNER, real math, not a
// placeholder. Needed because claimedNameBelongsTo (utils/verifyQnsClaim.ts)
// runs for real here (no mock on it below): a non-derivable placeholder
// address would make every claim fail verification, a different, wrong test.
const PARTNER = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
// An impersonator address, unrelated to KEY — a fixed placeholder, same
// convention as identityProviderVerification.test.tsx's OTHER.
const IMPOSTOR = 'QmThemThemThemThemThemThemThemThemThemThemThem';

// `mock`-prefixed so the jest.mock factories below (hoisted above these
// declarations) may close over them — same convention as
// identityProviderVerification.test.tsx and shareInviteSheetName.test.tsx.
let mockGetUserByFarcasterFid: jest.Mock;
let mockGetPublicProfile: jest.Mock;
let mockResolveBatch: jest.Mock;

jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    // Feeds useQuorumIdentityForFid — the badge's own "is this fid linked"
    // lookup, entirely separate from the identity provider's verification.
    getUserByFarcasterFid: (fid: number) => mockGetUserByFarcasterFid(fid),
    // Feeds the identity provider's enrich fetch. A DIFFERENT endpoint from
    // the one above; the badge's fix depends on this one actually being
    // called for the linked address, which is what `enrich` on <MemberName>
    // triggers.
    getPublicProfile: (address: string) => mockGetPublicProfile(address),
  }),
}));

jest.mock('@/services/api/qnsClient', () => ({
  resolveBatch: (names: string[]) => mockResolveBatch(names),
}));

// `@/utils/verifyQnsClaim` is deliberately NOT mocked. `claimedNameBelongsTo`
// is the ONE predicate that decides whether a claim becomes a `.q`, and
// letting it run for real — against the genuine KEY/PARTNER pair above — is
// what makes the impersonation case below prove a forged claim cannot pass,
// rather than merely proving the badge renders whatever a stubbed predicate
// says.

import { IdentityScopeProvider } from '@/identity/identityProvider';
import { QuorumIdentityBadge } from '@/components/SocialFeed/content/QuorumIdentityBadge';

const linkedIdentity = (over: { address?: string; profile?: Record<string, unknown> } = {}) => ({
  address: over.address ?? PARTNER,
  public_profile: {
    display_name: 'Alice Smith',
    profile_image: '',
    bio: '',
    primary_username: 'alice',
    timestamp: 0,
    signature: '',
    ...over.profile,
  },
});

const publicProfile = (over: Record<string, unknown> = {}) => ({
  display_name: 'Alice Smith',
  profile_image: '',
  bio: '',
  timestamp: 0,
  signature: '',
  primary_username: 'alice',
  ...over,
});

const nameRecord = (over: Record<string, unknown> = {}) => ({
  header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
  address: '0xrecord',
  resolveKey: KEY,
  metadata: null,
  ...over,
});

let queryClient: QueryClient;

function renderBadge(fid = 1) {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={{}} selfAddress={null}>
        <QuorumIdentityBadge fid={fid} theme={DarkTheme} />
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );
}

describe('QuorumIdentityBadge — the .q comes only from a verified claim', () => {
  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockGetUserByFarcasterFid = jest.fn().mockResolvedValue(linkedIdentity());
    mockGetPublicProfile = jest.fn().mockResolvedValue(publicProfile());
    mockResolveBatch = jest.fn().mockResolvedValue([nameRecord()]);
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it('renders the linked account under its verified .q — the follow-global default state', async () => {
    renderBadge();

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
  });

  it('never grants a .q to a linked account whose claim resolves to someone else (impersonation)', async () => {
    // The fid's linked Quorum address is IMPOSTOR, but the resolver's record
    // for 'alice' (unchanged from the mock above) derives back to PARTNER via
    // KEY, not IMPOSTOR — the exact forgery claimedNameBelongsTo exists to
    // catch. This is the CRITICAL-finding proof: with the crypto genuinely
    // running (no mock on @/utils/verifyQnsClaim), a claim that resolves to
    // the wrong address must render the global name, never a `.q`.
    mockGetUserByFarcasterFid.mockResolvedValue(linkedIdentity({ address: IMPOSTOR }));

    renderBadge();

    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeTruthy());
    expect(screen.queryByText('alice.q')).toBeNull();
  });
});
