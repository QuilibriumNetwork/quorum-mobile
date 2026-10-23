/**
 * useFarcasterDirectCasts - Fetches Farcaster direct cast conversations
 *
 * The inbox, messages, mark-read and text sends use the direct-cast token
 * (`services/farcaster/directCastAuth.ts`); a message with an image and
 * reactions use the session token (`farcasterAuthToken`). Nothing polls: the
 * socket (`useDirectCastLive`) keeps both caches current.
 */

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '@/context/AuthContext';
import {
  getDirectCastToken,
  peekDirectCastToken,
  subscribeDirectCastToken,
} from '@/services/farcaster/directCastAuth';
import {
  getCachedDMConversations,
  setCachedDMConversations,
  getCachedDMMessages,
  setCachedDMMessages,
  type CachedConversations,
  type CachedMessages,
} from '@/services/farcaster/farcasterDMCache';
import {
  getDirectCastConversations,
  getDirectCastMessages,
  isOneToOneConversationId,
  sendDirectCast,
  sendDirectCastWithMedia,
  markDirectCastRead,
  addDirectCastReaction,
  removeDirectCastReaction,
  type DirectCastConversation,
  type DirectCastMessage,
  type DirectCastMessageMetadata,
} from '@/services/farcasterClient';
import type { Conversation } from './useConversations';

export type { DirectCastConversation, DirectCastMessage };

// Query keys for Farcaster direct casts
export const farcasterDCQueryKeys = {
  conversations: ['farcaster-dc-conversations'] as const,
  messages: (conversationId: string) => ['farcaster-dc-messages', conversationId] as const,
};

/**
 * The direct-cast token for the signed-in Farcaster account, minted on first
 * use. Null until there is one (or when this account can't have one). A mint
 * that failed (offline, say) is tried again when the app comes back to the
 * front.
 */
export function useDirectCastToken(): string | null {
  const { user } = useAuth();
  const fid = user?.farcaster?.fid;
  const token = useSyncExternalStore(subscribeDirectCastToken, () => peekDirectCastToken(fid));
  useEffect(() => {
    if (fid == null || token) return;
    void getDirectCastToken();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void getDirectCastToken();
    });
    return () => sub.remove();
  }, [fid, token]);
  return token;
}

/**
 * Convert Farcaster conversation to unified Conversation type
 */
export function toUnifiedConversation(fc: DirectCastConversation, currentUserFid?: number): Conversation {
  const participants = fc.participants ?? [];
  const counterParty =
    fc.viewerContext?.counterParty ??
    participants.find((p) => p.fid !== currentUserFid) ??
    participants[0];
  // Use conversation photo (for groups) or counterparty's profile picture
  const iconUrl = fc.photoUrl ?? counterParty?.pfp?.url;

  // Everyone but the current user. The inbox doesn't always list participants;
  // a 1:1 then still has its counterparty.
  const participantFids = participants
    .filter((p) => p.fid !== currentUserFid)
    .map((p) => p.fid);
  if (participantFids.length === 0 && !fc.isGroup && counterParty?.fid != null) {
    participantFids.push(counterParty.fid);
  }

  // Extract preview from last message
  let lastMessagePreview: string | undefined;
  let lastMessageSenderName: string | undefined;
  if (fc.lastMessage) {
    lastMessagePreview = fc.lastMessage.message;
    // Get sender name - check if it's the current user or someone else
    if (fc.lastMessage.senderFid === currentUserFid) {
      lastMessageSenderName = 'You';
    } else {
      lastMessageSenderName = fc.lastMessage.senderContext?.displayName
        ?? fc.lastMessage.senderContext?.username
        ?? counterParty?.displayName
        ?? counterParty?.username;
    }
  }

  return {
    conversationId: `farcaster:${fc.conversationId}`,
    type: fc.isGroup ? 'group' : 'direct',
    // Fall back to 0 (sorts to the bottom), never Date.now() — a conversation
    // with a missing/last-message-less timestamp must not float to the top of
    // the inbox as if it were the most recent activity.
    timestamp: fc.lastMessage?.serverTimestamp ?? 0,
    address: `fid:${counterParty?.fid ?? 0}`,
    icon: iconUrl ?? '',
    displayName: fc.name ?? counterParty?.displayName ?? counterParty?.username ?? 'Unknown',
    source: 'farcaster',
    farcasterConversationId: fc.conversationId,
    farcasterFid: counterParty?.fid,
    farcasterUsername: counterParty?.username,
    farcasterParticipantFids: participantFids,
    lastMessagePreview,
    lastMessageSenderName,
    unreadCount: fc.viewerContext?.unreadCount ?? fc.unreadCount ?? 0,
    // Don't show read status for Farcaster conversations
  };
}

