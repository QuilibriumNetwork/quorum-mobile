/**
 * useSendEmbedMessage - Hook for sending image/embed messages to space channels
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, useWebSocket } from '@/context';
import { sendEmbedMessage, buildPostWithEmbeddedMedia } from '@/services/space/spaceMessageService';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import type { Message, GetMessagesResult } from '@quilibrium/quorum-shared';

export interface UseSendEmbedMessageParams {
  spaceId: string;
  channelId: string;
  imageUrl: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  isLargeGif?: boolean;
  /** Optional text to accompany the image */
  text?: string;
  /** Space roles/channels so a caption mention populates message.mentions
   *  (and therefore notifies the mentioned user). */
  spaceRoles?: Array<{ roleId: string; roleTag: string }>;
  spaceChannels?: Array<{ channelId: string; channelName: string }>;
}

export function useSendEmbedMessage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { enqueueOutbound, isConnected } = useWebSocket();

  return useMutation({
    mutationFn: async (params: UseSendEmbedMessageParams) => {
      if (!user?.address) {
        throw new Error('User must be logged in to send messages');
      }

      if (!isConnected) {
        throw new Error('Not connected to server. Please wait for connection.');
      }

      const result = await sendEmbedMessage({
        spaceId: params.spaceId,
        channelId: params.channelId,
        senderAddress: user.address,
        imageUrl: params.imageUrl,
        thumbnailUrl: params.thumbnailUrl,
        width: params.width?.toString(),
        height: params.height?.toString(),
        text: params.text,
        spaceRoles: params.spaceRoles,
        spaceChannels: params.spaceChannels,
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
      const tempId = `temp-embed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timestamp = Date.now();

      const optimisticMessage: Message = {
        channelId: params.channelId,
        spaceId: params.spaceId,
        messageId: tempId,
        digestAlgorithm: 'sha256',
        nonce: '',
        createdDate: timestamp,
        modifiedDate: timestamp,
        lastModifiedHash: '',
        // Mirror the sent shape (post + embeddedMedia) so the sender's own
        // optimistic row renders through the same path as the received message.
        content: buildPostWithEmbeddedMedia(
          user.address,
          params.imageUrl,
          params.thumbnailUrl,
          params.text
        ),
        reactions: [],
        mentions: { memberIds: [], roleIds: [], channelIds: [] },
        sendStatus: 'sending',
      };

      // Optimistically add to cache (append to end like text messages)
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

    onSettled: (data, err, params) => {
      queryClient.invalidateQueries({
        queryKey: ['messages', 'infinite', params.spaceId, params.channelId],
      });
    },
  });
}
