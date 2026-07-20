/**
 * Golden-vector tests for the canonical message fingerprint.
 *
 * The fingerprint is the exact byte string that gets ed448-signed and whose
 * SHA-256 is the wire messageId. Mobile and desktop MUST build it identically
 * or honest signatures verify as forgeries cross-platform (the failure that
 * dominated the 2026-07-19 debugging session). These hardcoded expectations
 * pin the byte layout so any drift in shared — or mobile drifting off shared —
 * turns into a red test instead of silent cross-platform message loss.
 */
import {
  buildMessageFingerprint,
  computeMessageIdHex,
} from '@quilibrium/quorum-shared';

describe('buildMessageFingerprint — cross-platform byte layout', () => {
  it('post (non-control): nonce + type + senderId + NO scope + text', () => {
    const fp = buildMessageFingerprint({
      nonce: 'n1',
      content: { type: 'post', senderId: 'userA', text: 'hello' },
      senderId: 'userA',
      spaceId: 'sp1',
      channelId: 'ch1',
    });
    // post is not a control type → spaceId/channelId are NOT bound.
    expect(fp).toBe('n1postuserAhello');
  });

  it('remove-message (control): binds spaceId+channelId between senderId and content', () => {
    const fp = buildMessageFingerprint({
      nonce: 'n1',
      content: { type: 'remove-message', senderId: 'userA', removeMessageId: 't1' },
      senderId: 'userA',
      spaceId: 'sp1',
      channelId: 'ch1',
    });
    // control type → scope = spaceId + channelId ('sp1ch1');
    // canonicalize(remove-message) = 'remove-message' + removeMessageId.
    expect(fp).toBe('n1remove-messageuserAsp1ch1remove-messaget1');
  });

  it('edit-message (control): scope-bound, canonicalize = type+originalId+text+editNonce', () => {
    const fp = buildMessageFingerprint({
      nonce: 'n1',
      content: {
        type: 'edit-message',
        senderId: 'userA',
        originalMessageId: 'orig1',
        editedText: 'new text',
        editedAt: 123,
        editNonce: 'en1',
      },
      senderId: 'userA',
      spaceId: 'sp1',
      channelId: 'ch1',
    });
    expect(fp).toBe('n1edit-messageuserAsp1ch1edit-messageorig1new texten1');
  });

  it('scope binding changes the fingerprint for control types across channels', () => {
    const base = {
      nonce: 'n1',
      content: { type: 'remove-message', senderId: 'userA', removeMessageId: 't1' } as const,
      senderId: 'userA',
      spaceId: 'sp1',
    };
    const inCh1 = buildMessageFingerprint({ ...base, channelId: 'ch1' });
    const inCh2 = buildMessageFingerprint({ ...base, channelId: 'ch2' });
    // Different channel → different fingerprint → a signed delete can't be
    // replayed into another channel/space.
    expect(inCh1).not.toBe(inCh2);
  });

  it('scope binding does NOT affect non-control posts across channels', () => {
    const base = {
      nonce: 'n1',
      content: { type: 'post', senderId: 'userA', text: 'hi' } as const,
      senderId: 'userA',
      spaceId: 'sp1',
    };
    const inCh1 = buildMessageFingerprint({ ...base, channelId: 'ch1' });
    const inCh2 = buildMessageFingerprint({ ...base, channelId: 'ch2' });
    // Post messageId is long-lived identity — must be channel-independent.
    expect(inCh1).toBe(inCh2);
  });

  it('computeMessageIdHex is deterministic lowercase 64-char hex', () => {
    const fp = 'n1postuserAhello';
    const id = computeMessageIdHex(fp);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(computeMessageIdHex(fp)).toBe(id); // stable
  });
});