/**
 * Hook to fetch Farcaster direct cast conversations
 */
export function useFarcasterConversations(options?: { enabled?: boolean }) {
  const { user } = useAuth();
  const directCastToken = useDirectCastToken();
  const hasFarcaster = !!user?.farcaster?.fid;
  const currentUserFid = user?.farcaster?.fid;

  // Paint the inbox instantly from MMKV, then refresh in the background.
  const initialData = useMemo(() => getCachedDMConversations(), []);

  const query = useInfiniteQuery({
    queryKey: farcasterDCQueryKeys.conversations,
    queryFn: async ({ pageParam, signal }) => {
      // 100 is the most farcaster.xyz gives at once.
      const result = await getDirectCastConversations({ cursor: pageParam, limit: 100, signal });

      return {
        conversations: result.conversations.map((fc) => toUnifiedConversation(fc, currentUserFid)),
        nextCursor: result.nextCursor,
        requestsCount: result.requestsCount,
      };
    },
    initialData,
    // Treat the cached data as stale so the background refresh still runs.
    initialDataUpdatedAt: 0,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextInboxCursor,
    enabled: (options?.enabled ?? true) && hasFarcaster && !!directCastToken,
    // Cached conversations paint at once and refresh in the background
    // (that doesn't hold up first paint). After that the socket keeps the
    // list current, and catches it up whenever it reconnects, including on
    // coming back to the app (it's closed in the background), so it isn't
    // refetched on focus as well. No polling.
    staleTime: 60000,
  });

  // Persist the freshest page so the next launch/open paints instantly.
  useEffect(() => {
    if (query.isFetched && query.data && query.data.pages.length > 0) {
      setCachedDMConversations(query.data as CachedConversations);
    }
  }, [query.data, query.isFetched]);

  return query;
}

/**
 * Hook to fetch messages for a Farcaster direct cast conversation
 */
export function useFarcasterDirectCastMessages(
  conversationId: string | undefined,
  options?: { enabled?: boolean }
) {
  const directCastToken = useDirectCastToken();

  // Extract actual Farcaster conversation ID from unified ID
  const fcConversationId = conversationId?.startsWith('farcaster:')
    ? conversationId.slice(10)
    : conversationId;

  // Paint the open DM instantly from MMKV, then refresh in the background.
  const initialData = useMemo(() => getCachedDMMessages(fcConversationId), [fcConversationId]);

  const query = useInfiniteQuery({
    queryKey: farcasterDCQueryKeys.messages(fcConversationId ?? ''),
    queryFn: async ({ pageParam, signal }) => {
      if (!fcConversationId) {
        throw new Error('Missing conversation ID');
      }

      const result = await getDirectCastMessages({
        conversationId: fcConversationId,
        signal,
        cursor: pageParam,
        limit: 50,
      });

      return {
        messages: result.messages,
        nextCursor: result.nextCursor,
      };
    },
    initialData,
    // Treat the cached page as stale so the background refresh still runs.
    initialDataUpdatedAt: 0,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: (options?.enabled ?? true) && !!directCastToken && !!fcConversationId,
    // No polling: new messages arrive over the socket (`useDirectCastLive`),
    // which writes them into every chat held in memory, so a chat opened
    // again is already current and isn't fetched again (each refetch reloads
    // every page held). When the socket reconnects, after a drop or on
    // coming back to the app, it refetches the open chat and marks the rest
    // stale, so they refetch when next opened. A chat painted from the copy
    // saved on the phone is stale from the start (above), so it refreshes on
    // opening.
    staleTime: 5 * 60_000,
  });

  // Persist the freshest page so re-opening this DM paints instantly.
  useEffect(() => {
    if (query.isFetched && query.data && (query.data.pages[0]?.messages.length ?? 0) > 0) {
      setCachedDMMessages(fcConversationId, query.data as CachedMessages);
    }
  }, [query.data, query.isFetched, fcConversationId]);

  return query;
}

type InboxPage = { conversations: Conversation[]; nextCursor?: string };

/**
 * The next inbox page's cursor, or none. farcaster.xyz's cursor can come round
 * again, so a cursor already used, or a page with no conversation not already
 * listed, is the end whatever the cursor says.
 */
