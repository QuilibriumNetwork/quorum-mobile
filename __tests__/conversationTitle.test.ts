/**
 * The name a DM shows for the person you are talking to.
 *
 * The inbox row and the conversation header had this logic written out twice,
 * and they disagreed: the header learned to rank a `.q` above the global name
 * while the list carried on rendering `conv.displayName` raw. These cases pin
 * the shared rule, and in particular the one that was wrong — a conversation's
 * `displayName` is the partner's GLOBAL name, not a per-conversation override,
 * because a DM cannot be renamed.
 */

import { resolveConversationTitle } from '../utils/conversationTitle';
import { truncateAddress } from '../utils/formatAddress';

const PARTNER = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

describe('resolveConversationTitle', () => {
  it('shows the .q above the partner global name', () => {
    // The regression. `displayName` is the partner's own global name arriving
    // over their broadcast; treating it as a per-conversation override ranked
    // it above the `.q` and the `.q` could never appear in a DM.
    expect(
      resolveConversationTitle({
        address: PARTNER,
        displayName: 'Alice',
        primary_username: 'alice',
      }),
    ).toBe('alice.q');
  });

  it('shows the global name when there is no .q', () => {
    expect(resolveConversationTitle({ address: PARTNER, displayName: 'Alice' })).toBe(
      'Alice',
    );
  });

  it('falls back to the long-form address when nothing resolves', () => {
    // Deliberately the `long` preset, not the resolver's default `medium`. Both
    // DM surfaces have always used it and a row is wide enough.
    expect(resolveConversationTitle({ address: PARTNER })).toBe(
      truncateAddress(PARTNER, 'long'),
    );
  });

  it('treats a blank display name as absent rather than rendering empty', () => {
    expect(resolveConversationTitle({ address: PARTNER, displayName: '   ' })).toBe(
      truncateAddress(PARTNER, 'long'),
    );
  });

  it('says Conversation when there is not even an address', () => {
    expect(resolveConversationTitle({ displayName: 'Alice' })).toBe('Conversation');
    expect(resolveConversationTitle(undefined)).toBe('Conversation');
  });

  it('honours a caller-supplied empty label', () => {
    expect(resolveConversationTitle({}, 'New message')).toBe('New message');
  });

  it('refuses a global name that would forge the verified .q marker', () => {
    // The forgery guard, reached through this helper. A partner broadcasting
    // the display name "alice.q" must not render identically to someone who
    // actually holds the QNS name.
    expect(
      resolveConversationTitle({ address: PARTNER, displayName: 'alice.q' }),
    ).toBe(truncateAddress(PARTNER, 'long'));
  });
});
