/**
 * `logMentionOrReply` — specifically, that the row it stores resolves mention
 * tokens in the message body against the space roster.
 *
 * The observed bug: a mention row's entire preview was
 * `@<QmTestTestEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imz>`. The sender's name was
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
const MENTIONED = 'QmTestTestEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imz';

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
  // These used to assert that the NAME was baked in here. That resolution moved
  // to render time (`partitionNotifications`' `resolveName`, bound to
  // `@/identity` in `useUnifiedNotifications`), because this path runs on the
  // WebSocket receive thread with no React tree above it — so it can never
  // verify a QNS claim, and a `.q` could never appear in a notification for
  // anyone, including the viewer. See
  // `.agents/issues/.open/2026-08-14-space-mention-notifications-bake-names-at-write-time-so-no-q-ever-renders.md`.
  //
  // What is pinned here now is the other half of that contract: this function
  // must leave the token ALONE, because a baked name carries no token for the
  // panel to resolve and would silently reinstate the bug.
  it('stores the mention token RAW, for the panel to resolve', async () => {
    await logMentionOrReply(replyMentioning(`@<${MENTIONED}> take a look`), ctx());
    expect(storedText()).toBe(`@<${MENTIONED}> take a look`);
  });

  it('stores the token raw even when the roster DOES know them', async () => {
    // The trap this guards: a future change that resolves "only when it's
    // cheap" would bake a name exactly when the roster is warm, which is the
    // common case — so the bug would come back for most rows and look fixed in
    // whichever one happened to miss.
    await logMentionOrReply(replyMentioning(`@<${THEM}> hi`), ctx());
    expect(storedText()).toBe(`@<${THEM}> hi`);
  });

  it('costs no roster lookup for the body at all', async () => {
    // The body used to drive one `getSpaceMember` per mentioned address on the
    // receive path. Exactly one lookup remains, for the sender.
    let lookups = 0;
    await logMentionOrReply(
      replyMentioning(`@<${MENTIONED}> and @<${THEM}> both`),
      ctx({
        getSpaceMember: async (_s: string, id: string) => {
          lookups++;
          return roster[id];
        },
      }),
    );
    expect(lookups).toBe(1);
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

  it('leaves several mentions in one message raw', async () => {
    await logMentionOrReply(
      replyMentioning(`@<${MENTIONED}> and @<${THEM}> both`),
      ctx(),
    );
    expect(storedText()).toBe(`@<${MENTIONED}> and @<${THEM}> both`);
  });
});

describe('logMentionOrReply — a mention of the viewer', () => {
  // Every row in this section exists because somebody mentioned YOU, so the
  // viewer's own address is the likeliest one to appear in a body here.
  //
  // This block used to prove the viewer's name was resolved HERE, from a
  // `self` identity threaded down from `WebSocketContext`. That could never
  // produce the viewer's `.q`: `SelfIdentity` carries no `primaryUsername`, and
  // this path could not have verified one anyway. The viewer now resolves at
  // render like everyone else, through the same ladder that gives them their
  // `.q` in the channel — see `notificationNamesResolveAtRender.test.ts`.
  //
  // The `self` field is gone from the ctx entirely rather than left unused, so
  // this cannot quietly come back as a second naming path.

  it('leaves a mention of the viewer raw, like any other', async () => {
    // Self is NOT a special case at write time any more. If it were, the
    // viewer would be the one person whose name could never gain a `.q`.
    await logMentionOrReply(
      replyMentioning(`@<${ME}> ping`),
      ctx({ getSpaceMember: async () => undefined }),
    );
    expect(storedText()).toBe(`@<${ME}> ping`);
  });

  it('still logs the row when the viewer has no stored identity anywhere', async () => {
    // The row surviving is the part that matters; the name is the panel's job.
    await logMentionOrReply(
      replyMentioning(`@<${ME}> ping`),
      ctx({ getSpaceMember: async () => undefined }),
    );
    expect(getMentionReplyLog()).toHaveLength(1);
    expect(storedText()).toContain('ping');
  });
});

describe('logMentionOrReply — the sender name degrades, it never forges', () => {
  // This function runs on the WebSocket receive path, outside any React tree,
  // so it cannot call the hook that verifies a claimed QNS name against the
  // network. `resolveMemberName` (which builds both `senderName` and
  // `senderDisplayName` below) has no verification of its own either — see
  // `messageSenderName.test.ts`'s "shows a QNS name with its suffix" case,
  // which proves it renders a `.q` for whatever sits in `primary_username`,
  // no questions asked.
  //
  // What keeps this path honest is the roster row it is ever handed:
  // `ctx.getSpaceMember` is wired to `storage.getSpaceMember`
  // (`WebSocketContext.tsx`), and the ONLY thing that handler ever writes from
  // an incoming claim is `claimed_primary_username` — never bare
  // `primary_username`, which is reserved for a verified promotion that only
  // happens inside a React tree and is never persisted back to storage. So a
  // real roster row reaching this function can carry a claim, but never
  // through the field this function's `.q` tier actually reads.
  //
  // This is the receive-path counterpart to the chat screen, which resolves
  // the SAME sender through `@/identity` and, once the claim verifies, shows
  // `alice.q`. A notification for the identical message may still show
  // `Alice` — a degradation, not a bug: showing the unverified `.q` on a lock
  // screen would be exactly the forgery this architecture exists to prevent.
  it('shows the global name, never a .q, for a sender whose claim only ever arrived unpromoted', async () => {
    await logMentionOrReply(
      replyMentioning(`@<${THEM}> hi`),
      ctx({
        getSpaceMember: async (_s: string, id: string) =>
          id === THEM
            ? { address: THEM, global_display_name: 'Alice', claimed_primary_username: 'alice' }
            : roster[id],
      }),
    );

    const entry = getMentionReplyLog()[0];
    expect(entry.senderName).toBe('Alice');
    expect(entry.senderDisplayName).toBe('Alice');
    expect(entry.senderName).not.toContain('.q');
    expect(entry.senderDisplayName).not.toContain('.q');
  });

  it('would show the .q if the roster row ever carried a promoted claim — proving the field, not the function, is what protects this path', async () => {
    // The contrast case. Same sender, same claimed name, but expressed the way
    // a VERIFIED promotion would look (bare `primary_username`, the shape
    // `useVerifiedQnsNamesInMap` produces inside React and never persists).
    // This must render `.q` — if it did not, the test above would be passing
    // for the wrong reason (a resolver that drops every claim, not one that
    // only trusts a promoted one).
    await logMentionOrReply(
      replyMentioning(`@<${THEM}> hi`),
      ctx({
        getSpaceMember: async (_s: string, id: string) =>
          id === THEM
            ? { address: THEM, global_display_name: 'Alice', primary_username: 'alice' }
            : roster[id],
      }),
    );

    const entry = getMentionReplyLog()[0];
    expect(entry.senderName).toBe('alice.q');
    expect(entry.senderDisplayName).toBe('alice.q');
  });
});
