/**
 * `RootIdentityScope` is the concrete component mounted in `app/_layout.tsx`.
 * `rootIdentityScope.test.tsx` pins `IdentityScopeProvider`/`MemberName`
 * directly with hand-built fixtures — it never imports `RootIdentityScope`
 * or `useMultiSpaceRosters`, so it cannot catch a wiring regression: auth,
 * spaces or rosters silently not reaching the provider, or a future refactor
 * that re-nests `RootIdentityScope` inside one of the app-level overlays
 * instead of wrapping all three as siblings — the exact shape of bug desktop
 * shipped, which is why this component exists. This file pins the WIRING
 * itself: that `RootIdentityScope`, given real hook data, produces a working
 * ladder for a descendant that mounts no provider of its own.
 *
 * `RootIdentityScope` lives in `identity/RootIdentityScope.tsx` rather than
 * inline in `app/_layout.tsx` specifically so it CAN be imported here:
 * importing `app/_layout.tsx` pulls in `components/Call` -> `react-native-webrtc`,
 * which throws `NativeEventEmitter requires a non-null argument` under jest.
 *
 * It imports `useAuth`/`useSpaces` from the SPECIFIC files
 * (`@/context/AuthContext`, `@/hooks/chat/useSpaces`), not the `@/context` /
 * `@/hooks/chat` barrels — both barrels transitively reach real
 * AuthContext/StorageContext code that needs a native crypto module jest
 * cannot satisfy (`Cannot find native module 'QuorumCrypto'`, via
 * `services/offline/storage.ts` -> `services/config` ->
 * `services/crypto/native-provider.ts`). It is also why `identity/index.ts`
 * does NOT re-export `RootIdentityScope` — see `identityBarrelSafety.test.tsx`.
 * The mocks below target those same specific files for that reason.
 */
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const ADDR = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const SELF_ADDR = 'QmMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMe';
const PARTNER = 'QmThemThemThemThemThemThemThemThemThemThemTh';

// A genuine ed448 key/address pair: `deriveAddress(QNS_KEY) === QNS_PARTNER`,
// and never anything else. Shared with identityProviderRosterClaims.test.tsx.
// Needed here because the claim check below is left UNMOCKED — a placeholder
// address could never verify, so the `.q` assertion would be untestable.
const QNS_KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
const QNS_PARTNER = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';

type MockUser = { address: string; displayName?: string } | null;
let mockUser: MockUser;
let mockSpaces: Array<{ spaceId: string }>;
let mockRosters: Record<string, Record<string, { display_name?: string; global_display_name?: string }>>;
let mockConversations: {
  address?: string;
  displayName?: string;
  claimed_primary_username?: string | null;
}[];
// `mock`-prefixed so the hoisted factories below may close over them.
let mockGetPublicProfile: jest.Mock;
let mockResolveBatch: jest.Mock;

// Mocked at the SPECIFIC file `RootIdentityScope.tsx` imports, not the
// `@/context` / `@/hooks/chat` barrels — those barrels transitively reach
// real AuthContext/StorageContext code that needs a native crypto module
// jest cannot satisfy (see identityBarrelSafety.test.tsx). Mocking the
// barrel here would silently stop intercepting the moment the import
// narrows, and this file would start failing at import time instead of at
// an assertion — worth the specificity.
jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));
jest.mock('@/hooks/chat/useSpaces', () => ({
  useSpaces: () => ({ data: mockSpaces }),
}));
jest.mock('@/hooks/useMultiSpaceRosters', () => ({
  useMultiSpaceRosters: () => mockRosters,
}));
// Same specific-file reasoning as above: `@/hooks/chat` is one of the barrels
// that reaches the native crypto module. Shaped like the real infinite query
// (`{ data: { pages: [{ conversations }] } }`) rather than a flat array, so a
// refactor that stops flattening pages fails here instead of silently
// resolving nothing.
jest.mock('@/hooks/chat/useConversations', () => ({
  useConversations: () => ({ data: { pages: [{ conversations: mockConversations }] } }),
}));

// The provider's two network seams. Only the `.q` test below reaches them —
// every other test here resolves without `enrich`, so nothing is requested and
// neither mock is ever called. `@/utils/verifyQnsClaim` is left UNMOCKED on
// purpose: the point of the `.q` test is that a real ed448 derivation agrees.
jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    getPublicProfile: (address: string) => mockGetPublicProfile(address),
  }),
}));
jest.mock('@/services/api/qnsClient', () => ({
  resolveBatch: (names: string[]) => mockResolveBatch(names),
}));

import { RootIdentityScope } from '@/identity/RootIdentityScope';
import { MemberName } from '@/identity/MemberName';

let queryClient: QueryClient;

function renderInScope(ui: React.ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <RootIdentityScope>{ui}</RootIdentityScope>
    </QueryClientProvider>,
  );
}

