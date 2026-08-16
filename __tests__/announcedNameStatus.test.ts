/**
 * The read-only half of the announced-name repair.
 *
 * Tested for the same reason the repair is: an operator's conclusions about
 * where a `.q` renders are downstream of it, and a scanner that under-reports
 * would send someone back to hunting a product bug that is really a stale
 * stored announcement.
 *
 * Two cases carry the weight:
 *  - an EMPTY claim must be REPORTED, not skipped. It is what "Clear" leaves
 *    behind, it still outranks the overlay, and it is the state most likely to
 *    be read as "nothing is there".
 *  - the scanner and the repair must agree exactly. A diagnostic that names
 *    rows its own fix cannot clear is worse than no diagnostic.
 */

import {
  describeAnnouncedRow,
  hasStoredClaim,
  scanAnnouncedNames,
} from '../services/dev/announcedNameStatus';
import {
  forgetAnnouncedNames,
  forgetConversationClaims,
  type AnnouncedNameRow,
  type RosterStore,
} from '../services/dev/forgetAnnouncedNames';

const A = 'QmAlice1111111111111111111111111111111111';
const B = 'QmBob22222222222222222222222222222222222222';
const C = 'QmCarol333333333333333333333333333333333333';

function rosterStore(initial: Record<string, AnnouncedNameRow[]>): RosterStore & {
  rows: Record<string, AnnouncedNameRow[]>;
} {
  const rows = initial;
  return {
    rows,
    spaceIds: () => Object.keys(rows),
    members: async (spaceId) => rows[spaceId] ?? [],
    saveMember: async (spaceId, member) => {
      const list = rows[spaceId] ?? [];
      const i = list.findIndex((m) => m.address === member.address);
      if (i >= 0) list[i] = member;
      else list.push(member);
      rows[spaceId] = list;
    },
  };
}

const noConversations = { conversations: async () => [] as AnnouncedNameRow[] };

describe('scanAnnouncedNames', () => {
  it('names the account holding a stored announcement', async () => {
    const scan = await scanAnnouncedNames(
      rosterStore({ s1: [{ address: A, claimed_primary_username: 'qtest' }] }),
      noConversations,
    );

    expect(scan.rows).toEqual([{ address: A, claims: ['qtest'], where: ['s1'] }]);
  });

  it('REPORTS an empty claim instead of treating it as absent', async () => {
    // The load-bearing case. `''` is what "Clear" leaves behind: still present,
    // still outranking the overlay. A scanner that skipped it would report
    // "clean" for the exact account that is stuck.
    const scan = await scanAnnouncedNames(
      rosterStore({ s1: [{ address: A, claimed_primary_username: '' }] }),
      noConversations,
    );

    expect(scan.rows).toEqual([{ address: A, claims: [''], where: ['s1'] }]);
  });

  it('treats null as present-but-naming-nobody, exactly as the repair does', async () => {
    const scan = await scanAnnouncedNames(
      rosterStore({ s1: [{ address: A, claimed_primary_username: null }] }),
      noConversations,
    );

    expect(scan.rows).toEqual([{ address: A, claims: [''], where: ['s1'] }]);
  });

  it('CONTROL ARM: a row that never announced is not reported', async () => {
    // Without this the scanner could pass every test above by reporting
    // everything, which would make every account look stuck.
    const scan = await scanAnnouncedNames(
      rosterStore({ s1: [{ address: A }, { address: B, claimed_primary_username: 'qtest' }] }),
      noConversations,
    );

    expect(scan.rows.map((r) => r.address)).toEqual([B]);
  });

  it('merges one address across spaces and the DM row, without repeating a claim', async () => {
    const scan = await scanAnnouncedNames(
      rosterStore({
        s1: [{ address: A, claimed_primary_username: 'qtest' }],
        s2: [{ address: A, claimed_primary_username: 'qtest' }],
      }),
      { conversations: async () => [{ address: A, claimed_primary_username: 'qtest' }] },
    );

    expect(scan.rows).toEqual([
      { address: A, claims: ['qtest'], where: ['s1', 's2', 'DM'] },
    ]);
  });

  it('surfaces a disagreement between rows rather than picking one', async () => {
    const scan = await scanAnnouncedNames(
      rosterStore({
        s1: [{ address: A, claimed_primary_username: 'qtest' }],
        s2: [{ address: A, claimed_primary_username: '' }],
      }),
      noConversations,
    );

    expect(scan.rows[0].claims).toEqual(['qtest', '']);
  });

  it('reports an unreadable roster instead of counting it as clean', async () => {
    const ok = rosterStore({ s1: [{ address: A, claimed_primary_username: 'qtest' }] });
    const scan = await scanAnnouncedNames(
      {
        ...ok,
        spaceIds: () => ['s1', 'broken'],
        members: async (spaceId) => {
          if (spaceId === 'broken') throw new Error('unreadable');
          return ok.rows[spaceId] ?? [];
        },
      },
      noConversations,
    );

    expect(scan.failures).toEqual(['broken']);
    expect(scan.rows).toHaveLength(1);
  });

  it('reports unreadable conversations as a DM failure', async () => {
    const scan = await scanAnnouncedNames(rosterStore({}), {
      conversations: async () => {
        throw new Error('unreadable');
      },
    });

    expect(scan.failures).toEqual(['DM']);
  });

  it('is read-only — the store is unchanged afterwards', async () => {
    const store = rosterStore({ s1: [{ address: A, claimed_primary_username: 'qtest' }] });
    const before = JSON.stringify(store.rows);

    await scanAnnouncedNames(store, noConversations);

    expect(JSON.stringify(store.rows)).toBe(before);
  });
});

