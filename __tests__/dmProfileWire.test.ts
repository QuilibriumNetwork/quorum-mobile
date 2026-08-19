/**
 * dm-update-profile arrives in two dialects and BOTH must apply:
 *  - wrapped (mobile senders): a full Message, payload under `content`
 *  - flat (desktop senders):   { type, senderId, ... } at top level,
 *    no content, no messageId
 * The flat dialect was being consumed by the no-messageId backstop without
 * applying — measured live: a desktop rename never reached the mobile row.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseDmProfileUpdate } from '../services/dm/dmProfileWire';

const PARTNER = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

describe('parseDmProfileUpdate', () => {
  it('parses the wrapped (mobile) dialect', () => {
    const wrapped = {
      messageId: 'dm-profile-1234',
      content: {
        type: 'dm-update-profile',
        senderId: PARTNER,
        displayName: 'Alice',
        userIcon: 'data:image/png;base64,AAA',
      },
    };
    expect(parseDmProfileUpdate(wrapped)).toEqual({
      senderId: PARTNER,
      displayName: 'Alice',
      userIcon: 'data:image/png;base64,AAA',
      bio: undefined,
      primaryUsername: undefined,
    });
  });

  it('parses the flat (desktop) dialect', () => {
    const flat = {
      type: 'dm-update-profile',
      senderId: PARTNER,
      displayName: 'Alice',
      userIcon: 'data:image/png;base64,AAA',
    };
    expect(parseDmProfileUpdate(flat)).toEqual({
      senderId: PARTNER,
      displayName: 'Alice',
      userIcon: 'data:image/png;base64,AAA',
      bio: undefined,
      primaryUsername: undefined,
    });
  });

  it('carries primaryUsername presence-exactly (empty string is an un-election)', () => {
    const flat = { type: 'dm-update-profile', senderId: PARTNER, primaryUsername: '' };
    expect(parseDmProfileUpdate(flat)?.primaryUsername).toBe('');
    const without = { type: 'dm-update-profile', senderId: PARTNER };
    expect(parseDmProfileUpdate(without)?.primaryUsername).toBeUndefined();
  });

  it('returns null for receipts and other flat control frames', () => {
    expect(parseDmProfileUpdate({ type: 'delivery-ack', senderId: PARTNER, messageIds: ['x'] })).toBeNull();
    expect(parseDmProfileUpdate({ type: 'read-ack', senderId: PARTNER })).toBeNull();
    expect(parseDmProfileUpdate({ type: 'typing-start', senderId: PARTNER })).toBeNull();
  });

  it('returns null for ordinary chat messages in both shapes', () => {
    expect(parseDmProfileUpdate({ messageId: 'm1', content: { type: 'post', senderId: PARTNER } })).toBeNull();
    expect(parseDmProfileUpdate({})).toBeNull();
    expect(parseDmProfileUpdate(null)).toBeNull();
  });

  it('prefers the wrapped payload when both shapes are somehow present', () => {
    // A wrapped message whose top level accidentally also says type: the
    // content payload is the authored one and must win.
    const both = {
      type: 'dm-update-profile',
      displayName: 'TopLevel',
      content: { type: 'dm-update-profile', senderId: PARTNER, displayName: 'Wrapped' },
    };
    expect(parseDmProfileUpdate(both)?.displayName).toBe('Wrapped');
  });

  it('applyDmProfileUpdate goes through the dual-dialect parser', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'context', 'WebSocketContext.tsx'),
      'utf8',
    );
    expect(src).toMatch(/parseDmProfileUpdate\s*\(\s*decryptedMessage\s*\)/);
  });
});