describe('RootIdentityScope', () => {
  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockUser = null;
    mockSpaces = [];
    mockRosters = {};
    mockConversations = [];
    mockGetPublicProfile = jest.fn().mockResolvedValue(null);
    mockResolveBatch = jest.fn().mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it('resolves a member for a descendant that mounts no provider of its own', () => {
    // The load-bearing assertion: RootIdentityScope, wired to real (mocked)
    // hook data, is enough on its own — nothing else needs to mount a
    // provider for MemberName to resolve.
    mockSpaces = [{ spaceId: 'space-1' }];
    mockRosters = { 'space-1': { [ADDR]: { global_display_name: 'Alice' } } };

    renderInScope(<MemberName address={ADDR} spaceId="space-1" />);

    expect(screen.getByText('Alice')).toBeTruthy();
  });

  it('seeds the device\'s own name from auth as the last global tier', () => {
    // Nothing else knows SELF_ADDR — no roster, no profile — so this only
    // resolves if RootIdentityScope actually threads `user.displayName`
    // through `selfLocalNameEntry` into the provider.
    mockUser = { address: SELF_ADDR, displayName: 'Selfy' };

    renderInScope(<MemberName address={SELF_ADDR} />);

    expect(screen.getByText('Selfy')).toBeTruthy();
  });

  it('seeds a DM partner\'s broadcast name, with no roster and no public profile', () => {
    // The regression this branch shipped. A DM has no `spaceId`, so no roster
    // row is consulted; the partner's name lives ONLY on the conversation row
    // until they publish a public profile. Without the wiring the ladder falls
    // through to a truncated address, which is what the operator saw: names
    // intact in channels (roster), addresses in DMs.
    //
    // No `spaceId` on purpose — that is what a DM surface passes.
    mockUser = { address: SELF_ADDR, displayName: 'Selfy' };
    mockConversations = [{ address: PARTNER, displayName: 'Bob' }];

    renderInScope(<MemberName address={PARTNER} />);

    expect(screen.getByText('Bob')).toBeTruthy();
  });

  it("carries a DM partner's broadcast .q CLAIM from the conversation row into the ladder", async () => {
    // The wiring this file exists for, for the QNS tier specifically.
    // `identityProviderRosterClaims.test.tsx` proves the provider verifies a DM
    // claim once it is handed one; nothing there proves anybody HANDS it one.
    // That gap is exactly how the roster half shipped broken: the claim kept
    // arriving and being stored, and no test noticed the ladder had stopped
    // reading it.
    //
    // No spaceId and no roster — a DM between two people who share no Space,
    // which is the case the public-profile route can never serve because the
    // server refuses every publish carrying the field.
    mockUser = { address: SELF_ADDR, displayName: 'Selfy' };
    mockConversations = [
      { address: QNS_PARTNER, displayName: 'Bob', claimed_primary_username: 'alice' },
    ];
    mockResolveBatch.mockResolvedValue([
      {
        header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
        address: '0xrecord',
        resolveKey: QNS_KEY,
        metadata: null,
      },
    ]);

    // `enrich` is what a bounded surface passes, and it is what puts the
    // address in the requested set the claim check is deliberately bounded by.
    renderInScope(<MemberName address={QNS_PARTNER} enrich />);

    await waitFor(() => expect(screen.getByText('alice.q')).toBeTruthy());
  });

  it('does not render a DM claim the resolver disagrees with', async () => {
    // The control arm, and the one that matters: without it the test above
    // passes just as well against an implementation that skips verification
    // entirely. Here the record for 'alice' derives back to QNS_PARTNER, but
    // PARTNER is the one claiming it.
    mockUser = { address: SELF_ADDR, displayName: 'Selfy' };
    mockConversations = [
      { address: PARTNER, displayName: 'Bob', claimed_primary_username: 'alice' },
    ];
    mockResolveBatch.mockResolvedValue([
      {
        header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
        address: '0xrecord',
        resolveKey: QNS_KEY,
        metadata: null,
      },
    ]);

    renderInScope(<MemberName address={PARTNER} enrich />);

    await waitFor(() => expect(mockResolveBatch).toHaveBeenCalled());
    expect(screen.getByText('Bob')).toBeTruthy();
    expect(screen.queryByText('alice.q')).toBeNull();
  });

  it('does not let a conversation row rename SELF', () => {
    // The control arm for the test above. Self's device name must outrank a
    // conversation row carrying self's address, otherwise the merge order is
    // wrong in a way the happy path cannot see.
    mockUser = { address: SELF_ADDR, displayName: 'Selfy' };
    mockConversations = [{ address: SELF_ADDR, displayName: 'Stale Self' }];

    renderInScope(<MemberName address={SELF_ADDR} />);

    expect(screen.getByText('Selfy')).toBeTruthy();
    expect(screen.queryByText('Stale Self')).toBeNull();
  });
});
