/**
 * useSendDirectReaction - Hook for sending encrypted reactions in DMs
 *
 * Similar to useSendDirectMessage but for reaction messages
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useStorageAdapter } from '@/context/StorageContext';
import { useAuth, useWebSocket } from '@/context';
import { getQuorumClient } from '@/services/api/quorumClient';
import { encryptionService } from '@/services/crypto/encryption-service';
import { ratchetMutex } from '@/services/crypto/ratchet-mutex';
import { encryptionStateStorage } from '@/services/crypto/encryption-state-storage';
import { getDeviceKeyset } from '@/services/onboarding/secureStorage';
import { queryKeys, bytesToHex, hexToBytes } from '@quilibrium/quorum-shared';
import { signConfirmedEnvelope } from './useSendDirectMessage';
import type { Message, ReactionMessage, RemoveReactionMessage, Reaction } from '@quilibrium/quorum-shared';

export interface SendDirectReactionParams {
  conversationId: string;
  recipientAddress: string;
  targetMessageId: string;
  reaction: string;
  /** Recipient encryption info - required for E2E encryption if no session exists */
  recipientInfo?: {
    identityKey: number[];
    signedPreKey: number[];
    inboxAddress: string;
    inboxEncryptionKey: number[];
  };
}

import type { MessagesPage, InfiniteMessagesData } from './queryTypes';
import type { StorageAdapter } from '@quilibrium/quorum-shared';

// Mirrors useSpaceReactions.persistReactionToStorage. Without this, a DM
// reaction lives only in the React Query cache and is silently dropped the
// next time the messages query refetches from MMKV (e.g. when the user
// sends a follow-up message and useSendDirectMessage invalidates the
// messages key). The peer's reactions arrive via WebSocketContext's
// applyDMGroupResults reaction branch, which also writes back to MMKV.
async function persistReactionToStorage(
  storage: StorageAdapter,
  recipientAddress: string,
  targetMessageId: string,
  apply: (reactions: Message['reactions']) => Message['reactions'],
): Promise<Message | undefined> {
  const stored = await storage.getMessage({
    spaceId: recipientAddress,
    channelId: recipientAddress,
    messageId: targetMessageId,
  });
  if (!stored) return undefined;
  const updated: Message = { ...stored, reactions: apply(stored.reactions) };
  await storage.saveMessage(updated, updated.createdDate, '', '', '', '');
  return stored;
}

