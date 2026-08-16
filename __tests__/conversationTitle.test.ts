/**
 * The Farcaster/fallback half of the name a DM shows for the person you are
 * talking to — the `.q`-carrying half now lives in `@/identity` (see the two
 * callers, `app/(tabs)/messages/index.tsx` and `app/(tabs)/messages/dm/[id].tsx`).
 *
 * The inbox row and the conversation header had this logic written out twice,
 * and they disagreed: the header learned to rank a `.q` above the global name
 * while the list carried on rendering `conv.displayName` raw. These cases pin
 * the shared GLOBAL-name rule that remains here — a conversation's `displayName`
 * is the partner's GLOBAL name, not a per-conversation override, because a DM
 * cannot be renamed.
 *
 * `ConversationIdentity` no longer has a `primary_username` field: this
 * function used to accept one and trust the caller to have verified it first,
 * a caller-discipline guarantee rather than a structural one. It is gone
 * entirely now, so there is nothing here to un-verify a test against — a
 * Quorum conversation's `.q` can only come from `@/identity` at the call site.
 */

import { resolveConversationTitle } from '../utils/conversationTitle';
import { truncateAddress } from '../utils/formatAddress';

const PARTNER = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

describe('resolveConversationTitle', () => {
  it('shows the global name — this function has no QNS tier at all any more', () => {
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
    // actually holds the QNS name — relevant here for the Farcaster case,
    // whose displayName is never verified either.
    expect(
      resolveConversationTitle({ address: PARTNER, displayName: 'alice.q' }),
    ).toBe(truncateAddress(PARTNER, 'long'));
  });
});
