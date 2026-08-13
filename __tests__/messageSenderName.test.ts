/**
 * The sender name on a preview row — space activity, and the author prefix on
 * a mention or reply in the Notifications tab.
 *
 * This existed as `display_name || name`, which reads ONLY the per-space
 * override tier. It appeared to work for years for one accidental reason: a
 * `join` stamped the joiner's global name into that slot. The moment joins were
 * fixed to write the global slot where they belong, every freshly-joined member
 * lost their name here and rendered as a truncated address — trading a wrong
 * permanent name for a missing one, on the surfaces you look at right after
 * somebody joins.
 *
 * These are the cases that would have caught that, plus the `.q` tier, which
 * this surface could never show at all.
 */

import { messageSenderName } from '../utils/messagePreview';

const SENDER = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const ME = 'QmPeerBEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

const withMember = (member: Record<string, unknown>) =>
  messageSenderName(SENDER, ME, { [SENDER]: member as never });

describe('messageSenderName', () => {
  it('resolves a member whose identity is only in the global slot', () => {
    // The regression. A freshly-joined member has exactly this shape: the join
    // fills the global slot and leaves the per-space override empty.
    expect(withMember({ global_display_name: 'Alice' })).toBe('Alice');
  });

  it('lets a deliberate per-space name outrank the global one', () => {
    expect(
      withMember({ display_name: 'Alice in this space', global_display_name: 'Alice' }),
    ).toBe('Alice in this space');
  });

  it('shows a QNS name with its suffix, which this surface never could before', () => {
    expect(withMember({ primary_username: 'alice', global_display_name: 'Alice' })).toBe(
      'alice.q',
    );
  });

  it('ignores an unpromoted claim under claimed_primary_username, unlike primary_username above', () => {
    // This function performs no verification of its own — the test above shows
    // it happily renders a `.q` for whatever sits in `primary_username`. What
    // keeps that safe on the receive path is that nothing ever writes a raw
    // broadcast claim there: `WebSocketContext`'s roster-update handler stores
    // an incoming claim under `claimed_primary_username` instead, precisely so
    // a surface that (like this one) skips verification never sees it. This
    // pins that the field name alone does the protecting: reading the member
    // exactly as `storage.getSpaceMember` would return it — the claim present,
    // but only under its inert key — must fall through to the global name.
    expect(
      withMember({ claimed_primary_username: 'alice', global_display_name: 'Alice' }),
    ).toBe('Alice');
  });

  it('still lets a per-space name outrank a QNS name', () => {
    // The ladder's whole point: a name you chose for this space beats the `.q`.
    expect(
      withMember({ display_name: 'Mod Alice', primary_username: 'alice' }),
    ).toBe('Mod Alice');
  });

  it('falls back to a compact address when nothing resolves', () => {
    // Deliberately NOT the resolver's Qm-aware truncation — callers of this
    // function want the short form. Unchanged behaviour, pinned so the switch
    // to the resolver did not quietly alter it.
    expect(withMember({})).toBe(`${SENDER.slice(0, 8)}...`);
    expect(messageSenderName(SENDER, ME, undefined)).toBe(`${SENDER.slice(0, 8)}...`);
  });

  it('says You for your own messages', () => {
    expect(messageSenderName(ME, ME, undefined)).toBe('You');
  });

  it('returns undefined with no sender', () => {
    expect(messageSenderName(undefined, ME, undefined)).toBeUndefined();
  });
});