export function nextInboxCursor(
  lastPage: InboxPage,
  allPages: InboxPage[],
  _lastPageParam?: string,
  allPageParams: (string | undefined)[] = [],
): string | undefined {
  const next = lastPage.nextCursor;
  if (!next || allPageParams.includes(next)) return undefined;
  const earlier = new Set(
    allPages.slice(0, -1).flatMap((page) => page.conversations.map((c) => c.conversationId)),
  );
  const addsSomething = lastPage.conversations.some((c) => !earlier.has(c.conversationId));
  return addsSomething ? next : undefined;
}

// Type for infinite query data structure
interface FarcasterMessagesPage {
  messages: DirectCastMessage[];
  nextCursor?: string;
}

interface InfiniteFarcasterMessagesData {
  pages: FarcasterMessagesPage[];
  pageParams: unknown[];
}

/**
 * Hook to send a Farcaster direct cast
 */
export function useSendFarcasterDirectCast() {
  const { farcasterAuthToken, user } = useAuth();
  const queryClient = useQueryClient();
  const currentUserFid = user?.farcaster?.fid;
  // FarcasterInfo only carries fid/username/pfpUrl — there's no
  // farcaster.displayName, so fall back to the Quorum-level display
  // name. user.profileImage (NOT profilePicture — that field doesn't
  // exist on UserInfo) is the correct local fallback when
  // farcaster.pfpUrl is empty; that bug was leaving optimistic sends
  // pfp-less.
  const currentUserDisplayName = user?.displayName ?? user?.farcaster?.username;
  const currentUserUsername = user?.farcaster?.username;
  const currentUserPfp = user?.farcaster?.pfpUrl ?? user?.profileImage;

  return useMutation({
    mutationFn: async ({
      conversationId,
      isGroup,
      recipientFids,
      message,
      inReplyToId,
      metadata,
    }: {
      conversationId: string;
      /** Defaults to whether the id isn't a 1:1's `<fid>-<fid>`. */
      isGroup?: boolean;
      recipientFids: number[];
      message: string;
      inReplyToId?: string;
      metadata?: DirectCastMessageMetadata;
    }): Promise<{ messageId?: string }> => {
      // Extract actual Farcaster conversation ID
      const fcConversationId = conversationId.startsWith('farcaster:')
        ? conversationId.slice(10)
        : conversationId;

      // An image goes the way farcaster.xyz sends media: the older endpoint,
      // with the session token.
      if (metadata) {
        if (!farcasterAuthToken) {
          throw new Error('Hypersnap auth token not available');
        }
        await sendDirectCastWithMedia({
          token: farcasterAuthToken,
          conversationId: fcConversationId,
          recipientFids,
          message,
          inReplyToId,
          metadata,
        });
        return {};
      }

      const group = isGroup ?? !isOneToOneConversationId(fcConversationId);
      return sendDirectCast({
        conversationId: fcConversationId,
        isGroup: group,
        recipientFid: group ? undefined : (recipientFids[0] ?? otherFidInConversationId(fcConversationId, currentUserFid)),
        message,
        inReplyToId,
      });
    },

    onMutate: async (variables) => {
      const fcConversationId = variables.conversationId.startsWith('farcaster:')
        ? variables.conversationId.slice(10)
        : variables.conversationId;

      // Cancel any outgoing refetches
      await queryClient.cancelQueries({
        queryKey: farcasterDCQueryKeys.messages(fcConversationId),
      });

      // Snapshot the previous value
      const previousData = queryClient.getQueryData<InfiniteFarcasterMessagesData>(
        farcasterDCQueryKeys.messages(fcConversationId)
      );

      // Create optimistic message
      const optimisticMessage: DirectCastMessage = {
        conversationId: fcConversationId,
        senderFid: currentUserFid ?? 0,
        messageId: `optimistic-${Date.now()}`,
        serverTimestamp: Date.now(),
        type: 'text',
        message: variables.message,
        hasMention: false,
        reactions: [],
        isPinned: false,
        isDeleted: false,
        senderContext: {
          fid: currentUserFid ?? 0,
          username: currentUserUsername,
          displayName: currentUserDisplayName ?? 'You',
          pfp: currentUserPfp ? { url: currentUserPfp } : undefined,
        },
        // Mark as optimistic for UI to show sending state
        _optimistic: true,
      } as DirectCastMessage & { _optimistic?: boolean };

      // Optimistically update the cache
      // Messages are returned newest-first from API, so we add to the first page
      queryClient.setQueryData<InfiniteFarcasterMessagesData>(
        farcasterDCQueryKeys.messages(fcConversationId),
        (old) => {
          if (!old) {
            return {
              pages: [{ messages: [optimisticMessage], nextCursor: undefined }],
              pageParams: [undefined],
            };
          }
          return {
            ...old,
            pages: old.pages.map((page, index) => {
              if (index === 0) {
                // Add to beginning of first page (newest first)
                return {
                  ...page,
                  messages: [optimisticMessage, ...page.messages],
                };
              }
              return page;
            }),
          };
        }
      );

      return { previousData, optimisticMessage };
    },

    onError: (error, variables, context) => {
      // Rollback to previous state on error
      if (context?.previousData) {
        const fcConversationId = variables.conversationId.startsWith('farcaster:')
          ? variables.conversationId.slice(10)
          : variables.conversationId;
        queryClient.setQueryData(
          farcasterDCQueryKeys.messages(fcConversationId),
          context.previousData
        );
      }
    },

    onSuccess: (result, variables, context) => {
      const fcConversationId = variables.conversationId.startsWith('farcaster:')
        ? variables.conversationId.slice(10)
        : variables.conversationId;
      const sent = context?.optimisticMessage;
      if (result.messageId && sent) {
        // The sent copy takes farcaster.xyz's id, so the socket's copy of it
        // replaces it in place rather than adding a second.
        const { _optimistic: _, ...confirmed } = sent as DirectCastMessage & { _optimistic?: boolean };
        queryClient.setQueryData<InfiniteFarcasterMessagesData>(
          farcasterDCQueryKeys.messages(fcConversationId),
          (old) =>
            old && {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                messages: page.messages.map((m) =>
                  m.messageId === sent.messageId ? { ...confirmed, messageId: result.messageId! } : m,
                ),
              })),
            },
        );
      } else {
        // No id back (an image send): fetch the real message.
        queryClient.invalidateQueries({
          queryKey: farcasterDCQueryKeys.messages(fcConversationId),
        });
      }
      // Also refresh conversations list
      queryClient.invalidateQueries({
        queryKey: farcasterDCQueryKeys.conversations,
      });
    },
  });
}

