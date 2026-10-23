/**
 * Direct casts arrive live over farcaster.xyz's websocket instead of polling.
 *
 * ## The change this pins
 *
 * The inbox polled every 30 s and an open chat every 5 s, re-fetching every
 * loaded page each time. Quilcast listens on `wss://ws.farcaster.xyz/stream`
 * with its direct-cast token and applies what arrives, and ours now does the
 * same.
 *
 * ## What is asserted
 *
 * - The socket authenticates with `dc_authenticate`, reconnects with backoff
 *   after a drop (saying so, to catch up), and stops when the token is revoked
 *   (4001).
 * - A new message goes into its chat and moves its conversation up with one more
 *   unread; on screen it's marked read instead. Our own message coming back
 *   replaces the copy still sending. A read clears the count. A conversation
 *   the inbox doesn't have is fetched on its own.
 * - The hook connects while the app is in front, closes in the background, and
 *   catches the inbox up when it reconnects.
 */
import React from 'react';
import { AppState } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { connectDirectCastSocket } from '@/services/farcaster/directCastSocket';
import { applyDirectCastEvent, useDirectCastLive, type DirectCastEventContext } from '@/hooks/chat/useDirectCastLive';
import { farcasterDCQueryKeys } from '@/hooks/chat/useFarcasterDirectCasts';
import type { DirectCastMessage } from '@/services/farcasterClient';

jest.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { farcaster: { fid: 42 } } }) }));
jest.mock('@/services/farcaster/directCastAuth', () => ({
  peekDirectCastToken: () => 'dc-1',
  subscribeDirectCastToken: () => () => {},
  getDirectCastToken: jest.fn(async () => 'dc-1'),
}));
jest.mock('@/services/farcaster/farcasterDMCache', () => ({
  getCachedDMConversations: () => undefined,
  setCachedDMConversations: () => {},
  getCachedDMMessages: () => undefined,
  setCachedDMMessages: () => {},
}));
jest.mock('@/utils/stripImageMetadata', () => ({ stripImageMetadata: async (uri: string) => uri }));