export function useSendDirectReaction() {
  const storage = useStorageAdapter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { enqueueOutbound } = useWebSocket();
  const apiClient = getQuorumClient();

  return useMutation({
    mutationFn: async ({
      conversationId,
      recipientAddress,
      targetMessageId,
      reaction,
      recipientInfo,
    }: SendDirectReactionParams): Promise<Message> => {
      const senderId = user?.address ?? 'unknown';

      const nonce = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
      const createdDate = Date.now();
      const messageId = `${nonce}-${createdDate}`;

      // Create reaction message
      const message: Message = {
        messageId,
        channelId: recipientAddress,
        spaceId: recipientAddress,
        digestAlgorithm: 'SHA-256',
        nonce,
        createdDate,
        modifiedDate: createdDate,
        lastModifiedHash: '',
        content: {
          type: 'reaction',
          senderId,
          messageId: targetMessageId,
          reaction,
        } as ReactionMessage,
        reactions: [],
        mentions: { memberIds: [], roleIds: [], channelIds: [] },
      };

      // E2E encryption checks
      const hasDeviceKeys = encryptionService.hasDeviceKeys();
      const hasSession = encryptionService.hasSession(conversationId);

      if (!hasDeviceKeys) {
        throw new Error('Device encryption keys not initialized.');
      }

      // Do NOT gate on isConnected: enqueueOutbound buffers the envelope and the
      // WS client flushes it on (re)connect, so a transient disconnect (or a
      // stale isConnected) must not drop the send. Mirrors the DM delete/edit paths.

      // Fetch recipient info if needed
      let finalRecipientInfo = recipientInfo;
      if (!finalRecipientInfo && !hasSession) {
        try {
          const registration = await apiClient.fetchUserRegistration(recipientAddress);
          if (registration) {
            const { toRecipientInfo } = await import('./useRecipientRegistration');
            finalRecipientInfo = toRecipientInfo(registration) ?? undefined;
          }
        } catch (regError) {
        }
      }

      if (!finalRecipientInfo && !hasSession) {
        throw new Error('No encryption session available.');
      }

      const deviceKeyset = await getDeviceKeyset();
      if (!deviceKeyset) {
        throw new Error('Device keyset not found.');
      }

      // Send encrypted reaction
      await sendEncryptedReaction(
        conversationId,
        recipientAddress,
        message,
        finalRecipientInfo,
        enqueueOutbound,
        {
          identityPublicKey: deviceKeyset.identityPublicKey,
          inboxAddress: deviceKeyset.inboxAddress,
          inboxEncryptionPublicKey: deviceKeyset.inboxEncryptionPublicKey,
        },
        senderId,
        user?.displayName
      );

      return message;
    },

    onMutate: async ({ recipientAddress, targetMessageId, reaction }) => {
      if (!user?.address) return;

      const key = queryKeys.messages.infinite(recipientAddress, recipientAddress);

      await queryClient.cancelQueries({ queryKey: key });
      const previousData = queryClient.getQueryData<InfiniteMessagesData>(key);

      const applyAdd = (existingReactions: Message['reactions']): Message['reactions'] => {
        const reactions = existingReactions || [];
        const existing = reactions.find(
          (r) => r.emojiName === reaction || r.emojiId === reaction
        );
        if (existing) {
          if (existing.memberIds.includes(user.address!)) return reactions;
          return reactions.map((r) =>
            r === existing
              ? { ...r, count: r.count + 1, memberIds: [...r.memberIds, user.address!] }
              : r
          );
        }
        const newReaction: Reaction = {
          emojiId: reaction,
          emojiName: reaction,
          spaceId: recipientAddress,
          count: 1,
          memberIds: [user.address!],
        };
        return [...reactions, newReaction];
      };

      // Optimistically add reaction to target message
      queryClient.setQueryData<InfiniteMessagesData>(key, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            messages: page.messages.map((m: Message) =>
              m.messageId === targetMessageId ? { ...m, reactions: applyAdd(m.reactions) } : m
            ),
          })),
        };
      });

      // Persist to MMKV — without this the reaction survives only in the
      // React Query cache and is dropped on the next refetch (e.g. when
      // the user sends a follow-up message and useSendDirectMessage
      // invalidates the messages key).
      const previousStored = await persistReactionToStorage(
        storage,
        recipientAddress,
        targetMessageId,
        applyAdd,
      );

      return { previousData, previousStored };
    },

    onError: async (err, { recipientAddress }, context) => {
      if (context?.previousData) {
        const key = queryKeys.messages.infinite(recipientAddress, recipientAddress);
        queryClient.setQueryData(key, context.previousData);
      }
      if (context?.previousStored) {
        await storage.saveMessage(
          context.previousStored,
          context.previousStored.createdDate,
          '', '', '', '',
        );
      }
    },
  });
}

