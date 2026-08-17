/**
 * Broadcast `.q` claims must reach the identity ladder.
 *
 * A `.q` reaches a viewer by two routes. Route A is the public profile, which
 * is dead server-side (upstream #240 rejects every publish carrying a
 * `primary_username`). Route B is the space/DM broadcast, stored on the local
 * roster row as `claimed_primary_username` — the ONLY functioning route in the
 * product today.
 *
 * `identityProviderVerification.test.tsx` covers Route A end to end through the
 * real provider. Every one of its fixtures supplies a public profile, so none
 * of it could fail if Route B were dropped entirely — which is exactly what the
 * identity migration did: the claim kept arriving, kept being stored, kept
 * being verifiable, and the ladder simply stopped reading it.
 *
 * So this file is Route B, deliberately with NO public profile in the fixtures
 * that test it. `claimedNameBelongsTo` is left UNMOCKED throughout: the
 * impersonation case below is only meaningful if the ed448 derivation genuinely
 * runs and genuinely disagrees.
 */
import React from 'react';
import { Text } from 'react-native';
import { screen, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { CustomThemeProvider } from '@/theme';
import type { RosterNameRow } from '@/identity/identityFromMaps';

// A genuine ed448 key/address pair, shared with identityProviderVerification
// and verifiedQnsNames.test.ts: `deriveAddress(KEY) === ADDRESS`, and never
// anything else. Real math, not a placeholder.
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
const ADDRESS = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const OTHER = 'QmThemThemThemThemThemThemThemThemThemThemThem';
const SPACE = 'space-1';

// `mock`-prefixed so the hoisted jest.mock factories may close over them.
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

import { IdentityScopeProvider } from '@/identity/identityProvider';
import { useResolvedName } from '@/identity/useResolvedName';

const nameRecord = (over: Record<string, unknown> = {}) => ({
  header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
  address: '0xrecord',
  resolveKey: KEY,
  metadata: null,
  ...over,
});

/** Renders what a real surface renders: the resolved name, `.q` suffix and all.
 *  `enrich` is what a bounded surface passes, and it is what drives
 *  `request(address)` — so this probe also exercises the demand-driven path. */
function NameProbe({ address, spaceId }: { address: string; spaceId?: string }) {
  const name = useResolvedName(address, { spaceId, enrich: true });
  return <Text testID={`name-${address}`}>{name}</Text>;
}

let queryClient: QueryClient;

function tree(
  rostersBySpace: Record<string, Record<string, RosterNameRow>>,
  probes: { address: string; spaceId?: string }[],
  conversationClaims?: Record<string, string>,
) {
  return (
    <QueryClientProvider client={queryClient}>
      {/* selfAddress null: nothing here is about self, and leaving it null
          keeps the provider's own mount-effect from adding an address the
          fetch-count assertions would then have to subtract. */}
      <IdentityScopeProvider
        rostersBySpace={rostersBySpace}
        conversationClaims={conversationClaims}
        selfAddress={null}
      >
        {probes.map((p) => (
          <NameProbe key={p.address} address={p.address} spaceId={p.spaceId} />
        ))}
      </IdentityScopeProvider>
    </QueryClientProvider>
  );
}

function renderProbes(
  rostersBySpace: Record<string, Record<string, RosterNameRow>>,
  probes: { address: string; spaceId?: string }[],
  conversationClaims?: Record<string, string>,
) {
  const result = renderWithProviders(tree(rostersBySpace, probes, conversationClaims));
  return {
    ...result,
    /** Re-render with a NEW roster, as a fresh broadcast would produce. The
     *  theme wrapper is repeated because RTL's `rerender` replaces the ROOT
     *  element, and `renderWithProviders` applied that wrapper internally. */
    updateRosters: (
      next: Record<string, Record<string, RosterNameRow>>,
      nextClaims?: Record<string, string>,
    ) =>
      result.rerender(
        <CustomThemeProvider defaultAccentColor="blue" defaultAppearance="dark">
          {tree(next, probes, nextClaims)}
        </CustomThemeProvider>,
      ),
  };
}

const nameOf = (address: string) =>
  screen.getByTestId(`name-${address}`).props.children as string;

describe('IdentityScopeProvider — broadcast (roster) .q claims', () => {
  beforeEach(() => {
    mockGetPublicProfile = jest.fn().mockResolvedValue(null);
    mockResolveBatch = jest.fn().mockResolvedValue([]);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    // `cleanup()` before `clear()`, so the tree unmounts and each query's last
    // observer drops before the cache is destroyed — RTL's own auto-cleanup
    // runs in an OUTER, later-firing afterEach. Same reasoning as
    // identityProviderVerification.test.tsx, which documents it at length.
    cleanup();
    queryClient.clear();
  });

  it('renders a .q from a roster claim when there is NO public profile at all', async () => {
    // The regression in one test. Route A returns nothing, as it does for every
    // user in production today; the name has to come from the broadcast or not
    // at all.
    mockResolveBatch.mockResolvedValue([nameRecord()]);

    renderProbes(
      { [SPACE]: { [ADDRESS]: { global_display_name: 'Global', claimed_primary_username: 'alice' } } },
      [{ address: ADDRESS, spaceId: SPACE }],
    );

    await waitFor(() => expect(nameOf(ADDRESS)).toBe('alice.q'));
    expect(mockGetPublicProfile).toHaveBeenCalledWith(ADDRESS);
  });

  it('never renders a roster claim that resolves to a DIFFERENT address (impersonation)', async () => {
    // OTHER broadcasts a claim on 'alice', but the resolver's record for
    // 'alice' derives back to ADDRESS. Anyone in your space can broadcast any
    // claim, so this check is the only thing between that and a forged `.q`.
    mockResolveBatch.mockResolvedValue([nameRecord()]);

    renderProbes(
      { [SPACE]: { [OTHER]: { global_display_name: 'Impostor', claimed_primary_username: 'alice' } } },
      [{ address: OTHER, spaceId: SPACE }],
    );

    await waitFor(() => expect(mockResolveBatch).toHaveBeenCalled());
    expect(nameOf(OTHER)).toBe('Impostor');
  });

  it('leaves a roster claim unrendered while its lookup is still in flight', async () => {
    // Unproven includes NOT-YET-KNOWN. A `.q` shown for the instant before a
    // lookup lands is the whole attack; a screenshot of that instant does not
    // expire.
    let releaseBatch: (records: unknown[]) => void = () => {};
    mockResolveBatch.mockImplementation(
      () => new Promise((resolve) => { releaseBatch = resolve; }),
    );

    renderProbes(
      { [SPACE]: { [ADDRESS]: { global_display_name: 'Global', claimed_primary_username: 'alice' } } },
      [{ address: ADDRESS, spaceId: SPACE }],
    );

    await waitFor(() => expect(mockResolveBatch).toHaveBeenCalled());
    expect(nameOf(ADDRESS)).toBe('Global');

    // Prove the pending state was pending, not permanently broken.
    releaseBatch([nameRecord()]);
    await waitFor(() => expect(nameOf(ADDRESS)).toBe('alice.q'));
  });

  it('lets an EMPTY roster claim un-elect a name the public profile still carries', async () => {
    // Presence, not truthiness. An empty broadcast claim is an un-election and
    // must beat a public profile that still carries the old name — otherwise
    // dropping your primary name changes nothing for anybody else, which is
    // the failure `NO_PRIMARY_NAME` exists to prevent on the sending side.
    //
    // Driven as a SEQUENCE rather than asserted on a single render, because a
    // one-shot assertion here passes for the wrong reason: before the profile
    // promise settles there is no claim to look up, so "no `.q`" is true for a
    // moment in every implementation, including one that ignores the roster
    // entirely. Rendering the `.q` FIRST is what makes the second half real.
    mockGetPublicProfile.mockResolvedValue({
      display_name: 'Global',
      profile_image: '',
      bio: '',
      timestamp: 0,
      signature: '',
      primary_username: 'alice',
    });
    mockResolveBatch.mockResolvedValue([nameRecord()]);

    const { updateRosters } = renderProbes(
      { [SPACE]: { [ADDRESS]: { global_display_name: 'Global' } } },
      [{ address: ADDRESS, spaceId: SPACE }],
    );

    // The profile claim verified and is on screen. This is the control arm:
    // without it the assertion below cannot distinguish "un-elected" from
    // "nothing had loaded yet".
    await waitFor(() => expect(nameOf(ADDRESS)).toBe('alice.q'));

    // The un-election arrives over the broadcast and lands on the roster row.
    updateRosters({
      [SPACE]: { [ADDRESS]: { global_display_name: 'Global', claimed_primary_username: '' } },
    });

    await waitFor(() => expect(nameOf(ADDRESS)).toBe('Global'));
  });

  it('falls back to the public-profile claim when the roster carries no field at all', async () => {
    // ABSENT is not EMPTY. A member whose claim only ever arrived over Route A
    // must keep rendering exactly as before this change.
    mockGetPublicProfile.mockResolvedValue({
      display_name: 'Global',
      profile_image: '',
      bio: '',
      timestamp: 0,
      signature: '',
      primary_username: 'alice',
    });
    mockResolveBatch.mockResolvedValue([nameRecord()]);

    renderProbes(
      { [SPACE]: { [ADDRESS]: { global_display_name: 'Global' } } },
      [{ address: ADDRESS, spaceId: SPACE }],
    );

    await waitFor(() => expect(nameOf(ADDRESS)).toBe('alice.q'));
  });

  it('lets a deliberate per-space nickname outrank the .q', async () => {
    // The control arm. If everything converges on the `.q`, precedence has been
    // inverted and a green run means nothing.
    mockResolveBatch.mockResolvedValue([nameRecord()]);

    renderProbes(
      {
        [SPACE]: {
          [ADDRESS]: {
            display_name: 'Nickname',
            global_display_name: 'Global',
            claimed_primary_username: 'alice',
          },
        },
      },
      [{ address: ADDRESS, spaceId: SPACE }],
    );

    await waitFor(() => expect(mockResolveBatch).toHaveBeenCalled());
    expect(nameOf(ADDRESS)).toBe('Nickname');
  });

  it('does not let a per-space name that merely echoes the global name bury the .q', async () => {
    // The name copied into the roster at join is not a deliberate choice.
    // `resolveIdentity` demotes it via its `space !== global` guard; this pins
    // that the roster claim still reaches the ladder underneath it.
    mockResolveBatch.mockResolvedValue([nameRecord()]);

    renderProbes(
      {
        [SPACE]: {
          [ADDRESS]: {
            display_name: 'Global',
            global_display_name: 'Global',
            claimed_primary_username: 'alice',
          },
        },
      },
      [{ address: ADDRESS, spaceId: SPACE }],
    );

    await waitFor(() => expect(nameOf(ADDRESS)).toBe('alice.q'));
  });

  it('never looks up a roster claim for an address nothing asked to resolve', async () => {
    // The bound, asserted as a NUMBER. A roster is unbounded by anything the
    // user did — a 5,000-member space would otherwise mean thousands of claims
    // fed into the verifier the moment any surface in that space mounts. That
    // is the fetch storm both clients already refused once, arriving by a new
    // route.
    const CLAIMANTS = 200;
    const roster: Record<string, RosterNameRow> = {};
    for (let i = 0; i < CLAIMANTS; i++) {
      roster[`QmBystander${i}`] = {
        global_display_name: `Bystander ${i}`,
        claimed_primary_username: `bystander${i}`,
      };
    }
    roster[ADDRESS] = { global_display_name: 'Global', claimed_primary_username: 'alice' };
    mockResolveBatch.mockResolvedValue([nameRecord()]);

    // Only ADDRESS is probed, so only ADDRESS is requested. The other 200 sit
    // in the same roster and must cost nothing.
    renderProbes({ [SPACE]: roster }, [{ address: ADDRESS, spaceId: SPACE }]);

    await waitFor(() => expect(nameOf(ADDRESS)).toBe('alice.q'));

    expect(mockGetPublicProfile).toHaveBeenCalledTimes(1);
    for (const call of mockResolveBatch.mock.calls) {
      expect(call[0]).toEqual(['alice']);
    }
  });
});

/**
 * The DM half of the same transport.
 *
 * A DM has no roster. The partner's broadcast claim lands on the CONVERSATION
 * row instead (`WebSocketContext`'s `dm-update-profile` handler writes
 * `claimed_primary_username` there), and a DM surface resolves with no
 * `spaceId`, so `identityFromMaps` consults no roster row at all. Wiring only
 * rosters would leave every DM-only partner without a `.q` — and a DM is
 * exactly where two people who share no space meet.
 */
describe('IdentityScopeProvider — broadcast .q claims from a DM conversation', () => {
  beforeEach(() => {
    mockGetPublicProfile = jest.fn().mockResolvedValue(null);
    mockResolveBatch = jest.fn().mockResolvedValue([]);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it('renders a .q for a DM partner with no roster and no public profile', async () => {
    mockResolveBatch.mockResolvedValue([nameRecord()]);

    // No rosters at all, no spaceId on the probe: a pure DM.
    renderProbes({}, [{ address: ADDRESS }], { [ADDRESS]: 'alice' });

    await waitFor(() => expect(nameOf(ADDRESS)).toBe('alice.q'));
  });

  it('never renders a DM claim that resolves to a DIFFERENT address', async () => {
    // Same gate as the roster path, and it has to be the same one: a DM
    // partner is the single easiest person to impersonate, because there is no
    // roster to cross-check against.
    mockGetPublicProfile.mockResolvedValue({
      display_name: 'Impostor',
      profile_image: '',
      bio: '',
      timestamp: 0,
      signature: '',
    });
    mockResolveBatch.mockResolvedValue([nameRecord()]);

    renderProbes({}, [{ address: OTHER }], { [OTHER]: 'alice' });

    await waitFor(() => expect(mockResolveBatch).toHaveBeenCalled());
    // Wait for the NAME to settle, not just for the lookup to fire. A DM has no
    // roster, so `Impostor` arrives with the fetched profile — while the claim
    // comes from `conversationClaims`, which is there on the first render. The
    // batch therefore fires BEFORE the profile lands, and asserting straight
    // after it flaked ~40% of runs on a truncated address. The `.q` assertion
    // was true either way, which is what made it look green.
    await waitFor(() => expect(nameOf(OTHER)).toBe('Impostor'));
    // Both inputs have now landed, so this is the settled answer, not a
    // snapshot of a moment before the claim could have been promoted.
    expect(nameOf(OTHER)).not.toMatch(/\.q$/);
  });

  it('lets an EMPTY DM claim un-elect a name the public profile still carries', async () => {
    // Same sequence-driven shape as the roster un-election test, and for the
    // same reason: a single-render assertion here would pass on a build that
    // ignores DM claims entirely.
    mockGetPublicProfile.mockResolvedValue({
      display_name: 'Global',
      profile_image: '',
      bio: '',
      timestamp: 0,
      signature: '',
      primary_username: 'alice',
    });
    mockResolveBatch.mockResolvedValue([nameRecord()]);

    const { updateRosters } = renderProbes({}, [{ address: ADDRESS }], {});

    await waitFor(() => expect(nameOf(ADDRESS)).toBe('alice.q'));

    updateRosters({}, { [ADDRESS]: '' });

    await waitFor(() => expect(nameOf(ADDRESS)).toBe('Global'));
  });

  it('never looks up a DM claim for an address nothing asked to resolve', async () => {
    // Same bound as the roster path. An inbox scrolled far enough carries
    // hundreds of partners; only the ones a surface actually resolves may cost
    // anything.
    const claims: Record<string, string> = {};
    for (let i = 0; i < 200; i++) claims[`QmBystander${i}`] = `bystander${i}`;
    claims[ADDRESS] = 'alice';
    mockResolveBatch.mockResolvedValue([nameRecord()]);

    renderProbes({}, [{ address: ADDRESS }], claims);

    await waitFor(() => expect(nameOf(ADDRESS)).toBe('alice.q'));

    expect(mockGetPublicProfile).toHaveBeenCalledTimes(1);
    for (const call of mockResolveBatch.mock.calls) {
      expect(call[0]).toEqual(['alice']);
    }
  });
});
