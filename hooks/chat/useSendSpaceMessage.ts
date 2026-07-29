/**
 * useSendSpaceMessage - Hook for sending encrypted messages to space channels
 *
 * Uses the SpaceMessageService to:
 * - Create optimistic UI updates
 * - Send encrypted messages via WebSocket
 * - Handle errors with rollback
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, useWebSocket } from '@/context';
import {
  sendSpaceMessage,
  createOptimisticMessage,
  type SendSpaceMessageParams,
} from '@/services/space/spaceMessageService';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import type { Message, GetMessagesResult } from '@quilibrium/quorum-shared';

export interface UseSendSpaceMessageParams {
  spaceId: string;
  channelId: string;
  text: string;
  repliesToMessageId?: string;
  replyToAuthorAddress?: string;
  spaceRoles?: Array<{ roleId: string; roleTag: string }>;
  spaceChannels?: Array<{ channelId: string; channelName: string }>;
  /** Sender has the mention:everyone permission (gates @everyone extraction). */
  allowEveryone?: boolean;
  /** Space repudiability (inverse of "Require Message Signing"). */
  isRepudiable?: boolean;
  /** Per-message lock state; only consulted when isRepudiable is true. */
  skipSigning?: boolean;
}

export function useSendSpaceMessage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: UseSendSpaceMessageParams) => {
      if (!user?.address) {
        throw new Error('User must be logged in to send messages');
      }

      // Do NOT gate on isConnected: enqueueOutbound buffers the envelope and the
      // WS client flushes it on (re)connect, so a transient disconnect (or a
      // stale isConnected) must not drop the send. Mirrors the DM delete/edit paths.

      const result = await sendSpaceMessage({
        spaceId: params.spaceId,
        channelId: params.channelId,
        text: params.text,
        senderAddress: user.address,
        repliesToMessageId: params.repliesToMessageId,
        replyToAuthorAddress: params.replyToAuthorAddress,
        spaceRoles: params.spaceRoles,
        spaceChannels: params.spaceChannels,
        allowEveryone: params.allowEveryone,
        // Sign unless the space left it optional AND the lock was opened.
        skipSigning: params.isRepudiable ? !!params.skipSigning : false,
      });

      // Send via WebSocket
      enqueueOutbound(async () => {
        return [result.wsEnvelope];
      });

      return result.message;
    },

    onMutate: async (params) => {
      if (!user?.address) return;

      const key = ['messages', 'infinite', params.spaceId, params.channelId];

      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: key });

      // Snapshot previous value
      const previousData = queryClient.getQueryData(key);

      // Create optimistic message
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const optimisticMessage = createOptimisticMessage(
        {
          spaceId: params.spaceId,
          channelId: params.channelId,
          text: params.text,
          senderAddress: user.address,
          repliesToMessageId: params.repliesToMessageId,
          replyToAuthorAddress: params.replyToAuthorAddress,
          spaceRoles: params.spaceRoles,
          spaceChannels: params.spaceChannels,
          allowEveryone: params.allowEveryone,
        },
        tempId
      );

      // Optimistically add to cache
      queryClient.setQueryData(
        key,
        (old: { pages: GetMessagesResult[]; pageParams: unknown[] } | undefined) => {
          if (!old) return old;

          return {
            ...old,
            pages: old.pages.map((page, index) => {
              if (index === 0) {
                return {
                  ...page,
                  messages: [...page.messages, optimisticMessage],
                };
              }
              return page;
            }),
          };
        }
      );

      return { previousData, optimisticMessage, tempId };
    },

    onError: (err, params, context) => {
      // Rollback on error
      if (context?.previousData) {
        const key = ['messages', 'infinite', params.spaceId, params.channelId];
        queryClient.setQueryData(key, context.previousData);
      }
    },

    onSuccess: async (message, params, context) => {
      const key = ['messages', 'infinite', params.spaceId, params.channelId];

      // Replace optimistic message with real one
      queryClient.setQueryData(
        key,
        (old: { pages: GetMessagesResult[]; pageParams: unknown[] } | undefined) => {
          if (!old) return old;

          return {
            ...old,
            pages: old.pages.map((page, index) => {
              if (index === 0) {
                return {
                  ...page,
                  messages: page.messages.map((m: Message) =>
                    m.messageId === context?.tempId ? { ...message, sendStatus: 'sent' } : m
                  ),
                };
              }
              return page;
            }),
          };
        }
      );

      // Persist to storage
      const adapter = getMMKVAdapter();
      await adapter.saveMessage(
        message,
        message.createdDate,
        user?.address ?? '',
        'space',
        '',
        ''
      );
    },

    // No onSettled invalidate — refetching can race a transiently-empty
    // SQLite (cold cipher cache, migration in flight) and wipe the cache.
  });
}
