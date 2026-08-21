/**
 * QNS claim-verification answers must never be written to disk.
 *
 * ## Why this test exists NOW, when the rule is older
 *
 * The rule had two things holding it up, and one of them has just been removed.
 *
 * The stated reason is a security bound: `useClaimRecords`' `staleTime` is one
 * hour, and it is the window in which a `.q` transferred to somebody else keeps
 * verifying for its PREVIOUS owner. The persister's `maxAge` is 24 hours. So
 * persisting these answers widens a one-hour window to a day and makes it
 * survive restarts — relaunch the app and the old owner's name renders again
 * from disk, having been re-verified by nothing.
 *
 * The unstated reason was an accident of the container. The records used to be
 * a `Map`, and `JSON.stringify(new Map([...]))` is `{}`, so they could not
 * survive persistence even with the rule deleted. That accident is gone: the
 * records are now the plain object `resolveNamesBatch` returns, which
 * round-trips through JSON perfectly.
 *
 * Deleting the rule therefore used to produce a crash or an empty object — loud,
 * or at worst harmless. It now produces a working 24-hour impersonation window
 * with no symptom at all. Nothing about the app would look wrong. That is
 * precisely the class of change a test has to catch, because a human review of
 * the deletion would see a line that appears redundant.
 *
 * ## What is asserted
 *
 * Both directions. Excluding the one key is worthless if the predicate has been
 * quietly narrowed to exclude everything (offline support would be dead and no
 * security test would notice), so the control arm proves an ordinary query is
 * still persisted.
 */
import { QueryClient, defaultShouldDehydrateQuery, type Query } from '@tanstack/react-query';

import { shouldPersistQuery, QNS_VERIFY_CLAIMS_KEY } from '@/services/offline/shouldPersistQuery';

/**
 * A real `Query` in the state the persister sees: successful, with data.
 * Built through a `QueryClient` rather than hand-rolled, so this exercises the
 * same object shape `dehydrate()` passes in — a stub could drift from it and
 * keep passing.
 */
function successfulQuery(queryKey: unknown[], data: unknown): Query {
  const client = new QueryClient();
  client.setQueryData(queryKey, data);
  const query = client.getQueryCache().find({ queryKey });
  if (!query) throw new Error('fixture query was not created');
  return query as Query;
}

describe('shouldPersistQuery', () => {
  it('refuses to persist the QNS claim-verification query', () => {
    // The whole point. `staleTime` is a security bound and the persister's
    // 24h `maxAge` would override it across restarts.
    const query = successfulQuery([QNS_VERIFY_CLAIMS_KEY, 'alice'], { alice: null });

    expect(shouldPersistQuery(query)).toBe(false);
  });

  it('refuses it even though the records now serialise perfectly', () => {
    // Pins the reasoning, not just the outcome. A populated record survives
    // JSON intact — this is no longer a shape that would arrive back broken, so
    // "it cannot be persisted anyway" is not a reason to drop the rule.
    const records = {
      alice: { address: '0xrecord', resolveKey: 'ab'.repeat(57), metadata: null },
    };
    expect(JSON.parse(JSON.stringify(records))).toEqual(records);

    expect(shouldPersistQuery(successfulQuery([QNS_VERIFY_CLAIMS_KEY, 'alice'], records))).toBe(
      false,
    );
  });

  it('uses the exact key useClaimRecords builds', () => {
    // The rule and the query key live in different files. If they drift, the
    // exclusion silently stops matching and everything else here still passes.
    expect(QNS_VERIFY_CLAIMS_KEY).toBe('qns-verify-claims');
  });

  it('CONTROL: still persists an ordinary query', () => {
    // Without this arm, narrowing the predicate to `() => false` would pass
    // every assertion above while disabling offline support entirely.
    const query = successfulQuery(['spaces'], [{ id: 'space-1' }]);

    expect(shouldPersistQuery(query)).toBe(true);
  });

  it('CONTROL: still defers to React Query on a query it would not persist itself', () => {
    // The exclusion is an ADDITION to the default policy, not a replacement for
    // it. A query that never resolved has no data worth writing, React Query's
    // own default says so, and this proves the rule still asks.
    //
    // ## Built through the cache, and NOT via setQueryData
    //
    // The obvious fixture — `setQueryData(['spaces'], undefined)` — creates NO
    // cache entry at all: React Query reads `undefined` as "no update" and
    // skips the write. MEASURED: `getQueryCache().getAll().length` is 0
    // afterwards and `find()` returns `undefined`.
    //
    // This test previously guarded that with `if (pending) { ...expect... }`,
    // which meant the body never ran and the whole case asserted NOTHING while
    // reporting green. Caught in independent review, not by me. `build()`
    // creates the entry directly, and the assertion below is unconditional so
    // a broken fixture fails loudly instead of silently skipping.
    const client = new QueryClient();
    // `readonly unknown[]`, not the inferred `string[]`: `Query`'s key type is
    // covariant in a way that makes the narrower inference unassignable to the
    // `Query` that `shouldPersistQuery` and `defaultShouldDehydrateQuery` take.
    const pending: Query = client
      .getQueryCache()
      .build(client, { queryKey: ['spaces'] as readonly unknown[] });

    // Fail loudly if the fixture ever stops producing a real query — that is
    // the exact failure mode this test just had.
    expect(pending).toBeDefined();
    expect(pending.state.status).toBe('pending');

    expect(shouldPersistQuery(pending)).toBe(defaultShouldDehydrateQuery(pending));
    // And spell out what that agreement IS, so the assertion cannot be
    // satisfied by both sides being broken in the same direction.
    expect(shouldPersistQuery(pending)).toBe(false);
  });
});