export function useRemoveDirectReaction() {
  const storage = useStorageAdapter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { enqueueOutbound } = useWebSocket();
  const apiClient = getQuorumClient();

  return useMutation({
    mutationFn: async ({
      conversationId,
      recipientAddress,
      targetMessageId,
      reaction,
      recipientInfo,
    }: SendDirectReactionParams): Promise<Message> => {
      const senderId = user?.address ?? 'unknown';

      const nonce = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
      const createdDate = Date.now();
      const messageId = `${nonce}-${createdDate}`;

      const message: Message = {
        messageId,
        channelId: recipientAddress,
        spaceId: recipientAddress,
        digestAlgorithm: 'SHA-256',
        nonce,
        createdDate,
        modifiedDate: createdDate,
        lastModifiedHash: '',
        content: {
          type: 'remove-reaction',
          senderId,
          messageId: targetMessageId,
          reaction,
        } as RemoveReactionMessage,
        reactions: [],
        mentions: { memberIds: [], roleIds: [], channelIds: [] },
      };

      const hasDeviceKeys = encryptionService.hasDeviceKeys();
      const hasSession = encryptionService.hasSession(conversationId);

      if (!hasDeviceKeys) {
        throw new Error('Device encryption keys not initialized.');
      }

      // Do NOT gate on isConnected: enqueueOutbound buffers the envelope and the
      // WS client flushes it on (re)connect, so a transient disconnect (or a
      // stale isConnected) must not drop the send. Mirrors the DM delete/edit paths.

      let finalRecipientInfo = recipientInfo;
      if (!finalRecipientInfo && !hasSession) {
        try {
          const registration = await apiClient.fetchUserRegistration(recipientAddress);
          if (registration) {
            const { toRecipientInfo } = await import('./useRecipientRegistration');
            finalRecipientInfo = toRecipientInfo(registration) ?? undefined;
          }
        } catch (regError) {
        }
      }

      if (!finalRecipientInfo && !hasSession) {
        throw new Error('No encryption session available.');
      }

      const deviceKeyset = await getDeviceKeyset();
      if (!deviceKeyset) {
        throw new Error('Device keyset not found.');
      }

      await sendEncryptedReaction(
        conversationId,
        recipientAddress,
        message,
        finalRecipientInfo,
        enqueueOutbound,
        {
          identityPublicKey: deviceKeyset.identityPublicKey,
          inboxAddress: deviceKeyset.inboxAddress,
          inboxEncryptionPublicKey: deviceKeyset.inboxEncryptionPublicKey,
        },
        senderId,
        user?.displayName
      );

      return message;
    },

    onMutate: async ({ recipientAddress, targetMessageId, reaction }) => {
      if (!user?.address) return;

      const key = queryKeys.messages.infinite(recipientAddress, recipientAddress);

      await queryClient.cancelQueries({ queryKey: key });
      const previousData = queryClient.getQueryData<InfiniteMessagesData>(key);

      const applyRemove = (existingReactions: Message['reactions']): Message['reactions'] =>
        (existingReactions || [])
          .map((r) => {
            if (r.emojiName !== reaction && r.emojiId !== reaction) return r;
            const newMemberIds = r.memberIds.filter((id) => id !== user.address);
            if (newMemberIds.length === 0) return null;
            return { ...r, count: newMemberIds.length, memberIds: newMemberIds };
          })
          .filter((r): r is Reaction => r !== null);

      // Optimistically remove reaction from target message
      queryClient.setQueryData<InfiniteMessagesData>(key, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            messages: page.messages.map((m: Message) =>
              m.messageId === targetMessageId ? { ...m, reactions: applyRemove(m.reactions) } : m
            ),
          })),
        };
      });

      // Persist to MMKV — same reasoning as the add path; without this a
      // follow-up message's invalidate-and-refetch resurrects the deleted
      // reaction from disk.
      const previousStored = await persistReactionToStorage(
        storage,
        recipientAddress,
        targetMessageId,
        applyRemove,
      );

      return { previousData, previousStored };
    },

    onError: async (err, { recipientAddress }, context) => {
      if (context?.previousData) {
        const key = queryKeys.messages.infinite(recipientAddress, recipientAddress);
        queryClient.setQueryData(key, context.previousData);
      }
      if (context?.previousStored) {
        await storage.saveMessage(
          context.previousStored,
          context.previousStored.createdDate,
          '', '', '', '',
        );
      }
    },
  });
}

/**
 * Encrypt + seal + enqueue a DM control message (reaction, remove-reaction,
 * remove-message, …). Requires an established session.
 */
