/**
 * useFarcasterDirectCasts - Fetches Farcaster direct cast conversations
 */

import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
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
  sendDirectCast,
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
 * Convert Farcaster conversation to unified Conversation type
 */
function toUnifiedConversation(fc: DirectCastConversation, currentUserFid?: number): Conversation {
  const counterParty = fc.viewerContext?.counterParty ?? fc.participants[0];
  // Use conversation photo (for groups) or counterparty's profile picture
  const iconUrl = fc.photoUrl ?? counterParty?.pfp?.url;

  // Get all participant FIDs except current user (needed for sending messages)
  const participantFids = fc.participants
    .filter((p) => p.fid !== currentUserFid)
    .map((p) => p.fid);

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
    unreadCount: fc.unreadCount,
    // Don't show read status for Farcaster conversations
  };
}

/**
 * Hook to fetch Farcaster direct cast conversations
 */
export function useFarcasterConversations(options?: { enabled?: boolean }) {
  const { farcasterAuthToken, user } = useAuth();
  const hasFarcaster = !!user?.farcaster?.fid;
  const currentUserFid = user?.farcaster?.fid;

  // Paint the inbox instantly from MMKV, then refresh in the background.
  const initialData = useMemo(() => getCachedDMConversations(), []);

  const query = useInfiniteQuery({
    queryKey: farcasterDCQueryKeys.conversations,
    queryFn: async ({ pageParam }) => {
      if (!farcasterAuthToken) {
        throw new Error('Farcaster auth token not available');
      }

      const result = await getDirectCastConversations({
        token: farcasterAuthToken,
        cursor: pageParam,
        limit: 20,
      });

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
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: (options?.enabled ?? true) && hasFarcaster && !!farcasterAuthToken,
    // Cache-first: the Messages tab must paint instantly on focus, not
    // block on a network round-trip (the old `refetchOnMount:'always'`
    // gated first paint for up to ~5s on slow connections). Cached
    // conversations show immediately; the `refetchInterval` below keeps
    // them fresh in the background so they're never more than ~15s stale.
    staleTime: 60000,
    refetchInterval: 15000,
    refetchIntervalInBackground: true,
    refetchOnMount: false,
    refetchOnWindowFocus: true,
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
  const { farcasterAuthToken } = useAuth();

  // Extract actual Farcaster conversation ID from unified ID
  const fcConversationId = conversationId?.startsWith('farcaster:')
    ? conversationId.slice(10)
    : conversationId;

  // Paint the open DM instantly from MMKV, then refresh in the background.
  const initialData = useMemo(() => getCachedDMMessages(fcConversationId), [fcConversationId]);

  const query = useInfiniteQuery({
    queryKey: farcasterDCQueryKeys.messages(fcConversationId ?? ''),
    queryFn: async ({ pageParam }) => {
      if (!farcasterAuthToken || !fcConversationId) {
        throw new Error('Missing auth token or conversation ID');
      }

      const result = await getDirectCastMessages({
        token: farcasterAuthToken,
        conversationId: fcConversationId,
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
    enabled: (options?.enabled ?? true) && !!farcasterAuthToken && !!fcConversationId,
    // Poll while the chat is open for near-real-time delivery, but NOT in
    // the background: `refetchIntervalInBackground` kept re-fetching +
    // re-rendering the entire (large) message view every 3s even when the
    // app/DM wasn't on screen, churning render memory until low-RAM (2GB)
    // devices OOM. Foreground-only polling + the referentially-stable
    // `displayMessages` mapping in FarcasterDirectMessageView stop the
    // unnecessary re-renders.
    staleTime: 3000,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    // Forces an immediate refresh when navigating into a chat —
    // otherwise the user lands on a screen with potentially-minutes-old
    // state, waits ~3s for the first poll, and only then sees fresh
    // messages.
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });

  // Persist the freshest page so re-opening this DM paints instantly.
  useEffect(() => {
    if (query.isFetched && query.data && (query.data.pages[0]?.messages.length ?? 0) > 0) {
      setCachedDMMessages(fcConversationId, query.data as CachedMessages);
    }
  }, [query.data, query.isFetched, fcConversationId]);

  return query;
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
      recipientFids,
      message,
      inReplyToId,
      metadata,
    }: {
      conversationId: string;
      recipientFids: number[];
      message: string;
      inReplyToId?: string;
      metadata?: DirectCastMessageMetadata;
    }) => {
      if (!farcasterAuthToken) {
        throw new Error('Farcaster auth token not available');
      }

      // Extract actual Farcaster conversation ID
      const fcConversationId = conversationId.startsWith('farcaster:')
        ? conversationId.slice(10)
        : conversationId;

      return sendDirectCast({
        token: farcasterAuthToken,
        conversationId: fcConversationId,
        recipientFids,
        message,
        inReplyToId,
        metadata,
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

    onSuccess: (result, variables) => {
      // Invalidate messages for this conversation to get the real message from server
      const fcConversationId = variables.conversationId.startsWith('farcaster:')
        ? variables.conversationId.slice(10)
        : variables.conversationId;
      queryClient.invalidateQueries({
        queryKey: farcasterDCQueryKeys.messages(fcConversationId),
      });
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
  const { farcasterAuthToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      if (!farcasterAuthToken) {
        throw new Error('Farcaster auth token not available');
      }

      const fcConversationId = conversationId.startsWith('farcaster:')
        ? conversationId.slice(10)
        : conversationId;

      return markDirectCastRead({
        token: farcasterAuthToken,
        conversationId: fcConversationId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: farcasterDCQueryKeys.conversations,
      });
    },
  });
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
        throw new Error('Farcaster auth token not available');
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
        throw new Error('Farcaster auth token not available');
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
