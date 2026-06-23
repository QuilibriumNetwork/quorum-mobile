/**
 * useSendDirectEmbedMessage - Hook for sending encrypted embed/image messages in DMs
 *
 * Similar to useSendDirectMessage but for embed content (images, videos)
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useStorageAdapter } from '@/context/StorageContext';
import { useAuth, useWebSocket } from '@/context';
import { getQuorumClient } from '@/services/api/quorumClient';
import { encryptionService } from '@/services/crypto/encryption-service';
import { encryptionStateStorage, type ConversationInboxKeypair } from '@/services/crypto/encryption-state-storage';
import { getDeviceKeyset } from '@/services/onboarding/secureStorage';
import { deriveAddress } from '@/services/onboarding/keyService';
import { queryKeys, bytesToHex, hexToBytes, type InitializationEnvelope, type EmbedMessage } from '@quilibrium/quorum-shared';
import type { Message } from '@quilibrium/quorum-shared';
import type { MessagePreview } from '@/utils/messagePreview';

export interface SendDirectEmbedMessageParams {
  conversationId: string;
  recipientAddress: string;
  imageUrl: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  /** Optional text to accompany the image */
  text?: string;
  /** Recipient encryption info - required for E2E encryption */
  recipientInfo?: {
    identityKey: number[];
    signedPreKey: number[];
    inboxAddress: string;
    inboxEncryptionKey: number[];
  };
}

import type { MessagesPage, InfiniteMessagesData } from './queryTypes';