/**
 * Hook to mark a Farcaster conversation as read
 */
export function useMarkFarcasterConversationRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      const fcConversationId = conversationId.startsWith('farcaster:')
        ? conversationId.slice(10)
        : conversationId;
      await markDirectCastRead({ conversationId: fcConversationId });
      return fcConversationId;
    },
    onSuccess: (fcConversationId) => {
      updateCachedConversation(queryClient, fcConversationId, (c) => ({ ...c, unreadCount: 0 }));
    },
  });
}

/** In a 1:1's id (`<fid>-<fid>`), the FID that isn't `me`. */
function otherFidInConversationId(conversationId: string, me: number | undefined): number | undefined {
  if (!isOneToOneConversationId(conversationId)) return undefined;
  return conversationId.split('-').map(Number).find((fid) => fid !== me);
}

export type InboxData = { pages: (InboxPage & { requestsCount?: number })[]; pageParams: unknown[] };

/**
 * Change one conversation in the cached inbox; `top` moves it to the top.
 * False when it isn't there.
 */
export function updateCachedConversation(
  queryClient: ReturnType<typeof useQueryClient>,
  fcConversationId: string,
  change: (c: Conversation) => Conversation | null,
  top = false,
): boolean {
  let found = false;
  queryClient.setQueryData<InboxData>(farcasterDCQueryKeys.conversations, (old) => {
    if (!old) return old;
    let moved: Conversation | null = null;
    const pages = old.pages.map((page) => ({
      ...page,
      conversations: page.conversations.flatMap((c) => {
        if (c.farcasterConversationId !== fcConversationId) return [c];
        found = true;
        const next = change(c);
        if (next && top) {
          moved = next;
          return [];
        }
        return next ? [next] : [];
      }),
    }));
    if (moved && pages[0]) pages[0] = { ...pages[0], conversations: [moved, ...pages[0].conversations] };
    return found ? { ...old, pages } : old;
  });
  return found;
}

/**
 * Apply / undo a reaction in place on a Farcaster message. Operates on
 * BOTH `reactions` (the aggregate `{reaction,count}[]` array the API
 * returns) AND `viewerContext.reactions` (the per-viewer list the
 * client checks to know whether the *current user* reacted), because
 * the UI keys off the viewerContext list to render the pressed state.
 */
function applyFarcasterReactionAdd(message: DirectCastMessage, reaction: string): DirectCastMessage {
  const viewer = message.viewerContext ?? { reactions: [] };
  if (viewer.reactions.includes(reaction)) return message; // idempotent
  const existing = message.reactions.find((r) => r.reaction === reaction);
  const reactions = existing
    ? message.reactions.map((r) =>
        r.reaction === reaction ? { ...r, count: r.count + 1 } : r,
      )
    : [...message.reactions, { reaction, count: 1 }];
  return {
    ...message,
    reactions,
    viewerContext: { ...viewer, reactions: [...viewer.reactions, reaction] },
  };
}

