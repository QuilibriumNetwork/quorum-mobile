/**
 * useSendDirectMessage - Hook for sending encrypted direct messages
 *
 * Handles:
 * - Message encryption via Double Ratchet
 * - WebSocket transport for encrypted messages
 * - Optimistic updates and local storage caching
 * - Fallback to HTTP API when encryption unavailable
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useStorageAdapter } from '@/context/StorageContext';
import { useAuth, useWebSocket } from '@/context';
import { getQuorumClient } from '@/services/api/quorumClient';
import { encryptionService } from '@/services/crypto/encryption-service';
import { ratchetMutex } from '@/services/crypto/ratchet-mutex';
import { encryptionStateStorage, type ConversationInboxKeypair } from '@/services/crypto/encryption-state-storage';
import { getDeviceKeyset, getPrivateKey, getPublicKey } from '@/services/onboarding/secureStorage';
import { deriveAddress } from '@/services/onboarding/keyService';
import { logger, queryKeys, bytesToHex, hexToBytes, type InitializationEnvelope } from '@quilibrium/quorum-shared';
import type { Message } from '@quilibrium/quorum-shared';
import { NativeSigningProvider } from '@/services/crypto/native-signing-provider';
import { sha256 } from '@noble/hashes/sha2.js';

interface SendDirectMessageParams {
  conversationId: string;
  recipientAddress: string;
  text: string;
  repliesToMessageId?: string;
  replyToAuthorAddress?: string;
  /** Recipient encryption info - required for E2E encryption (deprecated, use allRecipientDevices) */
  recipientInfo?: {
    identityKey: number[];
    signedPreKey: number[];
    inboxAddress: string;
    inboxEncryptionKey: number[];
  };
  /** All recipient device infos for multi-device support */
  allRecipientDevices?: Array<{
    identityKey: number[];
    signedPreKey: number[];
    inboxAddress: string;
    inboxEncryptionKey: number[];
  }>;
  /** All sender device infos for multi-device support (messages sent to sender's other devices too) */
  allSenderDevices?: Array<{
    identityKey: number[];
    signedPreKey: number[];
    inboxAddress: string;
    inboxEncryptionKey: number[];
  }>;
  /** Pre-generated message ID and nonce (from onMutate) - internal use only */
  _messageId?: string;
  _nonce?: string;
  _createdDate?: number;
  /** Conversation repudiability (inverse of "Always sign"). Unset/false ⇒ always sign. */
  isRepudiable?: boolean;
  /** Per-message lock state; only consulted when isRepudiable is true. */
  skipSigning?: boolean;
}

/**
 * Reset a DM encryption session, clearing all state.
 * Call this when messages consistently fail to decrypt.
 * After reset, the next message will establish a fresh session.
 *
 * @param conversationId - The conversation ID to reset
 */
export function resetDMSession(conversationId: string): void {
  encryptionService.resetSession(conversationId);
}

import type { MessagesPage, InfiniteMessagesData } from './queryTypes';

// Chunked bytes→base64 (String.fromCharCode(...bytes) overflows the argument
// limit on large envelopes, e.g. media embeds).
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[]
    );
  }
  return btoa(binary);
}

/**
 * Sign a sealed envelope for a CONFIRMED session with the conversation-inbox
 * signing key the peer shared at confirmation.
 *
 * SDK parity (DoubleRatchetInboxEncrypt): when sending_inbox.inbox_public_key
 * is set, the ciphertext is signed with sending_inbox.inbox_private_key and
 * both fields ride on the sealed message — writes to a registered
 * conversation inbox are verified against that key. Mobile historically sent
 * these fields empty, which went unnoticed because sessions never reached
 * the confirmed state; once they did, unsigned confirmed-path messages were
 * dropped downstream (no delivery, no receipt).
 *
 * Returns empty fields when the session has no signing material (init sends
 * to device inboxes are unsigned by design).
 */
export async function signConfirmedEnvelope(
  sendingInbox:
    | { inbox_public_key?: string; inbox_private_key?: string }
    | undefined,
  sealedEnvelope: string
): Promise<{ inbox_public_key: string; inbox_signature: string }> {
  if (!sendingInbox?.inbox_public_key || !sendingInbox.inbox_private_key) {
    return { inbox_public_key: '', inbox_signature: '' };
  }
  try {
    const signingProvider = new NativeSigningProvider();
    const privateKeyBase64 = bytesToBase64(
      new Uint8Array(hexToBytes(sendingInbox.inbox_private_key))
    );
    const messageBase64 = bytesToBase64(new TextEncoder().encode(sealedEnvelope));
    const signatureBase64 = await signingProvider.signEd448(privateKeyBase64, messageBase64);
    const signatureHex = Array.from(atob(signatureBase64))
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('');
    return {
      inbox_public_key: sendingInbox.inbox_public_key,
      inbox_signature: signatureHex,
    };
  } catch {
    // Unsigned fallback — the send may be rejected, but never block the
    // attempt on a signing failure.
    return { inbox_public_key: '', inbox_signature: '' };
  }
}

/**
 * Generate a messageId using SHA-256 hash, matching desktop implementation.
 * The hash is computed from: nonce + 'post' + senderAddress + messageContent
 *
 * @returns Object with messageId (hex string) and messageIdBytes (raw hash for signing)
 */
