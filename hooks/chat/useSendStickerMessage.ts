/**
 * useSendStickerMessage - Hook for sending sticker messages to space channels
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, useWebSocket } from '@/context';
import { sendStickerMessage } from '@/services/space/spaceMessageService';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import type { Message, GetMessagesResult } from '@quilibrium/quorum-shared';

export interface UseSendStickerMessageParams {
  spaceId: string;
  channelId: string;
  stickerId: string;
}

export function useSendStickerMessage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: UseSendStickerMessageParams) => {
      if (!user?.address) {
        throw new Error('User must be logged in to send stickers');
      }

      // Do NOT gate on isConnected: enqueueOutbound buffers the envelope and the
      // WS client flushes it on (re)connect, so a transient disconnect (or a
      // stale isConnected) must not drop the send. Mirrors the DM delete/edit paths.

      const result = await sendStickerMessage({
        spaceId: params.spaceId,
        channelId: params.channelId,
        stickerId: params.stickerId,
        senderAddress: user.address,
      });

      // Send via WebSocket
      enqueueOutbound(async () => {
        return [result.wsEnvelope];
      });

      // Store optimistically
      const adapter = getMMKVAdapter();
      await adapter.saveMessage(
        result.message,
        result.message.createdDate,
        user?.address ?? '',
        'space',
        '',
        ''
      );

      return result.message;
    },

    onSuccess: (message, params) => {
      // Invalidate messages query to refresh
      queryClient.invalidateQueries({
        queryKey: ['messages', 'infinite', params.spaceId, params.channelId],
      });
    },

    onError: (err, params) => {
    },
  });
}
