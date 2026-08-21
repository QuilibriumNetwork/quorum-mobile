/**
 * A rehydrated claim-records cache must not crash the channel screen, and must
 * not promote a claim it cannot vouch for.
 *
 * ## The crash this started as
 *
 * `useClaimRecords`' query data used to be a `Map`. React Query's cache is
 * persisted to MMKV as JSON (`app/_layout.tsx`), and `JSON.stringify(new
 * Map([...]))` is `{}` — a plain object with no `.get`. So an entry written
 * before that query was excluded from persistence rehydrated in a shape
 * `settleClaim` could not read, and the first member row carrying a claim threw
 * `records.get is not a function`, taking the whole channel down.
 *
 * MEASURED on device 2026-08-14: opening one specific channel crashed with that
 * error while other channels were fine — the difference being whether that
 * channel's set of claimed names happened to be in the persisted cache. The
 * fake-QNS overlay is what made it reachable at all, by giving every member a
 * claim; before that most spaces had none, the query never ran, and nothing was
 * ever persisted under that key.
 *
 * It was NOT a dev-only bug. Any real `.q` in a space reached the identical path.
 *
 * ## Why the crash class is now retired rather than guarded
 *
 * The records are a plain object now — the shape `resolveNamesBatch` returns.
 * The legacy on-disk value is `{}`, which under that container is not a broken
 * `Map` needing rescue: it is a perfectly readable, EMPTY set of records meaning
 * "nothing verified". Indexing it cannot throw, and every miss answers
 * `undefined`, which `claimedNameBelongsTo` rejects.
 *
 * So the upgrade path is now structural. That is exactly why this file stays:
 * the outcome it pins — an unreadable or empty cache costs a `.q`, never grants
 * one — is a security property, and it must not quietly come to depend on which
 * container the query happens to hold today.
 *
 * ## The control arm is the point
 *
 * Most cases below assert that nothing verifies. On their own they would pass
 * just as well against a hook hard-wired to verify NOTHING, which would silently
 * kill every `.q` in the app. One case therefore seeds a genuine record and
 * asserts the name DOES render, so this file can tell "fails closed" apart from
 * "does nothing".
 *
 * That arm runs the real `claimedNameBelongsTo` against a real ed448 key whose
 * derived address is the claimant's — no stubbed predicate — so it proves the
 * records actually flowed through the genuine check.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen, cleanup } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('@/services/api/qnsClient', () => ({
  resolveClaimedNames: jest.fn().mockResolvedValue({}),
}));

import { useVerifiedQnsNamesInMap } from '@/hooks/useVerifiedQnsNames';

/** Invented ed448-shaped public key (57 bytes) and the address it genuinely
 *  derives to. Not anyone's real key — the same fixture pair as
 *  `verifyQnsClaim.test.ts` and `verifiedQnsNames.test.ts`, so the control arm
 *  below exercises real derivation rather than a stub. */
const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
const ADDR = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';

/** The record `/resolve/batch` returns for a name this address really owns. */
const RECORD = {
  header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
  address: '0xrecord',
  resolveKey: KEY,
  metadata: null,
};

/** A member map in the shape the chat areas pass, with a row that CLAIMS a
 *  name — the row that reaches the records lookup, and nothing else does. */
const MEMBERS = {
  [ADDR]: { address: ADDR, display_name: 'Alice', primary_username: 'alice' },
};

/** The cache key `useClaimRecords` builds: one claimed name, so the joined
 *  name-set is just that name. */
const CACHE_KEY = ['qns-verify-claims', 'alice'];

function Probe() {
  const settled = useVerifiedQnsNamesInMap(MEMBERS);
  return <Text testID="qns">{settled[ADDR]?.primary_username ?? 'none'}</Text>;
}

let queryClient: QueryClient;

afterEach(() => {
  cleanup();
  queryClient.clear();
});

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

const renderProbe = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  );

describe('useClaimRecords — a cache rehydrated from JSON', () => {
  it('does not crash when the cached records are the empty object a Map serialises to', () => {
    // Exactly what the persister hands back for a `Map`, and what every device
    // that ran an older build still has sitting in MMKV.
    queryClient.setQueryData(CACHE_KEY, {});

    expect(() => renderProbe()).not.toThrow();
  });

  it('strips the claim rather than promoting one from an empty cache', () => {
    // Fail-closed. An empty answer must not become "verified" — that would put
    // an unchecked claim on screen, the one outcome this whole path exists to
    // prevent.
    queryClient.setQueryData(CACHE_KEY, {});

    renderProbe();

    expect(screen.getByTestId('qns').props.children).toBe('none');
  });

  it('CONTROL: a genuine records object still verifies, so nothing above disabled the check', () => {
    // Without this arm, a hook that returned "no records" unconditionally would
    // pass every other case here while having killed every `.q` in the app.
    //
    // Asserting the NAME, not merely that something rendered: an earlier version
    // of this file only checked that the render completed, which was true
    // whether the records were consulted or thrown away.
    queryClient.setQueryData(CACHE_KEY, { alice: RECORD });

    renderProbe();

    expect(screen.getByTestId('qns').props.children).toBe('alice');
  });

  it('costs a .q rather than crashing when handed a legacy Map', () => {
    // Honest scope, because this arm is weaker than it looks.
    //
    // It pins an OUTCOME — an unexpected container never verifies and never
    // throws — not the `instanceof Map` clause in `isClaimRecords`. MEASURED:
    // deleting that clause leaves this test green, because a `Map` read with
    // `records[name]` answers `undefined` for every key anyway. Two independent
    // routes reach the same result and this cannot tell them apart.
    //
    // It is kept because the OUTCOME is the security property, and because it
    // does catch the regression that matters: reintroducing `.get`-style access
    // makes every case in this file throw `records.get is not a function`
    // (MEASURED, all four). Do not strengthen the wording to claim it covers
    // the type guard.
    queryClient.setQueryData(CACHE_KEY, new Map([['alice', RECORD]]));

    expect(() => renderProbe()).not.toThrow();
    expect(screen.getByTestId('qns').props.children).toBe('none');
  });
});