export async function sendEncryptedControlMessage(
  conversationId: string,
  recipientAddress: string,
  message: Message,
  enqueueOutbound: (prepareMessage: () => Promise<string[]>) => void,
): Promise<void> {
  const { NativeCryptoProvider } = await import('@/services/crypto/native-provider');
  const cryptoProvider = new NativeCryptoProvider();

  enqueueOutbound(async () => {
    const outbounds: string[] = [];

    const latestState = encryptionStateStorage.getLatestState(conversationId);
    if (!latestState) {
      throw new Error('No encryption session found for conversation');
    }

    const encryptionState = encryptionStateStorage.getEncryptionState(
      conversationId,
      latestState.inboxId
    );

    if (!encryptionState) {
      throw new Error('Encryption state not found');
    }

    const encrypted = await encryptWithExistingSession(
      conversationId,
      latestState.inboxId,
      JSON.stringify(message),
      cryptoProvider
    );

    const sendingInbox = encryptionState.sendingInbox;

    if (sendingInbox?.inbox_address) {
      const sealingEphemeralKey = await cryptoProvider.generateX448();
      const recipientInboxEncryptionKey = hexToBytes(sendingInbox.inbox_encryption_key);

      const textEncoder = new TextEncoder();
      const envelopeBytes = Array.from(textEncoder.encode(encrypted.envelope));

      const sealedEnvelope = await cryptoProvider.encryptInboxMessage({
        inbox_public_key: recipientInboxEncryptionKey,
        ephemeral_private_key: sealingEphemeralKey.private_key,
        plaintext: envelopeBytes,
      });

      const inboxAuth = await signConfirmedEnvelope(sendingInbox, sealedEnvelope);
      const sealedMessage = {
        type: 'direct',
        inbox_address: sendingInbox.inbox_address,
        envelope: sealedEnvelope,
        ephemeral_public_key: bytesToHex(sealingEphemeralKey.public_key),
        inbox_public_key: inboxAuth.inbox_public_key,
        inbox_signature: inboxAuth.inbox_signature,
      };

      outbounds.push(JSON.stringify(sealedMessage));
    } else {
      throw new Error('No sendingInbox available for sending control message');
    }

    return outbounds;
  });
}

/**
 * Thin wrapper over sendEncryptedControlMessage, kept for the reaction call
 * sites' signature (the extra args were never used by the transport).
 */
async function sendEncryptedReaction(
  conversationId: string,
  recipientAddress: string,
  message: Message,
  _recipientInfo:
    | {
        identityKey: number[];
        signedPreKey: number[];
        inboxAddress: string;
        inboxEncryptionKey: number[];
      }
    | undefined,
  enqueueOutbound: (prepareMessage: () => Promise<string[]>) => void,
  _deviceKeyset: {
    identityPublicKey: number[];
    inboxAddress: string;
    inboxEncryptionPublicKey: number[];
  },
  _userAddress: string,
  _displayName?: string
): Promise<void> {
  await sendEncryptedControlMessage(conversationId, recipientAddress, message, enqueueOutbound);
}

/**
 * Encrypt a message using an existing session
 */
async function encryptWithExistingSession(
  conversationId: string,
  inboxAddress: string,
  plaintext: string,
  cryptoProvider: any
): Promise<{ envelope: string; ephemeralPublicKey: string }> {
  return ratchetMutex.runExclusive(conversationId, async () => {
  const encryptionState = encryptionStateStorage.getEncryptionState(
    conversationId,
    inboxAddress
  );

  if (!encryptionState) {
    throw new Error('No encryption state found');
  }

  const textEncoder = new TextEncoder();
  const messageBytes = Array.from(textEncoder.encode(plaintext));

  let ratchetState: Record<string, unknown>;
  let stateStr = encryptionState.state;

  if (stateStr === '[object Object]') {
    throw new Error(`Corrupted encryption state`);
  }

  if (stateStr.includes('\\"') || stateStr.includes('\\\\')) {
    stateStr = stateStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  if (!stateStr.startsWith('{')) {
    throw new Error(`Corrupted encryption state`);
  }

  ratchetState = JSON.parse(stateStr) as Record<string, unknown>;
  const sendingEphemeralPrivateKey = ratchetState.sending_ephemeral_private_key as string | number[];

  const privateKeyBase64 = typeof sendingEphemeralPrivateKey === 'string'
    ? sendingEphemeralPrivateKey
    : btoa(String.fromCharCode(...sendingEphemeralPrivateKey));

  const publicKeyBase64 = await cryptoProvider.getPublicKeyX448(privateKeyBase64);

  const publicKeyBytes = atob(publicKeyBase64);
  const ephemeralPublicKey = Array.from(publicKeyBytes)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');

  const result = await cryptoProvider.doubleRatchetEncrypt({
    ratchet_state: JSON.stringify(ratchetState),
    message: messageBytes,
  });

  encryptionStateStorage.saveEncryptionState({
    state: result.ratchet_state,
    timestamp: Date.now(),
    conversationId,
    inboxId: inboxAddress,
    sentAccept: encryptionState.sentAccept,
    sendingInbox: encryptionState.sendingInbox,
    tag: encryptionState.tag,
  }, true);

  return { envelope: result.envelope, ephemeralPublicKey };
  });
}
