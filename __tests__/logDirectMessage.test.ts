/**
 * `logDirectMessage` — the write side of the Quorum DM rows in the
 * notifications panel.
 *
 * Space messages already logged themselves at their receive point; DMs had no
 * equivalent, which is the whole reason they never appeared in the panel. The
 * gates on the new call are the part worth pinning down: it must not log our
 * own messages, must not log a muted conversation, and must key per
 * CONVERSATION so an active chat refreshes one row instead of appending one
 * row per message.
 */

jest.mock('react-native-mmkv', () => ({
  createMMKV: ({ id }: { id: string }) => {
    const stores = ((globalThis as Record<string, unknown>).__mmkv ??= new Map()) as Map<
      string,
      Map<string, string>
    >;
    if (!stores.has(id)) stores.set(id, new Map());
    const store = stores.get(id)!;
    return {
      getString: (k: string) => store.get(k),
      set: (k: string, v: string) => store.set(k, v),
      remove: (k: string) => store.delete(k),
      delete: (k: string) => store.delete(k),
      getAllKeys: () => Array.from(store.keys()),
      clearAll: () => store.clear(),
      contains: (k: string) => store.has(k),
    };
  },
}));

const mockMutedConversations = new Set<string>();
jest.mock('@/services/config', () => ({
  getLocalNotificationTypes: () => ['mention-you', 'mention-everyone', 'mention-roles', 'reply'],
  isConversationMutedForCurrentUser: (id: string) => mockMutedConversations.has(id),
}));
jest.mock('@/hooks/chat/useReplyTracking', () => ({ getActiveChannelKey: () => null }));

import type { Message } from '@quilibrium/quorum-shared';
import { logDirectMessage } from '../services/notifications/logMentionOrReply';
import {
  clearMentionReplyLog,
  getMentionReplyLog,
  type DmEntry,
} from '../services/notifications/mentionReplyLog';

const ME = 'qm-me';
const THEM = 'qm-them';
const CONV = 'qm-them/qm-them';

function post(text: string, createdDate = 5_000): Message {
  return {
    messageId: `msg-${text}`,
    createdDate,
    content: { type: 'post', text, senderId: THEM },
  } as unknown as Message;
}

function log(): DmEntry[] {
  return getMentionReplyLog().filter((e): e is DmEntry => e.kind === 'dm');
}

beforeEach(() => {
  clearMentionReplyLog();
  mockMutedConversations.clear();
});

describe('logDirectMessage', () => {
  it('logs an incoming DM with the sender, the text, and a conversation link', () => {
    logDirectMessage({
      conversationId: CONV,
      senderId: THEM,
      senderName: 'Dana',
      userAddress: ME,
      message: post('lunch?'),
    });
    expect(log()).toEqual([
      {
        id: `dm:${CONV}`,
        kind: 'dm',
        conversationId: CONV,
        senderId: THEM,
        senderName: 'Dana',
        preview: { kind: 'text', text: 'lunch?' },
        createdAt: 5_000,
      },
    ]);
  });

  it('never logs our own message', () => {
    // Multi-device sync echoes our own sends back to us. A row saying we
    // messaged ourselves is the visible symptom.
    logDirectMessage({
      conversationId: CONV,
      senderId: ME,
      senderName: 'Me',
      userAddress: ME,
      message: post('sent from my other phone'),
    });
    expect(log()).toEqual([]);
  });

  it('logs nothing when we do not know who we are', () => {
    logDirectMessage({
      conversationId: CONV,
      senderId: THEM,
      userAddress: null,
      message: post('hi'),
    });
    expect(log()).toEqual([]);
  });

  it('logs nothing for a muted conversation', () => {
    mockMutedConversations.add(CONV);
    logDirectMessage({
      conversationId: CONV,
      senderId: THEM,
      senderName: 'Dana',
      userAddress: ME,
      message: post('hi'),
    });
    expect(log()).toEqual([]);
  });

  it('still logs an unmuted conversation while another one is muted', () => {
    // The control arm: the mute has to be per-conversation, not a global off
    // switch that a bad predicate could silently become.
    mockMutedConversations.add('someone-else/someone-else');
    logDirectMessage({
      conversationId: CONV,
      senderId: THEM,
      senderName: 'Dana',
      userAddress: ME,
      message: post('hi'),
    });
    expect(log()).toHaveLength(1);
  });

  it('refreshes one row per conversation instead of stacking a row per message', () => {
    // Without the per-conversation key, a live chat writes one panel row per
    // message and buries everything else in the log.
    logDirectMessage({
      conversationId: CONV,
      senderId: THEM,
      senderName: 'Dana',
      userAddress: ME,
      message: post('one', 5_000),
    });
    logDirectMessage({
      conversationId: CONV,
      senderId: THEM,
      senderName: 'Dana',
      userAddress: ME,
      message: post('two', 6_000),
    });
    expect(log()).toHaveLength(1);
    expect(log()[0]).toMatchObject({
      preview: { kind: 'text', text: 'two' },
      createdAt: 6_000,
    });
  });

  it('keeps separate rows for separate conversations', () => {
    logDirectMessage({
      conversationId: CONV,
      senderId: THEM,
      userAddress: ME,
      message: post('one'),
    });
    logDirectMessage({
      conversationId: 'other/other',
      senderId: 'other',
      userAddress: ME,
      message: post('two'),
    });
    expect(log().map((e) => e.conversationId)).toEqual(['other/other', CONV]);
  });

  it('logs nothing for a message with no text to show', () => {
    // Receipts and unknown control types reach this point with an empty
    // preview; a blank row is worse than no row.
    logDirectMessage({
      conversationId: CONV,
      senderId: THEM,
      userAddress: ME,
      message: { messageId: 'm', createdDate: 1, content: { type: 'post', text: '  ' } } as unknown as Message,
    });
    expect(log()).toEqual([]);
  });

  it('describes a non-text message rather than showing a blank row', () => {
    logDirectMessage({
      conversationId: CONV,
      senderId: THEM,
      userAddress: ME,
      message: { messageId: 'm', createdDate: 1, content: { type: 'sticker' } } as unknown as Message,
    });
    expect(log()[0].preview).toEqual({ kind: 'sticker', text: 'Sticker' });
  });
});
