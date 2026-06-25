/**
 * useDeleteDirectMessage - delete your own DM, for everyone (matches desktop).
 *
 * After the optimistic local removal, sends a `remove-message` control message
 * over the SAME multi-device transport a normal text message uses
 * (sendEncryptedMessageToAllDevices) — fanning out to every device of the
 * recipient AND your own other devices, bootstrapping sessions as needed. This
 * is deliberately NOT the single-session reaction transport, which only reaches
 * one inbox and so misses devices. Receive-side auth (WebSocketContext) honors
 * the removal only when the cryptographically-authenticated sender authored the
 * target.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useStorageAdapter } from '@/context/StorageContext';
import { useAuth, useWebSocket } from '@/context';
import { getQuorumClient } from '@/services/api/quorumClient';
import { encryptionService } from '@/services/crypto/encryption-service';
import { getDeviceKeyset } from '@/services/onboarding/secureStorage';
import { logger, queryKeys } from '@quilibrium/quorum-shared';
import type { Message, RemoveMessage } from '@quilibrium/quorum-shared';
import { sendEncryptedMessageToAllDevices } from './useSendDirectMessage';

export interface UseDeleteDirectMessageParams {
  conversationId: string;
  recipientAddress: string;
  messageId: string;
}

type DeviceInfo = {
  identityKey: number[];
  signedPreKey: number[];
  inboxAddress: string;
  inboxEncryptionKey: number[];
};

import type { MessagesPage, InfiniteMessagesData } from './queryTypes';

export function useDeleteDirectMessage() {
  const queryClient = useQueryClient();
  const storage = useStorageAdapter();
  const { user } = useAuth();
  const { enqueueOutbound, subscribe } = useWebSocket();
  const apiClient = getQuorumClient();

  return useMutation({
    mutationFn: async (params: UseDeleteDirectMessageParams) => {
      await storage.deleteMessage(params.messageId);

      // Best-effort: propagate a `remove-message` control message to the
      // counterparty and our own devices. A send failure must not undo the
      // local delete, so swallow errors.
      try {
        const senderId = user?.address;
        if (!senderId) return params.messageId;

        // NOTE: deliberately do NOT gate on isConnected. enqueueOutbound queues
        // the message and the WS client flushes its queue on (re)connect, so a
        // transient disconnect must not silently drop the delete. We only need
        // device keys to be able to encrypt. (A normal text send throws on
        // !isConnected so the user can retry; a delete has no retry UI, so
        // dropping it silently is worse — enqueue and let it flush.)
        if (!encryptionService.hasDeviceKeys()) return params.messageId;

        const deviceKeyset = await getDeviceKeyset();
        if (!deviceKeyset) return params.messageId;

        const nonce = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          const v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        });
        const createdDate = Date.now();
        const controlMessageId = `${nonce}-${createdDate}`;

        // Control message: transported only, never persisted as a chat row.
        const message: Message = {
          messageId: controlMessageId,
          channelId: params.recipientAddress,
          spaceId: params.recipientAddress,
          digestAlgorithm: 'SHA-256',
          nonce,
          createdDate,
          modifiedDate: createdDate,
          lastModifiedHash: '',
          content: {
            type: 'remove-message',
            senderId,
            removeMessageId: params.messageId,
          } as RemoveMessage,
          reactions: [],
          mentions: { memberIds: [], roleIds: [], channelIds: [] },
        };

        // Resolve all target devices the same way a normal DM send does:
        // recipient's devices + our own OTHER devices. sendEncryptedMessageToAllDevices
        // also reuses existing sessions and bootstraps new ones per device.
        const { toAllDeviceInfos } = await import('./useRecipientRegistration');
        let allTargetDevices: DeviceInfo[] = [];
        try {
          const recipientReg = await apiClient.fetchUserRegistration(params.recipientAddress);
          if (recipientReg) allTargetDevices.push(...toAllDeviceInfos(recipientReg));
          const senderReg = await apiClient.fetchUserRegistration(senderId);
          if (senderReg) {
            allTargetDevices.push(
              ...toAllDeviceInfos(senderReg).filter((d) => d.inboxAddress !== deviceKeyset.inboxAddress)
            );
          }
        } catch {
          // Registration fetch failed — fall through; with no devices the send
          // is skipped below and the local delete still stands.
        }

        if (allTargetDevices.length === 0) return params.messageId;

        await sendEncryptedMessageToAllDevices(
          params.conversationId,
          params.recipientAddress,
          message,
          allTargetDevices,
          enqueueOutbound,
          subscribe,
          {
            identityPublicKey: deviceKeyset.identityPublicKey,
            inboxAddress: deviceKeyset.inboxAddress,
            inboxEncryptionPublicKey: deviceKeyset.inboxEncryptionPublicKey,
          },
          senderId,
          user?.displayName,
        );
      } catch (err) {
        logger.debug('[useDeleteDirectMessage] remove-message send failed (local delete stands)', err);
      }

      return params.messageId;
    },

    onMutate: async (params) => {
      // Use the same query key format as useMessages hook (spaceId, channelId = recipientAddress)
      const key = queryKeys.messages.infinite(params.recipientAddress, params.recipientAddress);

      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: key });

      // Snapshot previous value
      const previousData = queryClient.getQueryData<InfiniteMessagesData>(key);

      // Optimistically remove from cache
      queryClient.setQueryData<InfiniteMessagesData>(key, (old) => {
        if (!old) return old;

        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            messages: page.messages.filter((m) => m.messageId !== params.messageId),
          })),
        };
      });

      return { previousData };
    },

    onError: (err, params, context) => {
      // Rollback on error
      if (context?.previousData) {
        const key = queryKeys.messages.infinite(params.recipientAddress, params.recipientAddress);
        queryClient.setQueryData(key, context.previousData);
      }
    },

    onSettled: (data, err, params) => {
      // Invalidate to ensure consistency
      queryClient.invalidateQueries({
        queryKey: queryKeys.messages.infinite(params.recipientAddress, params.recipientAddress),
      });

      // Also invalidate conversations to update last message if needed
      queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.all('direct'),
      });
    },
  });
}