function generateMessageIdHash(
  nonce: string,
  senderAddress: string,
  messageContent: string
): { messageId: string; messageIdBytes: Uint8Array } {
  const encoder = new TextEncoder();
  const input = nonce + 'post' + senderAddress + messageContent;
  const inputBytes = encoder.encode(input);
  const hashBytes = sha256(inputBytes);
  const messageId = bytesToHex(Array.from(hashBytes));
  return { messageId, messageIdBytes: hashBytes };
}

/**
 * Sign a message ID hash with the user's Ed448 private key.
 * The messageIdBytes are the raw SHA-256 hash bytes (matching desktop behavior).
 * Returns the signature (hex) and public key (hex) if signing succeeds.
 */
async function signMessageIdHash(messageIdBytes: Uint8Array): Promise<{ signature: string; publicKey: string } | null> {
  try {
    const privateKeyHex = await getPrivateKey();
    const publicKeyHex = await getPublicKey();

    if (!privateKeyHex || !publicKeyHex) {
      return null;
    }

    // Convert hash bytes to base64 for signing (matching desktop which signs the raw hash)
    const messageBase64 = btoa(String.fromCharCode(...messageIdBytes));

    // Convert hex private key to base64
    const privateKeyBytes = hexToBytes(privateKeyHex);
    const privateKeyBase64 = btoa(String.fromCharCode(...privateKeyBytes));

    // Sign with Ed448
    const signingProvider = new NativeSigningProvider();
    const signatureBase64 = await signingProvider.signEd448(privateKeyBase64, messageBase64);

    // Convert signature from base64 to hex
    const signatureBytes = atob(signatureBase64);
    const signatureHex = Array.from(signatureBytes)
      .map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('');

    return {
      signature: signatureHex,
      publicKey: publicKeyHex,
    };
  } catch (error) {
    return null;
  }
}