describe('the scanner and the repair agree', () => {
  // The property that matters in use: every row named by the diagnostic is a
  // row the fix clears, and the fix clears nothing the diagnostic stayed quiet
  // about. Without this they can drift apart silently and the panel starts
  // reporting a count the button cannot act on.
  const data = (): Record<string, AnnouncedNameRow[]> => ({
    s1: [
      { address: A, claimed_primary_username: 'qtest' },
      { address: B }, // never announced
    ],
    s2: [
      { address: A, claimed_primary_username: '' }, // un-election
      { address: C, claimed_primary_username: null }, // present, names nobody
    ],
    s3: [{ address: B }], // nothing at all
  });

  it('clears exactly the row-instances the scan reported', async () => {
    const scan = await scanAnnouncedNames(rosterStore(data()), noConversations);
    const reportedRosterHits = scan.rows.reduce(
      (n, r) => n + r.where.filter((w) => w !== 'DM').length,
      0,
    );

    const repair = await forgetAnnouncedNames(rosterStore(data()));

    expect(repair.rowsCleared).toBe(reportedRosterHits);
    expect(reportedRosterHits).toBe(3);
  });

  it('a scan after a repair comes back empty', async () => {
    const store = rosterStore(data());
    await forgetAnnouncedNames(store);

    const scan = await scanAnnouncedNames(store, noConversations);

    expect(scan.rows).toEqual([]);
  });

  it('the DM halves agree too', async () => {
    const rows: AnnouncedNameRow[] = [
      { address: A, claimed_primary_username: 'qtest' },
      { address: B },
    ];
    const scan = await scanAnnouncedNames(rosterStore({}), { conversations: async () => rows });

    const repair = await forgetConversationClaims({
      conversations: async () => rows,
      save: async (row) => {
        rows[rows.findIndex((r) => r.address === row.address)] = row;
      },
    });

    expect(scan.rows).toHaveLength(1);
    expect(repair.rowsCleared).toBe(1);
  });

  it('hasStoredClaim matches the repair on every shape', () => {
    expect(hasStoredClaim({ address: A, claimed_primary_username: 'q' })).toBe(true);
    expect(hasStoredClaim({ address: A, claimed_primary_username: '' })).toBe(true);
    expect(hasStoredClaim({ address: A, claimed_primary_username: null })).toBe(true);
    expect(hasStoredClaim({ address: A, claimed_primary_username: undefined })).toBe(false);
    expect(hasStoredClaim({ address: A })).toBe(false);
    expect(hasStoredClaim(undefined)).toBe(false);
  });
});

describe('describeAnnouncedRow', () => {
  const shorten = (a: string) => `${a.slice(0, 6)}…`;

  it('spells out what an empty claim means rather than rendering blank', () => {
    const line = describeAnnouncedRow(
      { address: A, claims: [''], where: ['s1'] },
      undefined,
      shorten,
    );

    expect(line).toContain('EMPTY');
    expect(line).toContain('still outranks the overlay');
  });

  it('marks your own account', () => {
    const line = describeAnnouncedRow(
      { address: A, claims: ['qtest'], where: ['s1'] },
      A,
      shorten,
    );

    expect(line).toContain('me (');
    expect(line).toContain('"qtest.q"');
  });

  it('counts spaces and names the DM row separately', () => {
    expect(
      describeAnnouncedRow({ address: A, claims: ['q'], where: ['s1', 's2', 'DM'] }, undefined, shorten),
    ).toContain('2 spaces, DM');

    expect(
      describeAnnouncedRow({ address: A, claims: ['q'], where: ['s1'] }, undefined, shorten),
    ).toContain('1 space');
  });

  it('does not leak a full address into the line', () => {
    // The panel renders these on a screen that gets screenshotted.
    const line = describeAnnouncedRow({ address: A, claims: ['q'], where: ['s1'] }, A, shorten);

    expect(line).not.toContain(A);
  });
});
