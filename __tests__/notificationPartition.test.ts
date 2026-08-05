/**
 * Notifications panel partitioning: Farcaster dismissal, cross-source dedup
 * ordering, muted-DM exclusion, and badge arithmetic.
 *
 * Pure functions only — `partitionNotifications` is the non-React core of
 * `useUnifiedNotifications`, and `isDismissed`/`reachedWatermark` are the pure
 * half of the MMKV-backed dismissal module.
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
  partitionNotifications,
  type ConversationDetail,
  type PartitionInput,
} from '../services/notifications/partitionNotifications';
import {
  clearFarcasterNotifications,
  getFarcasterClearedBefore,
  isDismissed,
  reachedWatermark,
  resetFarcasterDismissal,
} from '../services/notifications/farcasterDismissal';
import type { FarcasterNotification } from '../services/farcasterClient';
import type { NotificationLogEntry } from '../services/notifications/notificationLog';
import type { MentionReplyEntry } from '../services/notifications/mentionReplyLog';

const T = {
  old: 1_000,
  clear: 2_000,
  fresh: 3_000,
} as const;

function farcasterLike(over: Partial<FarcasterNotification> = {}): FarcasterNotification {
  return {
    id: 'official-1',
    type: 'cast-like',
    timestamp: T.fresh,
    reactionType: 'like',
    totalItemCount: 6,
    actor: { fid: 111, username: 'alice' },
    content: { cast: { hash: '0xABC', text: 'hello' } },
    ...over,
  } as FarcasterNotification;
}

function haatzLike(over: Partial<FarcasterNotification> = {}): FarcasterNotification {
  return {
    id: 'haatz:cast-like:222::3000',
    type: 'cast-like',
    timestamp: T.fresh,
    reactionType: 'like',
    actor: { fid: 222, username: 'bob' },
    content: { cast: { hash: 'abc', text: 'hello' } },
    ...over,
  } as FarcasterNotification;
}

function chatEntry(over: Partial<NotificationLogEntry> = {}): NotificationLogEntry {
  return {
    id: 'chat-1',
    title: 'New message',
    body: 'hey',
    createdAt: T.fresh,
    data: { type: 'message', conversationId: 'conv-1' },
    ...over,
  } as NotificationLogEntry;
}

function mention(over: Partial<MentionReplyEntry> = {}): MentionReplyEntry {
  return {
    id: 'space:chan:msg',
    kind: 'mention-you',
    spaceId: 'space',
    spaceName: 'Space',
    channelId: 'chan',
    channelName: 'general',
    senderId: 'sender',
    senderName: 'Carol',
    preview: { kind: 'text', text: 'ping' },
    createdAt: T.fresh,
    ...over,
  } as MentionReplyEntry;
}

function input(over: Partial<PartitionInput> = {}): PartitionInput {
  return {
    quorumEntries: [],
    chatEntries: [],
    officialFarcaster: [],
    haatzFarcaster: [],
    clearedBefore: 0,
    mutedConversations: new Set<string>(),
    lastSeen: 0,
    quorumTabUnread: 0,
    ...over,
  };
}

describe('isDismissed', () => {
  it('dismisses items at or below the watermark', () => {
    expect(isDismissed(T.old, T.clear)).toBe(true);
    expect(isDismissed(T.clear, T.clear)).toBe(true);
  });

  it('keeps items above the watermark', () => {
    expect(isDismissed(T.fresh, T.clear)).toBe(false);
  });

  it('dismisses nothing when the user has never cleared', () => {
    expect(isDismissed(T.old, 0)).toBe(false);
  });
});

describe('the dismissal watermark store', () => {
  afterEach(() => resetFarcasterDismissal());

  it('starts at 0 — never cleared', () => {
    expect(getFarcasterClearedBefore()).toBe(0);
  });

  it('records the clear instant and persists it', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(T.clear);
    try {
      clearFarcasterNotifications();
      expect(getFarcasterClearedBefore()).toBe(T.clear);
    } finally {
      now.mockRestore();
    }
  });

  it('resets back to never-cleared', () => {
    clearFarcasterNotifications();
    resetFarcasterDismissal();
    expect(getFarcasterClearedBefore()).toBe(0);
  });
});

describe('reachedWatermark', () => {
  it('is false when the user has never cleared, however old the items', () => {
    // The control arm: a user who never taps clear must see no change at all,
    // including in how far infinite scroll will page.
    expect(reachedWatermark([{ timestamp: 1 }], 0)).toBe(false);
  });

  it('is false while every fetched item is newer than the watermark', () => {
    expect(reachedWatermark([{ timestamp: T.fresh }], T.clear)).toBe(false);
  });

  it('is true once a fetched item reaches the watermark', () => {
    expect(reachedWatermark([{ timestamp: T.fresh }, { timestamp: T.old }], T.clear)).toBe(true);
  });
});

describe('partitionNotifications — Farcaster dismissal', () => {
  it('hides Farcaster items at or below the watermark and keeps newer ones', () => {
    const result = partitionNotifications(
      input({
        officialFarcaster: [
          farcasterLike({ id: 'stale', timestamp: T.old, content: { cast: { hash: '0x1' } } }),
          farcasterLike({ id: 'new', timestamp: T.fresh, content: { cast: { hash: '0x2' } } }),
        ],
        clearedBefore: T.clear,
      }),
    );
    expect(result.farcasterFeedItems.map((i) => i.id)).toEqual(['fc:new']);
  });

  it('shows an aggregated group again once new activity lifts its timestamp', () => {
    // The official feed keys a group off `latestTimestamp`, so a cleared
    // like-group that gets a NEW like must come back. This is the property
    // that makes a watermark viable where a dismissed-id set would not be.
    const cleared = partitionNotifications(
      input({
        officialFarcaster: [farcasterLike({ timestamp: T.old, totalItemCount: 6 })],
        clearedBefore: T.clear,
      }),
    );
    expect(cleared.farcasterFeedItems).toHaveLength(0);

    const relit = partitionNotifications(
      input({
        officialFarcaster: [farcasterLike({ timestamp: T.fresh, totalItemCount: 7 })],
        clearedBefore: T.clear,
      }),
    );
    expect(relit.farcasterFeedItems).toHaveLength(1);
  });

  it('leaves Quorum rows untouched when Farcaster is dismissed', () => {
    const result = partitionNotifications(
      input({
        quorumEntries: [mention({ createdAt: T.old })],
        officialFarcaster: [farcasterLike({ timestamp: T.old })],
        clearedBefore: T.clear,
      }),
    );
    expect(result.quorumItems).toHaveLength(1);
    expect(result.farcasterFeedItems).toHaveLength(0);
  });

  it('dismisses nothing when the user has never cleared', () => {
    const result = partitionNotifications(
      input({ officialFarcaster: [farcasterLike({ timestamp: 1 })], clearedBefore: 0 }),
    );
    expect(result.farcasterFeedItems).toHaveLength(1);
  });
});

describe('partitionNotifications — dismissedCount (the dev instrument)', () => {
  it('reports how many rows the watermark is suppressing', () => {
    const result = partitionNotifications(
      input({
        officialFarcaster: [
          farcasterLike({ id: 'a', timestamp: T.old, content: { cast: { hash: '0x1' } } }),
          farcasterLike({ id: 'b', timestamp: T.old, content: { cast: { hash: '0x2' } } }),
          farcasterLike({ id: 'c', timestamp: T.fresh, content: { cast: { hash: '0x3' } } }),
        ],
        clearedBefore: T.clear,
      }),
    );
    expect(result.dismissedCount).toBe(2);
    expect(result.farcasterFeedItems).toHaveLength(1);
  });

  it('reports 0 when the user has never cleared', () => {
    // The number has to be able to read 0 for a real reason, otherwise it
    // cannot distinguish "dismissal hid these" from "something else did".
    const result = partitionNotifications(
      input({ officialFarcaster: [farcasterLike({ timestamp: T.old })], clearedBefore: 0 }),
    );
    expect(result.dismissedCount).toBe(0);
    expect(result.farcasterFeedItems).toHaveLength(1);
  });

  it('counts post-dedup rows, so a suppressed haatz duplicate is not counted twice', () => {
    const result = partitionNotifications(
      input({
        officialFarcaster: [farcasterLike({ timestamp: T.old })],
        haatzFarcaster: [haatzLike({ timestamp: T.old })],
        clearedBefore: T.clear,
      }),
    );
    expect(result.dismissedCount).toBe(1);
  });

  it('counts haatz-only rows the official feed never covered', () => {
    // Counting over the official list alone undercounts: a haatz item with no
    // official counterpart survives the blend, gets dismissed, and would go
    // unreported — so the panel would show fewer hidden rows than it hid.
    // (The three cases above cannot catch this: with no haatz-only item,
    // blended.length and official.length are identical.)
    const result = partitionNotifications(
      input({
        officialFarcaster: [farcasterLike({ timestamp: T.old })],
        haatzFarcaster: [
          haatzLike({
            id: 'haatz-follow',
            type: 'follow',
            timestamp: T.old,
            actor: { fid: 999, username: 'erin' },
            content: undefined,
          }),
        ],
        clearedBefore: T.clear,
      }),
    );
    expect(result.dismissedCount).toBe(2);
    expect(result.farcasterFeedItems).toHaveLength(0);
  });
});

describe('partitionNotifications — dedup must run before dismissal', () => {
  it('does not resurface haatz per-actor likes for a dismissed official group', () => {
    // The official feed aggregates ("alice and 5 others liked"); haatz reports
    // one row per liker for the same cast. Dedup drops the haatz rows because
    // the official group covers their key.
    //
    // The two sources do not agree on timestamps (different APIs, and haatz's
    // are recovered by a magnitude heuristic over three possible epochs), so
    // the same like can land either side of the watermark depending on who is
    // reporting it. That is what makes the ORDER load-bearing: filter the
    // official list first and its key vanishes from the dedup set, so these
    // duplicates survive the blend and pop back as fresh rows — one per liker
    // — for a cast the user just cleared.
    //
    // Dedup has to see the COMPLETE official key set to do its job. Filtering
    // before blending corrupts its input.
    const result = partitionNotifications(
      input({
        officialFarcaster: [farcasterLike({ timestamp: T.old })],
        haatzFarcaster: [
          haatzLike({ id: 'h1', timestamp: T.fresh }),
          haatzLike({ id: 'h2', timestamp: T.fresh, actor: { fid: 333, username: 'dave' } }),
        ],
        clearedBefore: T.clear,
      }),
    );
    expect(result.farcasterFeedItems).toHaveLength(0);
  });

  it('still dedups haatz against the official feed when nothing is dismissed', () => {
    const result = partitionNotifications(
      input({
        officialFarcaster: [farcasterLike()],
        haatzFarcaster: [haatzLike()],
      }),
    );
    expect(result.farcasterFeedItems).toHaveLength(1);
    expect(result.farcasterFeedItems[0].id).toBe('fc:official-1');
  });
});

describe('partitionNotifications — sectioning', () => {
  it('files Quorum background pings under Quorum, not Farcaster', () => {
    const result = partitionNotifications(
      input({ chatEntries: [chatEntry()], officialFarcaster: [farcasterLike()] }),
    );
    expect(result.quorumItems.map((i) => i.source)).toEqual(['chat']);
    expect(result.farcasterFeedItems.map((i) => i.source)).toEqual(['farcaster']);
  });

  it('files Farcaster direct-cast pings under Farcaster, not Quorum', () => {
    // The background ping log is shared by both products. Filing all of it
    // under either heading mislabels the other half.
    const result = partitionNotifications(
      input({
        chatEntries: [
          chatEntry({ id: 'q', data: { type: 'message', messageId: 'bg-1', origin: 'quorum' } } as Partial<NotificationLogEntry>),
          chatEntry({ id: 'f', data: { type: 'message', messageId: 'fc-1', origin: 'farcaster' } } as Partial<NotificationLogEntry>),
        ],
      }),
    );
    expect(result.quorumItems.map((i) => i.id)).toEqual(['chat:q']);
    expect(result.farcasterFeedItems.map((i) => i.id)).toEqual(['chat:f']);
  });

  it('falls back to the messageId prefix for entries logged before `origin` existed', () => {
    const result = partitionNotifications(
      input({
        chatEntries: [
          chatEntry({ id: 'legacy-q', data: { type: 'message', messageId: 'bg-1' } } as Partial<NotificationLogEntry>),
          chatEntry({ id: 'legacy-f', data: { type: 'message', messageId: 'fc-1' } } as Partial<NotificationLogEntry>),
        ],
      }),
    );
    expect(result.quorumItems.map((i) => i.id)).toEqual(['chat:legacy-q']);
    expect(result.farcasterFeedItems.map((i) => i.id)).toEqual(['chat:legacy-f']);
  });

  it('excludes muted-DM pings from the panel', () => {
    // This filter used to be applied to the Farcaster array, because that is
    // where the chat rows lived. Chat rows are the only rows carrying a
    // conversationId, so if it does not travel with them, muted DMs quietly
    // reappear in the panel.
    const result = partitionNotifications(
      input({
        chatEntries: [chatEntry({ id: 'muted' }), chatEntry({ id: 'loud', data: { type: 'message', conversationId: 'conv-2' } } as Partial<NotificationLogEntry>)],
        mutedConversations: new Set(['conv-1']),
      }),
    );
    expect(result.quorumItems.map((i) => i.id)).toEqual(['chat:loud']);
  });

  it('sorts each section newest-first', () => {
    const result = partitionNotifications(
      input({
        quorumEntries: [mention({ id: 'a', createdAt: T.old }), mention({ id: 'b', createdAt: T.fresh })],
      }),
    );
    expect(result.quorumItems.map((i) => i.id)).toEqual(['quorum:b', 'quorum:a']);
  });
});

describe('partitionNotifications — render-time conversation enrichment', () => {
  const detail = (over: Partial<ConversationDetail> = {}) =>
    new Map<string, ConversationDetail>([
      [
        'conv-1',
        {
          displayName: 'Alice',
          preview: 'see you tomorrow',
          senderName: 'Alice',
          avatarUrl: 'https://example.test/alice.png',
          ...over,
        },
      ],
    ]);

  it('names the sender and shows the message on a ping it can resolve', () => {
    const result = partitionNotifications(
      input({
        chatEntries: [chatEntry({ title: 'New Messages', body: 'You have a new direct message' })],
        conversationDetails: detail(),
      }),
    );
    expect(result.quorumItems[0]).toMatchObject({
      title: 'Alice',
      body: 'see you tomorrow',
      actorAvatarUrl: 'https://example.test/alice.png',
    });
  });

  it('leaves the stored generic copy alone when the conversation is unknown', () => {
    // The fallback matters more than the happy path: a conversation the list
    // has not synced yet must still render a readable row, not an empty one.
    const result = partitionNotifications(
      input({
        chatEntries: [chatEntry({ title: 'New Messages', body: 'You have a new direct message' })],
        conversationDetails: new Map(),
      }),
    );
    expect(result.quorumItems[0]).toMatchObject({
      title: 'New Messages',
      body: 'You have a new direct message',
    });
    expect(result.quorumItems[0].actorAvatarUrl).toBeUndefined();
  });

  it('leaves a ping carrying no conversationId generic', () => {
    // The app-was-closed case: nothing was decrypted, so there is nothing to
    // join against and the row must not claim otherwise.
    const result = partitionNotifications(
      input({
        chatEntries: [
          chatEntry({
            title: 'New Message',
            body: 'You have new messages waiting',
            data: { type: 'message', messageId: 'bg-1', origin: 'quorum' },
          } as Partial<NotificationLogEntry>),
        ],
        conversationDetails: detail(),
      }),
    );
    expect(result.quorumItems[0]).toMatchObject({
      title: 'New Message',
      body: 'You have new messages waiting',
    });
  });

  it('prefixes the sender in a group, where the sender is not the conversation', () => {
    const result = partitionNotifications(
      input({
        chatEntries: [chatEntry()],
        conversationDetails: detail({ displayName: 'Team', senderName: 'Bob' }),
      }),
    );
    expect(result.quorumItems[0].body).toBe('Bob: see you tomorrow');
  });

  it('keeps the generic body when the conversation has no message text', () => {
    const result = partitionNotifications(
      input({
        chatEntries: [chatEntry({ body: 'You have a new direct message' })],
        conversationDetails: detail({ preview: '   ' }),
      }),
    );
    expect(result.quorumItems[0]).toMatchObject({
      title: 'Alice',
      body: 'You have a new direct message',
    });
  });

  it('changes nothing at all when no conversation list is supplied', () => {
    // The control arm: the badge mounts the hook without enrichment, so the
    // no-detail path has to behave exactly as it did before this existed.
    const bare = partitionNotifications(input({ chatEntries: [chatEntry()] }));
    expect(bare.quorumItems[0]).toMatchObject({ title: 'New message', body: 'hey' });
  });

  it('still excludes a muted DM after enrichment', () => {
    // Enrichment must not become a way for a muted conversation to reappear
    // wearing a nicer label.
    const result = partitionNotifications(
      input({
        chatEntries: [chatEntry()],
        conversationDetails: detail(),
        mutedConversations: new Set(['conv-1']),
      }),
    );
    expect(result.quorumItems).toEqual([]);
  });
});

describe('partitionNotifications — badge count', () => {
  it('still counts background pings after they move to the Quorum section', () => {
    // The chat rows' `timestamp > lastSeen` fallback used to live inside the
    // reducer over the Farcaster array. getQuorumTabUnreadCount() knows only
    // about the mention log, so if that fallback is not carried across, the
    // badge silently stops reflecting background pings.
    const result = partitionNotifications(
      input({ chatEntries: [chatEntry({ createdAt: T.fresh })], lastSeen: T.clear }),
    );
    expect(result.unreadCount).toBe(1);
  });

  it('does not count background pings already seen', () => {
    const result = partitionNotifications(
      input({ chatEntries: [chatEntry({ createdAt: T.old })], lastSeen: T.clear }),
    );
    expect(result.unreadCount).toBe(0);
  });

  it('prefers the server isUnread flag for Farcaster rows over lastSeen', () => {
    const result = partitionNotifications(
      input({
        officialFarcaster: [farcasterLike({ timestamp: T.fresh, isUnread: false })],
        lastSeen: 0,
      }),
    );
    expect(result.unreadCount).toBe(0);
  });

  it('excludes dismissed Farcaster rows from the badge', () => {
    const result = partitionNotifications(
      input({
        officialFarcaster: [farcasterLike({ timestamp: T.old, isUnread: true })],
        clearedBefore: T.clear,
      }),
    );
    expect(result.unreadCount).toBe(0);
  });

  it('counts a Farcaster direct-cast ping once, not twice', () => {
    // It is a chat row that renders in the Farcaster section. Summing the two
    // SECTION arrays would count it on both sides.
    const result = partitionNotifications(
      input({
        chatEntries: [
          chatEntry({ createdAt: T.fresh, data: { type: 'message', messageId: 'fc-1', origin: 'farcaster' } } as Partial<NotificationLogEntry>),
        ],
        lastSeen: T.clear,
      }),
    );
    expect(result.unreadCount).toBe(1);
  });

  it('sums the three sources', () => {
    const result = partitionNotifications(
      input({
        chatEntries: [chatEntry({ createdAt: T.fresh })],
        officialFarcaster: [farcasterLike({ timestamp: T.fresh, isUnread: true })],
        lastSeen: T.clear,
        quorumTabUnread: 3,
      }),
    );
    expect(result.unreadCount).toBe(5);
  });
});