export function useSendDirectMessage() {
  const storage = useStorageAdapter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { enqueueOutbound, isConnected, subscribe } = useWebSocket();
  const apiClient = getQuorumClient();

  // Flip an optimistic DM bubble from 'sending' to 'sent' in the cache. Called
  // when the message actually transmits (via the onFlushed hook below). Guarded
  // on 'sending' so it no-ops if a server copy already replaced the message or
  // it was already marked sent (race-safe).
  const markDmMessageSent = (recipient: string, messageId: string) => {
    const key = queryKeys.messages.infinite(recipient, recipient);
    queryClient.setQueryData<InfiniteMessagesData>(key, (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          messages: page.messages.map((m) =>
            m.messageId === messageId && m.sendStatus === 'sending'
              ? { ...m, sendStatus: 'sent' as const }
              : m
          ),
        })),
      };
    });
  };

  return useMutation({
    mutationFn: async ({
      conversationId,
      recipientAddress,
      text,
      repliesToMessageId,
      replyToAuthorAddress,
      recipientInfo,
      allRecipientDevices,
      allSenderDevices,
      _messageId,
      _nonce,
      _createdDate,
      isRepudiable,
      skipSigning,
    }: SendDirectMessageParams): Promise<Message> => {
      const senderId = user?.address ?? 'unknown';

      // Use pre-generated values from onMutate, or generate new ones
      const nonce = _nonce ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
      const createdDate = _createdDate ?? Date.now();

      // Generate messageId using SHA-256 hash (matching desktop implementation)
      // Hash input: nonce + 'post' + senderAddress + messageContent
      const { messageId, messageIdBytes } = _messageId
        ? { messageId: _messageId, messageIdBytes: hexToBytes(_messageId) }
        : generateMessageIdHash(nonce, senderId, text);

      // Create message object
      // For DMs, both spaceId and channelId are the recipientAddress
      // This matches the query key format and how received messages are stored
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
          type: 'post',
          senderId,
          text,
          repliesToMessageId,
        },
        reactions: [],
        mentions: { memberIds: [], roleIds: [], channelIds: [] },
        // Add reply metadata for display purposes
        ...(repliesToMessageId && replyToAuthorAddress
          ? {
              replyMetadata: {
                parentAuthor: replyToAuthorAddress,
                parentChannelId: recipientAddress,
              },
            }
          : {}),
      };

      // Sign unless the conversation is repudiable AND the lock was opened for
      // this message. Mirrors desktop's effectiveSkip.
      const effectiveSkip = isRepudiable ? !!skipSigning : false;
      if (!effectiveSkip) {
        const signatureData = await signMessageIdHash(new Uint8Array(messageIdBytes));
        if (signatureData) {
          message.signature = signatureData.signature;
          message.publicKey = signatureData.publicKey;
        }
      }

      // E2E encryption is required for direct messages
      const hasDeviceKeys = encryptionService.hasDeviceKeys();

      const me = senderId.slice(0, 8);
      logger.debug(
        `[DM-send ${me}] starting send to ${recipientAddress.slice(0, 12)}, conv=${conversationId.slice(0, 24)}, hasKeys=${hasDeviceKeys}, isConnected=${isConnected}`,
      );

      // Validate encryption requirements
      if (!hasDeviceKeys) {
        logger.debug(`[DM-send ${me}] FAIL: no device keys`);
        throw new Error('Device encryption keys not initialized. Please restart the app.');
      }

      // Do NOT gate on isConnected: enqueueOutbound buffers the envelope and the
      // WS client flushes it on (re)connect, so a transient disconnect (or a
      // stale isConnected) must not drop the send. Mirrors the DM delete/edit paths.

      // Get our device keyset for the InitializationEnvelope
      const deviceKeyset = await getDeviceKeyset();
      if (!deviceKeyset) {
        throw new Error('Device keyset not found. Please re-register.');
      }

      // Collect all target device infos for multi-device support
      // This includes recipient's devices AND sender's other devices
      let allTargetDevices: Array<{
        identityKey: number[];
        signedPreKey: number[];
        inboxAddress: string;
        inboxEncryptionKey: number[];
      }> = [];

      // If we have the new multi-device params, use them
      if (allRecipientDevices && allRecipientDevices.length > 0) {
        allTargetDevices = [...allRecipientDevices];
      } else if (recipientInfo) {
        // Legacy fallback: single recipient device
        allTargetDevices = [recipientInfo];
      }

      // Add sender's other devices (for multi-device sync)
      if (allSenderDevices && allSenderDevices.length > 0) {
        // Filter out our current device (by inbox address)
        const otherSenderDevices = allSenderDevices.filter(
          (d) => d.inboxAddress !== deviceKeyset.inboxAddress
        );
        allTargetDevices = [...allTargetDevices, ...otherSenderDevices];
      }

      // If no devices and no existing sessions, try to fetch registrations
      if (allTargetDevices.length === 0) {
        const { toAllDeviceInfos } = await import('./useRecipientRegistration');

        try {
          // Fetch recipient registration
          const recipientReg = await apiClient.fetchUserRegistration(recipientAddress);
          if (recipientReg) {
            const recipientDevices = toAllDeviceInfos(recipientReg);
            allTargetDevices = [...recipientDevices];
          }

          // Fetch our own registration (for other devices)
          const senderReg = await apiClient.fetchUserRegistration(senderId);
          if (senderReg) {
            const senderDevices = toAllDeviceInfos(senderReg);
            const otherSenderDevices = senderDevices.filter(
              (d) => d.inboxAddress !== deviceKeyset.inboxAddress
            );
            allTargetDevices = [...allTargetDevices, ...otherSenderDevices];
          }
        } catch (regError) {
          // Failed to fetch registrations
        }
      }

      if (allTargetDevices.length === 0) {
        logger.debug(`[DM-send ${me}] FAIL: no target devices`);
        throw new Error('No target devices found. Recipient registration may be missing.');
      }

      logger.debug(
        `[DM-send ${me}] about to send to ${allTargetDevices.length} device(s):`,
        allTargetDevices.map((d) => d.inboxAddress.slice(0, 12)),
      );

      // Send to all target device inboxes (multi-device support)
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
        // Flip the bubble to 'sent' only when the message actually transmits
        // (fires inside the socket-OPEN drain). Until then it stays 'sending',
        // so an offline/queued message is never shown as sent.
        () => markDmMessageSent(recipientAddress, message.messageId)
      );

      // Return the signed message but keep it in its optimistic 'sending' state:
      // onSuccess attaches the signature, and the onFlushed callback above flips
      // it to 'sent' on real transmission.
      return message;
    },

    onMutate: async (variables) => {
      const {
        recipientAddress,
        text,
        repliesToMessageId,
        replyToAuthorAddress,
      } = variables;
      // Use the same query key format as useMessages hook (spaceId, channelId = recipientAddress)
      const key = queryKeys.messages.infinite(recipientAddress, recipientAddress);
      const senderId = user?.address ?? 'unknown';

      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: key });

      // Snapshot previous value
      const previousData = queryClient.getQueryData<InfiniteMessagesData>(key);

      // Create optimistic message with a proper ID using SHA-256 hash (matching desktop)
      const nonce = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
      const createdDate = Date.now();

      // Generate messageId using SHA-256 hash (matching desktop implementation)
      const { messageId } = generateMessageIdHash(nonce, senderId, text);

      // Reuse these EXACT values in mutationFn so the optimistic bubble and the
      // message we actually send share ONE id/nonce/date. Without this they
      // diverge (mutationFn generates its own), which is confusing and can make
      // edits/deletes/replies reference a different id than the recipient has.
      // mutationFn reads these via its `_messageId`/`_nonce`/`_createdDate` params.
      variables._nonce = nonce;
      variables._messageId = messageId;
      variables._createdDate = createdDate;

      const optimisticMessage: Message = {
        messageId,
        channelId: recipientAddress,
        spaceId: recipientAddress,
        digestAlgorithm: 'SHA-256',
        nonce,
        createdDate,
        modifiedDate: createdDate,
        lastModifiedHash: '',
        content: {
          type: 'post',
          senderId,
          text,
          repliesToMessageId,
        },
        reactions: [],
        mentions: { memberIds: [], roleIds: [], channelIds: [] },
        sendStatus: 'sending',
        // Add reply metadata for display purposes
        ...(repliesToMessageId && replyToAuthorAddress
          ? {
              replyMetadata: {
                parentAuthor: replyToAuthorAddress,
                parentChannelId: recipientAddress,
              },
            }
          : {}),
      };

      // Optimistically add to cache FIRST (before storage) for instant UI feedback
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

      // Defer storage save to next microtask so UI updates instantly
      // The message will persist after the cache update is reflected
      queueMicrotask(() => {
        storage.saveMessage(
          optimisticMessage,
          createdDate,
          recipientAddress,
          'direct',
          '',
          ''
        ).catch((e) => {});
      });

      return { previousData, optimisticMessage };
    },

    onError: async (err, { conversationId, recipientAddress }, context) => {
      const me = (user?.address ?? 'unknown').slice(0, 8);
      logger.debug(
        `[DM-send ${me}] MUTATION FAILED conv=${conversationId.slice(0, 24)} recipient=${recipientAddress.slice(0, 12)}:`,
        err instanceof Error ? err.message : err,
      );
      // Mark the optimistic message as failed in cache
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

        // Also update storage with failed status
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

      // Attach the real signature/publicKey to the optimistic bubble (it had
      // neither) so signed messages don't show the unsigned-warning icon. Do
      // NOT mark it 'sent' here — at this point the message is only QUEUED; the
      // onFlushed callback flips it to 'sent' when it actually transmits. Spread
      // the CURRENT cached message so we never clobber a 'sent' the flush may
      // already have applied (race-safe). With aligned ids, the sent message
      // and the optimistic bubble share one messageId.
      const optimisticId = context?.optimisticMessage.messageId;
      if (optimisticId) {
        queryClient.setQueryData<InfiniteMessagesData>(key, (old) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              messages: page.messages.map((m) =>
                m.messageId === optimisticId
                  ? { ...m, signature: message.signature, publicKey: message.publicKey }
                  : m
              ),
            })),
          };
        });
      }

      // Defer storage writes so UI updates instantly
      queueMicrotask(async () => {
        try {
          // Persist WITHOUT the ephemeral sendStatus so a reload renders the
          // message normally instead of restoring a stale 'sending' spinner.
          const persisted: Message = context?.optimisticMessage
            ? {
                ...context.optimisticMessage,
                signature: message.signature,
                publicKey: message.publicKey,
              }
            : { ...message };
          delete (persisted as Record<string, unknown>).sendStatus;

          await storage.saveMessage(
            persisted,
            persisted.createdDate,
            recipientAddress,
            'direct',
            '',
            ''
          );

          // Update conversation timestamp and preview
          const conversation = await storage.getConversation(conversationId);
          if (conversation) {
            // Extract text from message content
            const content = message.content as any;
            const previewText = Array.isArray(content?.text)
              ? content.text.join('')
              : content?.text || '';
            await storage.saveConversation({
              ...conversation,
              timestamp: message.createdDate,
              lastMessageId: message.messageId,
              lastMessagePreview: previewText,
              lastMessageSenderName: 'You',
            } as any);
          }
        } catch {
          // Storage write failed — message is already in cache via optimistic update
        }
      });

      // Invalidate conversations list to update timestamp
      queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.all('direct'),
      });
    },

    // No onSettled invalidate. Trust the optimistic cache + per-handler
    // disk writes. A refetch here would race with SQLite reads that can
    // be transiently empty (cold cipher-key cache, migration in flight)
    // and wipe in-flight messages from the visible state.
  });
}