export function useSendDirectEmbedMessage() {
  const storage = useStorageAdapter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { enqueueOutbound, isConnected, subscribe } = useWebSocket();
  const apiClient = getQuorumClient();

  return useMutation({
    mutationFn: async ({
      conversationId,
      recipientAddress,
      imageUrl,
      thumbnailUrl,
      width,
      height,
      text,
      recipientInfo,
    }: SendDirectEmbedMessageParams): Promise<Message> => {
      const senderId = user?.address ?? 'unknown';

      const nonce = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
      const createdDate = Date.now();
      const messageId = `${nonce}-${createdDate}`;

      // Create embed message object
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
          type: 'embed',
          senderId,
          imageUrl,
          thumbnailUrl,
          width: width?.toString(),
          height: height?.toString(),
          text,
        } as EmbedMessage & { text?: string },
        reactions: [],
        mentions: { memberIds: [], roleIds: [], channelIds: [] },
      };

      // E2E encryption is required for direct messages
      const hasDeviceKeys = encryptionService.hasDeviceKeys();
      const hasSession = encryptionService.hasSession(conversationId);

      if (!hasDeviceKeys) {
        throw new Error('Device encryption keys not initialized. Please restart the app.');
      }

      if (!isConnected) {
        throw new Error('WebSocket not connected. Please check your connection.');
      }

      // If no session and no recipientInfo provided, try to fetch the registration
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
        throw new Error('No encryption session available. Recipient registration may be missing.');
      }

      // Get our device keyset for the InitializationEnvelope
      const deviceKeyset = await getDeviceKeyset();
      if (!deviceKeyset) {
        throw new Error('Device keyset not found. Please re-register.');
      }

      // Encrypt and send via WebSocket (reuse the same encryption logic as text messages)
      await sendEncryptedEmbedMessage(
        conversationId,
        recipientAddress,
        message,
        finalRecipientInfo,
        enqueueOutbound,
        subscribe,
        {
          identityPublicKey: deviceKeyset.identityPublicKey,
          inboxAddress: deviceKeyset.inboxAddress,
          inboxEncryptionPublicKey: deviceKeyset.inboxEncryptionPublicKey,
        },
        senderId,
        user?.displayName
      );

      return { ...message, sendStatus: 'sent' };
    },

    onMutate: async ({
      conversationId,
      recipientAddress,
      imageUrl,
      thumbnailUrl,
      width,
      height,
      text,
    }) => {
      const key = queryKeys.messages.infinite(recipientAddress, recipientAddress);
      const senderId = user?.address ?? 'unknown';

      await queryClient.cancelQueries({ queryKey: key });

      const previousData = queryClient.getQueryData<InfiniteMessagesData>(key);

      const nonce = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
      const createdDate = Date.now();

      const optimisticMessage: Message = {
        messageId: `${nonce}-${createdDate}`,
        channelId: recipientAddress,
        spaceId: recipientAddress,
        digestAlgorithm: 'SHA-256',
        nonce,
        createdDate,
        modifiedDate: createdDate,
        lastModifiedHash: '',
        content: {
          type: 'embed',
          senderId,
          imageUrl,
          thumbnailUrl,
          width: width?.toString(),
          height: height?.toString(),
          text,
        } as EmbedMessage & { text?: string },
        reactions: [],
        mentions: { memberIds: [], roleIds: [], channelIds: [] },
        sendStatus: 'sending',
      };

      // Save to storage immediately
      await storage.saveMessage(
        optimisticMessage,
        createdDate,
        recipientAddress,
        'direct',
        '',
        ''
      );

      // Optimistically add to cache (append to end)
      queryClient.setQueryData<InfiniteMessagesData>(key, (old) => {
        if (!old) {
          return {
            pages: [
              {
                messages: [optimisticMessage],
                nextCursor: null,
                prevCursor: null,
              },
            ],
            pageParams: [undefined],
          };
        }
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
      });

      return { previousData, optimisticMessage };
    },

    onError: async (err, { recipientAddress }, context) => {
      if (context?.optimisticMessage) {
        const key = queryKeys.messages.infinite(recipientAddress, recipientAddress);
        const failedMessage: Message = {
          ...context.optimisticMessage,
          sendStatus: 'failed' as const,
          sendError: err instanceof Error ? err.message : 'Failed to send',
        };

        queryClient.setQueryData<InfiniteMessagesData>(key, (old) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              messages: page.messages.map((msg) =>
                msg.messageId === context.optimisticMessage.messageId
                  ? failedMessage
                  : msg
              ),
            })),
          };
        });

        await storage.saveMessage(
          failedMessage,
          failedMessage.createdDate,
          recipientAddress,
          'direct',
          '',
          ''
        );
      }
    },

    onSuccess: async (message, { conversationId, recipientAddress }, context) => {
      const key = queryKeys.messages.infinite(recipientAddress, recipientAddress);

      const sentMessage: Message = context?.optimisticMessage
        ? { ...context.optimisticMessage, sendStatus: 'sent' as const }
        : message;

      queryClient.setQueryData<InfiniteMessagesData>(key, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page, index) => {
            if (index === 0) {
              return {
                ...page,
                messages: page.messages.map((m) =>
                  m.messageId === context?.optimisticMessage.messageId
                    ? sentMessage
                    : m
                ),
              };
            }
            return page;
          }),
        };
      });

      await storage.saveMessage(
        sentMessage,
        sentMessage.createdDate,
        recipientAddress,
        'direct',
        '',
        ''
      );

      const conversation = await storage.getConversation(conversationId);
      if (conversation) {
        // Typed preview (icon + text, no emoji) so the sender's own DM row
        // matches the receive-side preview. Caption text wins over the generic
        // "Image" label, but the kind stays 'image' for the leading icon.
        const content = message.content as EmbedMessage & { text?: string };
        const preview: MessagePreview = {
          kind: content.videoUrl ? 'video' : 'image',
          text: content.text || (content.videoUrl ? 'Video' : 'Image'),
        };
        await storage.saveConversation({
          ...conversation,
          timestamp: message.createdDate,
          lastMessageId: message.messageId,
          lastMessagePreview: preview,
          lastMessageSenderName: 'You',
        } as any);
      }

      queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.all('direct'),
      });
    },

    // No onSettled invalidate (see useSendDirectMessage).
  });
}

/**
 * Send an encrypted embed message via WebSocket
 * Reuses the same encryption infrastructure as text messages
 */
