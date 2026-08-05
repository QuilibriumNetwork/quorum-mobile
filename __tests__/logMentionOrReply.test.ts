/**
 * `logMentionOrReply` — specifically, that the row it stores resolves mention
 * tokens in the message body against the space roster.
 *
 * The observed bug: a mention row's entire preview was
 * `@<QmQuCGpEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imXST1>`. The sender's name was
 * handled carefully in this same function and deliberately refused to show a
 * hash; mentions inside the body got no equivalent treatment.
 *
 * Uses `reply` rather than a mention to trigger classification, because the
 * point here is the PREVIEW, and reply detection is a single field comparison
 * rather than the shared mention predicate. What is being tested is what gets
 * written, not which kind it was written as.
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

jest.mock('@/services/config', () => ({
  getLocalNotificationTypes: () => ['mention-you', 'mention-everyone', 'mention-roles', 'reply'],
  isConversationMutedForCurrentUser: () => false,
}));
jest.mock('@/hooks/chat/useReplyTracking', () => ({ getActiveChannelKey: () => null }));

import type { Message } from '@quilibrium/quorum-shared';
import { logMentionOrReply } from '../services/notifications/logMentionOrReply';
import {
  clearMentionReplyLog,
  getMentionReplyLog,
} from '../services/notifications/mentionReplyLog';

const ME = 'QmMeMeMeEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imMMM1';
const THEM = 'QmThemThemgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imTT1';
const MENTIONED = 'QmQuCGpEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imXST1';

/** A reply to one of my messages, whose body mentions someone. */
function replyMentioning(text: string): Message {
  return {
    messageId: 'msg-1',
    createdDate: 5_000,
    replyMetadata: { parentAuthor: ME },
    content: { type: 'post', text, senderId: THEM },
  } as unknown as Message;
}

const roster: Record<string, { display_name?: string }> = {
  [MENTIONED]: { display_name: 'Brave Light' },
  [THEM]: { display_name: 'Sender' },
};

function ctx(over: Partial<Parameters<typeof logMentionOrReply>[1]> = {}) {
  return {
    spaceId: 'space',
    channelId: 'chan',
    userAddress: ME,
    notifyForBadge: true,
    getSpaceMember: async (_s: string, id: string) => roster[id],
    ...over,
  } as Parameters<typeof logMentionOrReply>[1];
}

const storedText = () => getMentionReplyLog()[0]?.preview.text;

beforeEach(() => clearMentionReplyLog());

describe('logMentionOrReply — mentions inside the body', () => {
  it('stores the mentioned person\'s name, not their address', () => {
    return logMentionOrReply(replyMentioning(`@<${MENTIONED}> take a look`), ctx()).then(() => {
      expect(storedText()).toBe('@Brave Light take a look');
    });
  });

  it('stores a truncated address when the roster does not know them', async () => {
    await logMentionOrReply(
      replyMentioning(`@<${MENTIONED}> hi`),
      ctx({ getSpaceMember: async () => undefined }),
    );
    expect(storedText()).not.toContain(MENTIONED);
    expect(storedText()).toContain('hi');
  });

  it('does not substitute one form of the hash for another', async () => {
    // A roster row with no name at all resolves to the address itself. Storing
    // that would "resolve" the mention into the same hash we were avoiding.
    await logMentionOrReply(
      replyMentioning(`@<${MENTIONED}> hi`),
      ctx({ getSpaceMember: async () => ({}) }),
    );
    expect(storedText()).not.toContain(MENTIONED);
  });

  it('survives a roster lookup that throws', async () => {
    // A lookup failure must cost the mention its name, not cost the user the
    // whole notification.
    await logMentionOrReply(
      replyMentioning(`@<${MENTIONED}> hi`),
      ctx({
        getSpaceMember: async (_s: string, id: string) => {
          if (id === MENTIONED) throw new Error('roster unavailable');
          return roster[id];
        },
      }),
    );
    expect(getMentionReplyLog()).toHaveLength(1);
    expect(storedText()).toContain('hi');
    expect(storedText()).not.toContain(MENTIONED);
  });

  it('leaves a message with no mentions exactly as written', async () => {
    // The control arm: the common case must be untouched, and must not pay for
    // a roster round-trip either.
    let lookups = 0;
    await logMentionOrReply(
      replyMentioning('just a normal reply'),
      ctx({
        getSpaceMember: async (_s: string, id: string) => {
          lookups++;
          return roster[id];
        },
      }),
    );
    expect(storedText()).toBe('just a normal reply');
    // Exactly one: the sender. None for the body.
    expect(lookups).toBe(1);
  });

  it('resolves several mentions in one message', async () => {
    await logMentionOrReply(
      replyMentioning(`@<${MENTIONED}> and @<${THEM}> both`),
      ctx(),
    );
    expect(storedText()).toBe('@Brave Light and @Sender both');
  });
});
