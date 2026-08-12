/**
 * `useNameResolver.resolve()` reads through `resolveWithFallback`
 * (`identity/useResolvedName.ts`), the exact same has-any-tier gate and
 * truncate fallback `<MemberName>` reads through. Before this file, nothing
 * exercised the resolver directly — `memberName.test.tsx` only ever rendered
 * `<MemberName>`, so a dropped check in a hand-duplicated copy of the gate
 * would have gone undetected on this path. It no longer is a copy; see the
 * mutation note below.
 *
 * The second half covers the `enrich` opt-in itself: `useResolvedMemberName`
 * must never request a profile unless a caller asks for one, and must
 * request exactly the address it was given when a caller does.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import { useNameResolver } from '@/identity/useNameResolver';
import { useResolvedMemberName } from '@/identity/useResolvedName';
import { truncateAddress } from '@/utils/formatAddress';

const ADDR = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

// `mock`-prefixed so the jest.mock factories below (hoisted above these
// declarations) are allowed to close over them, per the convention in
// identityProviderVerification.test.tsx. Needed here, unlike
// memberName.test.tsx: the enrich-wiring tests below genuinely trigger a
// request, so the network seam must be mocked rather than merely unreached.
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

let queryClient: QueryClient;

const wrap = (ui: React.ReactNode, sources: {
  rosters?: Record<string, Record<string, { display_name?: string; global_display_name?: string }>>;
  local?: Record<string, string>;
  spaceId?: string;
}) =>
  render(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider
        spaceId={sources.spaceId}
        rostersBySpace={sources.rosters ?? {}}
        selfAddress={null}
        locallyKnownNames={sources.local ?? {}}
      >
        {ui}
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  mockGetPublicProfile = jest.fn().mockResolvedValue(null);
  mockResolveBatch = jest.fn().mockResolvedValue([]);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

function ResolveProbe({ address }: { address: string }) {
  const { resolve } = useNameResolver();
  const r = resolve(address);
  return <Text testID="resolved">{r.isQnsVerified ? `${r.name}.q` : r.name}</Text>;
}

describe('useNameResolver — resolve()', () => {
  it('resolves a per-space nickname, the same tier <MemberName> uses', () => {
    wrap(<ResolveProbe address={ADDR} />, {
      spaceId: 'space-1',
      rosters: { 'space-1': { [ADDR]: { display_name: 'Mod Alice', global_display_name: 'Alice' } } },
    });
    expect(screen.getByTestId('resolved').props.children).toBe('Mod Alice');
  });

  it('resolves a locally-known global name with no fetch', () => {
    // Same DM-partner-with-no-profile scenario as memberName.test.tsx.
    wrap(<ResolveProbe address={ADDR} />, { local: { [ADDR]: 'Alice' } });
    expect(screen.getByTestId('resolved').props.children).toBe('Alice');
    expect(mockGetPublicProfile).not.toHaveBeenCalled();
  });

  it('falls back to the truncated address, not to shared\'s naive slice, when nothing knows the member', () => {
    wrap(<ResolveProbe address={ADDR} />, {});
    // Exact equality against mobile's own truncateAddress, not just a /Qm/
    // regex — a naive slice(0,6)…slice(-4) from shared would also start with
    // "Qm" and would pass a looser check while still being the wrong format.
    expect(screen.getByTestId('resolved').props.children).toBe(truncateAddress(ADDR));
  });
});

function EnrichProbe({ address, enrich }: { address: string; enrich?: boolean }) {
  useResolvedMemberName(address, { enrich });
  return null;
}

describe('useResolvedMemberName — enrich wiring', () => {
  it('does not request a profile when enrich is omitted', () => {
    wrap(<EnrichProbe address={ADDR} />, {});
    expect(mockGetPublicProfile).not.toHaveBeenCalled();
  });

  it('requests exactly the given address when enrich is true', async () => {
    wrap(<EnrichProbe address={ADDR} enrich />, {});
    await waitFor(() => expect(mockGetPublicProfile).toHaveBeenCalledWith(ADDR));
    expect(mockGetPublicProfile).toHaveBeenCalledTimes(1);
  });
});
