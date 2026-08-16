/**
 * The repair that un-sticks a test device.
 *
 * Tested despite being dev-only for the same reason the rest of the fake-QNS
 * tooling is: an operator's conclusions about where a `.q` renders are
 * downstream of it. A repair that silently cleared nothing would leave someone
 * chasing a product bug that is really a stale stored announcement — which is
 * exactly the session this was written after.
 *
 * The load-bearing case is DELETE-the-key, not set-to-empty. An empty string is
 * a present announcement (an un-election) and would keep outranking the
 * overlay, so a "repair" that wrote one would look like it worked and change
 * nothing at all.
 */

import {
  forgetConversationClaims,
  forgetAnnouncedNames,
  type AnnouncedNameRow,
  type RosterStore,
} from '../services/dev/forgetAnnouncedNames';

const A = 'QmAlice1111111111111111111111111111111111';
const B = 'QmBob22222222222222222222222222222222222222';

function store(initial: Record<string, AnnouncedNameRow[]>): RosterStore & {
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

describe('forgetAnnouncedNames', () => {
  it('DELETES the key rather than emptying it', async () => {
    // The whole repair. `claimed_primary_username: ''` is still an
    // announcement and still beats the overlay, so emptying would be a no-op
    // dressed as a fix.
    const s = store({ 's1': [{ address: A, claimed_primary_username: 'qtest' }] });

    await forgetAnnouncedNames(s);

    expect('claimed_primary_username' in s.rows.s1[0]).toBe(false);
  });

  it('clears an already-empty announcement too', async () => {
    // An un-election left behind by "Clear" is exactly as sticky as a name.
    const s = store({ 's1': [{ address: A, claimed_primary_username: '' }] });

    const res = await forgetAnnouncedNames(s);

    expect(res.rowsCleared).toBe(1);
    expect('claimed_primary_username' in s.rows.s1[0]).toBe(false);
  });

  it('preserves every other field on the row', async () => {
    // CONTROL ARM. The row carries join bindings and profile slots; a repair
    // that dropped them would break the space rather than fix a name.
    const s = store({
      's1': [
        {
          address: A,
          claimed_primary_username: 'qtest',
          display_name: 'Per-space',
          global_display_name: 'Global',
          inbox_address: 'inbox-1',
        } as AnnouncedNameRow,
      ],
    });

    await forgetAnnouncedNames(s);

    expect(s.rows.s1[0]).toEqual({
      address: A,
      display_name: 'Per-space',
      global_display_name: 'Global',
      inbox_address: 'inbox-1',
    });
  });

  it('leaves rows that never announced untouched, and counts honestly', async () => {
    const s = store({
      's1': [{ address: A, claimed_primary_username: 'qtest' }, { address: B }],
      's2': [{ address: B }],
    });

    const res = await forgetAnnouncedNames(s);

    expect(res).toEqual({ spacesTouched: 1, rowsCleared: 1, failures: [] });
  });

  it('reports a space it could not read instead of claiming success', async () => {
    // A partial wipe that reported success would send the operator back to
    // hunting a product bug for the account that stayed stuck.
    const s = store({ 's1': [{ address: A, claimed_primary_username: 'qtest' }] });
    const failing: RosterStore = {
      ...s,
      spaceIds: () => ['s1', 'broken'],
      members: async (spaceId) => {
        if (spaceId === 'broken') throw new Error('roster unreadable');
        return s.rows[spaceId] ?? [];
      },
    };

    const res = await forgetAnnouncedNames(failing);

    expect(res.rowsCleared).toBe(1);
    expect(res.failures).toEqual(['broken']);
  });
});

describe('forgetConversationClaims — the DM half', () => {
  it('clears a claim stored on a conversation row', async () => {
    // DMs have no roster, so the partner's announced claim lands here instead.
    // Clearing only spaces left every DM surface stuck, which read as the
    // repair doing nothing at all.
    const rows: AnnouncedNameRow[] = [{ address: A, claimed_primary_username: 'qtest' }];
    const res = await forgetConversationClaims({
      conversations: async () => rows,
      save: async (row) => {
        rows[0] = row;
      },
    });

    expect(res).toEqual({ rowsCleared: 1, failed: false });
    expect('claimed_primary_username' in rows[0]).toBe(false);
  });

  it('reports a failure rather than counting it as cleared', async () => {
    const res = await forgetConversationClaims({
      conversations: async () => {
        throw new Error('unreadable');
      },
      save: async () => {},
    });

    expect(res).toEqual({ rowsCleared: 0, failed: true });
  });
});
