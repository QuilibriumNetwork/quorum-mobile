/**
 * useEditDirectMessage - edit your own DM, syncing to every device (matches desktop).
 *
 * After the optimistic local update, sends an `edit-message` control message
 * over the SAME multi-device transport a normal text message uses
 * (sendEncryptedMessageToAllDevices) — fanning out to the peer's devices AND
 * your own other devices, bootstrapping sessions as needed. This is deliberately
 * NOT the single-session reaction transport, which only reaches one inbox and so
 * misses devices (see the DM-delete precedent). Receive-side auth
 * (WebSocketContext) honors the edit only when the cryptographically-
 * authenticated sender authored the target message.
 *
 * Enforces a 15-minute edit window and honors the conversation's "Save Edit
 * History" setting. Stamps an `editNonce` so a duplicate delivery is a
 * receive-side no-op (see quorum-shared editHistory).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, useWebSocket } from '@/context';
import { useStorageAdapter } from '@/context/StorageContext';
import { getQuorumClient } from '@/services/api/quorumClient';
import { encryptionService } from '@/services/crypto/encryption-service';
import { getDeviceKeyset } from '@/services/onboarding/secureStorage';
import { generateNonce } from '@/services/onboarding/keyService';
import {
  buildLocalEdits,
  logger,
  MESSAGE_EDIT_WINDOW_MS,
  queryKeys,
  type Message,
  type EditMessage,
} from '@quilibrium/quorum-shared';
import { sendEncryptedMessageToAllDevices } from './useSendDirectMessage';
import type { InfiniteMessagesData } from './queryTypes';

export interface UseEditDirectMessageParams {
  conversationId: string;
  recipientAddress: string;
  messageId: string;
  newText: string;
  originalCreatedDate: number;
}

type DeviceInfo = {
  identityKey: number[];
  signedPreKey: number[];
  inboxAddress: string;
  inboxEncryptionKey: number[];
};

export function useEditDirectMessage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const storage = useStorageAdapter();
  const { enqueueOutbound, subscribe } = useWebSocket();
  const apiClient = getQuorumClient();

  return useMutation({
    mutationFn: async (params: UseEditDirectMessageParams) => {
      if (!user?.address) {
        throw new Error('User must be logged in to edit messages');
      }

      // Enforce edit window
      const elapsed = Date.now() - params.originalCreatedDate;
      if (elapsed > MESSAGE_EDIT_WINDOW_MS) {
        throw new Error('Messages can only be edited within 15 minutes of sending');
      }

      // Honor the conversation's "Save Edit History" setting, matching
      // desktop (MessageEditTextarea.tsx / MessageService.ts): when OFF, drop
      // prior versions (edits: []) instead of accumulating. Default false to
      // match desktop's default everywhere — keeping history is opt-in. The
      // receive path applies the same gate so the peer's echoed edit stays
      // consistent with ours.
      const conversation = await storage.getConversation(params.conversationId);
      const saveEditHistory = conversation?.saveEditHistory ?? false;

      // Single edit timestamp + nonce, shared by the local write and the wire
      // send so every device converges on the same edit metadata. The nonce is
      // the receive-side replay guard (quorum-shared applyReceivedEdit).
      const editedAt = Date.now();
      const editNonce = generateNonce();

      // Local optimistic write to storage (the cache was already updated in
      // onMutate). Keeps MMKV in sync so the edit survives query invalidation.
      const key = queryKeys.messages.infinite(params.recipientAddress, params.recipientAddress);
      const existingData = queryClient.getQueryData<InfiniteMessagesData>(key);

      if (existingData) {
        for (const page of existingData.pages) {
          const msg = page.messages.find(m => m.messageId === params.messageId);
          if (msg && (msg.content.type === 'post' || msg.content.type === 'event')) {
            const updatedMsg: Message = {
              ...msg,
              modifiedDate: editedAt,
              lastModifiedHash: editNonce,
              content: {
                ...msg.content,
                text: params.newText,
              } as Message['content'],
              edits: buildLocalEdits(msg.edits, params.newText, editedAt, saveEditHistory),
            };
            await storage.saveMessage(
              updatedMsg,
              updatedMsg.createdDate,
              params.recipientAddress,
              'dm',
              '',
              '',
            );
            break;
          }
        }
      }

      // Transmit an `edit-message` control message to the peer's devices AND our
      // own other devices, over the all-devices transport (mirrors the DM-delete
      // path). Best-effort: a send failure must not undo the local edit.
      try {
        const senderId = user.address;

        // NOTE: deliberately do NOT gate on isConnected — enqueueOutbound queues
        // and the WS client flushes on (re)connect, so a transient disconnect
        // must not silently drop the edit. We only need device keys to encrypt.
        if (!encryptionService.hasDeviceKeys()) return params.messageId;

        const deviceKeyset = await getDeviceKeyset();
        if (!deviceKeyset) return params.messageId;

        const nonce = generateNonce();
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
            type: 'edit-message',
            senderId,
            originalMessageId: params.messageId,
            editedText: params.newText,
            editedAt,
            editNonce,
          } as EditMessage,
          reactions: [],
          mentions: { memberIds: [], roleIds: [], channelIds: [] },
        };

        // Resolve all target devices exactly as a normal DM send / the DM-delete
        // path does: recipient's devices + our own OTHER devices.
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
          // is skipped below and the local edit still stands.
        }

        if (allTargetDevices.length === 0) return params.messageId;

        logger.debug(
          `[useEditDirectMessage] posting edit-message for ${params.messageId.slice(0, 12)} to ${allTargetDevices.length} device(s)`
        );

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
        logger.debug('[useEditDirectMessage] edit-message send failed (local edit stands)', err);
      }

      return params.messageId;
    },

    onMutate: async (params) => {
      const key = queryKeys.messages.infinite(params.recipientAddress, params.recipientAddress);

      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: key });

      // Snapshot previous value
      const previousData = queryClient.getQueryData<InfiniteMessagesData>(key);

      // Same "Save Edit History" gate as the storage write, so the optimistic
      // cache and persisted message don't diverge (default false → desktop).
      const conversation = await storage.getConversation(params.conversationId);
      const saveEditHistory = conversation?.saveEditHistory ?? false;

      // Optimistically update the message text in cache
      queryClient.setQueryData<InfiniteMessagesData>(key, (old) => {
        if (!old) return old;

        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            messages: page.messages.map((m) => {
              if (m.messageId === params.messageId && m.content.type === 'post') {
                return {
                  ...m,
                  modifiedDate: Date.now(),
                  content: {
                    ...m.content,
                    text: params.newText,
                  },
                  edits: buildLocalEdits(m.edits, params.newText, Date.now(), saveEditHistory),
                };
              }
              return m;
            }),
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
      queryClient.invalidateQueries({
        queryKey: queryKeys.messages.infinite(params.recipientAddress, params.recipientAddress),
      });
    },
  });
}
