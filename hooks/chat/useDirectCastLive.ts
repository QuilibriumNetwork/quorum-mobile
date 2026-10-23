/**
 * Keeps the direct-cast inbox and open chats current from farcaster.xyz's
 * websocket (`services/farcaster/directCastSocket.ts`), as Quilcast does,
 * instead of polling.
 *
 * - A new message goes straight into its chat (if loaded) and moves its
 *   conversation up the inbox. Our own message coming back replaces the copy
 *   still sending, so nothing doubles.
 * - A message in the chat on screen is marked read as it arrives; elsewhere it
 *   counts as unread.
 * - A conversation the inbox doesn't have yet is fetched on its own.
 * - Each (re)connection catches the inbox and the open chat up, since events
 *   sent while the socket was down are lost. The socket is closed while the app
 *   is in the background and opened again when it returns.
 *
 * Mounted once, in the tabs layout.
 */

import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { getDirectCastToken } from '@/services/farcaster/directCastAuth';
import { connectDirectCastSocket, type DirectCastEvent } from '@/services/farcaster/directCastSocket';
import {
  getDirectCastConversation,
  markDirectCastRead,
  type DirectCastMessage,
} from '@/services/farcasterClient';
import {
  farcasterDCQueryKeys,
  toUnifiedConversation,
  updateCachedConversation,
  useDirectCastToken,
  type InboxData,
} from './useFarcasterDirectCasts';

/** How long events for one conversation gather before it's fetched once. */
const REFRESH_DELAY_MS = 1_500;

// The Farcaster conversation on screen (its farcaster.xyz id), set by the chat view.
let openConversation: string | null = null;

/** The chat view calls this with its conversation on screen; the returned function says it left. */
export function showDirectCastConversation(id: string): () => void {
  openConversation = id;
  return () => {
    if (openConversation === id) openConversation = null;
  };
}

export interface DirectCastEventContext {
  myFid?: number;
  /** The conversation is on screen with the app in front. */
  isOnScreen: (conversationId: string) => boolean;
  markRead: (conversationId: string) => void;
  /** Fetch one conversation and file it in the inbox. */
  refreshConversation: (conversationId: string) => void;
}

type MessagesData = { pages: { messages: DirectCastMessage[]; nextCursor?: string }[]; pageParams: unknown[] };

/** Apply one socket event to the caches. */
export function applyDirectCastEvent(
  queryClient: QueryClient,
  event: DirectCastEvent,
  ctx: DirectCastEventContext,
): void {
  const id = event.payload?.conversationId;
  if (!id) return;
  switch (event.messageType) {
    case 'refresh-direct-cast-conversation': {
      const message = event.payload?.message;
      if (!message) {
        ctx.refreshConversation(id);
        return;
      }
      const mine = ctx.myFid != null && message.senderFid === ctx.myFid;
      insertMessage(queryClient, id, message, mine);
      const readNow = !mine && ctx.isOnScreen(id);
      if (readNow) ctx.markRead(id);
      const inInbox = updateCachedConversation(
        queryClient,
        id,
        (c) => ({
          ...c,
          timestamp: message.serverTimestamp,
          lastMessagePreview: message.message,
          lastMessageSenderName: mine
            ? 'You'
            : message.senderContext?.displayName ?? message.senderContext?.username ?? c.lastMessageSenderName,
          unreadCount: mine || readNow ? c.unreadCount ?? 0 : (c.unreadCount ?? 0) + 1,
        }),
        true,
      );
      if (!inInbox) ctx.refreshConversation(id);
      return;
    }
    case 'direct-cast-read':
      updateCachedConversation(queryClient, id, (c) => ({ ...c, unreadCount: 0 }));
      return;
    case 'refresh-self-direct-casts-inbox':
      ctx.refreshConversation(id);
      return;
  }
}

