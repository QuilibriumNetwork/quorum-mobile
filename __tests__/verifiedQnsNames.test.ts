/**
 * Stripping unverified `.q` claims before they reach the name resolver.
 *
 * The design constraint that shapes all of this: the resolver stays pure and
 * synchronous and never learns that verification exists. Verification happens
 * UPSTREAM, by removing an unproven `primary_username` from the row. Every
 * display surface then inherits the check without a single one of them
 * changing, which is the whole reason there is one resolver.
 *
 * These are the pure pieces, exported and tested directly rather than through a
 * rendered hook — the same shape as `qnsLookupAddresses`, and for the same
 * reason: the interesting failures here are cost and correctness, neither of
 * which needs a renderer to observe.
 */

import {
  claimedNamesIn,
  resolveClaimedNames,
  stripUnverifiedNames,
  QNS_BATCH_LIMIT,
} from '../hooks/useVerifiedQnsNames';

const KEY =
  '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b';
const ADDRESS = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';
const OTHER = 'QmThemThemThemThemThemThemThemThemThemThemThem';

const rec = (over: Record<string, unknown> = {}) => ({
  header: { authorityKey: '0xabc', name: 'alice', parent: null, createdAt: 0, updatedAt: 0 },
  address: '0xrecord',
  resolveKey: KEY,
  metadata: null,
  ...over,
});

describe('claimedNamesIn', () => {
  it('collects distinct claims and ignores rows with none', () => {
    const names = claimedNamesIn([
      { address: 'QmA', primary_username: 'alice' },
      { address: 'QmB' },
      { address: 'QmC', primary_username: null },
      { address: 'QmD', primary_username: '' },
      { address: 'QmE', primary_username: 'bob' },
    ]);
    expect(names).toEqual(['alice', 'bob']);
  });

  it('collapses two accounts claiming the same name into ONE lookup', () => {
    // The cost property the whole design leans on, and also the security one:
    // both claimants are compared against the same single answer, so the
    // collision is settled by the request that verifies the real holder.
    const names = claimedNamesIn([
      { address: 'QmA', primary_username: 'alice' },
      { address: 'QmB', primary_username: 'alice' },
    ]);
    expect(names).toEqual(['alice']);
  });

  it('trims, and treats case as significant', () => {
    // QNS names are lowercase by registration, but a claim is attacker-supplied
    // text. Trim whitespace so ` alice ` cannot dodge the dedupe; do NOT fold
    // case here, because the resolver is the authority on what a name matches.
    expect(claimedNamesIn([{ address: 'QmA', primary_username: '  alice  ' }])).toEqual(['alice']);
  });

  it('returns nothing for a screen where nobody claims a .q', () => {
    // The common case today, and the one that must never reach the network:
    // an empty batch is a 400 from the API, not an empty result.
    expect(claimedNamesIn([{ address: 'QmA' }, { address: 'QmB' }])).toEqual([]);
  });
});

