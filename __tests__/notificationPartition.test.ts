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
  dismissFarcasterNotification,
  getFarcasterClearedBefore,
  getFarcasterDismissedKeys,
  isDismissed,
  isItemDismissed,
  pruneDismissed,
  reachedWatermark,
  resetFarcasterDismissal,
} from '../services/notifications/farcasterDismissal';
import { farcasterDismissKey } from '../services/notifications/partitionNotifications';
import type { FarcasterNotification } from '../services/farcasterClient';
import type { NotificationLogEntry } from '../services/notifications/notificationLog';
import type {
  DmEntry,
  MentionReplyEntry,
} from '../services/notifications/mentionReplyLog';

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

function dm(over: Partial<DmEntry> = {}): DmEntry {
  return {
    id: 'dm:dm-conv',
    kind: 'dm',
    conversationId: 'dm-conv',
    senderId: 'sender',
    senderName: 'Dana',
    preview: { kind: 'text', text: 'lunch?' },
    createdAt: T.fresh,
    ...over,
  };
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
    quorumTabSeenAt: 0,
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

describe('partitionNotifications — Quorum DM rows', () => {
  it('files a DM under Quorum, alongside the mentions', () => {
    // The decision the plan settled: sections are named for the PRODUCT, so a
    // Quorum DM belongs under "Quorum". No fourth section, no fourth pill.
    const result = partitionNotifications(
      input({ quorumEntries: [dm(), mention()], officialFarcaster: [farcasterLike()] }),
    );
    expect(result.quorumItems.map((i) => i.id)).toEqual(['quorum:dm:dm-conv', 'quorum:space:chan:msg']);
    expect(result.farcasterFeedItems.map((i) => i.source)).toEqual(['farcaster']);
  });

  it('says who sent it and what they said', () => {
    const result = partitionNotifications(input({ quorumEntries: [dm()] }));
    expect(result.quorumItems[0]).toMatchObject({ title: 'Dana', body: 'lunch?' });
  });

  it('links to the conversation, not to a space channel', () => {
    const result = partitionNotifications(input({ quorumEntries: [dm()] }));
    expect(result.quorumItems[0].link).toEqual({
      type: 'message',
      conversationId: 'dm-conv',
    });
  });

  it('keeps the space breadcrumb on mention rows', () => {
    // The control arm: adding the DM branch must not change how a mention
    // renders, and a mention link must not acquire a conversationId.
    const result = partitionNotifications(input({ quorumEntries: [mention()] }));
    expect(result.quorumItems[0]).toMatchObject({
      title: 'Carol mentioned you',
      body: '#general · ping',
      link: { type: 'message', spaceId: 'space', channelId: 'chan' },
    });
  });

  it('excludes a muted DM from the panel', () => {
    const result = partitionNotifications(
      input({
        quorumEntries: [dm({ id: 'dm:muted', conversationId: 'muted' }), dm()],
        mutedConversations: new Set(['muted']),
      }),
    );
    expect(result.quorumItems.map((i) => i.id)).toEqual(['quorum:dm:dm-conv']);
  });

  it('falls back to "Someone" rather than showing nothing', () => {
    const result = partitionNotifications(
      input({ quorumEntries: [dm({ senderName: undefined })] }),
    );
    expect(result.quorumItems[0].title).toBe('Someone');
  });

  it('takes the sender avatar from the live conversation list', () => {
    // The log stores no picture — an avatar is the one thing that should always
    // be current rather than a point-in-time record — so the row joins the
    // conversation list for it, the same way the Farcaster ping rows do.
    const result = partitionNotifications(
      input({
        quorumEntries: [dm()],
        conversationDetails: new Map([
          ['dm-conv', { displayName: 'Dana', avatarUrl: 'https://example.test/dana.png' }],
        ]),
      }),
    );
    expect(result.quorumItems[0].actorAvatarUrl).toBe('https://example.test/dana.png');
  });

  it('refreshes the name from the conversation when it resolves', () => {
    // Repairs a row logged before the sender's profile had synced, which would
    // otherwise show a truncated address forever.
    const result = partitionNotifications(
      input({
        quorumEntries: [dm({ senderName: 'Qm3f4a…8b2' })],
        conversationDetails: new Map([['dm-conv', { displayName: 'Dana' }]]),
      }),
    );
    expect(result.quorumItems[0].title).toBe('Dana');
  });

  it('leaves a DM row without an avatar when the conversation is unknown', () => {
    // The renderer falls back to the envelope glyph here, so this must be
    // undefined rather than an empty string an <Image> would try to load.
    const result = partitionNotifications(
      input({ quorumEntries: [dm()], conversationDetails: new Map() }),
    );
    expect(result.quorumItems[0].actorAvatarUrl).toBeUndefined();
    expect(result.quorumItems[0].title).toBe('Dana');
  });

  it('never gives a space mention row an avatar from a same-named conversation', () => {
    // Only DM rows join the conversation list. A mention row keys on space and
    // channel, and must not pick up a conversation that happens to share an id.
    const result = partitionNotifications(
      input({
        quorumEntries: [mention({ id: 'space:chan:msg' })],
        conversationDetails: new Map([
          ['space:chan:msg', { displayName: 'Nope', avatarUrl: 'https://example.test/x.png' }],
        ]),
      }),
    );
    expect(result.quorumItems[0].actorAvatarUrl).toBeUndefined();
    expect(result.quorumItems[0].title).toBe('Carol mentioned you');
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
        quorumEntries: [
          mention({ id: 'm1', createdAt: T.fresh }),
          mention({ id: 'm2', createdAt: T.fresh }),
          mention({ id: 'm3', createdAt: T.fresh }),
        ],
        chatEntries: [chatEntry({ createdAt: T.fresh })],
        officialFarcaster: [farcasterLike({ timestamp: T.fresh, isUnread: true })],
        lastSeen: T.clear,
        quorumTabSeenAt: T.clear,
      }),
    );
    expect(result.unreadCount).toBe(5);
  });

  it('does not count mentions already seen', () => {
    const result = partitionNotifications(
      input({
        quorumEntries: [mention({ createdAt: T.old })],
        quorumTabSeenAt: T.clear,
      }),
    );
    expect(result.unreadCount).toBe(0);
  });

  it('does not count a muted DM it is not showing', () => {
    // The badge and the panel have to agree on what exists. Muting a
    // conversation after its row was logged hides the row; a badge that keeps
    // counting it is a number the user cannot resolve by opening the tab.
    const result = partitionNotifications(
      input({
        quorumEntries: [dm({ createdAt: T.fresh })],
        mutedConversations: new Set(['dm-conv']),
        quorumTabSeenAt: T.clear,
      }),
    );
    expect(result.quorumItems).toEqual([]);
    expect(result.unreadCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Per-item dismissal (the row trash button).
//
// This is a SUPPRESSION path: when it misbehaves, the symptom is a notification
// that silently never appears, which no amount of using the app would surface.
// So the cases below deliberately include the two ways it could over-suppress
// (hiding a newer event, or stopping pagination) rather than only proving that
// the happy path hides a row.
// ---------------------------------------------------------------------------

describe('isItemDismissed', () => {
  it('hides an item at or below its own dismissal instant', () => {
    expect(isItemDismissed('like:abc', T.old, { 'like:abc': T.clear })).toBe(true);
    expect(isItemDismissed('like:abc', T.clear, { 'like:abc': T.clear })).toBe(true);
  });

  it('lets an aggregate that gained newer activity come back', () => {
    // The whole reason a dismissal stores an INSTANT and not a boolean. A
    // like-group is keyed off its latest timestamp, so a new like on the same
    // cast lifts the row above its own dismissal and it should return.
    expect(isItemDismissed('like:abc', T.fresh, { 'like:abc': T.clear })).toBe(false);
  });

  it('ignores keys that were never dismissed', () => {
    expect(isItemDismissed('follow:9', T.old, { 'like:abc': T.clear })).toBe(false);
  });

  it('hides nothing for an unkeyable item', () => {
    expect(isItemDismissed(undefined, T.old, { 'like:abc': T.clear })).toBe(false);
  });
});

describe('farcasterDismissKey', () => {
  it('gives the same key to one event arriving from both sources', () => {
    // Same like, same liker, seen by both feeds — one row, one key.
    //
    // The earlier version of this test compared the official fixture (actor
    // fid 111) against the haatz fixture (fid 222) and asserted they matched.
    // They are not the same event, and asserting they were is what justified a
    // key too coarse to tell two likers apart. Pin the actor to compare like
    // with like.
    const sameLiker = { actor: { fid: 111 } } as Partial<FarcasterNotification>;
    expect(farcasterDismissKey(farcasterLike(sameLiker))).toBe(
      farcasterDismissKey(haatzLike(sameLiker)),
    );
  });

  it('separates two people liking the same cast', () => {
    // The property whose absence let one trash tap sweep other people's rows.
    expect(farcasterDismissKey(haatzLike({ actor: { fid: 222 } } as Partial<FarcasterNotification>))).not.toBe(
      farcasterDismissKey(haatzLike({ actor: { fid: 333 } } as Partial<FarcasterNotification>)),
    );
  });

  it('still keys a like at cast level, so the prefix survives', () => {
    // The actor is a suffix on the cast-level key, not a replacement for it.
    // Dropping the prefix would let a like and a follow by the same person
    // collide.
    expect(farcasterDismissKey(farcasterLike())).toBe('like:abc:111');
  });

  it('separates a like from a recast on the same cast', () => {
    expect(farcasterDismissKey(farcasterLike())).not.toBe(
      farcasterDismissKey(farcasterLike({ type: 'cast-recast', reactionType: 'recast' })),
    );
  });

  it('falls back to the id when there is nothing semantic to key on', () => {
    // Mini-app/frame rows: no cast, no actor fid. Without the fallback their
    // key would be empty and the trash button would silently do nothing.
    const frame = farcasterLike({
      id: 'frame-1',
      type: 'frame',
      actor: undefined,
      content: undefined,
    });
    expect(farcasterDismissKey(frame)).toBe('id:frame-1');
  });
});

describe('pruneDismissed', () => {
  it('drops keys the watermark already covers', () => {
    // A key dismissed at or below the watermark can only hide a subset of what
    // the watermark hides, so keeping it is pure growth. This is what makes
    // "Clear all" collapse the map instead of accumulating one entry per clear.
    expect(pruneDismissed({ a: T.old, b: T.fresh }, T.clear)).toEqual({ b: T.fresh });
  });

  it('keeps everything when the user has never cleared', () => {
    expect(pruneDismissed({ a: T.old, b: T.fresh }, 0)).toEqual({ a: T.old, b: T.fresh });
  });

  it('drops a corrupted non-finite entry rather than carrying it forward', () => {
    expect(pruneDismissed({ a: NaN, b: T.fresh }, 0)).toEqual({ b: T.fresh });
  });
});

describe('the per-item dismissal store', () => {
  afterEach(() => resetFarcasterDismissal());

  it('starts empty', () => {
    expect(getFarcasterDismissedKeys()).toEqual({});
  });

  it('records the dismissal instant against the key and persists it', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(T.clear);
    try {
      dismissFarcasterNotification('like:abc');
      expect(getFarcasterDismissedKeys()).toEqual({ 'like:abc': T.clear });
    } finally {
      now.mockRestore();
    }
  });

  it('is emptied by a clear-all, which subsumes it', () => {
    dismissFarcasterNotification('like:abc');
    clearFarcasterNotifications();
    expect(getFarcasterDismissedKeys()).toEqual({});
  });

  it('is emptied by reset, so the dev undo covers both mechanisms', () => {
    dismissFarcasterNotification('like:abc');
    resetFarcasterDismissal();
    expect(getFarcasterDismissedKeys()).toEqual({});
  });
});

describe('partitionNotifications — per-item Farcaster dismissal', () => {
  /**
   * Take the dismiss key off the RENDERED row, then dismiss that row.
   *
   * Deliberately not a hand-written literal like `'like:abc'`. A literal stops
   * matching the moment the keying rule changes and the assertion below it goes
   * on passing while testing nothing — which is exactly how the cast-level
   * over-suppression bug shipped green.
   */
  function dismissRow(
    over: Partial<PartitionInput>,
    id: string,
    at = 5_000,
  ): ReturnType<typeof partitionNotifications> {
    const row = partitionNotifications(input(over)).farcasterFeedItems.find((i) => i.id === id);
    if (!row?.dismissKey) throw new Error(`no dismissKey on row ${id}`);
    return partitionNotifications(input({ ...over, dismissedKeys: { [row.dismissKey]: at } }));
  }

  it('hides only the dismissed row', () => {
    const feed: Partial<PartitionInput> = {
      officialFarcaster: [
        farcasterLike(),
        farcasterLike({
          id: 'official-2',
          content: { cast: { hash: '0xDEF', text: 'other' } },
        } as Partial<FarcasterNotification>),
      ],
    };
    const after = dismissRow(feed, 'fc:official-1');
    expect(after.farcasterFeedItems).toHaveLength(1);
    expect(after.farcasterFeedItems[0].id).toBe('fc:official-2');
    expect(after.dismissedCount).toBe(1);
  });

  it('hides only the row trashed when several people liked the SAME cast', () => {
    // THE REGRESSION THIS GUARDS.
    //
    // The official feed aggregates same-cast likes into one row, which is why
    // the DEDUP key is cast-level. But when the official feed is absent — no
    // token, an expired token, a poll gap — haatz's per-actor rows are
    // aggregated by nothing and render as several distinct rows. Keying
    // DISMISSAL at cast level too made one trash tap hide every one of them.
    //
    // Unrecoverable, which is what made it severe: haatz events are re-fetched
    // from a capped window, so once the swept rows aged out there was nothing
    // left to bring them back, and no signal that dismissal was the reason.
    const likes: Partial<PartitionInput> = {
      haatzFarcaster: [
        haatzLike({ id: 'h:bob', actor: { fid: 222 }, timestamp: 1_000 } as Partial<FarcasterNotification>),
        haatzLike({ id: 'h:carol', actor: { fid: 333 }, timestamp: 2_000 } as Partial<FarcasterNotification>),
        haatzLike({ id: 'h:dave', actor: { fid: 444 }, timestamp: 3_000 } as Partial<FarcasterNotification>),
      ],
    };
    expect(partitionNotifications(input(likes)).farcasterFeedItems).toHaveLength(3);
    // Trash the OLDEST row. A cast-level key stamped with "now" sweeps the two
    // newer ones with it, so picking the oldest is what makes the bug visible.
    const after = dismissRow(likes, 'fc:h:bob');
    expect(after.farcasterFeedItems.map((i) => i.id).sort()).toEqual(['fc:h:carol', 'fc:h:dave']);
  });

  it('still collapses one event that arrived from both sources', () => {
    // The cross-source case, stated honestly. The BLEND drops the haatz copy
    // because it shares a dedup key with the official row, so only one row is
    // ever visible and dismissing it leaves nothing.
    //
    // This is all the previous version of this test ever proved. It was written
    // as though DISMISSAL did the collapsing — it does not, and believing it did
    // is what justified the too-coarse key.
    const both: Partial<PartitionInput> = {
      officialFarcaster: [farcasterLike()],
      haatzFarcaster: [haatzLike()],
    };
    expect(partitionNotifications(input(both)).farcasterFeedItems).toHaveLength(1);
    expect(dismissRow(both, 'fc:official-1').farcasterFeedItems).toEqual([]);
  });

  it('brings the row back when the cast gets newer activity', () => {
    const key = partitionNotifications(input({ officialFarcaster: [farcasterLike()] }))
      .farcasterFeedItems[0].dismissKey!;
    // Dismissed at T.fresh; the group then gains a like and moves past it.
    const result = partitionNotifications(
      input({
        officialFarcaster: [farcasterLike({ timestamp: T.fresh + 1 })],
        dismissedKeys: { [key]: T.fresh },
      }),
    );
    expect(result.farcasterFeedItems).toHaveLength(1);
    expect(result.dismissedCount).toBe(0);
  });

  it('does not stop pagination', () => {
    // The control that matters most. Per-item dismissals are scattered through
    // the feed, so treating one as a floor the way the watermark is treated
    // would halt infinite scroll at the first hidden row and make every older
    // notification unreachable.
    const after = dismissRow({ officialFarcaster: [farcasterLike()] }, 'fc:official-1');
    expect(after.farcasterFeedItems).toEqual([]);
    expect(after.reachedWatermark).toBe(false);
  });

  it('leaves a user who has dismissed nothing completely unaffected', () => {
    // The control arm — same input, empty dismissal map.
    const withNone = partitionNotifications(
      input({ officialFarcaster: [farcasterLike()], haatzFarcaster: [haatzLike()] }),
    );
    expect(withNone.farcasterFeedItems).toHaveLength(1);
    expect(withNone.dismissedCount).toBe(0);
  });

  it('carries a dismiss key on every Farcaster row, so every row can be hidden', () => {
    const result = partitionNotifications(
      input({
        officialFarcaster: [
          farcasterLike(),
          farcasterLike({
            id: 'frame-1',
            type: 'frame',
            actor: undefined,
            content: undefined,
          } as Partial<FarcasterNotification>),
        ],
      }),
    );
    expect(result.farcasterFeedItems.every((i) => !!i.dismissKey)).toBe(true);
  });
});

describe('row kind, for the leading glyph', () => {
  it('labels each Farcaster activity so the renderer picks from a closed set', () => {
    const kinds = partitionNotifications(
      input({
        officialFarcaster: [
          farcasterLike(),
          farcasterLike({ id: 'o2', type: 'follow', content: undefined } as Partial<FarcasterNotification>),
          farcasterLike({ id: 'o3', type: 'cast-reply' }),
        ],
      }),
    )
      .farcasterFeedItems.map((i) => i.farcasterKind)
      .sort();
    expect(kinds).toEqual(['follow', 'like', 'reply']);
  });

  it('flags a ping that resolved a conversation, and one that did not', () => {
    // Drives initials-vs-glyph in the leading slot. A ping whose join missed
    // still has a title — the generic stored copy — so drawing initials of it
    // would render "New message" as somebody's monogram.
    const details = new Map<string, ConversationDetail>([
      ['conv-1', { displayName: 'Dana', preview: 'hey', avatarUrl: undefined }],
    ]);
    const resolved = partitionNotifications(
      input({ chatEntries: [chatEntry()], conversationDetails: details }),
    );
    expect(resolved.quorumItems[0].namesConversation).toBe(true);

    const missed = partitionNotifications(
      input({
        chatEntries: [
          chatEntry({
            data: { type: 'message', conversationId: 'nope', messageId: 'm1' },
          }),
        ],
      }),
    );
    expect(missed.quorumItems[0].namesConversation).toBeFalsy();
  });
});
