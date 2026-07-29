/**
 * useDeleteSpaceMessage - Hook for deleting messages from space channels
 *
 * Uses the SpaceMessageService to:
 * - Send encrypted delete messages via WebSocket
 * - Update local cache optimistically
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, useWebSocket } from '@/context';
import { sendDeleteMessage } from '@/services/space/spaceMessageService';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import type { Message, GetMessagesResult } from '@quilibrium/quorum-shared';

export interface UseDeleteSpaceMessageParams {
  spaceId: string;
  channelId: string;
  messageId: string;
}

export function useDeleteSpaceMessage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: UseDeleteSpaceMessageParams) => {
      if (!user?.address) {
        throw new Error('User must be logged in to delete messages');
      }

      // Do NOT gate on isConnected: enqueueOutbound buffers the envelope and the
      // WS client flushes it on (re)connect, so a transient disconnect (or a
      // stale isConnected) must not drop the send. Mirrors the DM delete/edit paths.

      const result = await sendDeleteMessage({
        spaceId: params.spaceId,
        channelId: params.channelId,
        targetMessageId: params.messageId,
        senderAddress: user.address,
      });

      // Send via WebSocket
      enqueueOutbound(async () => {
        return [result.wsEnvelope];
      });

      return params.messageId;
    },

    onMutate: async (params) => {
      const key = ['messages', 'infinite', params.spaceId, params.channelId];

      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: key });

      // Snapshot previous value
      const previousData = queryClient.getQueryData(key);

      // Optimistically remove from cache
      queryClient.setQueryData(
        key,
        (old: { pages: GetMessagesResult[]; pageParams: unknown[] } | undefined) => {
          if (!old) return old;

          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              messages: page.messages.filter((m: Message) => m.messageId !== params.messageId),
            })),
          };
        }
      );

      return { previousData };
    },

    onError: (err, params, context) => {
      // Rollback on error
      if (context?.previousData) {
        const key = ['messages', 'infinite', params.spaceId, params.channelId];
        queryClient.setQueryData(key, context.previousData);
      }
    },

    onSuccess: async (messageId, params) => {
      // Delete from local storage
      const adapter = getMMKVAdapter();
      await adapter.deleteMessage(messageId);
    },

    onSettled: (data, err, params) => {
      // Invalidate to refetch
      queryClient.invalidateQueries({
        queryKey: ['messages', 'infinite', params.spaceId, params.channelId],
      });
    },
  });
}
