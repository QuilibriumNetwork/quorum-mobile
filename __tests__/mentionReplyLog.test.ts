/**
 * The mentions/replies/DM log: per-row delete, and the boundary between the
 * two kinds of entry it now holds.
 *
 * The delete path is what the panel's per-row trash calls. The channel-unread
 * boundary matters because a DM entry has no space or channel — if one leaked
 * into the per-channel counts it would show up as a mention bubble on a channel
 * nobody was mentioned in, with nothing in that channel to explain it.
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

import {
  appendMentionReplyLog,
  clearMentionReplyLog,
  getMentionReplyLog,
  getUnreadCountForChannel,
  markChannelMentionsRead,
  removeMentionReplyEntry,
  type DmEntry,
  type SpaceMentionEntry,
} from '../services/notifications/mentionReplyLog';

function mention(id: string, createdAt = 5_000): SpaceMentionEntry {
  return {
    id,
    kind: 'mention-you',
    spaceId: 'space',
    channelId: 'chan',
    senderId: 'sender',
    preview: { kind: 'text', text: 'ping' },
    createdAt,
  };
}

function dm(id: string, createdAt = 5_000): DmEntry {
  return {
    id,
    kind: 'dm',
    conversationId: id.replace('dm:', ''),
    senderId: 'dana',
    preview: { kind: 'text', text: 'lunch?' },
    createdAt,
  };
}

beforeEach(() => clearMentionReplyLog());

describe('removeMentionReplyEntry', () => {
  it('removes the named row and leaves the rest', () => {
    appendMentionReplyLog(mention('a'));
    appendMentionReplyLog(mention('b'));
    appendMentionReplyLog(mention('c'));
    removeMentionReplyEntry('b');
    expect(getMentionReplyLog().map((e) => e.id)).toEqual(['c', 'a']);
  });

  it('removes a DM row the same way', () => {
    appendMentionReplyLog(dm('dm:conv-1'));
    appendMentionReplyLog(mention('a'));
    removeMentionReplyEntry('dm:conv-1');
    expect(getMentionReplyLog().map((e) => e.id)).toEqual(['a']);
  });

  it('does nothing for an id that is not there', () => {
    // The control arm: a stale id from a row already gone must not clear the
    // log or throw.
    appendMentionReplyLog(mention('a'));
    removeMentionReplyEntry('nope');
    expect(getMentionReplyLog().map((e) => e.id)).toEqual(['a']);
  });
});

describe('a log holding both kinds of entry', () => {
  it('keeps every field of a DM row through the storage round-trip', () => {
    // Entries are JSON'd into MMKV and coerced back on read. The read path was
    // written when every entry had a spaceId and a channelId, so this is the
    // assertion that would catch it silently dropping the DM-only fields.
    appendMentionReplyLog(dm('dm:conv-1', 7_000));
    expect(getMentionReplyLog()[0]).toEqual({
      id: 'dm:conv-1',
      kind: 'dm',
      conversationId: 'conv-1',
      senderId: 'dana',
      preview: { kind: 'text', text: 'lunch?' },
      createdAt: 7_000,
    });
  });

  it('counts a channel\'s mentions with DM rows sitting in the same log', () => {
    // NOTE on what this does and does not prove. `isSpaceMention` in the count
    // reducers is a TYPE guard, not a behavioral filter: a DM row has no
    // spaceId/channelId, so it keys to "undefined:undefined" and could never
    // match a real channel even without it. What this does catch is the count
    // path breaking on an entry shape it no longer expects.
    appendMentionReplyLog(mention('a'));
    appendMentionReplyLog(mention('b'));
    appendMentionReplyLog(dm('dm:conv-1'));
    expect(getUnreadCountForChannel('space', 'chan')).toBe(2);
  });

  it('drops the channel count to zero once the channel is marked read', () => {
    appendMentionReplyLog(mention('a', 5_000));
    expect(getUnreadCountForChannel('space', 'chan')).toBe(1);
    markChannelMentionsRead('space', 'chan', 6_000);
    expect(getUnreadCountForChannel('space', 'chan')).toBe(0);
  });

  it('never moves a channel read mark backwards', () => {
    appendMentionReplyLog(mention('a', 5_000));
    markChannelMentionsRead('space', 'chan', 6_000);
    markChannelMentionsRead('space', 'chan', 1_000);
    expect(getUnreadCountForChannel('space', 'chan')).toBe(0);
  });
});