// --- a websocket --------------------------------------------------------------

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: unknown[] = [];
  closed = false;
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onerror?: () => void;
  onclose?: (e: { code: number }) => void;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  // test helpers
  open() {
    this.onopen?.();
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
  receive(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}
const latest = () => FakeSocket.all[FakeSocket.all.length - 1];

beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.all = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('the socket', () => {
  it('authenticates with the direct-cast token, and reconnects after a drop with backoff', () => {
    const onOpen = jest.fn();
    const onEvent = jest.fn();
    const socket = connectDirectCastSocket('dc-1', { onEvent, onOpen });

    expect(latest().url).toBe('wss://ws.farcaster.xyz/stream');
    latest().open();
    expect(latest().sent).toEqual([{ messageType: 'dc_authenticate', data: 'dc-1' }]);
    expect(onOpen).toHaveBeenLastCalledWith(false);

    latest().receive({ messageType: 'direct-cast-read', payload: { conversationId: '7-42' } });
    expect(onEvent).toHaveBeenCalledWith({ messageType: 'direct-cast-read', payload: { conversationId: '7-42' } });

    latest().drop();
    expect(FakeSocket.all).toHaveLength(1);
    jest.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
    // Failing again before it opens waits twice as long.
    latest().drop();
    jest.advanceTimersByTime(1999);
    expect(FakeSocket.all).toHaveLength(2);
    jest.advanceTimersByTime(1);
    latest().open();
    expect(onOpen).toHaveBeenLastCalledWith(true);

    socket.close();
    latest().drop();
    jest.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('keeps backing off when connections drop straight after opening', () => {
    connectDirectCastSocket('dc-1', { onEvent: jest.fn() });
    const reopenAfter = (ms: number) => {
      latest().drop();
      const before = FakeSocket.all.length;
      jest.advanceTimersByTime(ms - 1);
      expect(FakeSocket.all).toHaveLength(before);
      jest.advanceTimersByTime(1);
      expect(FakeSocket.all).toHaveLength(before + 1);
      latest().open();
    };
    latest().open();
    reopenAfter(1000);
    // Accepted, then dropped at once: the wait keeps doubling.
    reopenAfter(2000);
    reopenAfter(4000);
    // A connection that holds for 30 s starts the backoff again from a second.
    jest.advanceTimersByTime(30_000);
    reopenAfter(1000);
  });

    it('stops when the token is revoked', () => {
    const onRevoked = jest.fn();
    connectDirectCastSocket('dc-1', { onEvent: jest.fn(), onRevoked });
    latest().open();
    latest().drop(4001);
    jest.advanceTimersByTime(60_000);
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(FakeSocket.all).toHaveLength(1);
  });
});

// --- applying events ----------------------------------------------------------

const ME = 42;
function message(id: string, sender: number, text: string, extra: object = {}): DirectCastMessage {
  return {
    conversationId: '7-42',
    senderFid: sender,
    messageId: id,
    serverTimestamp: 2000,
    type: 'text',
    message: text,
    hasMention: false,
    reactions: [],
    isPinned: false,
    isDeleted: false,
    senderContext: { fid: sender, displayName: sender === ME ? 'Me' : 'Seven' },
    ...extra,
  };
}
function conversation(id: string, unreadCount = 0) {
  return {
    conversationId: `farcaster:${id}`,
    farcasterConversationId: id,
    type: 'direct',
    timestamp: 1000,
    displayName: id,
    unreadCount,
    lastMessagePreview: 'old',
  };
}

function setup() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(farcasterDCQueryKeys.conversations, {
    pages: [{ conversations: [conversation('9-42'), conversation('7-42', 1)] }],
    pageParams: [undefined],
  });
  queryClient.setQueryData(farcasterDCQueryKeys.messages('7-42'), {
    pages: [{ messages: [message('m-1', 7, 'first')] }],
    pageParams: [undefined],
  });
  const ctx: DirectCastEventContext & { onScreen: string | null } = {
    myFid: ME,
    onScreen: null,
    isOnScreen: (id) => ctx.onScreen === id,
    markRead: jest.fn(),
    refreshConversation: jest.fn(),
  };
  const apply = (event: object) => applyDirectCastEvent(queryClient, event as never, ctx);
  const chat = () =>
    queryClient.getQueryData<{ pages: { messages: DirectCastMessage[] }[] }>(farcasterDCQueryKeys.messages('7-42'))!.pages[0]
      .messages;
  const inbox = () =>
    queryClient.getQueryData<{ pages: { conversations: ReturnType<typeof conversation>[] }[] }>(
      farcasterDCQueryKeys.conversations,
    )!.pages[0].conversations;
  return { apply, chat, inbox, ctx, queryClient };
}

describe('an event', () => {
  it('puts a new message in its chat and moves its conversation up, one more unread', () => {
    const { apply, chat, inbox, ctx } = setup();
    apply({ messageType: 'refresh-direct-cast-conversation', payload: { conversationId: '7-42', message: message('m-2', 7, 'hello') } });

    expect(chat().map((m) => m.messageId)).toEqual(['m-2', 'm-1']);
    expect(inbox()[0]).toMatchObject({ farcasterConversationId: '7-42', unreadCount: 2, lastMessagePreview: 'hello', timestamp: 2000 });
    expect(ctx.markRead).not.toHaveBeenCalled();
  });

  it('on screen, is read as it arrives', () => {
    const { apply, inbox, ctx } = setup();
    ctx.onScreen = '7-42';
    apply({ messageType: 'refresh-direct-cast-conversation', payload: { conversationId: '7-42', message: message('m-2', 7, 'hello') } });

    expect(ctx.markRead).toHaveBeenCalledWith('7-42');
    expect(inbox()[0].unreadCount).toBe(1);
  });

  it('replaces our own message still sending, instead of adding a second', () => {
    const { apply, chat, queryClient } = setup();
    // The copy the send mutation puts on top while it sends.
    const sending = { ...message('optimistic-1', ME, 'mine'), _optimistic: true };
    queryClient.setQueryData(farcasterDCQueryKeys.messages('7-42'), {
      pages: [{ messages: [sending, message('m-1', 7, 'first')] }],
      pageParams: [undefined],
    });

    apply({ messageType: 'refresh-direct-cast-conversation', payload: { conversationId: '7-42', message: message('m-2', ME, 'mine') } });
    expect(chat().map((m) => m.messageId)).toEqual(['m-2', 'm-1']);
  });

  it('replaces a message it already has (an edit or a delete)', () => {
    const { apply, chat } = setup();
    apply({
      messageType: 'refresh-direct-cast-conversation',
      payload: { conversationId: '7-42', message: message('m-1', 7, '', { isDeleted: true }) },
    });
    expect(chat()).toHaveLength(1);
    expect(chat()[0].isDeleted).toBe(true);
  });

  it('clears the unread count when the conversation is read elsewhere', () => {
    const { apply, inbox } = setup();
    apply({ messageType: 'direct-cast-read', payload: { conversationId: '7-42' } });
    expect(inbox().find((c) => c.farcasterConversationId === '7-42')!.unreadCount).toBe(0);
  });

  it('fetches a conversation the inbox doesn’t have', () => {
    const { apply, ctx } = setup();
    apply({ messageType: 'refresh-direct-cast-conversation', payload: { conversationId: '5-42', message: message('m-9', 5, 'new') } });
    apply({ messageType: 'refresh-self-direct-casts-inbox', payload: { conversationId: '9-42' } });
    expect(ctx.refreshConversation).toHaveBeenCalledWith('5-42');
    expect(ctx.refreshConversation).toHaveBeenCalledWith('9-42');
  });
});

// --- the hook ------------------------------------------------------------------

describe('useDirectCastLive', () => {
  it('connects in front, closes in the background, and catches up when it reconnects', () => {
    let appStateHandler: ((state: string) => void) | undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, handler: (s: string) => void) => {
      appStateHandler = handler;
      return { remove: () => (appStateHandler = undefined) };
    }) as never);
    const queryClient = new QueryClient();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useDirectCastLive(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

    expect(FakeSocket.all).toHaveLength(1);
    act(() => latest().open());
    expect(latest().sent).toEqual([{ messageType: 'dc_authenticate', data: 'dc-1' }]);
    // A fetch already running is left to finish, not cancelled and restarted.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: farcasterDCQueryKeys.conversations }, { cancelRefetch: false });
    // Every chat held is marked stale; only the one on screen refetches now.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['farcaster-dc-messages'] }, { cancelRefetch: false });

    invalidate.mockClear();
    act(() => appStateHandler?.('background'));
    expect(FakeSocket.all[0].closed).toBe(true);

    act(() => appStateHandler?.('active'));
    expect(FakeSocket.all).toHaveLength(2);
    act(() => latest().open());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: farcasterDCQueryKeys.conversations }, { cancelRefetch: false });
  });
});
