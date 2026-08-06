import { buildJoinedMemberRow, type JoinParticipant } from '@/services/space/joinedMemberRow';
import type { SpaceMember } from '@quilibrium/quorum-shared';

/**
 * A `join` control message is unauthenticated: anyone who can send into a space —
 * every current member, and anyone who left but kept the hub and config keys — can
 * send one naming any address. The receive handler does not check the signature that
 * rides along on the wire.
 *
 * That is survivable only because a join may not overwrite anything that matters. It
 * used to: the handler passed a fresh four-field object to `saveSpaceMember`, which
 * replaces the whole row, so a forged join silently un-kicked members and permanently
 * broke signature verification for real ones — on every member's device, not just the
 * sender's.
 *
 * Each test below pins one of those harms. They are the cases that cannot be checked
 * by using the app, because producing them requires a client that lies.
 */

const participant: JoinParticipant = {
  address: 'member-address',
  inboxAddress: 'attacker-chosen-inbox',
  displayName: 'New Name',
  userIcon: 'new-icon',
};

const existingMember: SpaceMember = {
  address: 'member-address',
  inbox_address: 'the-real-inbox',
  display_name: 'Real Name',
  profile_image: 'real-icon',
  joinedAt: 1_700_000_000_000,
};

/** Fixed receive clock. Later than every fixture joinedAt, so the clamp is a
 *  no-op except in the test that deliberately exercises it. */
const NOW = 1_850_000_000_000;

