/**
 * useDeleteConversationSignal - tell the counterparty AND our own devices that we
 * deleted this DM.
 *
 * Two control messages, one all-devices fan-out (matches desktop's deleteConversation):
 *   1. `delete-conversation`      → the counterparty resets its encryption session
 *      (it does NOT delete its copy) so the next message re-handshakes cleanly.
 *   2. `delete-conversation-self` → our OWN other devices delete the whole
 *      conversation. The counterparty also receives it in the fan-out, but its
 *      receive handler acts on this type ONLY when the sender is self, so it can
 *      never trigger a delete on the counterparty.
 *
 * Both are best-effort — a send failure must never block the local delete. Reuses
 * the all-devices DM transport (every device is an inbox, so the fan-out already
 * reaches our own other devices).
 */

import { useCallback } from 'react';
import { useAuth, useWebSocket } from '@/context';
import { getQuorumClient } from '@/services/api/quorumClient';
import { encryptionService } from '@/services/crypto/encryption-service';
import { getDeviceKeyset } from '@/services/onboarding/secureStorage';
import { logger } from '@quilibrium/quorum-shared';
import type {
  Message,
  DeleteConversationMessage,
  DeleteConversationSelfMessage,
} from '@quilibrium/quorum-shared';
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

        const makeNonce = () =>
          'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
          });

        // Build a transport-only control message (never persisted as a chat row).
        const buildControlMessage = (
          content: DeleteConversationMessage | DeleteConversationSelfMessage,
        ): Message => {
          const nonce = makeNonce();
          const createdDate = Date.now();
          return {
            messageId: `${nonce}-${createdDate}`,
            channelId: recipientAddress,
            spaceId: recipientAddress,
            digestAlgorithm: 'SHA-256',
            nonce,
            createdDate,
            modifiedDate: createdDate,
            lastModifiedHash: '',
            content,
            reactions: [],
            mentions: { memberIds: [], roleIds: [], channelIds: [] },
          };
        };

        // 1. Counterparty: reset your encryption session (do NOT delete their copy).
        const resetMessage = buildControlMessage({
          type: 'delete-conversation',
          senderId,
        } as DeleteConversationMessage);

        // 2. Self-sync: tell OUR OWN other devices to delete the whole conversation.
        // The fan-out reaches both parties; the receiver acts on this type only
        // when the sender is self, so the counterparty can never delete our copy.
        const selfMessage = buildControlMessage({
          type: 'delete-conversation-self',
          senderId,
          conversationAddress: recipientAddress,
        } as DeleteConversationSelfMessage);

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

        const deviceInfo = {
          identityPublicKey: deviceKeyset.identityPublicKey,
          inboxAddress: deviceKeyset.inboxAddress,
          inboxEncryptionPublicKey: deviceKeyset.inboxEncryptionPublicKey,
        };

        // Identity: NONE. A conversation row exists on inbound messages alone
        // (a stranger who messaged us, never replied to), so this control
        // message can be the very FIRST frame we ever send them — before the
        // reveal ledger has recorded any consent (that only happens via
        // onDeliberateDmSend, on a successful chat/embed send). Tapping
        // "delete conversation" is a human act, but it is not the deliberate
        // messaging act the privacy rule keys on — if anything it is the
        // opposite signal — so attaching identity here would let a spammer
        // learn our name/avatar simply by messaging us and having us delete
        // the conversation to get rid of it.
        const sendControl = (message: Message) =>
          sendEncryptedMessageToAllDevices(
            conversationId,
            recipientAddress,
            message,
            allTargetDevices,
            enqueueOutbound,
            subscribe,
            deviceInfo,
            senderId,
          );

        // Send both control messages over the same resolved device set. Each is
        // independent best-effort — a failure of one must not skip the other.
        await Promise.allSettled([sendControl(resetMessage), sendControl(selfMessage)]);
      } catch (err) {
        logger.debug('[useDeleteConversationSignal] send failed (local delete stands)', err);
      }
    },
    [user?.address, enqueueOutbound, subscribe, apiClient],
  );
}