/** Put `message` in its chat's cache, if that chat is loaded (newest first). */
function insertMessage(queryClient: QueryClient, id: string, message: DirectCastMessage, mine: boolean) {
  queryClient.setQueryData<MessagesData>(farcasterDCQueryKeys.messages(id), (old) => {
    if (!old?.pages.length) return old; // fetched when it's opened
    // Already here (edited, deleted, or our own send under its real id): replace it.
    let replaced = false;
    const pages = old.pages.map((page) => ({
      ...page,
      messages: page.messages.map((m) => {
        if (m.messageId !== message.messageId) return m;
        replaced = true;
        return message;
      }),
    }));
    if (replaced) return { ...old, pages };
    const first = pages[0].messages;
    // Our own message coming back takes the place of the one still sending.
    const sending = mine
      ? first.findIndex(
          (m) => (m as DirectCastMessage & { _optimistic?: boolean })._optimistic && m.message === message.message,
        )
      : -1;
    pages[0] = {
      ...pages[0],
      messages: sending >= 0 ? first.map((m, i) => (i === sending ? message : m)) : [message, ...first],
    };
    return { ...old, pages };
  });
}

const refreshing = new Map<string, ReturnType<typeof setTimeout>>();

/** Fetch one conversation (events for it in quick succession wait for one request) and file it. */
function refreshConversationSoon(queryClient: QueryClient, id: string, myFid: number | undefined) {
  if (refreshing.has(id)) return;
  refreshing.set(
    id,
    setTimeout(() => {
      refreshing.delete(id);
      getDirectCastConversation(id).then(
        (fc) => {
          if (!fc) return;
          const unified = toUnifiedConversation(fc, myFid);
          // Only the inbox is shown: a request or an archived conversation leaves it.
          const inInbox = (fc.viewerContext?.category ?? 'default') === 'default';
          const found = updateCachedConversation(queryClient, id, () => (inInbox ? unified : null));
          if (found || !inInbox) return;
          queryClient.setQueryData<InboxData>(farcasterDCQueryKeys.conversations, (old) =>
            old?.pages.length
              ? {
                  ...old,
                  pages: [{ ...old.pages[0], conversations: [unified, ...old.pages[0].conversations] }, ...old.pages.slice(1)],
                }
              : old,
          );
        },
        () => {},
      );
    }, REFRESH_DELAY_MS),
  );
}

/**
 * Refetch what the socket may have missed while it was down: the inbox and the
 * chat on screen now, every other chat held in memory when it's next opened.
 * A fetch already running (the inbox loading as the app starts) is left to
 * finish rather than cancelled and started again.
 */
function catchUp(queryClient: QueryClient) {
  const keep = { cancelRefetch: false };
  void queryClient.invalidateQueries({ queryKey: farcasterDCQueryKeys.conversations }, keep);
  // Prefix match: every chat. Only the one on screen has an observer, so only
  // it refetches now.
  void queryClient.invalidateQueries({ queryKey: ['farcaster-dc-messages'] }, keep);
}

const inFront = (state: AppStateStatus | null | undefined) => state !== 'background';

export function useDirectCastLive(): void {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const token = useDirectCastToken();
  const myFidRef = useRef(user?.farcaster?.fid);
  myFidRef.current = user?.farcaster?.fid;
  const [foreground, setForeground] = useState(() => inFront(AppState.currentState));

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setForeground(inFront(state)));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!token || !foreground) return;
    const socket = connectDirectCastSocket(token, {
      onEvent: (event) =>
        applyDirectCastEvent(queryClient, event, {
          myFid: myFidRef.current,
          isOnScreen: (id) => openConversation === id && AppState.currentState === 'active',
          markRead: (id) => {
            markDirectCastRead({ conversationId: id }).catch(() => {});
          },
          refreshConversation: (id) => refreshConversationSoon(queryClient, id, myFidRef.current),
        }),
      onOpen: () => catchUp(queryClient),
      // A new token re-renders this hook, which connects with it.
      onRevoked: () => {
        void getDirectCastToken({ fresh: true });
      },
    });
    return () => socket.close();
  }, [token, foreground, queryClient]);
}
