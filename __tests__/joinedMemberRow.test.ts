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

describe('buildJoinedMemberRow', () => {
  describe('an existing member row', () => {
    it('does not repoint inbox_address, so signature verification cannot be poisoned', () => {
      // resolveVerifiedSender matches members on inbox_address. Repointing it makes a
      // real member's genuine messages stop resolving to a known signer, permanently.
      const row = buildJoinedMemberRow(existingMember, participant);

      expect(row.inbox_address).toBe('the-real-inbox');
    });

    it('does not clear isKicked, so a forged join cannot un-kick someone', () => {
      const kicked: SpaceMember = { ...existingMember, isKicked: true };

      const row = buildJoinedMemberRow(kicked, participant);

      expect(row.isKicked).toBe(true);
    });

    it('preserves joinedAt', () => {
      const row = buildJoinedMemberRow(existingMember, participant);

      expect(row.joinedAt).toBe(1_700_000_000_000);
    });

    it('still applies the display fields a join legitimately carries', () => {
      const row = buildJoinedMemberRow(existingMember, participant);

      expect(row.display_name).toBe('New Name');
      expect(row.profile_image).toBe('new-icon');
    });

    it('does not blank an existing name or avatar when the join omits them', () => {
      const row = buildJoinedMemberRow(existingMember, {
        address: 'member-address',
        inboxAddress: 'attacker-chosen-inbox',
      });

      expect(row.display_name).toBe('Real Name');
      expect(row.profile_image).toBe('real-icon');
    });

    it('does not set inbox_address even when the row has none', () => {
      // The state a `leave` leaves behind. An earlier version made an exception here,
      // reasoning that an empty anchor has nothing to poison. It does: `update-profile`
      // upserts a blank-anchored row for ANY claimed address on a signature from an
      // unknown key, so an attacker can mint this state and then claim it with a forged
      // join. The cost of closing that is the row below — accepted deliberately.
      const departed: SpaceMember = { ...existingMember, inbox_address: '' };

      const row = buildJoinedMemberRow(departed, participant);

      expect(row.inbox_address).toBe('');
    });

    it('does not repoint the anchor on a kicked row, which is also blank', () => {
      // The exact state `kick` produces. Tested as a pair rather than as two separate
      // rows, because the combination is what an attacker actually finds in the wild
      // and neither single-field test would have caught a regression here.
      const kicked: SpaceMember = { ...existingMember, isKicked: true, inbox_address: '' };

      const row = buildJoinedMemberRow(kicked, participant);

      expect(row.isKicked).toBe(true);
      expect(row.inbox_address).toBe('');
    });

    it('keeps fields the join knows nothing about', () => {
      const withExtras = { ...existingMember, bio: 'kept', spaceTag: undefined } as SpaceMember;

      const row = buildJoinedMemberRow(withExtras, participant);

      expect(row.bio).toBe('kept');
    });
  });

  describe('a member who is not in the roster yet', () => {
    it('is taken at face value, because there is nothing to protect', () => {
      const row = buildJoinedMemberRow(undefined, { ...participant, joinedAt: 1_800_000_000_000 });

      expect(row).toEqual({
        address: 'member-address',
        inbox_address: 'attacker-chosen-inbox',
        display_name: 'New Name',
        profile_image: 'new-icon',
        joinedAt: 1_800_000_000_000,
      });
    });

    it('keeps joinedAt from the wire, which used to be dropped at the parse boundary', () => {
      // Both clients put joinedAt in the signed blob, but the receive-side type omitted
      // it, so every new member row was stored without one. Ordering and the join-bound
      // checks read it.
      const row = buildJoinedMemberRow(undefined, { ...participant, joinedAt: 1_800_000_000_000 });

      expect(row.joinedAt).toBe(1_800_000_000_000);
    });

    it('is not invented with a name or avatar the join did not send', () => {
      const row = buildJoinedMemberRow(undefined, {
        address: 'member-address',
        inboxAddress: 'some-inbox',
      });

      expect(row).toEqual({
        address: 'member-address',
        inbox_address: 'some-inbox',
      });
      expect('display_name' in row).toBe(false);
    });
  });
});
