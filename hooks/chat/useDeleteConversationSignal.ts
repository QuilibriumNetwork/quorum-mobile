/**
 * useDeleteConversationSignal - tell the counterparty we deleted this DM.
 *
 * Matches desktop: send a `delete-conversation` control message before the local
 * delete. On receive the counterparty only resets its encryption session (it does
 * NOT delete its copy) so the next message re-handshakes cleanly. Best-effort —
 * a send failure must never block the local delete. Reuses the all-devices DM
 * transport.
 */

import { useCallback } from 'react';
import { useAuth, useWebSocket } from '@/context';
import { getQuorumClient } from '@/services/api/quorumClient';
import { encryptionService } from '@/services/crypto/encryption-service';
import { getDeviceKeyset } from '@/services/onboarding/secureStorage';
import { logger } from '@quilibrium/quorum-shared';
import type { Message, DeleteConversationMessage } from '@quilibrium/quorum-shared';
import { sendEncryptedMessageToAllDevices } from './useSendDirectMessage';

type DeviceInfo = {
  identityKey: number[];
  signedPreKey: number[];
  inboxAddress: string;
  inboxEncryptionKey: number[];
};

export function useDeleteConversationSignal() {
  const { user } = useAuth();
  const { enqueueOutbound, subscribe } = useWebSocket();
  const apiClient = getQuorumClient();

  // conversationId is `${recipientAddress}/${recipientAddress}` for a DM.
  return useCallback(
    async (conversationId: string, recipientAddress: string) => {
      try {
        const senderId = user?.address;
        if (!senderId) return;

        // Mirror the message-delete send: don't gate on isConnected (enqueue and
        // let the WS client flush on reconnect); we only need device keys to encrypt.
        if (!encryptionService.hasDeviceKeys()) return;

        const deviceKeyset = await getDeviceKeyset();
        if (!deviceKeyset) return;

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
          channelId: recipientAddress,
          spaceId: recipientAddress,
          digestAlgorithm: 'SHA-256',
          nonce,
          createdDate,
          modifiedDate: createdDate,
          lastModifiedHash: '',
          content: {
            type: 'delete-conversation',
            senderId,
          } as DeleteConversationMessage,
          reactions: [],
          mentions: { memberIds: [], roleIds: [], channelIds: [] },
        };

        // Resolve target devices the same way a normal DM send does: the
        // recipient's devices + our own OTHER devices.
        const { toAllDeviceInfos } = await import('./useRecipientRegistration');
        const allTargetDevices: DeviceInfo[] = [];
        try {
          const recipientReg = await apiClient.fetchUserRegistration(recipientAddress);
          if (recipientReg) allTargetDevices.push(...toAllDeviceInfos(recipientReg));
          const senderReg = await apiClient.fetchUserRegistration(senderId);
          if (senderReg) {
            allTargetDevices.push(
              ...toAllDeviceInfos(senderReg).filter((d) => d.inboxAddress !== deviceKeyset.inboxAddress)
            );
          }
        } catch {
          // Registration fetch failed — with no devices the send is skipped.
        }

        if (allTargetDevices.length === 0) return;

        await sendEncryptedMessageToAllDevices(
          conversationId,
          recipientAddress,
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
        logger.debug('[useDeleteConversationSignal] send failed (local delete stands)', err);
      }
    },
    [user?.address, user?.displayName, enqueueOutbound, subscribe, apiClient],
  );
}
