/**
 * The unsigned-message warning is a claim about authorship, so the rule that
 * decides when it shows is worth pinning down.
 *
 * The bug this file exists for: the predicate only ever asked
 * `originalMessage?.signature`, which only Quorum messages carry. Farcaster
 * direct casts have no signature field in the protocol, so every single row in
 * every Farcaster conversation drew the warning and offered the user
 * "this may not be from the sender" — about a message that was fine.
 *
 * Note the CONTROL cases below: a genuinely unsigned Quorum message must still
 * warn. Without them a predicate hardcoded to `return false` would pass this
 * file, and the suite would be certifying nothing.
 */

import { shouldShowUnsignedWarning } from '@/components/Chat/unsignedWarning';
import { directCastToDisplayMessage, type DisplayMessage } from '@/components/Chat/types';
import type { DirectCastMessage } from '@/services/farcasterClient';

function quorumMessage(over: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: 'msg-1',
    userId: '0xabc',
    userName: 'Someone',
    userAvatar: '',
    timestamp: 1_700_000_000_000,
    timeString: '12:00',
    content: 'hello',
    renderType: 'post',
    ...over,
  };
}

function directCast(over: Partial<DirectCastMessage> = {}): DirectCastMessage {
  return {
    conversationId: 'conv-1',
    messageId: 'dc-1',
    senderFid: 4242,
    serverTimestamp: 1_700_000_000_000,
    type: 'text',
    message: 'gm',
    ...over,
  } as DirectCastMessage;
}

describe('shouldShowUnsignedWarning', () => {
  // --- CONTROL ARM: the warning must still fire where it means something -----

  it('WARNS on a Quorum message with no signature (deniable-mode send)', () => {
    expect(shouldShowUnsignedWarning(quorumMessage())).toBe(true);
  });

  it('WARNS on an unsigned Quorum media message', () => {
    expect(
      shouldShowUnsignedWarning(quorumMessage({ renderType: 'embed', imageUrl: 'https://x/y.png' }))
    ).toBe(true);
  });

  it('stays silent on a signed Quorum message', () => {
    const signed = quorumMessage({
      originalMessage: { signature: 'deadbeef' } as DisplayMessage['originalMessage'],
    });
    expect(shouldShowUnsignedWarning(signed)).toBe(false);
  });

  // --- THE REGRESSION: Farcaster direct casts ------------------------------

  it('never warns on a Farcaster direct cast — the transport has no signatures', () => {
    const row = directCastToDisplayMessage(directCast(), 1);
    expect(row.signatureNotApplicable).toBe(true);
    expect(shouldShowUnsignedWarning(row)).toBe(false);
  });

  it('never warns on a direct cast carrying an image, either', () => {
    const row = directCastToDisplayMessage(
      directCast({ message: 'https://imagedelivery.net/abc/original look' }),
      1
    );
    // The image path rewrites renderType, so this is a distinct render branch
    // (media rows draw the warning in the header, text rows draw it inline).
    expect(row.renderType).toBe('embed');
    expect(shouldShowUnsignedWarning(row)).toBe(false);
  });

  it('never warns on our own outgoing direct cast once it has landed', () => {
    const row = directCastToDisplayMessage(directCast({ senderFid: 1 }), 1);
    expect(shouldShowUnsignedWarning(row)).toBe(false);
  });

  // --- Rows that are not messages from anyone ------------------------------

  it('stays silent on system and error rows', () => {
    expect(shouldShowUnsignedWarning(quorumMessage({ renderType: 'system' }))).toBe(false);
    expect(shouldShowUnsignedWarning(quorumMessage({ renderType: 'error' }))).toBe(false);
  });

  it('stays silent while a message is still in flight', () => {
    expect(shouldShowUnsignedWarning(quorumMessage({ sendStatus: 'sending' }))).toBe(false);
    expect(shouldShowUnsignedWarning(quorumMessage({ sendStatus: 'failed' }))).toBe(false);
  });
});