function applyFarcasterReactionRemove(message: DirectCastMessage, reaction: string): DirectCastMessage {
  const viewer = message.viewerContext ?? { reactions: [] };
  if (!viewer.reactions.includes(reaction)) return message; // idempotent
  const reactions = message.reactions
    .map((r) => (r.reaction === reaction ? { ...r, count: r.count - 1 } : r))
    .filter((r) => r.count > 0);
  return {
    ...message,
    reactions,
    viewerContext: {
      ...viewer,
      reactions: viewer.reactions.filter((r) => r !== reaction),
    },
  };
}

function mutateFarcasterMessageInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  fcConversationId: string,
  messageId: string,
  transform: (m: DirectCastMessage) => DirectCastMessage,
): InfiniteFarcasterMessagesData | undefined {
  const key = farcasterDCQueryKeys.messages(fcConversationId);
  const previousData = queryClient.getQueryData<InfiniteFarcasterMessagesData>(key);
  queryClient.setQueryData<InfiniteFarcasterMessagesData>(key, (old) => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map((page) => ({
        ...page,
        messages: page.messages.map((m) =>
          m.messageId === messageId ? transform(m) : m,
        ),
      })),
    };
  });
  return previousData;
}

/**
 * Hook to add a reaction to a Farcaster direct cast message
 */
export function useAddFarcasterDirectCastReaction() {
  const { farcasterAuthToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      conversationId,
      messageId,
      reaction,
    }: {
      conversationId: string;
      messageId: string;
      reaction: string;
    }) => {
      if (!farcasterAuthToken) {
        throw new Error('Hypersnap auth token not available');
      }

      const fcConversationId = conversationId.startsWith('farcaster:')
        ? conversationId.slice(10)
        : conversationId;

      return addDirectCastReaction({
        token: farcasterAuthToken,
        conversationId: fcConversationId,
        messageId,
        reaction,
      });
    },
    onMutate: async ({ conversationId, messageId, reaction }) => {
      const fcConversationId = conversationId.startsWith('farcaster:')
        ? conversationId.slice(10)
        : conversationId;
      const key = farcasterDCQueryKeys.messages(fcConversationId);
      // Cancel in-flight refetches so they don't clobber the optimistic
      // state on resolve.
      await queryClient.cancelQueries({ queryKey: key });
      const previousData = mutateFarcasterMessageInCache(
        queryClient,
        fcConversationId,
        messageId,
        (m) => applyFarcasterReactionAdd(m, reaction),
      );
      return { previousData, fcConversationId };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(
          farcasterDCQueryKeys.messages(context.fcConversationId),
          context.previousData,
        );
      }
    },
    // Intentionally NOT invalidating in onSuccess. The Farcaster API
    // returns 204 No Content with no payload, so an invalidate-and-
    // refetch would just rebuild the same state we already applied
    // optimistically — at the cost of UI flicker if the refetch returns
    // before the user expects. The next natural refetch (conversation
    // switch, app foreground) will reconcile if anything drifted.
  });
}

/**
 * Hook to remove a reaction from a Farcaster direct cast message
 */
export function useRemoveFarcasterDirectCastReaction() {
  const { farcasterAuthToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      conversationId,
      messageId,
      reaction,
    }: {
      conversationId: string;
      messageId: string;
      reaction: string;
    }) => {
      if (!farcasterAuthToken) {
        throw new Error('Hypersnap auth token not available');
      }

      const fcConversationId = conversationId.startsWith('farcaster:')
        ? conversationId.slice(10)
        : conversationId;

      return removeDirectCastReaction({
        token: farcasterAuthToken,
        conversationId: fcConversationId,
        messageId,
        reaction,
      });
    },
    onMutate: async ({ conversationId, messageId, reaction }) => {
      const fcConversationId = conversationId.startsWith('farcaster:')
        ? conversationId.slice(10)
        : conversationId;
      const key = farcasterDCQueryKeys.messages(fcConversationId);
      await queryClient.cancelQueries({ queryKey: key });
      const previousData = mutateFarcasterMessageInCache(
        queryClient,
        fcConversationId,
        messageId,
        (m) => applyFarcasterReactionRemove(m, reaction),
      );
      return { previousData, fcConversationId };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(
          farcasterDCQueryKeys.messages(context.fcConversationId),
          context.previousData,
        );
      }
    },
  });
}