describe('buildJoinedMemberRow', () => {
  describe('an existing member row', () => {
    it('does not repoint inbox_address, so signature verification cannot be poisoned', () => {
      // resolveVerifiedSender matches members on inbox_address. Repointing it makes a
      // real member's genuine messages stop resolving to a known signer, permanently.
      const row = buildJoinedMemberRow(existingMember, participant, NOW);

      expect(row.inbox_address).toBe('the-real-inbox');
    });

    it('does not clear isKicked, so a forged join cannot un-kick someone', () => {
      const kicked: SpaceMember = { ...existingMember, isKicked: true };

      const row = buildJoinedMemberRow(kicked, participant, NOW);

      expect(row.isKicked).toBe(true);
    });

    it('preserves joinedAt', () => {
      const row = buildJoinedMemberRow(existingMember, participant, NOW);

      expect(row.joinedAt).toBe(1_700_000_000_000);
    });

    it('does not let a join overwrite an existing joinedAt', () => {
      // The new-row branch takes joinedAt off the wire, so the obvious "also fix
      // joinedAt drift" refactor is to extend that into this branch. It must not be:
      // the value is unauthenticated, and moving a member's join date rewrites the
      // ordering and any future join-bound check. Without this test that refactor
      // passes everything else in this file.
      const row = buildJoinedMemberRow(existingMember, {
        ...participant,
        joinedAt: 1_900_000_000_000,
      }, NOW);

      expect(row.joinedAt).toBe(1_700_000_000_000);
    });

    it('applies the join identity to the GLOBAL slot, never the per-space override', () => {
      // This is the fix. A join carries the joiner's GLOBAL name, but it used to
      // land in `display_name` — the per-space override — which outranks the QNS
      // `.q` name. So merely joining froze a member's global name as a
      // deliberate-looking per-space one on every other device, and their `.q`
      // could never win in that space again.
      const row = buildJoinedMemberRow(existingMember, participant, NOW);

      expect(row.global_display_name).toBe('New Name');
      expect(row.global_profile_image).toBe('new-icon');
      // The override keeps whatever the space's own name UI put there.
      expect(row.display_name).toBe('Real Name');
      expect(row.profile_image).toBe('real-icon');
    });

    it('stamps the global slot from joinedAt, so a later rename can be judged newer', () => {
      const row = buildJoinedMemberRow(
        existingMember,
        { ...participant, joinedAt: 1_700_000_000_000 },
        NOW,
      );

      expect(row.globalProfileTimestamp).toBe(1_700_000_000_000);
    });

    it('falls back to the receive clock when the join carries no joinedAt', () => {
      const row = buildJoinedMemberRow(existingMember, participant, NOW);

      expect(row.globalProfileTimestamp).toBe(NOW);
    });

    it('clamps a future joinedAt, so a forged join cannot pin a name forever', () => {
      // joinedAt rides on an unauthenticated payload. Unclamped, a join claiming
      // the year 3000 would out-rank every future legitimate global rename.
      const row = buildJoinedMemberRow(
        existingMember,
        { ...participant, joinedAt: 32_500_000_000_000 },
        NOW,
      );

      expect(row.globalProfileTimestamp).toBe(NOW);
    });

    it('does not let a stale join undo a fresher global rename', () => {
      // Same newer-wins guard the update-profile receive path applies. Without
      // it, a replayed join reverts a member's current name on every device.
      const renamed = {
        ...existingMember,
        global_display_name: 'Renamed Since',
        globalProfileTimestamp: 1_800_000_000_000,
      } as SpaceMember;

      const row = buildJoinedMemberRow(
        renamed,
        { ...participant, joinedAt: 1_700_000_000_000 },
        NOW,
      );

      expect(row.global_display_name).toBe('Renamed Since');
      expect(row.globalProfileTimestamp).toBe(1_800_000_000_000);
    });

    it('does not blank an existing name or avatar when the join omits them', () => {
      const row = buildJoinedMemberRow(existingMember, {
        address: 'member-address',
        inboxAddress: 'attacker-chosen-inbox',
      }, NOW);

      expect(row.display_name).toBe('Real Name');
      expect(row.profile_image).toBe('real-icon');
      // And no empty global stamp written for a join that said nothing.
      expect(row.globalProfileTimestamp).toBeUndefined();
    });

    it('does not set inbox_address even when the row has none', () => {
      // The state a `leave` leaves behind. An earlier version made an exception here,
      // reasoning that an empty anchor has nothing to poison. It does: `update-profile`
      // upserts a blank-anchored row for ANY claimed address on a signature from an
      // unknown key, so an attacker can mint this state and then claim it with a forged
      // join. The cost of closing that is the row below — accepted deliberately.
      const departed: SpaceMember = { ...existingMember, inbox_address: '' };

      const row = buildJoinedMemberRow(departed, participant, NOW);

      expect(row.inbox_address).toBe('');
    });

    it('does not repoint the anchor on a kicked row, which is also blank', () => {
      // The exact state `kick` produces. Tested as a pair rather than as two separate
      // rows, because the combination is what an attacker actually finds in the wild
      // and neither single-field test would have caught a regression here.
      const kicked: SpaceMember = { ...existingMember, isKicked: true, inbox_address: '' };

      const row = buildJoinedMemberRow(kicked, participant, NOW);

      expect(row.isKicked).toBe(true);
      expect(row.inbox_address).toBe('');
    });

    it('keeps fields the join knows nothing about', () => {
      const withExtras = { ...existingMember, bio: 'kept', spaceTag: undefined } as SpaceMember;

      const row = buildJoinedMemberRow(withExtras, participant, NOW);

      expect(row.bio).toBe('kept');
    });
  });

  describe('a member who is not in the roster yet', () => {
    it('is taken at face value, because there is nothing to protect', () => {
      const row = buildJoinedMemberRow(undefined, { ...participant, joinedAt: 1_800_000_000_000 }, NOW);

      expect(row).toEqual({
        address: 'member-address',
        inbox_address: 'attacker-chosen-inbox',
        global_display_name: 'New Name',
        global_profile_image: 'new-icon',
        globalProfileTimestamp: 1_800_000_000_000,
        joinedAt: 1_800_000_000_000,
      });
    });

    it('keeps joinedAt from the wire, which used to be dropped at the parse boundary', () => {
      // Both clients put joinedAt in the signed blob, but the receive-side type omitted
      // it, so every new member row was stored without one. Nothing reads it yet; it is
      // recorded so it exists when something does.
      const row = buildJoinedMemberRow(undefined, { ...participant, joinedAt: 1_800_000_000_000 }, NOW);

      expect(row.joinedAt).toBe(1_800_000_000_000);
    });

    it.each([
      ['NaN', Number.NaN],
      ['negative', -1],
      ['zero', 0],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['a string', '1800000000000' as unknown as number],
    ])('rejects a %s joinedAt rather than storing it', (_label, joinedAt) => {
      // The payload reaches this function through a bare `as` cast with no runtime
      // validation, so whatever a forged join sends arrives verbatim. Better to drop it
      // than hand the first future consumer a poisoned value.
      const row = buildJoinedMemberRow(undefined, { ...participant, joinedAt }, NOW);

      expect(row.joinedAt).toBeUndefined();
      // And the global stamp falls back to the clock rather than storing the
      // poison. An Infinity here would make existingStamp >= stamp always true,
      // freezing the member's name permanently.
      expect(row.globalProfileTimestamp).toBe(NOW);
    });

    it('is not invented with a name or avatar the join did not send', () => {
      const row = buildJoinedMemberRow(undefined, {
        address: 'member-address',
        inboxAddress: 'some-inbox',
      }, NOW);

      expect(row).toEqual({
        address: 'member-address',
        inbox_address: 'some-inbox',
      });
      expect('display_name' in row).toBe(false);
      expect('global_display_name' in row).toBe(false);
    });
  });
});