async function sendEncryptedMessage(
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
  const { NativeCryptoProvider } = await import(
    '@/services/crypto/native-provider'
  );
  const cryptoProvider = new NativeCryptoProvider();

  let conversationInboxAddress: string | null = null;
  let conversationInboxKeypair: { public_key: number[]; private_key: number[] } | null = null;
  let conversationSigningKeypair: { public_key: number[]; private_key: number[] } | null = null;

  if (recipientInfo) {
    // X448 for encryption, Ed448 for signing — address derives from the
    // Ed448 key to match device inbox derivation and allow signature
    // verification of inbox operations.
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

    // Subscribe BEFORE sending so the reply arrives on a listening socket.
    await subscribe([conversationInboxAddress]);
  }

  enqueueOutbound(async () => {
    const outbounds: string[] = [];

    if (recipientInfo && conversationInboxAddress && conversationInboxKeypair) {
      // First message: DR-encrypt and wrap in an InitializationEnvelope with
      // the return inbox info. ephemeral_public_key lives at the SealedMessage
      // top level (not in the envelope) and is reused for both sealing and
      // X3DH session establishment.
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

      // return_inbox_{public,private}_key carry the Ed448 signing keys, not
      // the X448 encryption keys.
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
        // SDK-standard tag: the SENDER'S DEVICE INBOX (the session identity
        // the receiver files this session under). Previously mobile sent the
        // return conversation inbox here, so peers filed our sessions under
        // an address absent from every device-registration list — desktop's
        // ghost-session prune then deleted them on every send.
        tag: deviceKeyset.inboxAddress,
        message: encrypted.envelope,
        type: 'direct',
      };

      const textEncoder = new TextEncoder();
      const envelopeBytes = Array.from(textEncoder.encode(JSON.stringify(initEnvelope)));

      const ephemeralPrivateKey = encrypted.ephemeralPrivateKey;
      if (!ephemeralPrivateKey || ephemeralPrivateKey.length === 0) {
        throw new Error('X3DH ephemeral private key not returned from encryption');
      }

      const ephemeralPrivateKeyBytes = ephemeralPrivateKey;

      const sealedEnvelope = await cryptoProvider.encryptInboxMessage({
        inbox_public_key: recipientInfo.inboxEncryptionKey,
        ephemeral_private_key: ephemeralPrivateKeyBytes,
        plaintext: envelopeBytes,
      });

      const ephemeralPublicKeyHex = x3dhEphemeralKeyHex;

      const sealedMessage = {
        type: 'direct',
        inbox_address: inboxAddress,
        ephemeral_public_key: ephemeralPublicKeyHex,
        envelope: sealedEnvelope,
        inbox_public_key: '',
        inbox_signature: '',
      };

      outbounds.push(JSON.stringify(sealedMessage));
    } else {
      // === EXISTING SESSION: Subsequent message ===
      // Use latestState to find the correct encryption state
      // This is the authoritative source for which inbox has the current session
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

      // Step 1: Double Ratchet encrypt using state from latestState
      const encrypted = await encryptWithExistingSession(
        conversationId,
        latestState.inboxId,
        JSON.stringify(message)
      );

      // Check if we have sendingInbox info for proper sealing
      const sendingInbox = encryptionState.sendingInbox;
      const needsInitEnvelope = !sendingInbox || sendingInbox.inbox_public_key === '';

      if (needsInitEnvelope && sendingInbox?.inbox_encryption_key) {
        // Session not yet confirmed: rewrap in an InitializationEnvelope.
        const ourConversationInbox = encryptionStateStorage.getConversationInboxKeypair(conversationId);

        // Reuse the X3DH ephemeral key from session establishment so the
        // receiver derives the matching session key. A fresh ephemeral
        // would make DR-decrypt fail.
        let ephemeralPrivateKeyBytes: number[];
        let ephemeralPublicKeyHex: string;

        if (encryptionState.x3dhEphemeralPublicKey && encryptionState.x3dhEphemeralPrivateKey) {
          ephemeralPublicKeyHex = encryptionState.x3dhEphemeralPublicKey;
          ephemeralPrivateKeyBytes = hexToBytes(encryptionState.x3dhEphemeralPrivateKey);
        } else {
          // Fallback for sessions created before ephemeral-key storage was
          // added — generate one and persist for future messages.
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
          // SDK-standard tag: sender's device inbox (see first-send builder).
          tag: deviceKeyset.inboxAddress,
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
        // Confirmed session: send to the recipient's per-conversation inbox.
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
        const existingSessionMsg = {
          type: 'direct',
          inbox_address: sendingInbox.inbox_address,
          envelope: sealedEnvelope,
          ephemeral_public_key: bytesToHex(sealingEphemeralKey.public_key),
          inbox_public_key: inboxAuth.inbox_public_key,
          inbox_signature: inboxAuth.inbox_signature,
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
 * Send an encrypted message to ALL target device inboxes
 *
 * This handles multi-device support by:
 * 1. Collecting all target inboxes (recipient's devices + sender's other devices)
 * 2. For each inbox, checking if we have an existing session
 * 3. Creating new sessions for new inboxes, using existing sessions for known ones
 * 4. Enqueueing all encrypted messages together
 */
export async function sendEncryptedMessageToAllDevices(
  conversationId: string,
  recipientAddress: string,
  message: Message,
  allTargetDevices: Array<{
    identityKey: number[];
    signedPreKey: number[];
    inboxAddress: string;
    inboxEncryptionKey: number[];
  }>,
  enqueueOutbound: (prepareMessage: () => Promise<string[]>) => void,
  subscribe: (inboxAddresses: string[]) => Promise<void>,
  deviceKeyset: {
    identityPublicKey: number[];
    inboxAddress: string;
    inboxEncryptionPublicKey: number[];
  },
  userAddress: string,
  displayName?: string,
  onFlushed?: () => void
): Promise<void> {
  // Import the NativeCryptoProvider for encryption
  const { NativeCryptoProvider } = await import('@/services/crypto/native-provider');
  const cryptoProvider = new NativeCryptoProvider();

  // Get all existing encryption states for this conversation
  const existingStates = encryptionStateStorage.getEncryptionStates(conversationId);

  // Ghost-session prune (SDK/desktop parity): drop TAGGED rows whose tag no
  // longer corresponds to any registered device inbox (stale devices, plus
  // legacy rows tagged with conversation-inbox addresses from before the
  // SDK-standard tag fix). Tagless rows are left alone. Skipped when the
  // device list is empty so a failed registration fetch can't wipe healthy
  // sessions.
  if (allTargetDevices.length > 0) {
    const validInboxes = new Set(allTargetDevices.map((d) => d.inboxAddress));
    for (const s of existingStates) {
      if (s.tag && !validInboxes.has(s.tag)) {
        encryptionStateStorage.deleteEncryptionState(conversationId, s.inboxId);
      }
    }
  }

  // Determine which devices need new sessions vs existing sessions
  const devicesNeedingNewSession: typeof allTargetDevices = [];
  const devicesWithExistingSession: Array<{
    device: typeof allTargetDevices[0];
    state: ReturnType<typeof encryptionStateStorage.getEncryptionState>;
  }> = [];

  for (const device of allTargetDevices) {
    // Skip our own current device inbox
    if (device.inboxAddress === deviceKeyset.inboxAddress) {
      continue;
    }

    // Check if we have an existing session for this device's inbox (by tag).
    // Several rows can share a tag (e.g. a session created by RECEIVING the
    // peer's message — born send-ready with their full return-inbox keys —
    // alongside an older self-initiated one still waiting for confirmation).
    // Prefer the send-ready row: it skips the init-envelope wrapping
    // entirely.
    const tagMatches = existingStates.filter((s) => s.tag === device.inboxAddress);
    const existingState =
      tagMatches.find((s) => s.sendingInbox?.inbox_public_key) ?? tagMatches[0];
    if (existingState) {
      devicesWithExistingSession.push({ device, state: existingState });
    } else {
      devicesNeedingNewSession.push(device);
    }
  }

  // For new sessions, generate conversation inbox keypairs BEFORE enqueuing
  // so we can properly subscribe to them
  // Generate all keypairs in parallel for better performance
  const newSessionPrepData = await Promise.all(
    devicesNeedingNewSession.map(async (device) => {
      // Generate X448 for encryption, Ed448 for signing - in parallel
      const [conversationInboxKeypair, conversationSigningKeypair] = await Promise.all([
        cryptoProvider.generateX448(),
        cryptoProvider.generateEd448(),
      ]);
      // Derive address from Ed448 signing key
      const conversationInboxAddress = deriveAddress(new Uint8Array(conversationSigningKeypair.public_key));

      // Store the conversation inbox keypair
      const storedKeypair: ConversationInboxKeypair = {
        conversationId,
        inboxAddress: conversationInboxAddress,
        encryptionPublicKey: conversationInboxKeypair.public_key,
        encryptionPrivateKey: conversationInboxKeypair.private_key,
        signingPublicKey: conversationSigningKeypair.public_key,
        signingPrivateKey: conversationSigningKeypair.private_key,
      };
      encryptionStateStorage.saveConversationInboxKeypair(storedKeypair);

      // Save inbox mapping
      encryptionStateStorage.saveInboxMapping(conversationInboxAddress, conversationId);

      return {
        device,
        conversationInboxAddress,
        conversationInboxKeypair,
        conversationSigningKeypair,
      };
    })
  );

  // Subscribe to all conversation inboxes in parallel
  const inboxAddresses = newSessionPrepData.map((p) => p.conversationInboxAddress);
  if (inboxAddresses.length > 0) {
    await subscribe(inboxAddresses);
  }

  // Enqueue all outbound messages
  enqueueOutbound(async () => {
    const outbounds: string[] = [];

    // === Handle new sessions ===
    for (const prep of newSessionPrepData) {
      const { device, conversationInboxAddress, conversationInboxKeypair, conversationSigningKeypair } = prep;

      // Encrypt with Double Ratchet using the new device method
      // This forces a new session to be established for this specific device
      const encrypted = await encryptionService.encryptMessageForNewDevice(
        conversationId,
        {
          address: recipientAddress,
          identityKey: device.identityKey,
          signedPreKey: device.signedPreKey,
          inboxAddress: device.inboxAddress,
          inboxEncryptionKey: device.inboxEncryptionKey,
        },
        JSON.stringify(message),
        conversationInboxAddress,
        device.inboxAddress  // Use device's inbox as the tag
      );

      // Get X3DH ephemeral key
      const x3dhEphemeralKey = encrypted.ephemeralPublicKey;
      if (!x3dhEphemeralKey || x3dhEphemeralKey.length === 0) {
        continue;
      }

      const x3dhEphemeralKeyBytes = Array.isArray(x3dhEphemeralKey) ? x3dhEphemeralKey : hexToBytes(x3dhEphemeralKey);
      const x3dhEphemeralKeyHex = Array.isArray(x3dhEphemeralKey) ? bytesToHex(x3dhEphemeralKey) : x3dhEphemeralKey;

      // Build InitializationEnvelope
      const initEnvelope: InitializationEnvelope = {
        user_address: userAddress,
        display_name: displayName || userAddress,
        return_inbox_address: conversationInboxAddress,
        return_inbox_encryption_key: bytesToHex(conversationInboxKeypair.public_key),
        return_inbox_public_key: bytesToHex(conversationSigningKeypair.public_key),
        return_inbox_private_key: bytesToHex(conversationSigningKeypair.private_key),
        identity_public_key: bytesToHex(deviceKeyset.identityPublicKey),
        // SDK-standard tag: sender's device inbox — the identity the
        // receiver files this session under (previously the conversation
        // inbox, which peers' device lists never contain).
        tag: deviceKeyset.inboxAddress,
        message: encrypted.envelope,
        type: 'direct',
      };

      // Seal with recipient's inbox encryption key
      const textEncoder = new TextEncoder();
      const envelopeBytes = Array.from(textEncoder.encode(JSON.stringify(initEnvelope)));

      const ephemeralPrivateKey = encrypted.ephemeralPrivateKey;
      if (!ephemeralPrivateKey || ephemeralPrivateKey.length === 0) {
        continue;
      }

      const sealedEnvelope = await cryptoProvider.encryptInboxMessage({
        inbox_public_key: device.inboxEncryptionKey,
        ephemeral_private_key: ephemeralPrivateKey,
        plaintext: envelopeBytes,
      });

      const sealedMessage = {
        type: 'direct',
        inbox_address: device.inboxAddress,
        ephemeral_public_key: x3dhEphemeralKeyHex,
        envelope: sealedEnvelope,
        inbox_public_key: '',
        inbox_signature: '',
      };

      outbounds.push(JSON.stringify(sealedMessage));
    }

    // === Handle existing sessions ===
    for (const { device, state } of devicesWithExistingSession) {
      if (!state) continue;

      // Validate state has required fields
      if (!state.inboxId || !state.state) {
        continue;
      }

      // Check if session is confirmed or needs InitializationEnvelope
      const sendingInbox = state.sendingInbox;
      const needsInitEnvelope = !sendingInbox || sendingInbox.inbox_public_key === '';

      if (needsInitEnvelope && sendingInbox?.inbox_encryption_key) {
        // CRITICAL: Unconfirmed session means the receiver never got our previous messages
        // or never acknowledged them. We need to send as a NEW session so the receiver
        // can do X3DH and derive the same initial ratchet state.
        //
        // If we use the existing (advanced) ratchet state, the receiver will do X3DH
        // to get the initial state, and won't be able to decrypt our message.
        //
        // Treat this like devicesNeedingNewSession - establish a fresh X3DH session.

        // Get or create conversation inbox for this device
        let convInboxAddress: string;
        let convInboxKeypair: { public_key: number[]; private_key: number[] };
        let convSigningKeypair: { public_key: number[]; private_key: number[] };

        const existingConvInbox = encryptionStateStorage.getConversationInboxKeypair(conversationId);
        if (existingConvInbox) {
          convInboxAddress = existingConvInbox.inboxAddress;
          convInboxKeypair = {
            public_key: existingConvInbox.encryptionPublicKey,
            private_key: existingConvInbox.encryptionPrivateKey,
          };
          convSigningKeypair = {
            public_key: existingConvInbox.signingPublicKey,
            private_key: existingConvInbox.signingPrivateKey,
          };
        } else {
          // Generate new conversation inbox
          convInboxKeypair = await cryptoProvider.generateX448();
          convSigningKeypair = await cryptoProvider.generateEd448();
          convInboxAddress = deriveAddress(new Uint8Array(convSigningKeypair.public_key));

          const storedKeypair: ConversationInboxKeypair = {
            conversationId,
            inboxAddress: convInboxAddress,
            encryptionPublicKey: convInboxKeypair.public_key,
            encryptionPrivateKey: convInboxKeypair.private_key,
            signingPublicKey: convSigningKeypair.public_key,
            signingPrivateKey: convSigningKeypair.private_key,
          };
          encryptionStateStorage.saveConversationInboxKeypair(storedKeypair);
          encryptionStateStorage.saveInboxMapping(convInboxAddress, conversationId);
        }

        // Force a new X3DH session for this device
        const encrypted = await encryptionService.encryptMessageForNewDevice(
          conversationId,
          {
            address: recipientAddress,
            identityKey: device.identityKey,
            signedPreKey: device.signedPreKey,
            inboxAddress: device.inboxAddress,
            inboxEncryptionKey: device.inboxEncryptionKey,
          },
          JSON.stringify(message),
          convInboxAddress,
          device.inboxAddress  // Tag with device inbox
        );

        const x3dhEphemeralKey = encrypted.ephemeralPublicKey;
        if (!x3dhEphemeralKey || x3dhEphemeralKey.length === 0) {
          continue;
        }

        const x3dhEphemeralKeyHex = Array.isArray(x3dhEphemeralKey) ? bytesToHex(x3dhEphemeralKey) : x3dhEphemeralKey;

        const initEnvelope: InitializationEnvelope = {
          user_address: userAddress,
          display_name: displayName || userAddress,
          return_inbox_address: convInboxAddress,
          return_inbox_encryption_key: bytesToHex(convInboxKeypair.public_key),
          return_inbox_public_key: bytesToHex(convSigningKeypair.public_key),
          return_inbox_private_key: bytesToHex(convSigningKeypair.private_key),
          identity_public_key: bytesToHex(deviceKeyset.identityPublicKey),
          // SDK-standard tag: sender's device inbox (see first-send builder).
          tag: deviceKeyset.inboxAddress,
          message: encrypted.envelope,
          type: 'direct',
        };

        const textEncoder = new TextEncoder();
        const envelopeBytes = Array.from(textEncoder.encode(JSON.stringify(initEnvelope)));

        const ephemeralPrivateKey = encrypted.ephemeralPrivateKey;
        if (!ephemeralPrivateKey || ephemeralPrivateKey.length === 0) {
          continue;
        }

        const sealedEnvelope = await cryptoProvider.encryptInboxMessage({
          inbox_public_key: device.inboxEncryptionKey,
          ephemeral_private_key: ephemeralPrivateKey,
          plaintext: envelopeBytes,
        });

        const sealedMessage = {
          type: 'direct',
          inbox_address: device.inboxAddress,
          ephemeral_public_key: x3dhEphemeralKeyHex,
          envelope: sealedEnvelope,
          inbox_public_key: '',
          inbox_signature: '',
        };

        outbounds.push(JSON.stringify(sealedMessage));
      } else if (sendingInbox?.inbox_address && sendingInbox?.inbox_encryption_key) {
        // Confirmed session - encrypt with existing session and send directly
        const encrypted = await encryptWithExistingSession(
          conversationId,
          state.inboxId,
          JSON.stringify(message)
        );

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
        const existingSessionMsg = {
          type: 'direct',
          inbox_address: sendingInbox.inbox_address,
          envelope: sealedEnvelope,
          ephemeral_public_key: bytesToHex(sealingEphemeralKey.public_key),
          inbox_public_key: inboxAuth.inbox_public_key,
          inbox_signature: inboxAuth.inbox_signature,
        };

        outbounds.push(JSON.stringify(existingSessionMsg));
      }
    }

    // Reached only inside the outbound-queue drain, which runs only when the
    // socket is OPEN — the honest "actually transmitting" moment.
    onFlushed?.();
    return outbounds;
  });
}

/**
 * Encrypt a message using an existing session
 */
async function encryptWithExistingSession(
  conversationId: string,
  inboxAddress: string,
  plaintext: string
): Promise<{ envelope: string; ephemeralPublicKey: string }> {
  return ratchetMutex.runExclusive(conversationId, async () => {
  const encryptionState = encryptionStateStorage.getEncryptionState(
    conversationId,
    inboxAddress
  );

  if (!encryptionState) {
    throw new Error('No encryption state found');
  }

  if (!encryptionState.state) {
    throw new Error('Encryption state has no ratchet state');
  }

  // Use the encryption service's internal encrypt method
  // Since we have an existing session, we don't need recipient info
  const textEncoder = new TextEncoder();
  const messageBytes = Array.from(textEncoder.encode(plaintext));

  // Import the NativeCryptoProvider directly for this operation
  const { NativeCryptoProvider } = await import(
    '@/services/crypto/native-provider'
  );
  const cryptoProvider = new NativeCryptoProvider();

  // Extract ephemeral public key from the ratchet state
  // The ratchet_state contains sending_ephemeral_private_key which we need to derive the public key from
  // Parse the ratchet state (it's always stored as a JSON string)
  let ratchetState: Record<string, unknown>;

  // Check for corrupted state
  let stateStr = encryptionState.state;
  if (stateStr === '[object Object]') {
    throw new Error(`Corrupted encryption state: ${stateStr.substring(0, 50)}`);
  }
  // Handle double-escaped JSON (starts with {\" which appears as {\\ in JS)
  // This happens when JSON was stringified twice
  if (stateStr.includes('\\"') || stateStr.includes('\\\\')) {
    // Unescape: \" -> " and \\ -> \
    stateStr = stateStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (!stateStr.startsWith('{')) {
    throw new Error(`Corrupted encryption state: ${stateStr.substring(0, 50)}`);
  }
  ratchetState = JSON.parse(stateStr) as Record<string, unknown>;
  const sendingEphemeralPrivateKey = ratchetState.sending_ephemeral_private_key as string | number[];

  // The key is stored as base64 string in the ratchet state
  // If it's somehow a byte array, convert it
  const privateKeyBase64 = typeof sendingEphemeralPrivateKey === 'string'
    ? sendingEphemeralPrivateKey
    : btoa(String.fromCharCode(...sendingEphemeralPrivateKey));

  // Get the public key from the private key (expects base64, returns base64)
  const publicKeyBase64 = await cryptoProvider.getPublicKeyX448(privateKeyBase64);

  // Convert base64 result to hex for the message
  const publicKeyBytes = atob(publicKeyBase64);
  const ephemeralPublicKey = Array.from(publicKeyBytes)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');

  // Pass the properly parsed state to the native module
  // The native module will handle it as an object (we fixed native-provider to parse strings)
  const result = await cryptoProvider.doubleRatchetEncrypt({
    ratchet_state: JSON.stringify(ratchetState), // Re-stringify the parsed state to ensure clean JSON
    message: messageBytes,
  });

  // Save updated state - preserve sendingInbox, tag, AND the X3DH ephemeral
  // keys (an unconfirmed session re-wraps each message reusing them;
  // dropping them here forced a fresh ephemeral next send and a receiver
  // ephemeral-cache miss).
  // The inboxAddress is OUR receiving inbox (not where we send TO)
  encryptionStateStorage.saveEncryptionState({
    state: result.ratchet_state,
    timestamp: Date.now(),
    conversationId,
    inboxId: inboxAddress, // Our receiving inbox
    sentAccept: encryptionState.sentAccept,
    sendingInbox: encryptionState.sendingInbox, // Preserve where to send
    tag: encryptionState.tag,
    x3dhEphemeralPublicKey: encryptionState.x3dhEphemeralPublicKey,
    x3dhEphemeralPrivateKey: encryptionState.x3dhEphemeralPrivateKey,
  }, true);

  return { envelope: result.envelope, ephemeralPublicKey };
  });
}

/**
 * Hook to get query key for direct messages
 * Use with useMessages or custom query
 */
export function useDirectMessagesKey(recipientAddress: string | undefined) {
  return recipientAddress ? queryKeys.messages.infinite(recipientAddress, recipientAddress) : null;
}