async function sendEncryptedEmbedMessage(
  conversationId: string,
  recipientAddress: string,
  message: Message,
  recipientInfo:
    | {
        identityKey: number[];
        signedPreKey: number[];
        inboxAddress: string;
        inboxEncryptionKey: number[];
      }
    | undefined,
  enqueueOutbound: (prepareMessage: () => Promise<string[]>) => void,
  subscribe: (inboxAddresses: string[]) => Promise<void>,
  deviceKeyset: {
    identityPublicKey: number[];
    inboxAddress: string;
    inboxEncryptionPublicKey: number[];
  },
  userAddress: string,
  displayName?: string
): Promise<void> {
  // Import the NativeCryptoProvider for encryption
  const { NativeCryptoProvider } = await import(
    '@/services/crypto/native-provider'
  );
  const cryptoProvider = new NativeCryptoProvider();

  // For new sessions, generate the conversation inbox keypair BEFORE enqueuing
  let conversationInboxAddress: string | null = null;
  let conversationInboxKeypair: { public_key: number[]; private_key: number[] } | null = null;
  let conversationSigningKeypair: { public_key: number[]; private_key: number[] } | null = null;

  if (recipientInfo) {
    // === NEW SESSION: Generate inbox keypairs first ===
    conversationInboxKeypair = await cryptoProvider.generateX448();
    conversationSigningKeypair = await cryptoProvider.generateEd448();
    conversationInboxAddress = deriveAddress(new Uint8Array(conversationSigningKeypair.public_key));

    const storedKeypair: ConversationInboxKeypair = {
      conversationId,
      inboxAddress: conversationInboxAddress,
      encryptionPublicKey: conversationInboxKeypair.public_key,
      encryptionPrivateKey: conversationInboxKeypair.private_key,
      signingPublicKey: conversationSigningKeypair.public_key,
      signingPrivateKey: conversationSigningKeypair.private_key,
    };
    encryptionStateStorage.saveConversationInboxKeypair(storedKeypair);

    encryptionStateStorage.saveInboxMapping(conversationInboxAddress, conversationId);

    await subscribe([conversationInboxAddress]);
  }

  enqueueOutbound(async () => {
    const outbounds: string[] = [];

    if (recipientInfo && conversationInboxAddress && conversationInboxKeypair) {
      // === NEW SESSION: First message ===
      const inboxAddress = recipientInfo.inboxAddress;

      const encrypted = await encryptionService.encryptMessage(
        conversationId,
        {
          address: recipientAddress,
          identityKey: recipientInfo.identityKey,
          signedPreKey: recipientInfo.signedPreKey,
          inboxAddress: recipientInfo.inboxAddress,
          inboxEncryptionKey: recipientInfo.inboxEncryptionKey,
        },
        JSON.stringify(message),
        conversationInboxAddress
      );

      const x3dhEphemeralKey = encrypted.ephemeralPublicKey;
      if (!x3dhEphemeralKey || x3dhEphemeralKey.length === 0) {
        throw new Error('X3DH ephemeral key not returned from encryption');
      }

      const x3dhEphemeralKeyBytes = Array.isArray(x3dhEphemeralKey)
        ? x3dhEphemeralKey
        : hexToBytes(x3dhEphemeralKey);
      const x3dhEphemeralKeyHex = Array.isArray(x3dhEphemeralKey)
        ? bytesToHex(x3dhEphemeralKey)
        : x3dhEphemeralKey;

      const initEnvelope: InitializationEnvelope = {
        user_address: userAddress,
        display_name: displayName || userAddress,
        return_inbox_address: conversationInboxAddress,
        return_inbox_encryption_key: bytesToHex(conversationInboxKeypair.public_key),
        return_inbox_public_key: conversationSigningKeypair
          ? bytesToHex(conversationSigningKeypair.public_key)
          : '',
        return_inbox_private_key: conversationSigningKeypair
          ? bytesToHex(conversationSigningKeypair.private_key)
          : '',
        identity_public_key: bytesToHex(deviceKeyset.identityPublicKey),
        tag: conversationInboxAddress,
        message: encrypted.envelope,
        type: 'direct',
      };

      const textEncoder = new TextEncoder();
      const envelopeBytes = Array.from(textEncoder.encode(JSON.stringify(initEnvelope)));

      const ephemeralPrivateKey = encrypted.ephemeralPrivateKey;
      if (!ephemeralPrivateKey || ephemeralPrivateKey.length === 0) {
        throw new Error('X3DH ephemeral private key not returned from encryption');
      }

      const sealedEnvelope = await cryptoProvider.encryptInboxMessage({
        inbox_public_key: recipientInfo.inboxEncryptionKey,
        ephemeral_private_key: ephemeralPrivateKey,
        plaintext: envelopeBytes,
      });

      const sealedMessage = {
        type: 'direct',
        inbox_address: inboxAddress,
        ephemeral_public_key: x3dhEphemeralKeyHex,
        envelope: sealedEnvelope,
        inbox_public_key: '',
        inbox_signature: '',
      };

      outbounds.push(JSON.stringify(sealedMessage));
    } else {
      // === EXISTING SESSION ===
      const latestState = encryptionStateStorage.getLatestState(conversationId);
      if (!latestState) {
        throw new Error('No encryption session found for conversation');
      }

      const encryptionState = encryptionStateStorage.getEncryptionState(
        conversationId,
        latestState.inboxId
      );

      if (!encryptionState) {
        throw new Error('Encryption state not found for inbox: ' + latestState.inboxId.substring(0, 12));
      }

      const encrypted = await encryptWithExistingSession(
        conversationId,
        latestState.inboxId,
        JSON.stringify(message),
        cryptoProvider
      );

      const sendingInbox = encryptionState.sendingInbox;
      const needsInitEnvelope = !sendingInbox || sendingInbox.inbox_public_key === '';

      if (needsInitEnvelope && sendingInbox?.inbox_encryption_key) {
        // Unconfirmed session
        const ourConversationInbox = encryptionStateStorage.getConversationInboxKeypair(conversationId);

        let ephemeralPrivateKeyBytes: number[];
        let ephemeralPublicKeyHex: string;

        if (encryptionState.x3dhEphemeralPublicKey && encryptionState.x3dhEphemeralPrivateKey) {
          ephemeralPublicKeyHex = encryptionState.x3dhEphemeralPublicKey;
          ephemeralPrivateKeyBytes = hexToBytes(encryptionState.x3dhEphemeralPrivateKey);
        } else {
          const sealingEphemeralKey = await cryptoProvider.generateX448();
          ephemeralPrivateKeyBytes = sealingEphemeralKey.private_key;
          ephemeralPublicKeyHex = bytesToHex(sealingEphemeralKey.public_key);

          const updatedState = {
            ...encryptionState,
            x3dhEphemeralPublicKey: ephemeralPublicKeyHex,
            x3dhEphemeralPrivateKey: bytesToHex(ephemeralPrivateKeyBytes),
          };
          encryptionStateStorage.saveEncryptionState(updatedState, false);
        }

        const initEnvelope: InitializationEnvelope = {
          user_address: userAddress,
          display_name: displayName || userAddress,
          return_inbox_address: ourConversationInbox?.inboxAddress || deviceKeyset.inboxAddress,
          return_inbox_encryption_key: ourConversationInbox
            ? bytesToHex(ourConversationInbox.encryptionPublicKey)
            : bytesToHex(deviceKeyset.inboxEncryptionPublicKey),
          return_inbox_public_key: ourConversationInbox?.signingPublicKey
            ? bytesToHex(ourConversationInbox.signingPublicKey)
            : '',
          return_inbox_private_key: ourConversationInbox?.signingPrivateKey
            ? bytesToHex(ourConversationInbox.signingPrivateKey)
            : '',
          identity_public_key: bytesToHex(deviceKeyset.identityPublicKey),
          tag: ourConversationInbox?.inboxAddress || deviceKeyset.inboxAddress,
          message: encrypted.envelope,
          type: 'direct',
        };

        const textEncoder = new TextEncoder();
        const envelopeBytes = Array.from(textEncoder.encode(JSON.stringify(initEnvelope)));
        const recipientInboxEncryptionKey = hexToBytes(sendingInbox.inbox_encryption_key);

        const sealedEnvelope = await cryptoProvider.encryptInboxMessage({
          inbox_public_key: recipientInboxEncryptionKey,
          ephemeral_private_key: ephemeralPrivateKeyBytes,
          plaintext: envelopeBytes,
        });

        const sealedMessage = {
          type: 'direct',
          inbox_address: sendingInbox.inbox_address,
          ephemeral_public_key: ephemeralPublicKeyHex,
          envelope: sealedEnvelope,
          inbox_public_key: '',
          inbox_signature: '',
        };

        outbounds.push(JSON.stringify(sealedMessage));
      } else if (sendingInbox?.inbox_address) {
        // Confirmed session
        const sealingEphemeralKey = await cryptoProvider.generateX448();
        const recipientInboxEncryptionKey = hexToBytes(sendingInbox.inbox_encryption_key);

        const textEncoder = new TextEncoder();
        const envelopeBytes = Array.from(textEncoder.encode(encrypted.envelope));

        const sealedEnvelope = await cryptoProvider.encryptInboxMessage({
          inbox_public_key: recipientInboxEncryptionKey,
          ephemeral_private_key: sealingEphemeralKey.private_key,
          plaintext: envelopeBytes,
        });

        const existingSessionMsg = {
          type: 'direct',
          inbox_address: sendingInbox.inbox_address,
          envelope: sealedEnvelope,
          ephemeral_public_key: bytesToHex(sealingEphemeralKey.public_key),
          inbox_public_key: '',
          inbox_signature: '',
        };

        outbounds.push(JSON.stringify(existingSessionMsg));
      } else {
        throw new Error('No sendingInbox available for sending');
      }
    }

    return outbounds;
  });
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
    throw new Error(`Corrupted encryption state: ${stateStr.substring(0, 50)}`);
  }

  if (stateStr.includes('\\"') || stateStr.includes('\\\\')) {
    stateStr = stateStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  if (!stateStr.startsWith('{')) {
    throw new Error(`Corrupted encryption state: ${stateStr.substring(0, 50)}`);
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
}