describe('resolveClaimedNames', () => {
  it('chunks at the limit the API actually enforces', () => {
    // Asserted as a literal on purpose. Every other test here derives from the
    // constant, so they would all stay green if it were changed to the wrong
    // value — and the wrong value means a 400 that loses every name on screen.
    // 100 is MEASURED against production, not read from a doc.
    expect(QNS_BATCH_LIMIT).toBe(100);
  });

  it('issues no request at all when there is nothing to resolve', async () => {
    const batch = jest.fn();
    const out = await resolveClaimedNames([], batch);
    expect(batch).not.toHaveBeenCalled();
    expect(out.size).toBe(0);
  });

  it('resolves a screenful in a single request', async () => {
    const batch = jest.fn(async (names: string[]) => names.map((n) => rec({ header: { name: n } })));
    const out = await resolveClaimedNames(['alice', 'bob'], batch);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith(['alice', 'bob']);
    expect(out.size).toBe(2);
  });

  it('chunks at the API limit instead of sending one oversized request', async () => {
    // 101 names is a 400 for the WHOLE request, not a truncated answer — so
    // getting this wrong loses every name on the screen, not just the excess.
    // Never exercised by hand, and only reachable in the largest spaces.
    const names = Array.from({ length: QNS_BATCH_LIMIT + 1 }, (_, i) => `name${i}`);
    const batch = jest.fn(async (chunk: string[]) => chunk.map(() => null));
    await resolveClaimedNames(names, batch);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(batch.mock.calls[0][0]).toHaveLength(QNS_BATCH_LIMIT);
    expect(batch.mock.calls[1][0]).toHaveLength(1);
  });

  it('keeps names aligned with their records across a chunk boundary', async () => {
    // Positional mapping is the failure that would verify one person's claim
    // against another person's record. Worth an explicit assertion.
    const names = Array.from({ length: QNS_BATCH_LIMIT + 2 }, (_, i) => `name${i}`);
    const batch = async (chunk: string[]) => chunk.map((n) => rec({ header: { name: n } }));
    const out = await resolveClaimedNames(names, batch);
    expect(out.get('name0')?.header.name).toBe('name0');
    expect(out.get(`name${QNS_BATCH_LIMIT}`)?.header.name).toBe(`name${QNS_BATCH_LIMIT}`);
    expect(out.get(`name${QNS_BATCH_LIMIT + 1}`)?.header.name).toBe(`name${QNS_BATCH_LIMIT + 1}`);
  });

  it('returns an empty map when the resolver fails, rather than throwing', async () => {
    // R3, fail closed on the NAME. A resolver outage must degrade names, never
    // take down the surface that was rendering them.
    const out = await resolveClaimedNames(['alice'], async () => {
      throw new Error('offline');
    });
    expect(out.size).toBe(0);
  });
});

describe('stripUnverifiedNames', () => {
  const verified = new Map([['alice', rec()]]);

  it('keeps a claim that resolves to the claimant', () => {
    const rows = [{ address: ADDRESS, primary_username: 'alice' }];
    expect(stripUnverifiedNames(rows, verified)[0].primary_username).toBe('alice');
  });

  it('strips a claim belonging to somebody else', () => {
    // The impersonation. The row keeps everything else, so the member still
    // renders — under their global name, per R1: degrade the NAME, never the
    // message.
    const rows = [{ address: OTHER, primary_username: 'alice', global_display_name: 'Mallory' }];
    const out = stripUnverifiedNames(rows, verified);
    expect(out[0].primary_username).toBeUndefined();
    expect(out[0].global_display_name).toBe('Mallory');
    expect(out[0].address).toBe(OTHER);
  });

  it('strips a claim whose lookup has not returned yet', () => {
    // R2, and the reason the default is "stripped" rather than "kept". A `.q`
    // rendered for even the instant before a lookup lands is the attack: a
    // screenshot of that instant does not expire.
    const rows = [{ address: ADDRESS, primary_username: 'alice' }];
    expect(stripUnverifiedNames(rows, new Map())[0].primary_username).toBeUndefined();
  });

  it('strips a claim the resolver returned nothing for', () => {
    const rows = [{ address: ADDRESS, primary_username: 'ghost' }];
    expect(stripUnverifiedNames(rows, new Map([['ghost', null]]))[0].primary_username).toBeUndefined();
  });

  it('settles a collision in favour of the real holder only', () => {
    // Two accounts claim `alice`; one owns it. One record, two verdicts, and
    // the impersonator does not inherit the real holder's answer.
    const rows = [
      { address: ADDRESS, primary_username: 'alice' },
      { address: OTHER, primary_username: 'alice' },
    ];
    const out = stripUnverifiedNames(rows, verified);
    expect(out[0].primary_username).toBe('alice');
    expect(out[1].primary_username).toBeUndefined();
  });

  it('leaves rows that never claimed anything completely alone', () => {
    const rows = [{ address: ADDRESS, global_display_name: 'Nobody' }];
    expect(stripUnverifiedNames(rows, new Map())).toBe(rows);
  });

  it('returns the SAME array when nothing needed stripping', () => {
    // Referential stability, not cosmetics. These rows feed memoised member
    // maps and a virtualised list; returning a fresh array every render
    // re-renders every row on every tick, on the exact surface this feature is
    // most at risk of making expensive.
    const rows = [{ address: ADDRESS, primary_username: 'alice' }];
    expect(stripUnverifiedNames(rows, verified)).toBe(rows);
  });
});
