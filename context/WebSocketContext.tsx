/**
 * WebSocketContext - Manages WebSocket connection for E2E encrypted messaging
 *
 * Provides:
 * - WebSocket connection management (connect, reconnect, disconnect)
 * - Encrypted message sending via enqueueOutbound
 * - Incoming message handling with decryption
 * - Inbox subscription management
 */

import {
  bytesToHex,
  canManageReadOnlyChannel,
  createChannelPermissionChecker,
  createRNWebSocketClient,
  int64ToBytes,
  logger,
  queryKeys,
} from '@quilibrium/quorum-shared';
import { useQueryClient } from '@tanstack/react-query';
import { PERSISTABLE_TYPES } from '@/components/Chat/types';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, AppState, AppStateStatus, InteractionManager } from 'react-native';

import type { Conversation } from '@/hooks/chat/useConversations';
import { recordSpaceActivity } from '@/hooks/chat/useSpaceActivity';
import { logMentionOrReply } from '@/services/notifications/logMentionOrReply';
import { shouldNotifyForContext } from '@/services/notifications/notificationPrefs';
import { messagePreview as getSpaceMessagePreview, messageSenderName } from '@/utils/messagePreview';
import { applyReceivedEdit } from '@/utils/editHistory';
import { sha256 } from '@noble/hashes/sha2.js';
import type {
  Channel,
  EncryptedWebSocketMessage,
  KickMessage,
  Message,
  MuteMessage,
  RemoveMessage,
  SealedMessage,
  Space,
  SpaceMember,
  UnsealedEnvelope,
  WebSocketClient,
  WebSocketConnectionState,
} from '@quilibrium/quorum-shared';
import { getQuorumClient } from '../services/api/quorumClient';
import { getAllSpaceInboxAddresses, getInboxToSpaceMap, getSpace, getSpaceByHubAddress, getSpaceIds, getSpaceKey, saveSpace, saveSpaceKey } from '../services/config/spaceStorage';
import { encryptionService } from '../services/crypto/encryption-service';
import { encryptionStateStorage, type ConversationInboxKeypair } from '../services/crypto/encryption-state-storage';
import { NativeCryptoProvider, SyncSealedMessage, type BatchSpaceGroup, type BatchSpaceMessage, type BatchProcessInput, type BatchProcessOutput, type BatchSpaceGroupResult, type BatchDMGroup, type BatchDMMessage, type BatchDRState } from '../services/crypto/native-provider';
import { NativeSigningProvider } from '../services/crypto/native-signing-provider';
import { mmkvStorage } from '../services/offline/storage';
import { getDeviceKeyset, type DeviceKeyset } from '../services/onboarding/secureStorage';
import {
  clearSentEnvelope,
  isSentEnvelope,
} from '../services/space/spaceMessageService';
import {
  hasMuteId,
  isUserMuted as isModMutedUser,
  markMuteIdSeen,
  removeMute as removeModMute,
  setMute as setModMute,
} from '../services/space/modMuteStorage';
import { buildListenHubFrame, buildLogSinceFrame } from '../services/space/hubLogSync';
import { getHubLastSeq, setHubLastSeq } from '../services/space/hubLogCursor';
import { getMMKVAdapter } from '../services/storage/mmkvAdapter';
import { useAuth } from './AuthContext';
import { useStorageAdapter } from './StorageContext';

import { getApiConfig } from '../services/api/config';

import type { MessagesPage, InfiniteMessagesData } from '../hooks/chat/queryTypes';

interface WebSocketContextValue {
  // Connection state
  connectionState: WebSocketConnectionState;
  isConnected: boolean;

  // Actions
  connect: () => Promise<void>;
  disconnect: () => void;

  // Message sending
  enqueueOutbound: (prepareMessage: () => Promise<string[]>) => void;

  // Inbox subscriptions
  subscribe: (inboxAddresses: string[]) => Promise<void>;
  unsubscribe: (inboxAddresses: string[]) => Promise<void>;

  // Kick events - space ID that user was kicked from, null when acknowledged
  kickedFromSpaceId: string | null;
  clearKickedFromSpace: () => void;

  // Call signaling — CallContext registers a handler to receive decrypted call messages
  registerCallSignalingHandler: (handler: (message: any) => void) => () => void;

  // Per-space log transport — register to receive log-update / log-since-result / log-append-ack frames
  registerLogFrameHandler: (handler: (frame: LogFrame) => void) => () => void;
}

export type LogEntryFrame = {
  seq: number;
  ts: number;
  payload: { ts: number; data: any };
};

export type LogFrame =
  | { type: 'log-update'; hub_address: string; seq: number; ts: number }
  | { type: 'log-append-ack'; hub_address: string; seq: number; ts: number; request_id?: string }
  | {
      type: 'log-since-result';
      hub_address: string;
      entries: LogEntryFrame[];
      has_more: boolean;
      request_id?: string;
    };

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

interface WebSocketProviderProps {
  children: React.ReactNode;
}

// Helper to get short user address for logging
function shortAddr(address: string | undefined): string {
  if (!address) return '???';
  return address.substring(0, 8);
}

/**
 * Delete messages from inbox after successful decryption
 * This prevents the same messages from being re-delivered on reconnect
 */
async function deleteInboxMessages(
  inboxAddress: string,
  timestamps: number[],
  deviceKeyset: DeviceKeyset
): Promise<void> {
  try {
    const cryptoProvider = new NativeCryptoProvider();

    // Build the message to sign: inbox_address + timestamps concatenated as strings
    const messageToSign = inboxAddress + timestamps.map(t => `${t}`).join('');
    const messageBytes = new TextEncoder().encode(messageToSign);

    // Convert private key to base64 for the native module
    const privateKeyBase64 = btoa(String.fromCharCode(...deviceKeyset.inboxSigningPrivateKey));
    const messageBase64 = btoa(String.fromCharCode(...messageBytes));

    // Sign with Ed448
    const signatureBase64 = await cryptoProvider.signEd448(privateKeyBase64, messageBase64);

    // Convert signature and public key to hex
    const signatureBytes = atob(signatureBase64);
    const signatureHex = Array.from(signatureBytes)
      .map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('');

    const publicKeyHex = deviceKeyset.inboxSigningPublicKey
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Call the API to delete messages
    const client = getQuorumClient();
    const deletePayload = {
      inbox_address: inboxAddress,
      timestamps,
      inbox_public_key: publicKeyHex,
      inbox_signature: signatureHex,
    };
    await client.deleteInboxMessages(deletePayload);
  } catch (error) {
    // Log but don't fail - message deletion is best-effort
  }
}

/**
 * Delete messages from a space inbox after successful processing
 * Uses the space's inbox key for signing (different from device inbox key)
 */
async function deleteSpaceInboxMessages(
  inboxAddress: string,
  timestamps: number[],
  inboxKey: { publicKey: string; privateKey: string }
): Promise<void> {
  try {
    const cryptoProvider = new NativeCryptoProvider();

    // Build the message to sign: inbox_address + timestamps concatenated as strings
    const messageToSign = inboxAddress + timestamps.map(t => `${t}`).join('');
    const messageBytes = new TextEncoder().encode(messageToSign);

    // Convert private key from hex to base64 for the native module
    const privateKeyBytes = hexToBytes(inboxKey.privateKey);
    const privateKeyBase64 = btoa(String.fromCharCode(...privateKeyBytes));
    const messageBase64 = btoa(String.fromCharCode(...messageBytes));

    // Sign with Ed448
    const signatureBase64 = await cryptoProvider.signEd448(privateKeyBase64, messageBase64);

    // Convert signature to hex
    const signatureBytes = atob(signatureBase64);
    const signatureHex = Array.from(signatureBytes)
      .map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('');

    // Call the API to delete messages
    const client = getQuorumClient();
    await client.deleteInboxMessages({
      inbox_address: inboxAddress,
      timestamps,
      inbox_public_key: inboxKey.publicKey,
      inbox_signature: signatureHex,
    });
  } catch (error) {
    // Log but don't fail - message deletion is best-effort
  }
}

/**
 * Delete messages from a conversation inbox after successful processing
 * Uses the conversation inbox's signing key (Ed448)
 */
async function deleteConversationInboxMessages(
  inboxAddress: string,
  timestamps: number[],
  signingKey: { publicKey: string; privateKey: string }
): Promise<void> {
  try {
    const cryptoProvider = new NativeCryptoProvider();

    // Build the message to sign: inbox_address + timestamps concatenated as strings
    const messageToSign = inboxAddress + timestamps.map(t => `${t}`).join('');
    const messageBytes = new TextEncoder().encode(messageToSign);

    // Convert private key from hex to base64 for the native module
    const privateKeyBytes = hexToBytes(signingKey.privateKey);
    const privateKeyBase64 = btoa(String.fromCharCode(...privateKeyBytes));
    const messageBase64 = btoa(String.fromCharCode(...messageBytes));

    // Sign with Ed448
    const signatureBase64 = await cryptoProvider.signEd448(privateKeyBase64, messageBase64);

    // Convert signature to hex
    const signatureBytes = atob(signatureBase64);
    const signatureHex = Array.from(signatureBytes)
      .map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('');

    // Call the API to delete messages
    const client = getQuorumClient();
    await client.deleteInboxMessages({
      inbox_address: inboxAddress,
      timestamps,
      inbox_public_key: signingKey.publicKey,
      inbox_signature: signatureHex,
    });
  } catch (error) {
    // Log but don't fail - message deletion is best-effort
  }
}

/**
 * Unseal an initialization envelope using a conversation-specific inbox keypair
 * This is needed when we're the initiator and receive a reply on our conversation inbox
 */
/**
 * Result of unsealing a message at a conversation inbox
 * Content could be an InitializationEnvelope or a raw Double Ratchet envelope
 */
type UnsealedContent =
  | { type: 'init'; envelope: UnsealedEnvelope }
  | { type: 'dr'; envelope: string }; // DR envelope is just the JSON string

async function unsealWithConversationKeypair(
  sealedMessage: SealedMessage,
  keypair: ConversationInboxKeypair
): Promise<UnsealedContent> {
  const cryptoProvider = new NativeCryptoProvider();
  const textDecoder = new TextDecoder();

  // Parse the ephemeral public key from hex string to bytes
  const ephemeralPublicKey = hexToBytes(sealedMessage.ephemeral_public_key);

  // Parse the envelope (it's a MessageCiphertext JSON)
  let envelopeStr = sealedMessage.envelope;

  // If the envelope starts with a quote, it might be a quoted JSON string
  if (envelopeStr.startsWith('"') && envelopeStr.endsWith('"')) {
    envelopeStr = JSON.parse(envelopeStr) as string;
  }

  const ciphertext = JSON.parse(envelopeStr) as {
    ciphertext: string;
    initialization_vector: string;
    associated_data?: string;
  };

  // Decrypt using the conversation inbox private key
  const decryptedBytes = await cryptoProvider.decryptInboxMessage({
    inbox_private_key: keypair.encryptionPrivateKey,
    ephemeral_public_key: ephemeralPublicKey,
    ciphertext,
  });

  // Parse to check what type of content we received
  const decryptedString = textDecoder.decode(new Uint8Array(decryptedBytes));
  const parsed = JSON.parse(decryptedString) as Record<string, unknown>;

  // Check if this is a Double Ratchet envelope (has protocol_identifier)
  // or an InitializationEnvelope (has user_address)
  if ('protocol_identifier' in parsed) {
    // This is a raw Double Ratchet envelope
    return { type: 'dr', envelope: decryptedString };
  } else {
    // This is an InitializationEnvelope
    const envelope = parsed as unknown as UnsealedEnvelope;

    // If missing ephemeral_public_key, fall back to sealed message key
    if (!envelope.ephemeral_public_key) {
      envelope.ephemeral_public_key = sealedMessage.ephemeral_public_key;
    }

    return { type: 'init', envelope };
  }
}

/**
 * Convert hex string to byte array
 */
function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substr(i, 2), 16));
  }
  return bytes;
}

export function WebSocketProvider({ children }: WebSocketProviderProps) {
  const { isAuthenticated, user } = useAuth();
  const queryClient = useQueryClient();
  const storage = useStorageAdapter();

  // Use a ref for user address so callbacks always have the latest value
  const userAddrRef = useRef<string>('???');
  userAddrRef.current = shortAddr(user?.address);

  // Store full user address for comparison in callbacks (not shortened)
  const fullUserAddrRef = useRef<string | undefined>(undefined);
  fullUserAddrRef.current = user?.address;

  // Helper function to get current user address for logging
  const getAddr = () => userAddrRef.current;

  const [connectionState, setConnectionState] =
    useState<WebSocketConnectionState>('disconnected');

  // Track if user was kicked from a space - used by consumers to navigate away
  const [kickedFromSpaceId, setKickedFromSpaceId] = useState<string | null>(null);
  const clearKickedFromSpace = useCallback(() => setKickedFromSpaceId(null), []);

  // Call signaling handler — CallContext registers to intercept call-* messages
  const callSignalingHandlerRef = useRef<((message: any) => void) | null>(null);
  const registerCallSignalingHandler = useCallback((handler: (message: any) => void) => {
    callSignalingHandlerRef.current = handler;
    return () => { callSignalingHandlerRef.current = null; };
  }, []);

  // Per-space log frame handlers — multiple subscribers (one per useSpaceLog hook).
  const logFrameHandlersRef = useRef<Set<(frame: LogFrame) => void>>(new Set());
  const registerLogFrameHandler = useCallback((handler: (frame: LogFrame) => void) => {
    logFrameHandlersRef.current.add(handler);
    return () => { logFrameHandlersRef.current.delete(handler); };
  }, []);

  // WebSocket client instance (singleton for the app)
  const wsClientRef = useRef<WebSocketClient | null>(null);

  // Track subscribed inbox addresses
  const subscribedInboxesRef = useRef<Set<string>>(new Set());

  // Initialize device keys for encryption
  const deviceKeysInitialized = useRef(false);

  // Store our own inbox address for checking initialization messages
  const ownInboxAddressRef = useRef<string | null>(null);

  // Message queue for throttled processing - prevents CPU overload from burst messages
  const messageQueueRef = useRef<EncryptedWebSocketMessage[]>([]);
  const isProcessingQueueRef = useRef(false);
  const MESSAGE_PROCESS_DELAY_MS = 10; // 10ms delay between non-batch messages (brief yield to UI thread)
  const MAX_MESSAGE_QUEUE_SIZE = 2000;
  // Gate for verbose per-message / per-batch diagnostics. These build
  // JSON.stringify(batch.map(...)) payloads that are NEVER printed
  // (logger.debug sits below the logger's "log" minLevel), yet the
  // argument is always evaluated — so during a reconnect catch-up flood
  // they churn Hermes (native-heap) allocations for nothing. Flip to
  // true only when actively tracing the message pipeline.
  const WS_TRACE = false;
  // Max messages drained into a single batch per processMessageQueue
  // iteration. The queue can hold up to MAX_MESSAGE_QUEUE_SIZE; draining
  // it all at once builds the entire batchInput object + its
  // JSON.stringify in JS memory simultaneously (on top of the native
  // parse + results), which spikes peak RSS on a reconnect catch-up and
  // gets the foreground app OOM-killed by the kernel on small (≤2GB)
  // devices — a process SIGKILL, not a catchable java OOM. Draining in
  // bounded slices (the while loop just iterates more times, yielding
  // between drains so the prior slice's memory is reclaimed) keeps the
  // working set flat. Ordering/DR-state correctness is preserved: slices
  // stay FIFO and the native side re-reads ratchet state from MMKV
  // between calls.
  const MAX_BATCH_DRAIN_SIZE = 250;

  // Pre-unsealed payload cache - populated by batch native decryption in processMessageQueue
  // Key: `${inboxAddress}:${timestamp}`, Value: decrypted plaintext payload
  // This eliminates N JS-native bridge crossings for N space messages
  const preUnsealedCacheRef = useRef<Map<string, string>>(new Map());
  const MAX_PRE_UNSEALED_CACHE_SIZE = 500;

  // Ratchet state deserialization cache - avoids re-parsing JSON on every message
  // Key: raw state string, Value: parsed object
  const ratchetStateCacheRef = useRef<Map<string, object>>(new Map());
  const MAX_RATCHET_CACHE_SIZE = 200;

  /**
   * Parse ratchet state from a raw state string, using the cache to avoid
   * redundant JSON.parse calls. Handles the double-nested state structure.
   */
  const parseRatchetState = useCallback((rawState: string): object => {
    const cached = ratchetStateCacheRef.current.get(rawState);
    if (cached) return cached;

    const parsed = JSON.parse(rawState);
    const result = (parsed.state && typeof parsed.state === 'string')
      ? JSON.parse(parsed.state)
      : parsed;

    if (ratchetStateCacheRef.current.size >= MAX_RATCHET_CACHE_SIZE) {
      const firstKey = ratchetStateCacheRef.current.keys().next().value;
      if (firstKey) ratchetStateCacheRef.current.delete(firstKey);
    }
    ratchetStateCacheRef.current.set(rawState, result as object);
    return result;
  }, []);

  // Coalesce conversation-list refreshes. During a reconnect catch-up
  // thousands of DM messages would otherwise EACH fire an *active*
  // refetch of the conversation list (synchronous storage read + full
  // FlashList re-render). That per-message refetch was the launch-time
  // "redraw storm" — the bulk of the render-thread + ART churn that
  // pinned the native heap and got the app OOM-killed, even with no view
  // open (the initial route is the conversation list). Instead: collect
  // the touched conversation ids and invalidate the list + those details
  // at most once per debounce window, collapsing thousands of refetches
  // into a handful.
  const CONVERSATION_REFRESH_DEBOUNCE_MS = 400;
  const convRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingConvDetailIdsRef = useRef<Set<string>>(new Set());
  const scheduleConversationRefresh = useCallback((conversationId?: string) => {
    if (conversationId) pendingConvDetailIdsRef.current.add(conversationId);
    if (convRefreshTimerRef.current) return; // a flush is already scheduled
    convRefreshTimerRef.current = setTimeout(() => {
      convRefreshTimerRef.current = null;
      const ids = pendingConvDetailIdsRef.current;
      pendingConvDetailIdsRef.current = new Set();
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all('direct'), refetchType: 'active' });
      ids.forEach((id) =>
        queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(id), refetchType: 'active' }),
      );
    }, CONVERSATION_REFRESH_DEBOUNCE_MS);
  }, [queryClient]);

  // Receive side of DM profile sync. A `dm-update-profile` control message
  // carries a partner's GLOBAL profile change (displayName / userIcon / bio)
  // over the established DM session. It must NOT be persisted/rendered as a
  // chat post — it updates the conversation row in place. Shared by both DM
  // decrypt paths (handleIncomingMessage + applyDMGroupResults) so the two
  // intercepts can't drift. Returns true when it handled the message (caller
  // should stop processing it), false otherwise.
  const applyDmProfileUpdate = useCallback(
    async (decryptedMessage: Message, senderAddress: string): Promise<boolean> => {
      const content = decryptedMessage.content as
        | { type?: string; senderId?: string; displayName?: string; userIcon?: string; bio?: string }
        | undefined;
      if (content?.type !== 'dm-update-profile') return false;

      // Anti-spoof: the claimed senderId must match the cryptographically
      // authenticated envelope sender. On mismatch we still consume the
      // message (return true → never persisted as a post), just don't apply it.
      // Mirrors desktop's "return true even on mismatch".
      if (content.senderId && content.senderId !== senderAddress) {
        logger.warn('[DMProfile] dropped dm-update-profile with mismatched senderId', {
          claimed: content.senderId?.slice(0, 8),
          envelope: senderAddress.slice(0, 8),
        });
        return true;
      }

      // No DM row means no established conversation to update — drop silently.
      const conversationId = `${senderAddress}/${senderAddress}`;
      const existing = await storage.getConversation(conversationId);
      if (!existing) return true;

      // Merge: displayName/userIcon truthy-guarded (empty = leave), bio
      // `!== undefined` (empty string = deliberate clear). Same convention as
      // the space update-profile handler and desktop's handleDMProfileUpdate.
      const merged: Conversation = {
        ...existing,
        ...(content.displayName ? { displayName: content.displayName } : {}),
        ...(content.userIcon ? { icon: content.userIcon } : {}),
        ...(content.bio !== undefined ? { bio: content.bio } : {}),
      };
      await storage.saveConversation(merged);
      scheduleConversationRefresh(conversationId);
      return true;
    },
    [storage, scheduleConversationRefresh],
  );

  /**
   * Initialize device keys and set them in the encryption service
   */
  const initializeDeviceKeys = useCallback(async () => {
    if (deviceKeysInitialized.current) {
      // Verify keys are actually set
      const hasKeys = encryptionService.hasDeviceKeys();
      if (!hasKeys) {
        // Reset flag to force re-initialization
        deviceKeysInitialized.current = false;
      } else {
        return true;
      }
    }

    try {
      const keyset = await getDeviceKeyset();
      if (!keyset) {
        return false;
      }

      encryptionService.setDeviceKeys({
        identityPrivateKey: keyset.identityPrivateKey,
        identityPublicKey: keyset.identityPublicKey,
        preKeyPrivateKey: keyset.preKeyPrivateKey,
        preKeyPublicKey: keyset.preKeyPublicKey,
        inboxEncryptionPrivateKey: keyset.inboxEncryptionPrivateKey,
        inboxEncryptionPublicKey: keyset.inboxEncryptionPublicKey,
      });

      // Store our inbox address for checking init messages
      ownInboxAddressRef.current = keyset.inboxAddress;
      const me = user?.address?.slice(0, 8) ?? '???';
      logger.debug(
        `[DEVICE ${me}] ownInbox=${keyset.inboxAddress.slice(0, 16)}`,
      );

      deviceKeysInitialized.current = true;
      return true;
    } catch (error) {
      return false;
    }
  }, []);

  /**
   * Handle incoming encrypted WebSocket message
   *
   * Two paths:
   * 1. Message on OUR device inbox = initialization envelope from new sender
   *    → Unseal → Initialize recipient session → Get decrypted message
   * 2. Message on existing conversation inbox = subsequent message
   *    → Decrypt using existing session
   */
  const handleIncomingMessage = useCallback(
    async (message: EncryptedWebSocketMessage) => {
      try {
        if (!message.encryptedContent) {
          return;
        }

        // Parse the encrypted content as a SealedMessage
        const sealedMessage = JSON.parse(message.encryptedContent) as SealedMessage;

        // Check if message arrived on our device inbox
        const isOnDeviceInbox = message.inboxAddress === ownInboxAddressRef.current;

        // Check if this is a space inbox message
        const spaceInboxAddresses = getAllSpaceInboxAddresses();
        const isSpaceInbox = spaceInboxAddresses.includes(message.inboxAddress);

        if (isSpaceInbox) {

          // Find which space this inbox belongs to
          // Use O(1) lookup map instead of O(n) loop
          let inboxToSpaceMap: Map<string, string>;
          try {
            inboxToSpaceMap = getInboxToSpaceMap();
          } catch (e) {
            return;
          }

          try {

            // O(1) lookup instead of O(n) loop
            const spaceId = inboxToSpaceMap.get(message.inboxAddress) ?? null;
            let hubKey: { publicKey: string; privateKey: string; address?: string } | null = null;
            let spaceInboxKey: { publicKey: string; privateKey: string; address?: string } | null = null;

            if (spaceId) {
              hubKey = getSpaceKey(spaceId, 'hub');
              spaceInboxKey = getSpaceKey(spaceId, 'inbox');
            }

            if (!spaceId || !hubKey) {
              return;
            }

            if (!hubKey.privateKey) {
              return;
            }

            // Get config key for hub envelope decryption
            const configKey = getSpaceKey(spaceId, 'config');

            // Check pre-unsealed cache first (populated by batch native decryption)
            const cacheKey = `${message.inboxAddress}:${message.timestamp}`;
            let unsealedPayload: string;
            const cachedPayload = preUnsealedCacheRef.current.get(cacheKey);
            const cryptoProvider = new NativeCryptoProvider();

            if (cachedPayload) {
              // Use batch-decrypted result (avoids JS-native bridge crossing)
              unsealedPayload = cachedPayload;
              preUnsealedCacheRef.current.delete(cacheKey);
            } else {
              // Fallback: individual unseal (for messages not in batch)
              const outerEnvelopeType = (sealedMessage as { type?: string }).type;
              const hubPrivateKeyBytes = hexToBytes(hubKey.privateKey);

              if (outerEnvelopeType === 'sync') {
                const syncSealedMessage = sealedMessage as unknown as SyncSealedMessage;
                unsealedPayload = await cryptoProvider.unsealSyncEnvelope(
                  hubPrivateKeyBytes,
                  syncSealedMessage,
                  configKey ? Array.from(hexToBytes(configKey.privateKey)) : undefined
                );
              } else {
                const hubSealedMessage = sealedMessage as unknown as {
                  hub_address: string;
                  ephemeral_public_key: string;
                  envelope: string;
                  hub_public_key: string;
                  hub_signature: string;
                };
                unsealedPayload = await cryptoProvider.unsealHubEnvelope(
                  hubPrivateKeyBytes,
                  hubSealedMessage.ephemeral_public_key,
                  hubSealedMessage.envelope,
                  configKey ? hexToBytes(configKey.privateKey) : undefined
                );
              }
            }

            // Parse the unsealed payload - it should be { type: 'message', message: tripleRatchetEnvelope }
            const payload = JSON.parse(unsealedPayload) as {
              type: string;
              message: string | Message;
            };

            // Handle control messages (join, leave, kick, sync, etc.)
            if (payload.type === 'control') {
              const controlPayload = payload as unknown as {
                type: 'control';
                message: {
                  type: string;
                  participant?: unknown;
                  inboxPublicKey?: string;
                  inboxSignature?: string;
                  kick?: string;
                  peerMap?: { id_peer_map: unknown; peer_id_map: unknown };
                  manifest?: {
                    owner_public_key: string;
                    owner_signature: string;
                    space_manifest: string;
                    ephemeral_public_key: string;
                    timestamp: number;
                  };
                };
              };

              const controlType = controlPayload.message?.type;

              switch (controlType) {
                case 'join': {
                  // A new participant joined - update peer maps and member list
                  try {
                    const joinPayload = controlPayload.message as {
                      type: 'join';
                      participant: {
                        address: string;
                        id: number;
                        inboxAddress: string;
                        inboxPubKey: string;
                        pubKey: string;
                        inboxKey: string;
                        identityKey: string;
                        preKey: string;
                        userIcon?: string;
                        displayName?: string;
                      };
                      inboxPublicKey?: string;
                      inboxSignature?: string;
                    };

                    const participant = joinPayload.participant;
                    if (!participant) {
                      break;
                    }

                    // Skip if this is our own join message echoed back
                    if (participant.address === user?.address) {
                      break;
                    }

                    // Update the Triple Ratchet state with new peer
                    const spaceConversationId = `${spaceId}/${spaceId}`;
                    const encryptionStates = encryptionStateStorage.getEncryptionStates(spaceConversationId);

                    if (encryptionStates.length > 0) {
                      try {
                        const stateData = encryptionStates[0];
                        // Parse the nested state structure (outer parse needed for template/evals)
                        const parsed = JSON.parse(stateData.state);
                        const ratchetState = parseRatchetState(stateData.state) as Record<string, unknown>;

                        // Add new peer to peer_id_map (maps public key to ID)
                        if (!ratchetState.peer_id_map) {
                          ratchetState.peer_id_map = {};
                        }
                        // Convert hex pubKey to base64 for peer_id_map key
                        const pubKeyBytes = hexToBytes(participant.inboxKey);
                        const pubKeyBase64 = btoa(String.fromCharCode(...pubKeyBytes));
                        (ratchetState.peer_id_map as Record<string, number>)[pubKeyBase64] = participant.id;

                        // Add new peer to id_peer_map (maps ID to peer info)
                        if (!ratchetState.id_peer_map) {
                          ratchetState.id_peer_map = {};
                        }
                        // Convert hex keys to base64
                        const identityKeyBytes = hexToBytes(participant.identityKey);
                        const identityKeyBase64 = btoa(String.fromCharCode(...identityKeyBytes));
                        const preKeyBytes = hexToBytes(participant.preKey);
                        const preKeyBase64 = btoa(String.fromCharCode(...preKeyBytes));

                        (ratchetState.id_peer_map as Record<number, unknown>)[participant.id] = {
                          public_key: pubKeyBase64,
                          identity_public_key: identityKeyBase64,
                          signed_pre_public_key: preKeyBase64,
                        };

                        // Update dkg_ratchet total count
                        if (ratchetState.dkg_ratchet) {
                          const dkgRatchet = typeof ratchetState.dkg_ratchet === 'string'
                            ? JSON.parse(ratchetState.dkg_ratchet)
                            : ratchetState.dkg_ratchet;
                          dkgRatchet.total = Object.keys(ratchetState.peer_id_map as object).length;
                          ratchetState.dkg_ratchet = JSON.stringify(dkgRatchet);
                        }

                        // Save updated state - PRESERVE template and evals for invite generation!
                        let updatedState: string;
                        if (parsed.state) {
                          // Preserve template and evals from the original parsed structure
                          updatedState = JSON.stringify({
                            state: JSON.stringify(ratchetState),
                            template: parsed.template,
                            evals: parsed.evals,
                          });
                        } else {
                          updatedState = JSON.stringify(ratchetState);
                        }

                        encryptionStateStorage.saveEncryptionState({
                          ...stateData,
                          state: updatedState,
                          timestamp: Date.now(),
                        });
                        ratchetStateCacheRef.current.clear();

                        // CRITICAL: Also update fallback state with new peer
                        // The fallback state is used for decryption when the main state has evolved
                        // If the fallback doesn't have the new peer in peer_id_map, decryption fails with "Malformed header"
                        const fallbackState = encryptionStateStorage.getFallbackState(spaceConversationId, stateData.inboxId);
                        if (fallbackState) {
                          try {
                            const fallbackRatchetState = parseRatchetState(fallbackState.state) as Record<string, unknown>;

                            // Add new peer to fallback peer_id_map
                            if (!fallbackRatchetState.peer_id_map) {
                              fallbackRatchetState.peer_id_map = {};
                            }
                            (fallbackRatchetState.peer_id_map as Record<string, number>)[pubKeyBase64] = participant.id;

                            // Add new peer to fallback id_peer_map
                            if (!fallbackRatchetState.id_peer_map) {
                              fallbackRatchetState.id_peer_map = {};
                            }
                            (fallbackRatchetState.id_peer_map as Record<number, unknown>)[participant.id] = {
                              public_key: pubKeyBase64,
                              identity_public_key: identityKeyBase64,
                              signed_pre_public_key: preKeyBase64,
                            };

                            // Update fallback dkg_ratchet total count
                            if (fallbackRatchetState.dkg_ratchet) {
                              const fallbackDkgRatchet = typeof fallbackRatchetState.dkg_ratchet === 'string'
                                ? JSON.parse(fallbackRatchetState.dkg_ratchet)
                                : fallbackRatchetState.dkg_ratchet;
                              fallbackDkgRatchet.total = Object.keys(fallbackRatchetState.peer_id_map as object).length;
                              fallbackRatchetState.dkg_ratchet = JSON.stringify(fallbackDkgRatchet);
                            }

                            // Save updated fallback state
                            const fallbackOuter = JSON.parse(fallbackState.state);
                            const updatedFallbackState = (fallbackOuter.state && typeof fallbackOuter.state === 'string')
                              ? JSON.stringify({ state: JSON.stringify(fallbackRatchetState) })
                              : JSON.stringify(fallbackRatchetState);

                            encryptionStateStorage.saveFallbackState({
                              ...fallbackState,
                              state: updatedFallbackState,
                              timestamp: Date.now(),
                            });
                            ratchetStateCacheRef.current.clear();

                          } catch (fallbackUpdateError) {
                          }
                        }
                      } catch (peerMapError) {
                      }
                    }

                    // Save member to storage
                    const adapter = getMMKVAdapter();
                    await adapter.saveSpaceMember(spaceId, {
                      address: participant.address,
                      display_name: participant.displayName,
                      profile_image: participant.userIcon,
                      inbox_address: participant.inboxAddress,
                    });

                    // Update space members cache directly (member data available from join event)
                    queryClient.setQueryData(queryKeys.spaces.members(spaceId), (old: SpaceMember[] | undefined) => {
                      if (!old) return old;
                      if (old.some((m: SpaceMember) => m.address === participant.address)) {
                        return old.map((m: SpaceMember) =>
                          m.address === participant.address
                            ? { ...m, display_name: participant.displayName, profile_image: participant.userIcon, inbox_address: participant.inboxAddress }
                            : m
                        );
                      }
                      return [...old, {
                        address: participant.address,
                        display_name: participant.displayName,
                        profile_image: participant.userIcon,
                        inbox_address: participant.inboxAddress,
                      }];
                    });

                    // Save join event as a message (matches desktop behavior)
                    const space = getSpace(spaceId);
                    const channelId = space?.defaultChannelId || spaceId;
                    const joinMessageIdBytes = sha256(new TextEncoder().encode('join' + participant.inboxAddress));
                    const joinMessageId = bytesToHex(joinMessageIdBytes);
                    const now = Date.now();

                    const joinMessage: Message = {
                      channelId,
                      spaceId,
                      messageId: joinMessageId,
                      digestAlgorithm: 'SHA-256',
                      nonce: joinMessageId,
                      createdDate: now,
                      modifiedDate: now,
                      lastModifiedHash: '',
                      reactions: [],
                      mentions: { memberIds: [], roleIds: [], channelIds: [] },
                      content: {
                        senderId: participant.address,
                        type: 'join',
                      },
                    };

                    await adapter.saveMessage(joinMessage, now, '', '', '', '');
                    // Update cache directly instead of invalidating (avoids refetch)
                    const messagesKey = queryKeys.messages.infinite(spaceId, channelId);
                    queryClient.setQueryData<{ pages: { messages: Message[] }[]; pageParams: unknown[] }>(messagesKey, (old) => {
                      if (!old) return old;
                      return {
                        ...old,
                        pages: old.pages.map((page, index) => {
                          if (index === 0) {
                            return { ...page, messages: [...page.messages, joinMessage] };
                          }
                          return page;
                        }),
                      };
                    });
                  } catch (joinError) {
                  }
                  break;
                }

                case 'leave': {
                  // A participant left the space - mark their inbox as empty
                  try {
                    const leavePayload = controlPayload.message as {
                      type: 'leave';
                      participant?: { address: string };
                      address?: string;
                    };

                    const leavingAddress = leavePayload.participant?.address || leavePayload.address;
                    if (!leavingAddress) {
                      break;
                    }

                    // Update member in storage - set inbox_address to empty string to mark inactive
                    const adapter = getMMKVAdapter();
                    const existingMember = await adapter.getSpaceMember(spaceId, leavingAddress);
                    if (existingMember) {
                      await adapter.saveSpaceMember(spaceId, {
                        ...existingMember,
                        inbox_address: '', // Empty = left/inactive
                      });
                    }

                    // Update space members cache directly (mark member as inactive)
                    queryClient.setQueryData(queryKeys.spaces.members(spaceId), (old: SpaceMember[] | undefined) => {
                      if (!old) return old;
                      return old.map((m: SpaceMember) =>
                        m.address === leavingAddress
                          ? { ...m, inbox_address: '' }
                          : m
                      );
                    });
                  } catch (leaveError) {
                  }
                  break;
                }

                case 'kick': {
                  // A participant was kicked from the space
                  const kickedAddress = controlPayload.message.kick;

                  if (!kickedAddress) {
                    break;
                  }

                  try {
                    const adapter = getMMKVAdapter();

                    // Get our own address - try ref first, then MMKV storage as fallback
                    let ownAddress = fullUserAddrRef.current;
                    if (!ownAddress) {
                      // Fallback: get user address directly from MMKV storage (same as AuthContext)
                      try {
                        const storedUser = mmkvStorage.getItem('auth:user');
                        if (storedUser) {
                          const parsed = JSON.parse(storedUser);
                          ownAddress = parsed.address;
                        }
                      } catch {
                        // Storage/parse failure — ownAddress stays null
                      }
                    }

                    // Check if we are being kicked
                    if (ownAddress && kickedAddress === ownAddress) {
                      // Get space name for notification
                      const space = getSpace(spaceId);
                      const spaceName = space?.spaceName || 'this space';

                      // Show alert to user
                      Alert.alert(
                        'Kicked from Space',
                        `You've been kicked from ${spaceName}.`,
                        [{ text: 'OK' }]
                      );

                      // Unsubscribe from the space inbox immediately
                      const spaceInboxKey = getSpaceKey(spaceId, 'inbox');
                      const spaceInboxAddress = spaceInboxKey?.address;
                      if (spaceInboxAddress && wsClientRef.current) {
                        try {
                          await wsClientRef.current.unsubscribe([spaceInboxAddress]);
                          subscribedInboxesRef.current.delete(spaceInboxAddress);
                        } catch (unsubError) {
                        }
                      }

                      // Clean up local data for this space
                      try {
                        // 1. Clear encryption states
                        const spaceConversationId = `${spaceId}/${spaceId}`;
                        const states = encryptionStateStorage.getEncryptionStates(spaceConversationId);
                        for (const state of states) {
                          encryptionStateStorage.deleteEncryptionState(spaceConversationId, state.inboxId);
                        }

                        // 2. Update user config to remove space
                        const userConfig = await adapter.getUserConfig(ownAddress);
                        if (userConfig) {
                          const updatedConfig = {
                            ...userConfig,
                            spaceIds: userConfig.spaceIds.filter((id: string) => id !== spaceId),
                          };
                          await adapter.saveUserConfig(updatedConfig);
                        }

                        // 3. Delete the space (this clears space data including members)
                        await adapter.deleteSpace(spaceId);

                        // Invalidate active space queries (space was deleted from storage)
                        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all, refetchType: 'active' });

                        // Set kicked space ID so consumers can navigate away
                        setKickedFromSpaceId(spaceId);
                      } catch (cleanupError) {
                      }
                    } else {
                      // Someone else was kicked - mark them as kicked
                      const existingMember = await adapter.getSpaceMember(spaceId, kickedAddress);
                      if (existingMember) {
                        await adapter.saveSpaceMember(spaceId, {
                          ...existingMember,
                          inbox_address: '',
                          isKicked: true,
                        });
                      }
                    }

                    // Update space members cache directly (mark kicked member as inactive)
                    queryClient.setQueryData(queryKeys.spaces.members(spaceId), (old: SpaceMember[] | undefined) => {
                      if (!old) return old;
                      return old.map((m: SpaceMember) =>
                        m.address === kickedAddress
                          ? { ...m, inbox_address: '', isKicked: true }
                          : m
                      );
                    });
                  } catch (kickError) {
                  }
                  break;
                }

                // 'sync', 'sync-peer-map', 'sync-request', 'sync-info',
                // 'sync-initiate', 'sync-members', 'sync-messages',
                // 'sync-manifest', 'sync-delta' — sync handlers removed.
                // Catch-up is handled by the per-hub log transport
                // (`listen-hub` + `log-since`); peer-to-peer mesh sync is
                // gone. New joiners only see messages sent after they
                // joined.

                case 'verify-kicked': {
                  // Verify kicked status for users
                  try {
                    const verifyPayload = controlPayload.message as {
                      type: 'verify-kicked';
                      kickedAddresses?: string[];
                    };

                    if (verifyPayload.kickedAddresses && verifyPayload.kickedAddresses.length > 0) {
                      const adapter = getMMKVAdapter();
                      // Batch get and save in parallel for performance
                      const updatePromises = verifyPayload.kickedAddresses.map(async (address) => {
                        const member = await adapter.getSpaceMember(spaceId, address);
                        if (member) {
                          await adapter.saveSpaceMember(spaceId, {
                            ...member,
                            isKicked: true,
                            inbox_address: '',
                          });
                        }
                      });
                      await Promise.all(updatePromises);
                      // Update cache directly (mark kicked members as inactive)
                      const kickedSet = new Set(verifyPayload.kickedAddresses);
                      queryClient.setQueryData(queryKeys.spaces.members(spaceId), (old: SpaceMember[] | undefined) => {
                        if (!old) return old;
                        return old.map((m: SpaceMember) =>
                          kickedSet.has(m.address)
                            ? { ...m, isKicked: true, inbox_address: '' }
                            : m
                        );
                      });
                    }
                  } catch (verifyError) {
                  }
                  break;
                }

                case 'rekey': {
                  // Re-encryption after kick - update encryption state with new keys
                  try {
                    const rekeyPayload = controlPayload.message as {
                      type: 'rekey';
                      info?: string; // Inbox-sealed envelope containing new configKey and state
                      kick?: string; // Optional: user being kicked in this rekey
                    };

                    if (!rekeyPayload.info) {
                      break;
                    }

                    // Get device keyset for unsealing
                    const deviceKeyset = await getDeviceKeyset();
                    if (!deviceKeyset) {
                      break;
                    }
                    if (!deviceKeyset.inboxEncryptionPrivateKey || !Array.isArray(deviceKeyset.inboxEncryptionPrivateKey) || deviceKeyset.inboxEncryptionPrivateKey.length === 0) {
                      break;
                    }

                    // Parse the sealed info envelope (InboxSealedEnvelope structure)
                    const sealedEnvelope = JSON.parse(rekeyPayload.info) as {
                      inbox_public_key: string;
                      ephemeral_public_key: string;
                      envelope: string; // JSON containing { ciphertext, initialization_vector }
                    };

                    // Handle both new format (InboxSealedEnvelope) and legacy format
                    let ephemeralPubKey: string;
                    let ciphertext: { ciphertext: string; initialization_vector: string; associated_data?: string };

                    if (sealedEnvelope.envelope) {
                      // New InboxSealedEnvelope format
                      ephemeralPubKey = sealedEnvelope.ephemeral_public_key;
                      ciphertext = JSON.parse(sealedEnvelope.envelope);
                    } else {
                      // Legacy format (direct ciphertext fields)
                      const legacyInfo = sealedEnvelope as unknown as {
                        ephemeral_public_key: string;
                        ciphertext: string;
                        initialization_vector: string;
                        associated_data?: string;
                      };
                      ephemeralPubKey = legacyInfo.ephemeral_public_key;
                      ciphertext = {
                        ciphertext: legacyInfo.ciphertext,
                        initialization_vector: legacyInfo.initialization_vector,
                        associated_data: legacyInfo.associated_data,
                      };
                    }

                    // Validate required fields
                    if (!ephemeralPubKey || !ciphertext.ciphertext || !ciphertext.initialization_vector) {
                      break;
                    }

                    // Unseal using device inbox encryption key
                    const cryptoProvider = new NativeCryptoProvider();
                    const decryptedBytes = await cryptoProvider.decryptInboxMessage({
                      inbox_private_key: Array.from(deviceKeyset.inboxEncryptionPrivateKey),
                      ephemeral_public_key: hexToBytes(ephemeralPubKey),
                      ciphertext,
                    });

                    const innerEnvelope = JSON.parse(
                      new TextDecoder().decode(new Uint8Array(decryptedBytes))
                    ) as {
                      configKey: string; // New config private key (hex)
                      state: string;     // New Triple Ratchet template state (JSON)
                    };

                    // 1. Save the new config key
                    if (innerEnvelope.configKey) {
                      // Derive config public key from private key
                      const configPrivKeyBytes = hexToBytes(innerEnvelope.configKey);
                      const configPrivKeyBase64 = btoa(String.fromCharCode(...configPrivKeyBytes));
                      const configPubKeyBase64 = await cryptoProvider.getPublicKeyX448(configPrivKeyBase64);
                      const configPubKeyBinary = atob(configPubKeyBase64);
                      let configPubKeyHex = '';
                      for (let i = 0; i < configPubKeyBinary.length; i++) {
                        configPubKeyHex += configPubKeyBinary.charCodeAt(i).toString(16).padStart(2, '0');
                      }

                      saveSpaceKey({
                        spaceId,
                        keyId: 'config',
                        privateKey: innerEnvelope.configKey,
                        publicKey: configPubKeyHex,
                      });
                    }

                    // 2. Update the Triple Ratchet state
                    if (innerEnvelope.state) {
                      const template = JSON.parse(innerEnvelope.state) as Record<string, unknown>;

                      // Set peer_key from device's inbox encryption private key
                      if (!deviceKeyset.inboxEncryptionPrivateKey || !Array.isArray(deviceKeyset.inboxEncryptionPrivateKey) || deviceKeyset.inboxEncryptionPrivateKey.length === 0) {
                        break;
                      }
                      template.peer_key = btoa(String.fromCharCode(...deviceKeyset.inboxEncryptionPrivateKey));

                      // Get existing state to preserve inboxId
                      const spaceConversationId = `${spaceId}/${spaceId}`;
                      const existingStates = encryptionStateStorage.getEncryptionStates(spaceConversationId);
                      const inboxId = existingStates.length > 0
                        ? existingStates[0].inboxId
                        : getSpaceKey(spaceId, 'inbox')?.address || '';

                      // Build the new state structure
                      const newState = JSON.stringify({
                        state: JSON.stringify(template),
                      });

                      // Save updated encryption state
                      encryptionStateStorage.saveEncryptionState({
                        conversationId: spaceConversationId,
                        inboxId,
                        state: newState,
                        timestamp: Date.now(),
                      });
                      ratchetStateCacheRef.current.clear();

                      // Also update fallback state for consistency
                      encryptionStateStorage.saveFallbackState({
                        conversationId: spaceConversationId,
                        inboxId,
                        state: newState,
                        timestamp: Date.now(),
                      });
                      ratchetStateCacheRef.current.clear();

                    }

                    // 3. Handle kick if included
                    if (rekeyPayload.kick) {
                      const kickedAddress = rekeyPayload.kick;

                      // Get our address - use ref first, then MMKV storage fallback
                      let ownAddress = fullUserAddrRef.current;
                      if (!ownAddress) {
                        try {
                          const storedUser = mmkvStorage.getItem('auth:user');
                          if (storedUser) {
                            const parsed = JSON.parse(storedUser);
                            ownAddress = parsed.address;
                          }
                        } catch {
                          // Storage/parse failure — ownAddress stays null
                        }
                      }

                      if (ownAddress && kickedAddress === ownAddress) {
                        // We are being kicked — handled below via space removal
                      } else {
                        const adapter = getMMKVAdapter();
                        const existingMember = await adapter.getSpaceMember(spaceId, kickedAddress);
                        if (existingMember) {
                          await adapter.saveSpaceMember(spaceId, {
                            ...existingMember,
                            inbox_address: '',
                            isKicked: true,
                          });
                        }

                        // Save kick event as a message (for chat history)
                        const space = getSpace(spaceId);
                        const channelId = space?.defaultChannelId || spaceId;
                        const kickMessageIdBytes = sha256(new TextEncoder().encode('kick' + kickedAddress));
                        const kickMessageId = bytesToHex(kickMessageIdBytes);
                        const now = Date.now();

                        const kickMessage: Message = {
                          channelId,
                          spaceId,
                          messageId: kickMessageId,
                          digestAlgorithm: 'SHA-256',
                          nonce: kickMessageId,
                          createdDate: now,
                          modifiedDate: now,
                          lastModifiedHash: '',
                          reactions: [],
                          mentions: { memberIds: [], roleIds: [], channelIds: [] },
                          content: {
                            senderId: kickedAddress,
                            type: 'kick',
                          } as KickMessage,
                        };

                        await adapter.saveMessage(kickMessage, now, '', '', '', '');
                        // Update cache directly instead of invalidating (avoids refetch)
                        const messagesKey = queryKeys.messages.infinite(spaceId, channelId);
                        queryClient.setQueryData<{ pages: { messages: Message[] }[]; pageParams: unknown[] }>(messagesKey, (old) => {
                          if (!old) return old;
                          return {
                            ...old,
                            pages: old.pages.map((page, index) => {
                              if (index === 0) {
                                return { ...page, messages: [...page.messages, kickMessage] };
                              }
                              return page;
                            }),
                          };
                        });
                      }
                      // Members list needs refresh since membership changed (rekey = post-kick)
                      // Only refetch active queries to avoid unnecessary network calls
                      queryClient.invalidateQueries({
                        queryKey: queryKeys.spaces.members(spaceId),
                        refetchType: 'active',
                      });
                    }

                  } catch (rekeyError) {
                    if (rekeyError instanceof Error) {
                    }
                  }
                  break;
                }

                case 'space-manifest':
                  // Space configuration update
                  //
                  // NOTE: every failure exit below is intentionally logged at
                  // `warn` with a distinct `[space-manifest]` tag + reason, so a
                  // desktop space change that doesn't reach mobile can be traced
                  // to the exact gate that rejected it. The handler used to fail
                  // silently (empty catch, bare `break`s) which made this
                  // impossible to diagnose. No keys or decrypted content are
                  // logged — only the spaceId (truncated) + the reason.
                  logger.debug(`[space-manifest] received for space=${spaceId?.slice(0, 12)}`);
                  try {
                    const manifest = controlPayload.message.manifest;
                    if (!manifest) {
                      logger.warn(`[space-manifest] dropped: no manifest field (space=${spaceId?.slice(0, 12)})`);
                      break;
                    }


                    // Get space registration to verify owner
                    const quorumClient = getQuorumClient();
                    const spaceReg = await quorumClient.getSpaceRegistration(spaceId);
                    if (!spaceReg?.owner_public_keys?.includes(manifest.owner_public_key)) {
                      logger.warn(`[space-manifest] dropped: owner key not in registration (space=${spaceId?.slice(0, 12)}, regKeys=${spaceReg?.owner_public_keys?.length ?? 'none'})`);
                      break;
                    }

                    // Verify signature - native module expects base64 encoded values
                    const signingProvider = new NativeSigningProvider();
                    const messageToVerify = new Uint8Array([
                      ...new TextEncoder().encode(manifest.space_manifest),
                      ...int64ToBytes(manifest.timestamp),
                    ]);

                    // Convert hex to base64 for the native module
                    // Helper to convert Uint8Array to base64 without stack overflow
                    const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
                      let binary = '';
                      for (let i = 0; i < bytes.length; i++) {
                        binary += String.fromCharCode(bytes[i]);
                      }
                      return btoa(binary);
                    };

                    const publicKeyBytes = hexToBytes(manifest.owner_public_key);
                    const publicKeyBase64 = uint8ArrayToBase64(new Uint8Array(publicKeyBytes));
                    const messageBase64 = uint8ArrayToBase64(messageToVerify);
                    const signatureBytes = hexToBytes(manifest.owner_signature);
                    const signatureBase64 = uint8ArrayToBase64(new Uint8Array(signatureBytes));


                    const isValid = await signingProvider.verifyEd448(
                      publicKeyBase64,
                      messageBase64,
                      signatureBase64
                    );

                    if (!isValid) {
                      logger.warn(`[space-manifest] dropped: Ed448 signature invalid (space=${spaceId?.slice(0, 12)})`);
                      break;
                    }

                    // Decrypt the manifest using config key
                    const configKey = getSpaceKey(spaceId, 'config');
                    if (!configKey) {
                      logger.warn(`[space-manifest] dropped: no config key stored for space=${spaceId?.slice(0, 12)} (likely missed a rekey)`);
                      break;
                    }

                    const ciphertext = JSON.parse(manifest.space_manifest) as {
                      ciphertext: string;
                      initialization_vector: string;
                      associated_data: string;
                    };

                    const cryptoProvider = new NativeCryptoProvider();
                    const decryptedBytes = await cryptoProvider.decryptInboxMessage({
                      inbox_private_key: Array.from(hexToBytes(configKey.privateKey)),
                      ephemeral_public_key: Array.from(hexToBytes(manifest.ephemeral_public_key)),
                      ciphertext,
                    });

                    const decryptedText = new TextDecoder().decode(new Uint8Array(decryptedBytes));
                    const updatedSpace = JSON.parse(decryptedText) as Space;

                    // Staleness guard. The hub replays historical log entries on
                    // every reconnect (log-since-result), so OLD space manifests
                    // routinely arrive after newer local changes. Applying them
                    // blindly clobbers the newer state (e.g. a fresh rename snaps
                    // back to an older name). Skip any manifest that is not newer
                    // than what we already have.
                    //
                    // Compare the signed manifest.timestamp (set at broadcast
                    // time) against the stored space's modifiedDate (the sender's
                    // Date.now() when it last wrote the space). Fail OPEN: apply
                    // when there's no stored space yet, when the stored space has
                    // no modifiedDate, or on an exact tie — never block a
                    // first-seen or legitimately-newer update.
                    const existingSpace = getSpace(spaceId);
                    const incomingTs = manifest.timestamp;
                    const existingTs = existingSpace?.modifiedDate;
                    if (
                      existingSpace &&
                      typeof existingTs === 'number' &&
                      typeof incomingTs === 'number' &&
                      incomingTs < existingTs
                    ) {
                      logger.debug(
                        `[space-manifest] skipped: stale manifest for space=${spaceId?.slice(0, 12)} (incoming=${incomingTs} < local=${existingTs})`
                      );
                      break;
                    }

                    // Save updated space
                    saveSpace(updatedSpace);
                    logger.debug(`[space-manifest] applied + saved for space=${spaceId?.slice(0, 12)} (name="${updatedSpace.spaceName}", channels=${updatedSpace.groups?.flatMap(g => g.channels)?.length ?? 0})`);

                    // Mirror linked Farcaster channels into the bindings MMKV
                    // so the picker hook (useSpaceBindings) sees the
                    // remotely-pushed change without needing to know about
                    // the manifest field.
                    const linked = (updatedSpace as Space & { linkedFarcasterChannels?: unknown }).linkedFarcasterChannels;
                    if (Array.isArray(linked)) {
                      const keys = linked.filter((k): k is string => typeof k === 'string');
                      const { setSpaceBindings } = await import('../services/space/channelBindings');
                      setSpaceBindings(spaceId, keys);
                    }

                    // Update React Query cache directly with the new space data
                    queryClient.setQueryData(queryKeys.spaces.detail(spaceId), updatedSpace);
                    // Update the space in the spaces list cache
                    queryClient.setQueryData(queryKeys.spaces.all, (old: Space[] | undefined) => {
                      if (!old) return old;
                      return old.map((s: Space) => s.spaceId === spaceId ? updatedSpace : s);
                    });
                    // Invalidate the channels query so channel-level changes
                    // (name, isReadOnly/managerRoleIds, added/removed channels)
                    // reach the UI immediately. useChannels derives from the
                    // stored space but has a 5-min staleTime, so without this the
                    // saved manifest wouldn't show until the cache expired or the
                    // screen remounted. Also invalidate the spaces list so the
                    // name updates even when that query wasn't already cached
                    // (the setQueryData above no-ops when `old` is undefined).
                    queryClient.invalidateQueries({ queryKey: queryKeys.channels.bySpace(spaceId) });
                    queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all });
                  } catch (err) {
                    // Most failure modes throw here: getSpaceRegistration
                    // (network), verifyEd448, JSON.parse of the manifest,
                    // decryptInboxMessage (stale/missing config key), or
                    // JSON.parse of the decrypted space. The error message
                    // usually identifies which. Previously swallowed silently.
                    logger.warn(`[space-manifest] dropped: threw while processing space=${spaceId?.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
                  }
                  break;

                default:
              }

              // Delete control message from inbox after successful processing
              if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                deleteSpaceInboxMessages(
                  spaceInboxKey.address,
                  [message.timestamp],
                  { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                ).catch(err => {});
              }

              return;
            }

            if (payload.type !== 'message') {
              return;
            }

            // Check if message is already plaintext (envelope-only encryption, no TR)
            // Plaintext messages have messageId, channelId, spaceId, and content fields
            const isPlaintextMessage = typeof payload.message === 'object' &&
              payload.message !== null &&
              'messageId' in payload.message &&
              'channelId' in payload.message &&
              'content' in payload.message;

            let spaceMessage: Message;

            if (isPlaintextMessage) {
              // Message is already decrypted (envelope-only encryption path)
              spaceMessage = payload.message as Message;

              // Check if this is our own message echo
              const senderId = (spaceMessage.content as { senderId?: string })?.senderId;
              if (senderId && senderId === user?.address) {
                if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                  deleteSpaceInboxMessages(
                    spaceInboxKey.address,
                    [message.timestamp],
                    { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                  ).catch(err => {});
                }
                return;
              }
            } else {
              // Message is TR-encrypted, need to decrypt with Triple Ratchet
              // Get Triple Ratchet state for this space
              const spaceConversationId = `${spaceId}/${spaceId}`;
              const encryptionStates = encryptionStateStorage.getEncryptionStates(spaceConversationId);

              if (encryptionStates.length === 0) {
                return;
              }

              // Decrypt with Triple Ratchet
              let ratchetState: unknown;
              try {
                ratchetState = JSON.parse(encryptionStates[0].state);
              } catch (parseError) {
                return;
              }

              if (!ratchetState || typeof ratchetState !== 'object') {
                return;
              }

              const tripleRatchetEnvelope = typeof payload.message === 'string'
                ? payload.message
                : JSON.stringify(payload.message);

              // Check if this is our own echoed message - skip decryption
              // (Triple Ratchet participants can't decrypt their own messages)
              if (isSentEnvelope(tripleRatchetEnvelope)) {
              clearSentEnvelope(tripleRatchetEnvelope);
              // Still need to delete from inbox even for our own messages
              if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                deleteSpaceInboxMessages(
                  spaceInboxKey.address,
                  [message.timestamp],
                  { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                ).catch(err => {});
              }
              return;
            }

            const ratchetStateObj = ratchetState as Record<string, unknown>;

            let decryptResult;
            let usedFallback = false; // Track whether we used fallback for decrypt
            // Get the actual state - it may be nested as { state: "..." }
            // State must be a string (JSON), so stringify if it's an object
            // Declare outside try block so it's accessible in the save section
            const rawState = ratchetStateObj.state ?? ratchetStateObj;
            const actualState: string = typeof rawState === 'string' ? rawState : JSON.stringify(rawState);

            try {
              decryptResult = await cryptoProvider.tripleRatchetDecrypt({
                ratchet_state: actualState,
                envelope: tripleRatchetEnvelope,
              });

              // Validate the decrypt result - check for error patterns
              const ratchetStateStr = typeof decryptResult.ratchet_state === 'string'
                ? decryptResult.ratchet_state
                : JSON.stringify(decryptResult.ratchet_state);

              if (ratchetStateStr.includes('invalid') || ratchetStateStr.includes('error')) {
                throw new Error(`Triple Ratchet decrypt failed: ${ratchetStateStr.substring(0, 100)}`);
              }

            } catch (decryptError) {
              // Try fallback state if available (header keys may have changed after encrypt)
              const fallbackState = encryptionStateStorage.getFallbackState(spaceConversationId, encryptionStates[0].inboxId);
              if (fallbackState) {
                try {
                  // Parse fallback state same way as main state
                  let fallbackRatchetState: unknown;
                  try {
                    fallbackRatchetState = JSON.parse(fallbackState.state);
                  } catch {
                    fallbackRatchetState = { state: fallbackState.state };
                  }

                  const fallbackRaw = (fallbackRatchetState as Record<string, unknown>).state ?? fallbackRatchetState;
                  const fallbackActualState: string = typeof fallbackRaw === 'string'
                    ? fallbackRaw
                    : JSON.stringify(fallbackRaw);

                  // Log critical fallback state fields
                  const fallbackParsed = JSON.parse(fallbackActualState);

                  decryptResult = await cryptoProvider.tripleRatchetDecrypt({
                    ratchet_state: fallbackActualState,
                    envelope: tripleRatchetEnvelope,
                  });

                  // Validate fallback decrypt result
                  const fallbackRatchetStateStr = typeof decryptResult.ratchet_state === 'string'
                    ? decryptResult.ratchet_state
                    : JSON.stringify(decryptResult.ratchet_state);

                  // Log the first 300 chars of ratchet_state to see if it's an error

                  // Check for error patterns (case-insensitive) or empty message
                  const lowerState = fallbackRatchetStateStr.toLowerCase();
                  if (lowerState.includes('invalid') || lowerState.includes('error') || lowerState.includes('crypto error')) {
                    throw new Error(`Fallback Triple Ratchet decrypt failed: ${fallbackRatchetStateStr.substring(0, 100)}`);
                  }

                  // Also check if message is empty - this indicates decrypt actually failed
                  if (!decryptResult.message || decryptResult.message.length === 0) {
                    throw new Error('Fallback Triple Ratchet decrypt returned empty message');
                  }

                  usedFallback = true; // Mark that we used fallback
                  // DO NOT delete fallback state - keep it for future decrypts
                  // The peer (desktop) may not be advancing its ratchet
                } catch (fallbackError) {
                  throw decryptError; // Throw original error
                }
              } else {
                throw decryptError;
              }
            }

            // Skip saving when fallback was used — fallback state is frozen at
            // join/create time and updating from it would diverge from the peer.
            if (!usedFallback) {
              const ratchetStateStr = typeof decryptResult.ratchet_state === 'string'
                ? decryptResult.ratchet_state
                : JSON.stringify(decryptResult.ratchet_state);

              if (!ratchetStateStr.includes('invalid') && ratchetStateStr.startsWith('{')) {
                const wasNested = 'state' in ratchetStateObj;
                let stateToSave: string;
                if (wasNested) {
                  const originalParsed = JSON.parse(encryptionStates[0].state);
                  stateToSave = JSON.stringify({
                    state: ratchetStateStr,
                    template: originalParsed.template,
                    evals: originalParsed.evals,
                  });
                } else {
                  stateToSave = ratchetStateStr;
                }

                encryptionStateStorage.saveEncryptionState({
                  conversationId: spaceConversationId,
                  inboxId: encryptionStates[0].inboxId,
                  state: stateToSave,
                  timestamp: Date.now(),
                });
                ratchetStateCacheRef.current.clear();
              }
            }

            if (!decryptResult.message || decryptResult.message.length === 0) {
              return;
            }

            const decryptedBytes = new Uint8Array(decryptResult.message);
            const decryptedText = new TextDecoder().decode(decryptedBytes);

            try {
              spaceMessage = JSON.parse(decryptedText) as Message;
            } catch (parseError) {
              return;
            }


            const senderId = (spaceMessage.content as { senderId?: string })?.senderId;
            const ownContentType = spaceMessage.content?.type;
            if (senderId && senderId === user?.address) {
              // Space-call messages render even on self-echo (no optimistic update for them).
              if (ownContentType !== 'space-call-start' && ownContentType !== 'space-call-end') {
                if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                  deleteSpaceInboxMessages(
                    spaceInboxKey.address,
                    [message.timestamp],
                    { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                  ).catch(err => {});
                }
                return;
              }
            }
          }

            // Get space info for storage
            const space = getSpace(spaceId);
            const channelId = spaceMessage.channelId || space?.defaultChannelId || spaceId;
            const messagesKey = queryKeys.messages.infinite(spaceId, channelId);

            // Handle special message types that modify existing messages
            const contentType = spaceMessage.content?.type;
            logger.debug(`[SpaceMsg] type=${contentType} id=${spaceMessage.messageId?.slice(0, 12)}`);

            // Client-side deduplication: Skip if we've already processed this message
            // Regular messages (post, embed, sticker) are deduplicated by checking storage
            // Control-type messages (reaction, edit, remove) are idempotent so they're safe to reprocess
            if (contentType === 'post' || contentType === 'embed' || contentType === 'sticker') {
              const existingMessage = await storage.getMessage({
                spaceId,
                channelId,
                messageId: spaceMessage.messageId,
              });
              if (existingMessage) {
                // Still need to delete from inbox even for duplicates, otherwise they keep reappearing
                if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                  deleteSpaceInboxMessages(
                    spaceInboxKey.address,
                    [message.timestamp],
                    { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                  ).catch(err => {});
                }
                return;
              }
            }

            if (contentType === 'reaction') {
              // Add reaction to target message
              const reactionContent = spaceMessage.content as { messageId: string; reaction: string; senderId: string };

              // Helper to compute new reactions
              const computeNewReactions = (currentReactions: Message['reactions']) => {
                const reactions = currentReactions || [];
                const existingReaction = reactions.find((r) => r.emojiId === reactionContent.reaction);
                if (existingReaction) {
                  if (!existingReaction.memberIds.includes(reactionContent.senderId)) {
                    return reactions.map((r) =>
                      r.emojiId === reactionContent.reaction
                        ? { ...r, count: r.count + 1, memberIds: [...r.memberIds, reactionContent.senderId] }
                        : r
                    );
                  }
                  return reactions; // Already has this reaction from this user
                } else {
                  return [
                    ...reactions,
                    {
                      emojiId: reactionContent.reaction,
                      emojiName: reactionContent.reaction,
                      spaceId,
                      count: 1,
                      memberIds: [reactionContent.senderId],
                    },
                  ];
                }
              };

              // Update React Query cache for immediate UI update
              queryClient.setQueryData<InfiniteMessagesData>(messagesKey, (old) => {
                if (!old) return old;
                return {
                  ...old,
                  pages: old.pages.map((page) => ({
                    ...page,
                    messages: page.messages.map((msg) => {
                      if (msg.messageId === reactionContent.messageId) {
                        return { ...msg, reactions: computeNewReactions(msg.reactions) };
                      }
                      return msg;
                    }),
                  })),
                };
              });

              // Persist to storage
              const existingMessage = await storage.getMessage({
                spaceId,
                channelId,
                messageId: reactionContent.messageId,
              });
              if (existingMessage) {
                const updatedMessage = {
                  ...existingMessage,
                  reactions: computeNewReactions(existingMessage.reactions),
                };
                await storage.saveMessage(updatedMessage, updatedMessage.createdDate, '', '', '', '');
              }
              // Delete reaction message from inbox after processing
              if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                deleteSpaceInboxMessages(
                  spaceInboxKey.address,
                  [message.timestamp],
                  { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                ).catch(err => {});
              }
              return;
            }

            if (contentType === 'remove-reaction') {
              // Remove reaction from target message
              const reactionContent = spaceMessage.content as { messageId: string; reaction: string; senderId: string };

              // Helper to compute updated reactions after removal
              const computeRemovedReactions = (currentReactions: Message['reactions']) => {
                return (currentReactions || [])
                  .map((r) =>
                    r.emojiId === reactionContent.reaction
                      ? { ...r, count: r.count - 1, memberIds: r.memberIds.filter((id) => id !== reactionContent.senderId) }
                      : r
                  )
                  .filter((r) => r.count > 0);
              };

              // Update React Query cache for immediate UI update
              queryClient.setQueryData<InfiniteMessagesData>(messagesKey, (old) => {
                if (!old) return old;
                return {
                  ...old,
                  pages: old.pages.map((page) => ({
                    ...page,
                    messages: page.messages.map((msg) => {
                      if (msg.messageId === reactionContent.messageId) {
                        return { ...msg, reactions: computeRemovedReactions(msg.reactions) };
                      }
                      return msg;
                    }),
                  })),
                };
              });

              // Persist to storage
              const existingMessage = await storage.getMessage({
                spaceId,
                channelId,
                messageId: reactionContent.messageId,
              });
              if (existingMessage) {
                const updatedMessage = {
                  ...existingMessage,
                  reactions: computeRemovedReactions(existingMessage.reactions),
                };
                await storage.saveMessage(updatedMessage, updatedMessage.createdDate, '', '', '', '');
              }
              // Delete remove-reaction message from inbox after processing
              if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                deleteSpaceInboxMessages(
                  spaceInboxKey.address,
                  [message.timestamp],
                  { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                ).catch(err => {});
              }
              return;
            }

            if (contentType === 'edit-message') {
              // Update existing message with edit
              const editContent = spaceMessage.content as { originalMessageId: string; editedText: string | string[]; editedAt: number; editNonce?: string };

              // Honor the space's "Save Edit History" setting, matching desktop:
              // when OFF, don't retain prior versions (edits: []). Default false.
              const saveEditHistory = space?.saveEditHistory ?? false;

              queryClient.setQueryData<InfiniteMessagesData>(messagesKey, (old) => {
                if (!old) return old;
                return {
                  ...old,
                  pages: old.pages.map((page) => ({
                    ...page,
                    messages: page.messages.map((msg) => {
                      if (msg.messageId === editContent.originalMessageId && msg.content.type === 'post') {
                        const applied = applyReceivedEdit(msg, {
                          newText: editContent.editedText,
                          editedAt: editContent.editedAt,
                          editNonce: editContent.editNonce,
                          saveEditHistory,
                        });
                        if (!applied.changed) return msg;
                        return {
                          ...msg,
                          modifiedDate: applied.modifiedDate,
                          lastModifiedHash: applied.lastModifiedHash,
                          content: {
                            ...msg.content,
                            text: editContent.editedText,
                          },
                          edits: applied.edits,
                        };
                      }
                      return msg;
                    }),
                  })),
                };
              });
              // Persist to storage so the edit survives query invalidation /
              // remount / navigating away and back. Without this, the cache
              // update above gets overwritten the next time the infinite
              // query refetches from MMKV.
              const existingMsg = await storage.getMessage({ spaceId, channelId, messageId: editContent.originalMessageId });
              if (existingMsg && existingMsg.content.type === 'post') {
                const applied = applyReceivedEdit(existingMsg, {
                  newText: editContent.editedText,
                  editedAt: editContent.editedAt,
                  editNonce: editContent.editNonce,
                  saveEditHistory,
                });
                // Skip the write when the edit was already applied — a replayed
                // edit-message must not clobber stored history.
                if (applied.changed) {
                  const updated: Message = {
                    ...existingMsg,
                    modifiedDate: applied.modifiedDate,
                    lastModifiedHash: applied.lastModifiedHash,
                    content: { ...existingMsg.content, text: editContent.editedText },
                    edits: applied.edits,
                  };
                  await storage.saveMessage(updated, updated.createdDate, '', '', '', '');
                }
              }
              // Delete edit-message from inbox after processing
              if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                deleteSpaceInboxMessages(
                  spaceInboxKey.address,
                  [message.timestamp],
                  { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                ).catch(err => {});
              }
              return;
            }

            if (contentType === 'remove-message') {
              const removeContent = spaceMessage.content as RemoveMessage;

              // Receive-side permission enforcement. The sender's own client
              // gates the delete button, but we can't trust that — a modified
              // or buggy client (or a space owner relying on the owner-bypass
              // footgun) could broadcast a delete it shouldn't. So we re-validate
              // here against the sender's role, exactly as desktop does
              // (MessageService.ts remove-message handling). No isSpaceOwner
              // bypass: receivers can't verify ownership, so owners must hold a
              // role with message:delete to delete others' messages.
              //
              // Self-deletes never reach this handler — own echoes are filtered
              // upstream (sent-envelope / senderId checks) and the local removal
              // is optimistic — so this guard can't block a legitimate own delete.
              const targetMessage = await storage.getMessage({
                spaceId,
                channelId,
                messageId: removeContent.removeMessageId,
              });

              if (targetMessage) {
                // Resolve the channel for read-only / manager-role handling.
                const channel: Channel | undefined = space?.groups
                  ?.find((g) => g.channels.find((c) => c.channelId === channelId))
                  ?.channels.find((c) => c.channelId === channelId);

                const checker = createChannelPermissionChecker({
                  userAddress: removeContent.senderId,
                  isSpaceOwner: false,
                  space: space ?? undefined,
                  channel,
                });

                if (!checker.canDeleteMessage(targetMessage)) {
                  // Unauthorized delete — drop it, but still clear the inbox
                  // entry so we don't reprocess it on every reconnect.
                  logger.debug(
                    `[SpaceMsg] dropped unauthorized remove-message from ${removeContent.senderId?.slice(0, 12)} for ${removeContent.removeMessageId?.slice(0, 12)}`
                  );
                  if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                    deleteSpaceInboxMessages(
                      spaceInboxKey.address,
                      [message.timestamp],
                      { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                    ).catch(err => {});
                  }
                  return;
                }
              }
              // targetMessage missing → nothing to protect; honor the removal so
              // a stale reference doesn't linger in the cache.

              // Remove message from cache and storage
              queryClient.setQueryData<InfiniteMessagesData>(messagesKey, (old) => {
                if (!old) return old;
                return {
                  ...old,
                  pages: old.pages.map((page) => ({
                    ...page,
                    messages: page.messages.filter((msg) => msg.messageId !== removeContent.removeMessageId),
                  })),
                };
              });

              // Also remove from storage
              await storage.deleteMessage(removeContent.removeMessageId);
              // Delete remove-message from inbox after processing
              if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                deleteSpaceInboxMessages(
                  spaceInboxKey.address,
                  [message.timestamp],
                  { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                ).catch(err => {});
              }
              return;
            }

            if (contentType === 'mute') {
              const muteContent = spaceMessage.content as MuteMessage;

              // Receive-side moderation-mute enforcement. Like remove-message we
              // NEVER trust the sender's client — we re-validate the sender holds
              // the `user:mute` role before honoring the mute. No isSpaceOwner
              // bypass: receivers can't verify ownership, so owners must hold a
              // user:mute role too (matches desktop mute-user-system). Fail-secure:
              // reject when space data is unavailable.
              const dropMuteInbox = () => {
                if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                  deleteSpaceInboxMessages(
                    spaceInboxKey.address,
                    [message.timestamp],
                    { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                  ).catch(err => {});
                }
              };

              // Self-mute is invalid; duplicate muteId is a replay (no-op).
              if (
                !muteContent.targetUserId ||
                muteContent.targetUserId === muteContent.senderId ||
                hasMuteId(muteContent.muteId)
              ) {
                dropMuteInbox();
                return;
              }

              // Fail-secure: no space => can't verify permission => reject.
              if (!space) {
                logger.debug('[SpaceMsg] dropped mute — space data unavailable (fail-secure)');
                dropMuteInbox();
                return;
              }

              const muteChannel: Channel | undefined = space.groups
                ?.find((g) => g.channels.find((c) => c.channelId === channelId))
                ?.channels.find((c) => c.channelId === channelId);
              const muteChecker = createChannelPermissionChecker({
                userAddress: muteContent.senderId,
                isSpaceOwner: false,
                space,
                channel: muteChannel,
              });
              if (!muteChecker.canMuteUser()) {
                logger.debug(
                  `[SpaceMsg] dropped unauthorized mute from ${muteContent.senderId?.slice(0, 12)} for ${muteContent.targetUserId?.slice(0, 12)}`
                );
                dropMuteInbox();
                return;
              }

              if (muteContent.action === 'unmute') {
                removeModMute(spaceId, muteContent.targetUserId);
                markMuteIdSeen(muteContent.muteId);
              } else {
                const now = muteContent.timestamp || Date.now();
                setModMute({
                  spaceId,
                  targetUserId: muteContent.targetUserId,
                  mutedAt: now,
                  mutedBy: muteContent.senderId,
                  lastMuteId: muteContent.muteId,
                  expiresAt:
                    muteContent.duration !== undefined ? now + muteContent.duration : undefined,
                });
              }
              dropMuteInbox();
              return;
            }

            if (contentType === 'update-profile') {
              // Update member profile (display name, icon, bio) in storage and cache.
              // Two changes vs. the previous implementation:
              //   1. UPSERT instead of update-only — if we don't have a
              //      member record yet (joined the space after the sender
              //      sent their update, or join control was missed), we
              //      still record the profile so the next member-list
              //      fetch surfaces the right data.
              //   2. Per-field clear semantics: displayName and bio use a
              //      presence check (!== undefined) so an empty string is a
              //      DELIBERATE clear (desktop now omits a field on the wire
              //      when it didn't change, so '' is always intentional —
              //      this is why the old "empty = no change" guard for
              //      displayName was dropped). userIcon stays on the truthy
              //      guard (icons aren't cleared via this path; an empty
              //      avatar would just blank the member's icon by mistake).
              const profileContent = spaceMessage.content as {
                senderId: string;
                displayName?: string;
                userIcon?: string;
                bio?: string;
                farcasterFid?: number;
                farcasterUsername?: string;
              };

              const adapter = getMMKVAdapter();
              const existingMember = await adapter.getSpaceMember(spaceId, profileContent.senderId) as
                | (SpaceMember & { profileTimestamp?: number; farcasterFid?: number; farcasterUsername?: string })
                | undefined;

              // Stamp the merge with the wire message's createdDate so the
              // public-profile fallback can decide which is newer when
              // both exist for the same user.
              const ts = spaceMessage.createdDate || Date.now();

              // Skip stale updates — older than the timestamp we already
              // applied for this member.
              if (existingMember?.profileTimestamp && existingMember.profileTimestamp >= ts) {
                if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                  deleteSpaceInboxMessages(
                    spaceInboxKey.address,
                    [message.timestamp],
                    { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                  ).catch(err => {});
                }
                return;
              }

              const merged = {
                ...(existingMember ?? {
                  address: profileContent.senderId,
                  inbox_address: '',
                }),
                // Presence check (not truthy): an empty displayName is a
                // deliberate per-space-name clear ("use my global/QNS name
                // here"), matching bio's semantics and desktop's receiver.
                // The sender omits displayName on bio/avatar-only edits, so
                // '' on the wire is always an intentional clear.
                ...(profileContent.displayName !== undefined ? { display_name: profileContent.displayName } : {}),
                ...(profileContent.userIcon ? { profile_image: profileContent.userIcon } : {}),
                ...(profileContent.bio !== undefined ? { bio: profileContent.bio } : {}),
                ...(profileContent.farcasterFid !== undefined && profileContent.farcasterFid > 0
                  ? { farcasterFid: profileContent.farcasterFid }
                  : {}),
                ...(profileContent.farcasterUsername ? { farcasterUsername: profileContent.farcasterUsername } : {}),
                profileTimestamp: ts,
              } as SpaceMember & { profileTimestamp: number; farcasterFid?: number; farcasterUsername?: string };

              await adapter.saveSpaceMember(spaceId, merged);

              // Update React Query members cache. Insert if missing.
              queryClient.setQueryData(queryKeys.spaces.members(spaceId), (old: SpaceMember[] | undefined) => {
                if (!old) return old;
                const idx = old.findIndex((m) => m.address === profileContent.senderId);
                if (idx >= 0) {
                  return old.map((m, i) => (i === idx ? merged : m));
                }
                return [...old, merged];
              });

              // Delete update-profile message from inbox after processing
              if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                deleteSpaceInboxMessages(
                  spaceInboxKey.address,
                  [message.timestamp],
                  { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                ).catch(err => {});
              }
              return;
            }

            // Default-deny: only PERSISTABLE_TYPES reach saveMessage. Runs after
            // the applied-type handlers above (reaction/edit/remove/update-profile,
            // which all return earlier) and before the save. Subsumes the old
            // pin/mute/thread guard plus any future type mobile doesn't yet render;
            // opting one in means adding it to PERSISTABLE_TYPES + a render branch.
            if (contentType && !PERSISTABLE_TYPES.has(contentType)) {
              logger.debug(`[SpaceMsg] default-deny dropped unsupported type=${contentType}`);
              if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                deleteSpaceInboxMessages(
                  spaceInboxKey.address,
                  [message.timestamp],
                  { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                ).catch(err => {});
              }
              return;
            }

            // Moderation-mute enforcement (receive-side). Drop incoming postable
            // content from a user muted in this space — for everyone, matching
            // desktop. Runs BEFORE storage.saveMessage so a muted user's message
            // can't resurrect from disk on refetch. A mute that arrives in the
            // same stream is applied by the 'mute' handler above (earlier inbox
            // ordering); lazy expiry means a lapsed mute stops dropping.
            if (
              (contentType === 'post' ||
                contentType === 'embed' ||
                contentType === 'sticker') &&
              'senderId' in spaceMessage.content &&
              spaceMessage.content.senderId &&
              isModMutedUser(spaceId, spaceMessage.content.senderId)
            ) {
              logger.debug(
                `[SpaceMsg] dropped message from muted user ${spaceMessage.content.senderId.slice(0, 12)} in ${spaceId?.slice(0, 12)}`
              );
              if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                deleteSpaceInboxMessages(
                  spaceInboxKey.address,
                  [message.timestamp],
                  { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                ).catch(err => {});
              }
              return;
            }

            // Read-only channel enforcement (receive-side). Postable content
            // (post/embed/sticker) authored by a non-manager must not land in a
            // read-only channel — the sender's client should have blocked it, but
            // we can't trust that (same reasoning as the remove-message guard).
            // Covers all three postable types and runs BEFORE storage.saveMessage
            // so a dropped message can't resurrect from disk on refetch.
            if (
              contentType === 'post' ||
              contentType === 'embed' ||
              contentType === 'sticker'
            ) {
              const channel: Channel | undefined = space?.groups
                ?.find((g) => g.channels.find((c) => c.channelId === channelId))
                ?.channels.find((c) => c.channelId === channelId);

              if (channel?.isReadOnly) {
                const senderId = 'senderId' in spaceMessage.content
                  ? spaceMessage.content.senderId
                  : undefined;
                const canPost = !!senderId
                  && canManageReadOnlyChannel(senderId, false, space ?? undefined, channel);
                if (!canPost) {
                  logger.debug(
                    `[SpaceMsg] dropped read-only-channel post from ${senderId?.slice(0, 12)} in ${channelId?.slice(0, 12)}`
                  );
                  if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                    deleteSpaceInboxMessages(
                      spaceInboxKey.address,
                      [message.timestamp],
                      { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                    ).catch(err => {});
                  }
                  return;
                }
              }
            }

            // Regular message types (post, embed, sticker, join, leave, kick, etc.)
            // Save message to storage
            await storage.saveMessage(
              {
                ...spaceMessage,
                spaceId,
                channelId,
              },
              spaceMessage.createdDate || Date.now(),
              spaceId,
              'space',
              space?.iconUrl || '',
              space?.spaceName || spaceId.substring(0, 8)
            );

            // Muting a channel/space silences its in-app reply/mention badge
            // too, not just push notifications — same gate as the push path.
            const notifyForBadge = shouldNotifyForContext({ spaceId, channelId });

            // Mentions/replies are detected + persisted by logMentionOrReply
            // below (which also drives the channel bubble via the read-state
            // log). The old integer counters were retired in favor of that
            // single source of truth.

            // Track last space activity for inbox sorting + preview
            {
              const preview = getSpaceMessagePreview(spaceMessage);
              const senderId = ('senderId' in spaceMessage.content ? spaceMessage.content.senderId : undefined);
              const senderMember = spaceId && senderId ? await storage.getSpaceMember(spaceId, senderId) : undefined;
              const senderName = messageSenderName(
                senderId,
                fullUserAddrRef.current ?? undefined,
                senderId && senderMember ? { [senderId]: senderMember } : undefined
              );
              recordSpaceActivity(spaceId, {
                timestamp: spaceMessage.createdDate || Date.now(),
                preview,
                senderName,
                channelId,
              });
            }

            // Persist mentions/replies into the notifications inbox log (the
            // Quorum section of the Notifications tab). Same detection as the
            // badge counters above; this just keeps the full row. Fire-and-forget
            // so it never blocks message processing.
            void logMentionOrReply(spaceMessage, {
              spaceId,
              channelId,
              userAddress: fullUserAddrRef.current,
              space: space ?? undefined,
              channelName: space?.groups
                ?.flatMap((g) => g.channels)
                .find((c) => c.channelId === channelId)?.channelName,
              notifyForBadge,
              getSpaceMember: (sid, mid) => storage.getSpaceMember(sid, mid),
            });

            // Update React Query cache. If there's no existing cache (the
            // query was unmounted and gc'd, or hasn't mounted yet), leave
            // it alone — the message is already on disk via saveMessage()
            // above, and the next mount will load the full list from
            // MMKV. Synthesizing a single-message page here would clobber
            // the disk-backed history with just-this-one-message until
            // the next refetch.
            queryClient.setQueryData<InfiniteMessagesData>(messagesKey, (old) => {
              if (!old) return old;

              const messageExists = old.pages.some((page) =>
                page.messages.some((m) => m.messageId === spaceMessage.messageId)
              );

              if (messageExists) return old;

              return {
                ...old,
                pages: old.pages.map((page, index) => {
                  if (index === 0) {
                    return { ...page, messages: [...page.messages, spaceMessage] };
                  }
                  return page;
                }),
              };
            });

            // Note: We already updated the cache with setQueryData above
            // No need to invalidateQueries which would trigger a full refetch


            // Delete message from inbox after successful processing
            if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
              deleteSpaceInboxMessages(
                spaceInboxKey.address,
                [message.timestamp],
                { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
              ).catch(err => {});
            }
          } catch (spaceError) {
            if (spaceError instanceof Error) {
            }
          }

          return;
        }

        // Check if we have an existing session for the inbox this message arrived on
        // If we have a session mapping, it's a subsequent message (not init)
        const existingMapping = encryptionStateStorage.getInboxMapping(message.inboxAddress);

        // Check envelope format to distinguish init messages from subsequent messages
        // Init messages have envelope with {ciphertext, initialization_vector} (MessageCiphertext)
        // Subsequent messages have envelope with {protocol_identifier, message_header, message_body} (DoubleRatchet)
        let envelopeData: Record<string, unknown> | null = null;
        try {
          envelopeData = typeof sealedMessage.envelope === 'string'
            ? JSON.parse(sealedMessage.envelope) as Record<string, unknown>
            : sealedMessage.envelope as unknown as Record<string, unknown>;
        } catch {
          // If we can't parse, assume it might be an init message
        }
        const isDoubleRatchetEnvelope = envelopeData && 'protocol_identifier' in envelopeData;
        const isInitEnvelope = envelopeData && 'ciphertext' in envelopeData && 'initialization_vector' in envelopeData;

        // Init message = device inbox + MessageCiphertext envelope.
        // Discriminate by envelope shape, not inbox mapping — a stale
        // mapping from a previous conversation would misclassify.
        const isInitMessage = isOnDeviceInbox && isInitEnvelope;

        const sealedAny = sealedMessage as unknown as Record<string, unknown>;

        // Per-conversation inboxes (subscribed when we initiate) must NOT
        // be filtered as echoes — replies legitimately arrive there.
        const isOurConversationInbox = encryptionStateStorage.getConversationInboxKeypairByAddress(message.inboxAddress) !== null;

        if (!isOnDeviceInbox && !isOurConversationInbox && sealedMessage.inbox_address && sealedMessage.ephemeral_public_key) {
          // Echo: outbound init format addressed elsewhere.
          return;
        }

        // Also check for echoed subsequent messages with hub_address (messages we sent back)
        // These have envelope and hub_address but no inbox_address at root level
        if (!isOnDeviceInbox && sealedMessage.envelope && sealedAny.hub_address !== undefined) {
          // This is a subsequent message format on an inbox we're subscribed to
          // that isn't our own device inbox. Check if we have a session for this inbox.
          // Also check if this is a conversation inbox we created - those are legitimate.
          if (!existingMapping && !isOurConversationInbox) {
            return;
          }
        }

        let conversationId = '';
        let decryptedMessage: Message;

        // Session-authenticated sender, captured before the self-sync rewrite
        // below repoints conversationId to the partner. Used for remove-message auth.
        let authenticatedDmSender = '';

        // Track user profile info (display name, icon) from InitializationEnvelope
        let userProfileFromEnvelope: { displayName?: string; userIcon?: string } | undefined;

        if (isInitMessage) {
          // === Path 1: First message from new sender ===
          try {
            // Unseal the envelope using our inbox encryption key
            const unsealed = await encryptionService.unsealInitializationEnvelope(sealedMessage);

            // Initialize recipient session (performs X3DH and sets up Double Ratchet)
            // Pass the inbox address where we received this message so state is stored correctly
            // Returns null if decryption fails (expected for multi-device)
            const sessionResult = await encryptionService.initializeRecipientSession(
              unsealed,
              message.inboxAddress  // Our device inbox where we received this init
            );

            if (!sessionResult) {
              // Decryption failed - message was likely for a different device
              return;
            }

            conversationId = sessionResult.conversationId;
            authenticatedDmSender = conversationId.split('/')[0];
            userProfileFromEnvelope = sessionResult.userProfile;

            // The message should now be properly decrypted plaintext JSON
            decryptedMessage = JSON.parse(sessionResult.message) as Message;

            // Self-echo init guard: if the sender is our own address and the
            // message carries no channelId, we cannot determine the real partner.
            // Drop it to prevent a phantom selfAddress/selfAddress conversation row.
            const initSenderAddress = conversationId.split('/')[0];
            if (initSenderAddress === user?.address) {
              if (decryptedMessage.channelId) {
                // Has channelId — redirect to the real partner conversation.
                const actualRecipient = decryptedMessage.channelId;
                conversationId = `${actualRecipient}/${actualRecipient}`;
              } else {
                // Channel-less self-echo (observed live: a steady stream of
                // self-echoes with no channelId and often no content.type).
                // Cannot attribute to a real partner and nothing to display —
                // discard so it can't create a self-address conversation row.
                return;
              }
            }

            // Subscribe to our conversation inbox so future replies arrive.
            if (sessionResult.ourConversationInbox) {
              const client = wsClientRef.current;
              if (client && client.isConnected) {
                await client.subscribe([sessionResult.ourConversationInbox]);
                subscribedInboxesRef.current.add(sessionResult.ourConversationInbox);
              }
            }
          } catch (initError) {
            // Manual reset via resetDMSession() is available if needed
            return;
          }
        } else {
          // === Path 2: Subsequent message on existing session inbox ===
          let decryptedText: string | null = null;

          // For device inbox messages, we MUST use trial decryption because
          // multiple conversations share the same device inbox and the inbox mapping
          // can be wrong (overwritten by the most recent conversation).
          if (isOnDeviceInbox && isDoubleRatchetEnvelope) {
            // Get all states that have this inbox ID
            const statesForInbox = encryptionStateStorage.getStatesByInboxId(message.inboxAddress);

            for (const { conversationId: convId } of statesForInbox) {
              // Try to decrypt with this session
              // Returns null if decryption fails (expected for multi-device)
              const result = await encryptionService.decryptMessage(
                convId,
                message.inboxAddress,
                sealedMessage.envelope
              );

              // Check if decryption succeeded
              if (result && result.length > 0) {
                decryptedText = result;
                conversationId = convId;
                break;
              }
              // Null result means decryption failed, try next session
            }

            if (!decryptedText) {
              return;
            }
          } else {
            // For non-device inbox messages:
            // 1. Check if this is a conversation-specific inbox we created
            // 2. Unseal the message first
            // 3. Check if the unsealed content is an InitializationEnvelope or raw DR envelope
            // 4. Handle accordingly

            // Check if we have a conversation inbox keypair for this address
            const conversationKeypair = encryptionStateStorage.getConversationInboxKeypairByAddress(message.inboxAddress);

            if (conversationKeypair) {
              // === Sealed message arriving at our conversation-specific inbox ===
              // After unsealing, the content could be:
              // 1. An InitializationEnvelope (unconfirmed session)
              // 2. A raw Double Ratchet envelope (confirmed session)
              try {
                // Unseal using our conversation inbox private key
                const unsealedContent = await unsealWithConversationKeypair(sealedMessage, conversationKeypair);

                if (unsealedContent.type === 'dr') {
                  // === Raw Double Ratchet envelope (confirmed session) ===
                  // Get conversation ID from the keypair
                  conversationId = conversationKeypair.conversationId;

                  // Get the encryption state for this conversation at this inbox
                  const encState = encryptionStateStorage.getEncryptionState(conversationId, message.inboxAddress);
                  if (!encState) {
                    return;
                  }

                  // Decrypt the Double Ratchet envelope
                  decryptedText = await encryptionService.decryptMessage(
                    conversationId,
                    message.inboxAddress,
                    unsealedContent.envelope
                  );
                } else {
                  // === InitializationEnvelope (unconfirmed session) ===
                  const unsealed = unsealedContent.envelope;

                  // Determine conversation ID from the unsealed envelope
                  conversationId = `${unsealed.user_address}/${unsealed.user_address}`;

                  // Check if we already have an encryption state for this conversation
                  // If so, use existing session to decrypt (don't do X3DH again)
                  const existingStates = encryptionStateStorage.getEncryptionStates(conversationId);
                  const hasExistingSession = existingStates.length > 0;

                  if (hasExistingSession) {
                    // === Use existing session to decrypt ===
                    // The message is wrapped in InitEnvelope but we already have a session
                    // Try to decrypt with existing states (trial decryption)
                    let successInboxId: string | null = null;
                    for (const encState of existingStates) {
                      try {
                        decryptedText = await encryptionService.decryptMessage(
                          conversationId,
                          encState.inboxId,
                          unsealed.message  // The Double Ratchet envelope inside the InitEnvelope
                        );
                        if (decryptedText && !decryptedText.startsWith('Decryption failed')) {
                          successInboxId = encState.inboxId;

                          // Extract user profile from envelope
                          userProfileFromEnvelope = (unsealed.display_name || unsealed.user_icon)
                            ? { displayName: unsealed.display_name, userIcon: unsealed.user_icon }
                            : undefined;
                          break;
                        }
                      } catch (decryptErr) {
                      }
                    }

                    if (!decryptedText || decryptedText.startsWith('Decryption failed') || !successInboxId) {
                      return;
                    }

                    // IMPORTANT: Update sendingInbox from the InitEnvelope
                    // This tells us where to send future replies (the sender's return inbox)
                    if (unsealed.return_inbox_address && unsealed.return_inbox_encryption_key) {
                      const currentState = encryptionStateStorage.getEncryptionState(conversationId, successInboxId);
                      if (currentState) {
                        const updatedSendingInbox = {
                          inbox_address: unsealed.return_inbox_address,
                          inbox_encryption_key: unsealed.return_inbox_encryption_key,
                          inbox_public_key: unsealed.return_inbox_public_key || '',
                          inbox_private_key: '',
                        };
                        encryptionStateStorage.saveEncryptionState({
                          ...currentState,
                          sendingInbox: updatedSendingInbox,
                        }, false);
                        ratchetStateCacheRef.current.clear();
                      }
                    }
                  } else {
                    // === First message from this sender - initialize new session ===
                    // Returns null if decryption fails (expected for multi-device)
                    const sessionResult = await encryptionService.initializeRecipientSession(
                      unsealed,
                      message.inboxAddress  // Our conversation inbox where we received this
                    );

                    if (!sessionResult) {
                      // Decryption failed - message was likely for a different device
                      return;
                    }

                    conversationId = sessionResult.conversationId;
                    decryptedText = sessionResult.message;
                    userProfileFromEnvelope = sessionResult.userProfile;

                    // Subscribe to our conversation inbox for receiving future replies
                    if (sessionResult.ourConversationInbox) {
                      const client = wsClientRef.current;
                      if (client && client.isConnected) {
                        await client.subscribe([sessionResult.ourConversationInbox]);
                        subscribedInboxesRef.current.add(sessionResult.ourConversationInbox);
                      }
                    }
                  }
                }
              } catch (unsealError) {
                return;
              }
            } else {
              // Standard non-device inbox message (Double Ratchet envelope)
              // This shouldn't happen often - messages should go to conversation inboxes
              const mapping = encryptionStateStorage.getInboxMapping(message.inboxAddress);

              if (!mapping) {
                return;
              }

              conversationId = mapping.conversationId;

              // Decrypt using existing session
              try {
                decryptedText = await encryptionService.decryptMessage(
                  conversationId,
                  message.inboxAddress,
                  sealedMessage.envelope
                );
              } catch (decryptError) {
                // If this is a "no state" error, it's likely stale data - skip gracefully
                if (decryptError instanceof Error && decryptError.message.includes('No encryption state')) {
                  return;
                }
                throw decryptError;
              }
            }
          }


          if (!decryptedText || decryptedText.length === 0 || decryptedText.startsWith('Decryption failed')) {
            return;
          }

          decryptedMessage = JSON.parse(decryptedText) as Message;

          // Intercept call signaling messages — forward to CallContext, don't display in chat.
          // call-event is the exception: it renders in chat history as a system message.
          if (decryptedMessage.content?.type?.startsWith('call-') && decryptedMessage.content?.type !== 'call-event') {
            callSignalingHandlerRef.current?.(decryptedMessage);
            // Best-effort: delete from server so stale signals don't replay on next launch
            getDeviceKeyset().then(dk => {
              if (dk) deleteInboxMessages(message.inboxAddress, [message.timestamp], dk).catch(() => {});
            });
            return;
          }

          // Handle same-user multi-device sync:
          // When receiving a message from our own address (different device),
          // the conversation should be with the actual recipient (channelId), not ourselves.
          // This matches desktop behavior in MessageService.ts lines 2082-2086
          const senderAddress = conversationId.split('/')[0];
          authenticatedDmSender = senderAddress; // before the rewrite below
          if (senderAddress === user?.address && decryptedMessage.channelId) {
            const actualRecipient = decryptedMessage.channelId;
            conversationId = `${actualRecipient}/${actualRecipient}`;
          } else if (senderAddress === user?.address) {
            // Channel-less self-echo — can't attribute to a partner, nothing to
            // display. Drop it so it can't create a self-address conversation row.
            return;
          }
        }

        // Extract sender address from conversation ID (may have been updated for self-sync)
        const senderAddress = conversationId.split('/')[0];

        // Self-sync guard: on our own message echoed from another device the
        // envelope profile is OURS, not the partner's — drop it so it can't
        // overwrite the partner's row. Mirrors desktop's
        // `envelope.user_address != self_address` check. authenticatedDmSender
        // is the true (pre-rewrite) sender.
        if (authenticatedDmSender && authenticatedDmSender === user?.address) {
          userProfileFromEnvelope = undefined;
        }

        // Intercept dm-update-profile control messages — update the partner's
        // conversation row in place, never persist as a chat post. Handles both
        // parse branches above (new-session + subsequent-message) since both
        // converge here. Best-effort: delete from server so it doesn't replay.
        if (await applyDmProfileUpdate(decryptedMessage, senderAddress)) {
          getDeviceKeyset().then(dk => {
            if (dk) deleteInboxMessages(message.inboxAddress, [message.timestamp], dk).catch(() => {});
          });
          return;
        }

        // remove-message on the fallback path (defensive — the batch path folds
        // these; without this a control message reaching here is a ghost post).
        if (decryptedMessage.content?.type === 'remove-message') {
          const removeContent = decryptedMessage.content as RemoveMessage;
          const targetMsg = await storage.getMessage({
            spaceId: senderAddress,
            channelId: senderAddress,
            messageId: removeContent.removeMessageId,
          });
          // Auth: deleter must be the target's author, judged by the
          // session-authenticated sender, not the spoofable payload senderId.
          const authorized = removeContent.senderId === authenticatedDmSender &&
            (!targetMsg || targetMsg.content?.senderId === authenticatedDmSender);
          if (authorized && targetMsg) {
            const key = queryKeys.messages.infinite(senderAddress, senderAddress);
            queryClient.setQueryData<InfiniteMessagesData>(key, (old) => {
              if (!old) return old;
              return { ...old, pages: old.pages.map((page) => ({
                ...page,
                messages: page.messages.filter((m) => m.messageId !== removeContent.removeMessageId),
              })) };
            });
            await storage.deleteMessage(removeContent.removeMessageId);
            scheduleConversationRefresh(conversationId);
          } else if (!authorized) {
            logger.debug(
              `[DM-fallback] dropped unauthorized remove-message from ${removeContent.senderId?.slice(0, 12)} for ${removeContent.removeMessageId?.slice(0, 12)}`
            );
          }
          // Best-effort: clear the control message from the inbox.
          getDeviceKeyset().then(dk => {
            if (dk) deleteInboxMessages(message.inboxAddress, [message.timestamp], dk).catch(() => {});
          });
          return;
        }

        // delete-conversation, fallback path (defensive — mirrors the batch
        // branch): reset the session only, before the save.
        if (decryptedMessage.content?.type === 'delete-conversation') {
          encryptionStateStorage.deleteAllEncryptionStates(conversationId);
          getDeviceKeyset().then(dk => {
            if (dk) deleteInboxMessages(message.inboxAddress, [message.timestamp], dk).catch(() => {});
          });
          return;
        }

        // delete-conversation-self: not implemented on mobile yet — drop it so
        // it isn't saved as a ghost row (forward-compat until mobile Part 2).
        if ((decryptedMessage.content?.type as string) === 'delete-conversation-self') {
          getDeviceKeyset().then(dk => {
            if (dk) deleteInboxMessages(message.inboxAddress, [message.timestamp], dk).catch(() => {});
          });
          return;
        }

        // Save conversation to storage (creates new or updates existing)
        const existingConversation = await storage.getConversation(conversationId);
        // Get sender display name for preview
        const senderDisplayName = userProfileFromEnvelope?.displayName || existingConversation?.displayName || senderAddress.substring(0, 8);
        // Typed preview (icon + text, no emoji) — single source of truth in
        // utils/messagePreview, which now also handles call-event.
        const messagePreview = getSpaceMessagePreview(decryptedMessage);
        if (!existingConversation) {
          const newConversation: Conversation = {
            conversationId,
            address: senderAddress,
            displayName: senderDisplayName,
            icon: userProfileFromEnvelope?.userIcon || '',
            timestamp: decryptedMessage.createdDate || Date.now(),
            type: 'direct',
            lastMessagePreview: messagePreview,
            lastMessageSenderName: senderDisplayName,
          };
          await storage.saveConversation(newConversation);
        } else {
          // Update existing conversation - update profile if we have new info
          const updatedConversation: Conversation = {
            ...existingConversation,
            timestamp: decryptedMessage.createdDate || Date.now(),
            // Update display name and icon if we have new profile data
            displayName: userProfileFromEnvelope?.displayName || existingConversation.displayName,
            icon: userProfileFromEnvelope?.userIcon || existingConversation.icon,
            lastMessagePreview: messagePreview,
            lastMessageSenderName: senderDisplayName,
          };
          await storage.saveConversation(updatedConversation);
        }

        // Save message to storage
        // For DMs, we use senderAddress as both spaceId and channelId
        await storage.saveMessage(
          {
            ...decryptedMessage,
            spaceId: senderAddress,
            channelId: senderAddress,
          },
          decryptedMessage.createdDate || Date.now(),
          senderAddress,
          'direct',
          '', // No icon
          senderAddress.substring(0, 8) // Display name
        );

        // Key shape must match useSendDirectMessage:
        // queryKeys.messages.infinite(otherPartyAddress, otherPartyAddress).
        const messagesKey = queryKeys.messages.infinite(senderAddress, senderAddress);

        queryClient.setQueryData<InfiniteMessagesData>(messagesKey, (old) => {
          // No existing cache — leave it alone. saveMessage() above already
          // wrote to MMKV, and a fresh mount will read the full list from
          // disk. Synthesizing a single-message page would clobber the
          // disk-backed history.
          if (!old) return old;

          // Check if message already exists (by messageId)
          const messageExists = old.pages.some((page) =>
            page.messages.some((m) => m.messageId === decryptedMessage.messageId)
          );

          if (messageExists) {
            return old;
          }

          // Add to first page (newest messages)
          return {
            ...old,
            pages: old.pages.map((page, index) => {
              if (index === 0) {
                return {
                  ...page,
                  messages: [...page.messages, decryptedMessage],
                };
              }
              return page;
            }),
          };
        });

        // Update conversation list to show latest message.
        // Skip invalidating messagesKey: setQueryData above is canonical
        // and a refetch races with storage writes. Coalesced so a
        // fallback-path catch-up doesn't refetch+re-render per message.
        scheduleConversationRefresh(conversationId);


        // Delete the message from the server inbox after successful processing
        // This prevents re-delivery on reconnect which would cause decryption failures
        // (since the ratchet state has already advanced)
        if (message.timestamp) {
          // Check if this message arrived on a conversation inbox (not device inbox)
          const conversationKeypair = encryptionStateStorage.getConversationInboxKeypairByAddress(message.inboxAddress);

          if (conversationKeypair && conversationKeypair.signingPrivateKey && conversationKeypair.signingPublicKey) {
            // Conversation inbox - use Ed448 signing key for deletion
            // Address is now derived from Ed448 signing key, so signature verification will work
            const signingKey = {
              publicKey: bytesToHex(conversationKeypair.signingPublicKey),
              privateKey: bytesToHex(conversationKeypair.signingPrivateKey),
            };
            // Best-effort: fire and forget — don't block on deletion
            deleteConversationInboxMessages(message.inboxAddress, [message.timestamp], signingKey).catch(() => {});
          } else {
            // Device inbox - use device keyset signing key for deletion
            const deviceKeyset = await getDeviceKeyset();
            if (deviceKeyset) {
              // Best-effort: fire and forget — don't block on deletion
              deleteInboxMessages(message.inboxAddress, [message.timestamp], deviceKeyset).catch(() => {});
            }
          }
        }
      } catch {
        // Message processing failed — isolate so other messages continue processing
      }
    },
    [queryClient, storage, applyDmProfileUpdate]
  );

  /**
   * Batch pre-unseal space messages to populate the cache.
   * Groups messages by spaceId, does a single native call per space,
   * and stores results in preUnsealedCacheRef for handleIncomingMessage to consume.
   */
  const batchPreUnsealSpaceMessages = useCallback(async (
    messages: EncryptedWebSocketMessage[]
  ): Promise<void> => {
    // Classify messages: space inbox vs other
    const spaceInboxAddresses = getAllSpaceInboxAddresses();
    const spaceInboxSet = new Set(spaceInboxAddresses);

    // Group space messages by spaceId
    const spaceGroups = new Map<string, {
      hubPrivateKey: number[];
      configPrivateKey: number[] | undefined;
      entries: { message: EncryptedWebSocketMessage; ephemeral_public_key: string; envelope: string }[];
    }>();

    let inboxToSpaceMap: Map<string, string>;
    try {
      inboxToSpaceMap = getInboxToSpaceMap();
    } catch {
      return; // Can't batch without map
    }

    for (const msg of messages) {
      if (!msg.encryptedContent || !spaceInboxSet.has(msg.inboxAddress)) continue;

      const spaceId = inboxToSpaceMap.get(msg.inboxAddress);
      if (!spaceId) continue;

      const hubKey = getSpaceKey(spaceId, 'hub');
      if (!hubKey?.privateKey) continue;

      let sealedMessage: Record<string, unknown>;
      try {
        sealedMessage = JSON.parse(msg.encryptedContent) as Record<string, unknown>;
      } catch {
        continue;
      }

      // Extract ephemeral_public_key and envelope from either hub or sync format
      let ephemeralPubKey: string | undefined;
      let envelope: string | undefined;

      if (sealedMessage.type === 'sync') {
        ephemeralPubKey = sealedMessage.ephemeral_public_key as string;
        envelope = sealedMessage.envelope as string;
      } else {
        ephemeralPubKey = sealedMessage.ephemeral_public_key as string;
        envelope = sealedMessage.envelope as string;
      }

      if (!ephemeralPubKey || !envelope) continue;

      if (!spaceGroups.has(spaceId)) {
        const configKey = getSpaceKey(spaceId, 'config');
        spaceGroups.set(spaceId, {
          hubPrivateKey: hexToBytes(hubKey.privateKey),
          configPrivateKey: configKey ? hexToBytes(configKey.privateKey) : undefined,
          entries: [],
        });
      }

      spaceGroups.get(spaceId)!.entries.push({
        message: msg,
        ephemeral_public_key: ephemeralPubKey,
        envelope,
      });
    }

    // Batch unseal each space group
    const cryptoProvider = new NativeCryptoProvider();

    for (const [, group] of spaceGroups) {
      if (group.entries.length === 0) continue;

      try {
        const results = await cryptoProvider.batchUnsealEnvelopes(
          group.hubPrivateKey,
          group.entries.map(e => ({
            ephemeral_public_key: e.ephemeral_public_key,
            envelope: e.envelope,
          })),
          group.configPrivateKey
        );

        // Store successful results in cache
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if ('plaintext' in result) {
            const entry = group.entries[i];
            const cacheKey = `${entry.message.inboxAddress}:${entry.message.timestamp}`;
            if (preUnsealedCacheRef.current.size >= MAX_PRE_UNSEALED_CACHE_SIZE) {
              // Evict oldest entries (first 100)
              const keys = Array.from(preUnsealedCacheRef.current.keys());
              for (let i = 0; i < 100; i++) {
                preUnsealedCacheRef.current.delete(keys[i]);
              }
            }
            preUnsealedCacheRef.current.set(cacheKey, result.plaintext);
          }
          // Errors are silently skipped - handleIncomingMessage will fall back to individual unseal
        }
      } catch {
        // If batch fails, individual processing will still work as fallback
      }
    }
  }, []);

  /**
   * Build the batch input for native processing.
   * Classifies messages as space/DM, gathers crypto state from MMKV.
   */
  const preclassifyAndGatherState = useCallback((
    batch: EncryptedWebSocketMessage[]
  ): { batchInput: BatchProcessInput; nonBatchMessages: EncryptedWebSocketMessage[] } => {
    const spaceInboxAddresses = getAllSpaceInboxAddresses();
    const spaceInboxSet = new Set(spaceInboxAddresses);

    let inboxToSpaceMap: Map<string, string>;
    try {
      inboxToSpaceMap = getInboxToSpaceMap();
    } catch {
      return { batchInput: { user_address: fullUserAddrRef.current || '', space_groups: [], dm_groups: [] }, nonBatchMessages: batch };
    }

    const spaceGroupMap = new Map<string, BatchSpaceGroup>();
    const dmGroupMap = new Map<string, BatchDMGroup>();
    const nonBatchMessages: EncryptedWebSocketMessage[] = [];

    for (const msg of batch) {
      if (!msg.encryptedContent) {
        nonBatchMessages.push(msg);
        continue;
      }

      const isSpaceInbox = spaceInboxSet.has(msg.inboxAddress);
      const isOnDeviceInbox = msg.inboxAddress === ownInboxAddressRef.current;

      if (isSpaceInbox) {
        // Space message - add to space group
        const spaceId = inboxToSpaceMap.get(msg.inboxAddress);
        if (!spaceId) {
          nonBatchMessages.push(msg);
          continue;
        }

        const hubKey = getSpaceKey(spaceId, 'hub');
        if (!hubKey?.privateKey) {
          nonBatchMessages.push(msg);
          continue;
        }

        let sealedMessage: Record<string, unknown>;
        try {
          sealedMessage = JSON.parse(msg.encryptedContent) as Record<string, unknown>;
        } catch {
          nonBatchMessages.push(msg);
          continue;
        }

        const ephemeralPubKey = sealedMessage.ephemeral_public_key as string;
        const envelope = sealedMessage.envelope as string;
        if (!ephemeralPubKey || !envelope) {
          nonBatchMessages.push(msg);
          continue;
        }

        if (!spaceGroupMap.has(spaceId)) {
          const configKey = getSpaceKey(spaceId, 'config');
          const spaceConversationId = `${spaceId}/${spaceId}`;
          const encryptionStates = encryptionStateStorage.getEncryptionStates(spaceConversationId);

          let trState = '';
          let trFallbackState: string | null = null;
          let trStateIsNested = false;

          if (encryptionStates.length > 0) {
            const parsed = JSON.parse(encryptionStates[0].state);
            if (parsed.state && typeof parsed.state === 'string') {
              trState = parsed.state;
              trStateIsNested = true;
            } else {
              trState = encryptionStates[0].state;
            }

            const fallback = encryptionStateStorage.getFallbackState(spaceConversationId, encryptionStates[0].inboxId);
            if (fallback) {
              const fallbackParsed = JSON.parse(fallback.state);
              trFallbackState = (fallbackParsed.state && typeof fallbackParsed.state === 'string')
                ? fallbackParsed.state
                : fallback.state;
            }
          }

          spaceGroupMap.set(spaceId, {
            space_id: spaceId,
            hub_private_key: hexToBytes(hubKey.privateKey),
            config_private_key: configKey ? hexToBytes(configKey.privateKey) : null,
            tr_state: trState,
            tr_fallback_state: trFallbackState,
            tr_state_is_nested: trStateIsNested,
            sent_envelope_fingerprints: [], // Populated below
            messages: [],
          });
        }

        const envelopeType: 'hub' | 'sync' = sealedMessage.type === 'sync' ? 'sync' : 'hub';

        spaceGroupMap.get(spaceId)!.messages.push({
          inbox_address: msg.inboxAddress,
          timestamp: msg.timestamp,
          envelope_type: envelopeType,
          ephemeral_public_key: ephemeralPubKey,
          envelope,
        });
      } else if (isOnDeviceInbox) {
        // DM on device inbox - check if DR envelope for batch processing
        let sealedMessage: Record<string, unknown>;
        try {
          sealedMessage = JSON.parse(msg.encryptedContent) as Record<string, unknown>;
        } catch {
          nonBatchMessages.push(msg);
          continue;
        }

        let envelopeData: Record<string, unknown> | null = null;
        try {
          const envStr = typeof sealedMessage.envelope === 'string' ? sealedMessage.envelope : JSON.stringify(sealedMessage.envelope);
          envelopeData = JSON.parse(envStr) as Record<string, unknown>;
        } catch { /* ignore */ }

        const isDoubleRatchetEnvelope = envelopeData && 'protocol_identifier' in envelopeData;
        const isInitEnvelope = envelopeData && 'ciphertext' in envelopeData && 'initialization_vector' in envelopeData;

        // Both DR and init envelopes on device inbox go through native batch
        const groupKey = `device_inbox:${msg.inboxAddress}`;
        if (!dmGroupMap.has(groupKey)) {
          // Gather all DR states for this inbox
          const statesForInbox = encryptionStateStorage.getStatesByInboxId(msg.inboxAddress);
          const drStates: BatchDRState[] = statesForInbox.map(s => ({
            conversation_id: s.conversationId,
            inbox_id: s.state.inboxId || msg.inboxAddress,
            state: s.state.state,
          }));

          // Get device keys for init envelope processing
          const deviceKeys = encryptionService.getDeviceKeys();

          dmGroupMap.set(groupKey, {
            conversation_id: '', // Multiple possible conversations
            message_type: 'device_inbox',
            device_inbox_private_key: null,
            device_inbox_encryption_private_key: deviceKeys?.inboxEncryptionPrivateKey || null,
            conversation_inbox_private_key: null,
            conversation_inbox_signing_private_key: null,
            identity_private_key: deviceKeys?.identityPrivateKey || [],
            pre_key_private_key: deviceKeys?.preKeyPrivateKey || [],
            dr_states: drStates,
            messages: [],
          });
        }

        dmGroupMap.get(groupKey)!.messages.push({
          inbox_address: msg.inboxAddress,
          timestamp: msg.timestamp,
          encrypted_content: msg.encryptedContent,
          is_double_ratchet_envelope: !!isDoubleRatchetEnvelope && !isInitEnvelope,
          is_init_envelope: !!isInitEnvelope,
        });
      } else {
        // Conversation inbox or unknown - check if we can batch
        const conversationKeypair = encryptionStateStorage.getConversationInboxKeypairByAddress(msg.inboxAddress);
        if (conversationKeypair) {
          let sealedMessage: Record<string, unknown>;
          try {
            sealedMessage = JSON.parse(msg.encryptedContent) as Record<string, unknown>;
          } catch {
            nonBatchMessages.push(msg);
            continue;
          }

          // Check if we have existing states for this conversation
          const existingStates = encryptionStateStorage.getEncryptionStates(conversationKeypair.conversationId);
          if (existingStates.length > 0) {
            const groupKey = `conv_inbox:${msg.inboxAddress}`;
            if (!dmGroupMap.has(groupKey)) {
              const drStates: BatchDRState[] = existingStates.map(s => ({
                conversation_id: s.conversationId,
                inbox_id: s.inboxId || msg.inboxAddress,
                state: s.state,
              }));

              dmGroupMap.set(groupKey, {
                conversation_id: conversationKeypair.conversationId,
                message_type: 'conversation_inbox',
                device_inbox_private_key: null,
                device_inbox_encryption_private_key: null,
                conversation_inbox_private_key: conversationKeypair.encryptionPrivateKey ? Array.from(conversationKeypair.encryptionPrivateKey) : null,
                conversation_inbox_signing_private_key: conversationKeypair.signingPrivateKey ? Array.from(conversationKeypair.signingPrivateKey) : null,
                identity_private_key: [],
                pre_key_private_key: [],
                dr_states: drStates,
                messages: [],
              });
            }

            dmGroupMap.get(groupKey)!.messages.push({
              inbox_address: msg.inboxAddress,
              timestamp: msg.timestamp,
              encrypted_content: msg.encryptedContent,
              // Fast path: assume raw Double Ratchet after unseal. If the
              // inner content turns out to be an InitializationEnvelope (e.g.
              // the peer's session isn't confirmed yet and they still wrap),
              // the native batch returns `unseal_failed` and the fallback in
              // `applyDMGroupResults` routes the message to JS
              // `handleIncomingMessage` which handles both envelope types.
              is_double_ratchet_envelope: true,
              is_init_envelope: false,
            });
          } else {
            // No existing states - init message, fall back to JS
            nonBatchMessages.push(msg);
          }
        } else {
          // Unknown inbox - fall back
          nonBatchMessages.push(msg);
        }
      }
    }

    const batchInput: BatchProcessInput = {
      user_address: fullUserAddrRef.current || '',
      space_groups: Array.from(spaceGroupMap.values()),
      dm_groups: Array.from(dmGroupMap.values()),
    };

    return { batchInput, nonBatchMessages };
  }, []);

  /**
   * Apply space message results from batch native processing.
   * Handles: save to storage, React Query cache updates, reactions, edits, removes, etc.
   */
  const applySpaceGroupResults = useCallback(async (
    results: BatchSpaceGroupResult[],
    batch: EncryptedWebSocketMessage[]
  ) => {
    for (const groupResult of results) {
      const spaceId = groupResult.space_id;
      const spaceInboxKey = getSpaceKey(spaceId, 'inbox');

      // TR state is now written directly by native MMKV — no JS state write needed

      // Process each message result
      const deleteTimestamps: number[] = [];

      // Coalesced reaction/edit updates. During the loop, reaction-add,
      // reaction-remove, and edit handlers queue their changes here instead
      // of writing storage + cache once per item. After the loop we flush:
      // one saveMessage per distinct message (cumulative state, latest wins)
      // and one setQueryData per affected query key (all transforms applied
      // in a single immutable pass).
      const pendingStorageUpdates = new Map<string, Message>();
      const pendingCacheTransforms = new Map<string, {
        queryKey: ReturnType<typeof queryKeys.messages.infinite>;
        transforms: Map<string, ((msg: Message) => Message)[]>;
      }>();
      const queueCacheTransform = (
        queryKey: ReturnType<typeof queryKeys.messages.infinite>,
        messageId: string,
        transform: (msg: Message) => Message,
      ) => {
        const keyHash = JSON.stringify(queryKey);
        let entry = pendingCacheTransforms.get(keyHash);
        if (!entry) {
          entry = { queryKey, transforms: new Map() };
          pendingCacheTransforms.set(keyHash, entry);
        }
        const fns = entry.transforms.get(messageId);
        if (fns) fns.push(transform);
        else entry.transforms.set(messageId, [transform]);
      };

      for (const msgResult of groupResult.messages) {
        deleteTimestamps.push(msgResult.timestamp);

        if (msgResult.status === 'unseal_failed' || msgResult.status === 'decrypt_failed') {
          continue;
        }

        if (msgResult.status === 'self_echo') {
          // Self-echoes of space-call messages still need to be rendered
          // (no optimistic update was added when sending)
          if (msgResult.decrypted_message) {
            try {
              const selfMsg = JSON.parse(msgResult.decrypted_message) as Message;
              if (selfMsg.content?.type === 'space-call-start' || selfMsg.content?.type === 'space-call-end') {
                // Fall through to normal processing below
              } else {
                continue;
              }
            } catch {
              continue;
            }
          } else {
            continue;
          }
        }

        if (msgResult.status === 'control') {
          // Control messages (incl. space-manifest) must be processed by JS for
          // side effects. Two silent drop points used to live here; they're now
          // logged so a control message that never reaches handleIncomingMessage
          // can be traced (relevant to the space-manifest sync investigation).
          if (!msgResult.control_payload) {
            logger.debug(`[batch-control] dropped: status=control but no control_payload (ts=${msgResult.timestamp})`);
            continue;
          }
          // Find the original message in the batch by timestamp
          const originalMsg = batch.find(m => m.timestamp === msgResult.timestamp && m.encryptedContent);
          if (originalMsg) {
            // Re-populate the preUnsealedCacheRef so handleIncomingMessage can use it
            const cacheKey = `${originalMsg.inboxAddress}:${originalMsg.timestamp}`;
            if (preUnsealedCacheRef.current.size >= MAX_PRE_UNSEALED_CACHE_SIZE) {
              // Evict oldest entries (first 100)
              const keys = Array.from(preUnsealedCacheRef.current.keys());
              for (let i = 0; i < 100; i++) {
                preUnsealedCacheRef.current.delete(keys[i]);
              }
            }
            preUnsealedCacheRef.current.set(cacheKey, msgResult.control_payload);
            try {
              await handleIncomingMessage(originalMsg);
            } catch (err) {
              logger.warn(`[batch-control] handleIncomingMessage threw (ts=${msgResult.timestamp}): ${err instanceof Error ? err.message : String(err)}`);
            }
          } else {
            logger.debug(`[batch-control] dropped: no original batch message for ts=${msgResult.timestamp}`);
          }
          continue;
        }

        if ((msgResult.status === 'decrypted' || msgResult.status === 'plaintext') && msgResult.decrypted_message) {
          // Apply decrypted space message
          let spaceMessage: Message;
          try {
            spaceMessage = JSON.parse(msgResult.decrypted_message) as Message;
          } catch {
            continue;
          }

          const space = getSpace(spaceId);
          const channelId = spaceMessage.channelId || space?.defaultChannelId || spaceId;
          const messagesKey = queryKeys.messages.infinite(spaceId, channelId);
          const contentType = spaceMessage.content?.type;

          // Deduplication for regular messages
          if (contentType === 'post' || contentType === 'embed' || contentType === 'sticker') {
            const existingMessage = await storage.getMessage({ spaceId, channelId, messageId: spaceMessage.messageId });
            if (existingMessage) continue;
          }

          // Handle special message types
          if (contentType === 'reaction') {
            const reactionContent = spaceMessage.content as { messageId: string; reaction: string; senderId: string };
            const computeNewReactions = (currentReactions: Message['reactions']) => {
              const reactions = currentReactions || [];
              const existing = reactions.find(r => r.emojiId === reactionContent.reaction);
              if (existing) {
                if (!existing.memberIds.includes(reactionContent.senderId)) {
                  return reactions.map(r => r.emojiId === reactionContent.reaction
                    ? { ...r, count: r.count + 1, memberIds: [...r.memberIds, reactionContent.senderId] }
                    : r);
                }
                return reactions;
              }
              return [...reactions, {
                emojiId: reactionContent.reaction,
                emojiName: reactionContent.reaction,
                spaceId,
                count: 1,
                memberIds: [reactionContent.senderId],
              }];
            };

            queueCacheTransform(messagesKey, reactionContent.messageId, (msg) => (
              { ...msg, reactions: computeNewReactions(msg.reactions) }
            ));

            const baseMsg = pendingStorageUpdates.get(reactionContent.messageId)
              ?? await storage.getMessage({ spaceId, channelId, messageId: reactionContent.messageId });
            if (baseMsg) {
              pendingStorageUpdates.set(reactionContent.messageId, { ...baseMsg, reactions: computeNewReactions(baseMsg.reactions) });
            }
            continue;
          }

          if (contentType === 'remove-reaction') {
            const reactionContent = spaceMessage.content as { messageId: string; reaction: string; senderId: string };
            const computeRemoved = (cur: Message['reactions']) =>
              (cur || []).map(r => r.emojiId === reactionContent.reaction
                ? { ...r, count: r.count - 1, memberIds: r.memberIds.filter(id => id !== reactionContent.senderId) }
                : r).filter(r => r.count > 0);

            queueCacheTransform(messagesKey, reactionContent.messageId, (msg) => (
              { ...msg, reactions: computeRemoved(msg.reactions) }
            ));

            const baseMsg = pendingStorageUpdates.get(reactionContent.messageId)
              ?? await storage.getMessage({ spaceId, channelId, messageId: reactionContent.messageId });
            if (baseMsg) {
              pendingStorageUpdates.set(reactionContent.messageId, { ...baseMsg, reactions: computeRemoved(baseMsg.reactions) });
            }
            continue;
          }

          if (contentType === 'edit-message') {
            const editContent = spaceMessage.content as { originalMessageId: string; editedText: string | string[]; editedAt: number; editNonce?: string };
            // Honor the space's "Save Edit History" setting, matching desktop:
            // when OFF, don't retain prior versions (edits: []). Default false.
            const saveEditHistory = space?.saveEditHistory ?? false;
            const applyEdit = (msg: Message): Message => {
              if (msg.content.type !== 'post') return msg;
              const applied = applyReceivedEdit(msg, {
                newText: editContent.editedText,
                editedAt: editContent.editedAt,
                editNonce: editContent.editNonce,
                saveEditHistory,
              });
              // Replayed edit already applied → leave the message untouched so a
              // duplicate delivery can't wipe stored history.
              if (!applied.changed) return msg;
              return {
                ...msg,
                modifiedDate: applied.modifiedDate,
                lastModifiedHash: applied.lastModifiedHash,
                content: { ...msg.content, text: editContent.editedText },
                edits: applied.edits,
              };
            };
            queueCacheTransform(messagesKey, editContent.originalMessageId, applyEdit);
            // Persist to storage too. Cache-only updates revert as soon as the
            // query refetches from disk (e.g. on remount, invalidate, or when
            // the user navigates away and back), so the edit appears to "snap
            // back" to the original. Match what the cache update did above.
            const baseMsg = pendingStorageUpdates.get(editContent.originalMessageId)
              ?? await storage.getMessage({ spaceId, channelId, messageId: editContent.originalMessageId });
            if (baseMsg && baseMsg.content.type === 'post') {
              pendingStorageUpdates.set(editContent.originalMessageId, applyEdit(baseMsg));
            }
            continue;
          }

          if (contentType === 'remove-message') {
            const removeContent = spaceMessage.content as RemoveMessage;

            // Receive-side permission enforcement — same rule as the live path
            // above. Validate the sender's role before honoring a delete; never
            // trust the sender's client. No isSpaceOwner bypass (receivers can't
            // verify ownership). Self-deletes are filtered upstream as self-echoes,
            // so this won't block legitimate own deletes.
            const targetMessage = await storage.getMessage({
              spaceId,
              channelId,
              messageId: removeContent.removeMessageId,
            });
            if (targetMessage) {
              const channel: Channel | undefined = space?.groups
                ?.find((g) => g.channels.find((c) => c.channelId === channelId))
                ?.channels.find((c) => c.channelId === channelId);
              const checker = createChannelPermissionChecker({
                userAddress: removeContent.senderId,
                isSpaceOwner: false,
                space: space ?? undefined,
                channel,
              });
              if (!checker.canDeleteMessage(targetMessage)) {
                logger.debug(
                  `[BatchMsg] dropped unauthorized remove-message from ${removeContent.senderId?.slice(0, 12)} for ${removeContent.removeMessageId?.slice(0, 12)}`
                );
                continue;
              }
            }

            queryClient.setQueryData<InfiniteMessagesData>(messagesKey, (old) => {
              if (!old) return old;
              return { ...old, pages: old.pages.map(page => ({
                ...page,
                messages: page.messages.filter(msg => msg.messageId !== removeContent.removeMessageId),
              })) };
            });
            await storage.deleteMessage(removeContent.removeMessageId);
            // Drop any queued reaction/edit update for this message so the
            // deferred flush below doesn't resurrect it after deletion.
            pendingStorageUpdates.delete(removeContent.removeMessageId);
            for (const entry of pendingCacheTransforms.values()) {
              entry.transforms.delete(removeContent.removeMessageId);
            }
            continue;
          }

          if (contentType === 'mute') {
            // Moderation-mute — same receive-side enforcement as the live path.
            // Re-validate the sender's user:mute role; no isSpaceOwner bypass;
            // fail-secure when space data is missing; reject self-mute + replays.
            const muteContent = spaceMessage.content as MuteMessage;

            if (
              !muteContent.targetUserId ||
              muteContent.targetUserId === muteContent.senderId ||
              hasMuteId(muteContent.muteId)
            ) {
              continue;
            }
            if (!space) {
              logger.debug('[BatchMsg] dropped mute — space data unavailable (fail-secure)');
              continue;
            }

            const muteChannel: Channel | undefined = space.groups
              ?.find((g) => g.channels.find((c) => c.channelId === channelId))
              ?.channels.find((c) => c.channelId === channelId);
            const muteChecker = createChannelPermissionChecker({
              userAddress: muteContent.senderId,
              isSpaceOwner: false,
              space,
              channel: muteChannel,
            });
            if (!muteChecker.canMuteUser()) {
              logger.debug(
                `[BatchMsg] dropped unauthorized mute from ${muteContent.senderId?.slice(0, 12)} for ${muteContent.targetUserId?.slice(0, 12)}`
              );
              continue;
            }

            if (muteContent.action === 'unmute') {
              removeModMute(spaceId, muteContent.targetUserId);
              markMuteIdSeen(muteContent.muteId);
            } else {
              const now = muteContent.timestamp || Date.now();
              setModMute({
                spaceId,
                targetUserId: muteContent.targetUserId,
                mutedAt: now,
                mutedBy: muteContent.senderId,
                lastMuteId: muteContent.muteId,
                expiresAt:
                  muteContent.duration !== undefined ? now + muteContent.duration : undefined,
              });
            }
            continue;
          }

          if (contentType === 'update-profile') {
            // Mirror of the live handler. Must run BEFORE the default-deny:
            // update-profile is an applied type, not persistable, so without this
            // the connect-time profile re-broadcast would be dropped and the
            // member's profile update would never reach this device.
            const profileContent = spaceMessage.content as {
              senderId: string;
              displayName?: string;
              userIcon?: string;
              bio?: string;
              farcasterFid?: number;
              farcasterUsername?: string;
            };
            const adapter = getMMKVAdapter();
            const existingMember = await adapter.getSpaceMember(spaceId, profileContent.senderId) as
              | (SpaceMember & { profileTimestamp?: number; farcasterFid?: number; farcasterUsername?: string })
              | undefined;
            const ts = spaceMessage.createdDate || Date.now();

            // Skip stale updates.
            if (existingMember?.profileTimestamp && existingMember.profileTimestamp >= ts) {
              continue;
            }

            // Spread-only-if-truthy: an empty string in the wire content
            // means "no change", not "clear it". Same rule as the legacy
            // handler; without it a partial broadcast (e.g. avatar-only)
            // would clobber everyone's stored display name.
            const merged = {
              ...(existingMember ?? {
                address: profileContent.senderId,
                inbox_address: '',
              }),
              // Presence check (not truthy): empty displayName = deliberate
              // per-space-name clear, matching bio + desktop's receiver. See
              // the matching comment in the JS-path handler above.
              ...(profileContent.displayName !== undefined ? { display_name: profileContent.displayName } : {}),
              ...(profileContent.userIcon ? { profile_image: profileContent.userIcon } : {}),
              ...(profileContent.bio !== undefined ? { bio: profileContent.bio } : {}),
              ...(profileContent.farcasterFid !== undefined && profileContent.farcasterFid > 0
                ? { farcasterFid: profileContent.farcasterFid }
                : {}),
              ...(profileContent.farcasterUsername ? { farcasterUsername: profileContent.farcasterUsername } : {}),
              profileTimestamp: ts,
            } as SpaceMember & { profileTimestamp: number; farcasterFid?: number; farcasterUsername?: string };

            await adapter.saveSpaceMember(spaceId, merged);

            queryClient.setQueryData(queryKeys.spaces.members(spaceId), (old: SpaceMember[] | undefined) => {
              if (!old) return old;
              const idx = old.findIndex((m) => m.address === profileContent.senderId);
              if (idx >= 0) return old.map((m, i) => (i === idx ? merged : m));
              return [...old, merged];
            });

            continue;
          }

          // Default-deny — identical rule to the live path, same PERSISTABLE_TYPES
          // set (no divergence). Runs after the applied-type handlers that
          // `continue` earlier.
          if (contentType && !PERSISTABLE_TYPES.has(contentType)) {
            logger.debug(`[BatchMsg] default-deny dropped unsupported type=${contentType}`);
            continue;
          }

          // Moderation-mute enforcement (receive-side) — same rule as the live
          // path. Drop incoming post/embed/sticker from a user muted in this
          // space before the save so it can't resurrect from disk.
          if (
            (contentType === 'post' ||
              contentType === 'embed' ||
              contentType === 'sticker') &&
            'senderId' in spaceMessage.content &&
            spaceMessage.content.senderId &&
            isModMutedUser(spaceId, spaceMessage.content.senderId)
          ) {
            logger.debug(
              `[BatchMsg] dropped message from muted user ${spaceMessage.content.senderId.slice(0, 12)} in ${spaceId?.slice(0, 12)}`
            );
            continue;
          }

          // Read-only channel enforcement (receive-side) — same rule as the
          // live path above. Drop non-manager post/embed/sticker before the
          // save so it can't resurrect from disk.
          if (
            contentType === 'post' ||
            contentType === 'embed' ||
            contentType === 'sticker'
          ) {
            const channel: Channel | undefined = space?.groups
              ?.find((g) => g.channels.find((c) => c.channelId === channelId))
              ?.channels.find((c) => c.channelId === channelId);
            if (channel?.isReadOnly) {
              const senderId = 'senderId' in spaceMessage.content
                ? spaceMessage.content.senderId
                : undefined;
              const canPost = !!senderId
                && canManageReadOnlyChannel(senderId, false, space ?? undefined, channel);
              if (!canPost) {
                logger.debug(
                  `[BatchMsg] dropped read-only-channel post from ${senderId?.slice(0, 12)} in ${channelId?.slice(0, 12)}`
                );
                continue;
              }
            }
          }

          // Regular message - save and update cache
          await storage.saveMessage(
            { ...spaceMessage, spaceId, channelId },
            spaceMessage.createdDate || Date.now(),
            spaceId, 'space',
            space?.iconUrl || '',
            space?.spaceName || spaceId.substring(0, 8)
          );

          // Muted channel/space → no in-app badge (same gate as push).
          const notifyForBadge = shouldNotifyForContext({ spaceId, channelId });

          // Mentions/replies persisted by logMentionOrReply below (catch-up
          // path) — same single source of truth as the live path.

          // Track last space activity for inbox sorting + preview
          {
            const preview = getSpaceMessagePreview(spaceMessage);
            const senderId = ('senderId' in spaceMessage.content ? spaceMessage.content.senderId : undefined);
            const senderMember = spaceId && senderId ? await storage.getSpaceMember(spaceId, senderId) : undefined;
            const senderName = messageSenderName(
              senderId,
              fullUserAddrRef.current ?? undefined,
              senderId && senderMember ? { [senderId]: senderMember } : undefined
            );
            recordSpaceActivity(spaceId, {
              timestamp: spaceMessage.createdDate || Date.now(),
              preview,
              senderName,
              channelId,
            });
          }

          // Persist mentions/replies into the notifications inbox log — catch-up
          // path. Same helper as the live path; the log dedups by message id so
          // a message seen on both paths produces ONE row.
          void logMentionOrReply(spaceMessage, {
            spaceId,
            channelId,
            userAddress: fullUserAddrRef.current,
            space: space ?? undefined,
            channelName: space?.groups
              ?.flatMap((g) => g.channels)
              .find((c) => c.channelId === channelId)?.channelName,
            notifyForBadge,
            getSpaceMember: (sid, mid) => storage.getSpaceMember(sid, mid),
          });

          queryClient.setQueryData<InfiniteMessagesData>(messagesKey, (old) => {
            // No existing cache — leave it alone (saveMessage above wrote
            // to MMKV; next mount loads the full history from disk).
            if (!old) return old;
            if (old.pages.some(page => page.messages.some(m => m.messageId === spaceMessage.messageId))) return old;
            return { ...old, pages: old.pages.map((page, i) => i === 0 ? { ...page, messages: [...page.messages, spaceMessage] } : page) };
          });
        }
      }

      // Flush coalesced reaction/edit cache updates: one setQueryData per
      // affected query key, applying every queued transform in a single
      // immutable pass. No existing cache — leave it alone (same as before).
      for (const { queryKey: messagesKey, transforms } of pendingCacheTransforms.values()) {
        if (transforms.size === 0) continue;
        queryClient.setQueryData<InfiniteMessagesData>(messagesKey, (old) => {
          if (!old) return old;
          return { ...old, pages: old.pages.map(page => ({
            ...page,
            messages: page.messages.map(msg => {
              const fns = transforms.get(msg.messageId);
              if (!fns) return msg;
              return fns.reduce((m, fn) => fn(m), msg);
            }),
          })) };
        });
      }

      // Flush coalesced storage updates: one saveMessage per distinct message.
      for (const updated of pendingStorageUpdates.values()) {
        await storage.saveMessage(updated, updated.createdDate, '', '', '', '');
      }

      // Best-effort: batch delete processed messages from inbox
      if (deleteTimestamps.length > 0 && spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
        deleteSpaceInboxMessages(
          spaceInboxKey.address,
          deleteTimestamps,
          { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
        ).catch(() => {});
      }
    }
  }, [queryClient, storage, handleIncomingMessage]);

  /**
   * Apply DM message results from batch native processing.
   */
  const applyDMGroupResults = useCallback(async (
    results: BatchProcessOutput['dm_results'],
    batch: EncryptedWebSocketMessage[]
  ) => {
    // Collect messages the native batch couldn't handle so we can fall back
    // to the full JS handleIncomingMessage path. The common case that
    // reaches the fallback: the peer's session isn't confirmed yet, so they
    // wrap their reply in an InitializationEnvelope inside a conversation
    // inbox seal — the batch's DR-only path returns `unseal_failed`.
    const fallbackMessages: EncryptedWebSocketMessage[] = [];
    const processedKeys = new Set<string>();
    const batchKey = (m: EncryptedWebSocketMessage) => `${m.inboxAddress}:${m.timestamp}`;

    for (const groupResult of results) {
      // DR states and init session state are now written directly by native MMKV — no JS state write needed

      // Subscribe to new conversation inbox if init created one
      if (groupResult.new_conversation_inbox) {
        const client = wsClientRef.current;
        if (client && client.isConnected) {
          await client.subscribe([groupResult.new_conversation_inbox]);
        }
        subscribedInboxesRef.current.add(groupResult.new_conversation_inbox);
      }

      // Process each DM message result
      for (const msgResult of groupResult.messages) {
        if ((msgResult.status !== 'decrypted' && msgResult.status !== 'init_decrypted') || !msgResult.decrypted_message) {
          // Batch couldn't decrypt. Most common reason: conversation-inbox
          // message where the inner unsealed content is an
          // InitializationEnvelope rather than a raw DR envelope. Route it
          // back to the JS path which correctly handles both.
          if (msgResult.timestamp != null) {
            const original = batch.find(
              (m) =>
                m.timestamp === msgResult.timestamp &&
                !processedKeys.has(batchKey(m)),
            );
            if (original) {
              fallbackMessages.push(original);
              processedKeys.add(batchKey(original));
            }
          }
          continue;
        }
        if (msgResult.timestamp != null) {
          const original = batch.find((m) => m.timestamp === msgResult.timestamp);
          if (original) processedKeys.add(batchKey(original));
        }

        let conversationId = msgResult.conversation_id || groupResult.conversation_id;
        let decryptedMessage: Message;
        try {
          decryptedMessage = JSON.parse(msgResult.decrypted_message) as Message;
        } catch {
          continue;
        }

        // Intercept call signaling messages — forward to CallContext, don't display in chat.
        // call-event passes through to render in chat history.
        if (decryptedMessage.content?.type?.startsWith('call-') && decryptedMessage.content?.type !== 'call-event') {
          callSignalingHandlerRef.current?.(decryptedMessage);
          // Best-effort: delete from server so stale signals don't replay on next launch
          const originalMsg = batch.find(m => m.timestamp === msgResult.timestamp);
          if (originalMsg) {
            getDeviceKeyset().then(dk => {
              if (dk) deleteInboxMessages(originalMsg.inboxAddress, [originalMsg.timestamp], dk).catch(() => {});
            });
          }
          continue;
        }

        // Handle same-user multi-device sync. A true (pre-rewrite) sender === us
        // means our own message echoed from another device; its user_profile is
        // OURS, not the partner's (see the JS path's self-sync guard).
        const senderAddress = conversationId.split('/')[0];
        const isSelfSyncEcho = senderAddress === fullUserAddrRef.current;
        if (isSelfSyncEcho && decryptedMessage.channelId) {
          const actualRecipient = decryptedMessage.channelId;
          conversationId = `${actualRecipient}/${actualRecipient}`;
        } else if (isSelfSyncEcho) {
          // Channel-less self-echo — can't attribute to a partner, nothing to
          // display. Drop it so it can't create a self-address conversation row.
          continue;
        }

        // Intercept dm-update-profile control messages — same as the JS path.
        // Update the partner's conversation row in place, never persist as a
        // post. senderAddress here is the (post-self-sync) conversation owner.
        const batchProfileSender = conversationId.split('/')[0];
        if (await applyDmProfileUpdate(decryptedMessage, batchProfileSender)) {
          const originalMsg = batch.find(m => m.timestamp === msgResult.timestamp);
          if (originalMsg) {
            getDeviceKeyset().then(dk => {
              if (dk) deleteInboxMessages(originalMsg.inboxAddress, [originalMsg.timestamp], dk).catch(() => {});
            });
          }
          continue;
        }

        const resolvedSenderAddress = conversationId.split('/')[0];

        // delete-conversation: counterparty deleted this DM. Reset our encryption
        // session only (next message re-handshakes); do NOT delete our copy.
        // Before the conversation-save below so it can't resurrect a deleted row.
        if (decryptedMessage.content?.type === 'delete-conversation') {
          encryptionStateStorage.deleteAllEncryptionStates(conversationId);

          // Best-effort: clear the processed control message from the inbox.
          const originalDeleteMsg = batch.find(m => m.timestamp === msgResult.timestamp);
          if (originalDeleteMsg) {
            const conversationKeypair = encryptionStateStorage.getConversationInboxKeypairByAddress(originalDeleteMsg.inboxAddress);
            if (conversationKeypair?.signingPrivateKey && conversationKeypair?.signingPublicKey) {
              const signingKey = {
                publicKey: bytesToHex(conversationKeypair.signingPublicKey),
                privateKey: bytesToHex(conversationKeypair.signingPrivateKey),
              };
              deleteConversationInboxMessages(originalDeleteMsg.inboxAddress, [originalDeleteMsg.timestamp], signingKey).catch(() => {});
            } else {
              getDeviceKeyset().then(dk => {
                if (dk) deleteInboxMessages(originalDeleteMsg.inboxAddress, [originalDeleteMsg.timestamp], dk).catch(() => {});
              });
            }
          }
          continue;
        }

        // delete-conversation-self: self-device delete-sync (desktop sends it).
        // Mobile doesn't implement the wipe yet — drop it so it isn't saved as a
        // ghost row. Forward-compat until mobile Part 2 lands. Never act on it
        // from a non-self sender regardless.
        if ((decryptedMessage.content?.type as string) === 'delete-conversation-self') {
          const originalSelfMsg = batch.find(m => m.timestamp === msgResult.timestamp);
          if (originalSelfMsg) {
            getDeviceKeyset().then(dk => {
              if (dk) deleteInboxMessages(originalSelfMsg.inboxAddress, [originalSelfMsg.timestamp], dk).catch(() => {});
            });
          }
          continue;
        }

        // Save conversation. On a self-sync echo ignore our own profile for the
        // row identity (see the JS path's self-sync guard).
        const rowProfile = isSelfSyncEcho ? undefined : msgResult.user_profile;
        const existingConversation = await storage.getConversation(conversationId);
        const senderDisplayName = rowProfile?.display_name || existingConversation?.displayName || resolvedSenderAddress.substring(0, 8);
        const senderIcon = rowProfile?.user_icon || existingConversation?.icon || '';
        // Typed preview (icon + text, no emoji) — see the live DM path above.
        const messagePreview = getSpaceMessagePreview(decryptedMessage);

        if (!existingConversation) {
          const newConversation: Conversation = {
            conversationId,
            address: resolvedSenderAddress,
            displayName: senderDisplayName,
            icon: senderIcon,
            timestamp: decryptedMessage.createdDate || Date.now(),
            type: 'direct',
            lastMessagePreview: messagePreview,
            lastMessageSenderName: senderDisplayName,
          };
          await storage.saveConversation(newConversation);
        } else {
          const updatedConversation: Conversation = {
            ...existingConversation,
            displayName: senderDisplayName,
            icon: senderIcon,
            timestamp: decryptedMessage.createdDate || Date.now(),
            lastMessagePreview: messagePreview,
            lastMessageSenderName: senderDisplayName,
          };
          await storage.saveConversation(updatedConversation);
        }

        const messagesKey = queryKeys.messages.infinite(resolvedSenderAddress, resolvedSenderAddress);

        // Reactions are control messages, not standalone chat entries — they
        // fold into the target message's `reactions` field. Without this
        // branch the peer's reaction would be saved as a ghost message and
        // never appear on the target. Mirrors the space-side handler at
        // applySpaceGroupResults (reaction / remove-reaction).
        const dmContentType = decryptedMessage.content?.type;
        if (dmContentType === 'reaction' || dmContentType === 'remove-reaction') {
          const rc = decryptedMessage.content as { messageId: string; reaction: string; senderId: string };
          const apply = (cur: Message['reactions']): Message['reactions'] => {
            const reactions = cur || [];
            if (dmContentType === 'reaction') {
              const existing = reactions.find(r => r.emojiId === rc.reaction || r.emojiName === rc.reaction);
              if (existing) {
                if (existing.memberIds.includes(rc.senderId)) return reactions;
                return reactions.map(r => r === existing
                  ? { ...r, count: r.count + 1, memberIds: [...r.memberIds, rc.senderId] }
                  : r);
              }
              return [...reactions, {
                emojiId: rc.reaction,
                emojiName: rc.reaction,
                spaceId: resolvedSenderAddress,
                count: 1,
                memberIds: [rc.senderId],
              }];
            }
            // remove-reaction
            return reactions
              .map(r => {
                if (r.emojiId !== rc.reaction && r.emojiName !== rc.reaction) return r;
                const newMembers = r.memberIds.filter(id => id !== rc.senderId);
                if (newMembers.length === 0) return null;
                return { ...r, count: newMembers.length, memberIds: newMembers };
              })
              .filter((r): r is NonNullable<typeof r> => r !== null);
          };

          queryClient.setQueryData<InfiniteMessagesData>(messagesKey, (old) => {
            if (!old) return old;
            return { ...old, pages: old.pages.map(page => ({
              ...page,
              messages: page.messages.map(msg =>
                msg.messageId === rc.messageId ? { ...msg, reactions: apply(msg.reactions) } : msg
              ),
            })) };
          });

          const targetMsg = await storage.getMessage({
            spaceId: resolvedSenderAddress,
            channelId: resolvedSenderAddress,
            messageId: rc.messageId,
          });
          if (targetMsg) {
            await storage.saveMessage(
              { ...targetMsg, reactions: apply(targetMsg.reactions) },
              targetMsg.createdDate,
              resolvedSenderAddress, 'direct', senderIcon, senderDisplayName,
            );
          }

          // Best-effort: delete processed message from inbox (same as below)
          const originalReactionMsg = batch.find(m => m.timestamp === msgResult.timestamp);
          if (originalReactionMsg) {
            const conversationKeypair = encryptionStateStorage.getConversationInboxKeypairByAddress(originalReactionMsg.inboxAddress);
            if (conversationKeypair?.signingPrivateKey && conversationKeypair?.signingPublicKey) {
              // Hex-encode the byte-array keypair to match the signing-key shape
              // (same as the post path below).
              const signingKey = {
                publicKey: bytesToHex(conversationKeypair.signingPublicKey),
                privateKey: bytesToHex(conversationKeypair.signingPrivateKey),
              };
              deleteConversationInboxMessages(originalReactionMsg.inboxAddress, [originalReactionMsg.timestamp], signingKey).catch(() => {});
            } else {
              getDeviceKeyset().then(dk => {
                if (dk) deleteInboxMessages(originalReactionMsg.inboxAddress, [originalReactionMsg.timestamp], dk).catch(() => {});
              });
            }
          }
          continue;
        }

        // remove-message: delete-for-everyone control message. Fold it (don't
        // persist as a ghost post), authorizing per the check below.
        if (dmContentType === 'remove-message') {
          const removeContent = decryptedMessage.content as RemoveMessage;
          const targetMsg = await storage.getMessage({
            spaceId: resolvedSenderAddress,
            channelId: resolvedSenderAddress,
            messageId: removeContent.removeMessageId,
          });

          // Auth: deleter must be the target's author. "Deleter" is the
          // session-authenticated sender (pre-self-sync `senderAddress`), NOT
          // the spoofable payload `senderId` — else a peer could claim your
          // address and delete a message you wrote. Pre-self-sync keeps your own
          // echo authorized (it's you, deleting your own message).
          const authenticatedSender = senderAddress;
          const authorized = removeContent.senderId === authenticatedSender &&
            (!targetMsg || targetMsg.content?.senderId === authenticatedSender);

          if (authorized && targetMsg) {
            queryClient.setQueryData<InfiniteMessagesData>(messagesKey, (old) => {
              if (!old) return old;
              return { ...old, pages: old.pages.map(page => ({
                ...page,
                messages: page.messages.filter(msg => msg.messageId !== removeContent.removeMessageId),
              })) };
            });
            await storage.deleteMessage(removeContent.removeMessageId);
            // Refresh the conversation row so its lastMessagePreview isn't stale
            // when the deleted message was the latest. Matches the fallback path.
            scheduleConversationRefresh(conversationId);
          } else if (!authorized) {
            logger.debug(
              `[DM] dropped unauthorized remove-message from ${removeContent.senderId?.slice(0, 12)} for ${removeContent.removeMessageId?.slice(0, 12)}`
            );
          }

          // Best-effort: delete processed control message from inbox (same as
          // the reaction branch / the post path below).
          const originalRemoveMsg = batch.find(m => m.timestamp === msgResult.timestamp);
          if (originalRemoveMsg) {
            const conversationKeypair = encryptionStateStorage.getConversationInboxKeypairByAddress(originalRemoveMsg.inboxAddress);
            if (conversationKeypair?.signingPrivateKey && conversationKeypair?.signingPublicKey) {
              const signingKey = {
                publicKey: bytesToHex(conversationKeypair.signingPublicKey),
                privateKey: bytesToHex(conversationKeypair.signingPrivateKey),
              };
              deleteConversationInboxMessages(originalRemoveMsg.inboxAddress, [originalRemoveMsg.timestamp], signingKey).catch(() => {});
            } else {
              getDeviceKeyset().then(dk => {
                if (dk) deleteInboxMessages(originalRemoveMsg.inboxAddress, [originalRemoveMsg.timestamp], dk).catch(() => {});
              });
            }
          }
          continue;
        }

        // Save message
        await storage.saveMessage(
          { ...decryptedMessage, spaceId: resolvedSenderAddress, channelId: resolvedSenderAddress },
          decryptedMessage.createdDate || Date.now(),
          resolvedSenderAddress, 'direct', senderIcon, senderDisplayName
        );

        // Update React Query cache
        queryClient.setQueryData<InfiniteMessagesData>(messagesKey, (old) => {
          // No existing cache — leave it alone (the message is already in
          // MMKV; next mount reads the full history from disk).
          if (!old) return old;
          if (old.pages.some(page => page.messages.some(m => m.messageId === decryptedMessage.messageId))) return old;
          return { ...old, pages: old.pages.map((page, i) => i === 0 ? { ...page, messages: [...page.messages, decryptedMessage] } : page) };
        });

        // Refresh active conversation queries (data already saved to
        // storage). Debounced/coalesced so a catch-up flood doesn't fire
        // one refetch+re-render per message — see scheduleConversationRefresh.
        scheduleConversationRefresh(conversationId);

        // Best-effort: delete processed message from inbox
        const originalMsg = batch.find(m => m.timestamp === msgResult.timestamp);
        if (originalMsg) {
          const conversationKeypair = encryptionStateStorage.getConversationInboxKeypairByAddress(originalMsg.inboxAddress);
          if (conversationKeypair?.signingPrivateKey && conversationKeypair?.signingPublicKey) {
            const signingKey = {
              publicKey: bytesToHex(conversationKeypair.signingPublicKey),
              privateKey: bytesToHex(conversationKeypair.signingPrivateKey),
            };
            deleteConversationInboxMessages(originalMsg.inboxAddress, [originalMsg.timestamp], signingKey).catch(() => {});
          } else {
            getDeviceKeyset().then(dk => {
              if (dk) deleteInboxMessages(originalMsg.inboxAddress, [originalMsg.timestamp], dk).catch(() => {});
            });
          }
        }
      }
    }

    // Fallback: run the full JS path for any batch messages the native
    // processor couldn't decrypt. This catches the init-envelope-wrapped-in-
    // conversation-inbox case among others.
    const meFb = fullUserAddrRef.current?.slice(0, 8) ?? '???';
    if (fallbackMessages.length > 0) {
      logger.debug(
        `[DM-fallback ${meFb}] batch failed for ${fallbackMessages.length} msg(s), routing to JS`,
        fallbackMessages.map((m) => ({
          inboxAddress: m.inboxAddress.substring(0, 12) + '...',
          timestamp: m.timestamp,
        })),
      );
    }
    for (const msg of fallbackMessages) {
      try {
        await handleIncomingMessage(msg);
      } catch (err) {
        logger.debug(`[DM-fallback ${meFb}] handleIncomingMessage threw`, err);
      }
    }
  }, [queryClient, storage, handleIncomingMessage, applyDmProfileUpdate]);

  /**
   * Process message queue with throttling to prevent CPU overload
   * Uses batch native processing for space, DM, and init messages (1 bridge crossing per batch)
   * Falls back to individual handleIncomingMessage for control messages and edge cases
   */
  const processMessageQueue = useCallback(async () => {
    if (isProcessingQueueRef.current) return;
    isProcessingQueueRef.current = true;

    while (messageQueueRef.current.length > 0) {
      // Drain a bounded slice (not the whole queue) so the per-iteration
      // working set — batchInput + its JSON.stringify + native parse +
      // results — stays flat. The loop keeps going until the queue is
      // empty; see MAX_BATCH_DRAIN_SIZE for why this matters on small
      // devices.
      const batch = messageQueueRef.current.splice(0, MAX_BATCH_DRAIN_SIZE);

      try {
        // Classify messages and gather crypto state
        const { batchInput, nonBatchMessages } = preclassifyAndGatherState(batch);

        // Diagnostic: log how each incoming batch gets routed so we can see
        // whether DM messages are reaching the native fast path or the JS
        // slow path.
        const me = fullUserAddrRef.current?.slice(0, 8) ?? '???';
        if (WS_TRACE && batch.length > 0) {
          logger.debug(
            `[DM-classify ${me}]`,
            JSON.stringify({
              total: batch.length,
              inboxes: batch.map((m) => m.inboxAddress.slice(0, 12)),
              space_groups: batchInput.space_groups.length,
              dm_groups: batchInput.dm_groups.map((g) => ({
                type: g.message_type,
                conv: g.conversation_id?.slice(0, 12),
                msgs: g.messages.length,
                states: g.dr_states.length,
                stateInboxIds: g.dr_states.map((s) => s.inbox_id.slice(0, 12)),
              })),
              nonBatch: nonBatchMessages.map((m) => ({
                inbox: m.inboxAddress.slice(0, 12),
                ts: m.timestamp,
              })),
            }),
          );
        }

        // Process batch natively if there are batchable messages
        if (batchInput.space_groups.length > 0 || batchInput.dm_groups.length > 0) {
          const cryptoProvider = new NativeCryptoProvider();
          const batchOutput = await cryptoProvider.batchProcessMessages(batchInput);

          if (WS_TRACE && batchOutput.dm_results.length > 0) {
            logger.debug(
              `[DM-batch-result ${me}]`,
              JSON.stringify(
                batchOutput.dm_results.map((r) => ({
                  conv: r.conversation_id?.slice(0, 12),
                  msgs: r.messages.map((m) => ({
                    status: m.status,
                    ts: m.timestamp,
                    hasMsg: !!m.decrypted_message,
                  })),
                })),
              ),
            );
          }

          // Apply results
          if (batchOutput.space_results.length > 0) {
            await applySpaceGroupResults(batchOutput.space_results, batch);
          }
          if (batchOutput.dm_results.length > 0) {
            await applyDMGroupResults(batchOutput.dm_results, batch);
          }
        }

        // Process non-batchable messages (control messages, edge cases) individually
        for (let i = 0; i < nonBatchMessages.length; i++) {
          // Yield to UI thread every 5 messages to prevent jank
          if (i % 5 === 0) {
            await new Promise<void>(resolve => {
              InteractionManager.runAfterInteractions(() => resolve());
            });
          }

          try {
            await handleIncomingMessage(nonBatchMessages[i]);
          } catch { /* ignore */ }

          // Brief yield between messages only if more work remains
          if (i < nonBatchMessages.length - 1 || messageQueueRef.current.length > 0) {
            await new Promise(resolve => setTimeout(resolve, MESSAGE_PROCESS_DELAY_MS));
          }
        }
      } catch (batchError) {
        // Fallback: if batch processing fails entirely, process all individually
        await batchPreUnsealSpaceMessages(batch);
        for (const message of batch) {
          await new Promise<void>(resolve => {
            InteractionManager.runAfterInteractions(() => resolve());
          });
          try {
            await handleIncomingMessage(message);
          } catch { /* ignore */ }
        }
      }

      // Per-hub log cursor advance: after a batch is fully drained, scan for
      // synthetic messages tagged with their log seq. Advance the cursor only
      // along a contiguous run from the prior cursor — if there's a gap (e.g.
      // queue-overflow dropped older entries), stop at the gap so the next
      // log-since refetches what we lost. Doing this AFTER persistence means
      // a crash mid-batch leaves the cursor unchanged.
      const seqsByHub = new Map<string, number[]>();
      for (const msg of batch) {
        const m = msg as { __logSeq?: number; __logHub?: string };
        if (m.__logSeq && m.__logHub) {
          const list = seqsByHub.get(m.__logHub) ?? [];
          list.push(m.__logSeq);
          seqsByHub.set(m.__logHub, list);
        }
      }
      seqsByHub.forEach((seqs, hub) => {
        seqs.sort((a, b) => a - b);
        let advance = getHubLastSeq(hub);
        for (const seq of seqs) {
          if (seq <= advance) continue;
          if (seq === advance + 1) advance = seq;
          else break; // gap — stop and let next log-since refetch
        }
        if (advance > getHubLastSeq(hub)) setHubLastSeq(hub, advance);
      });

      // Yield between drains so this slice's batchInput/stringify/result
      // allocations are reclaimed before the next slice builds — keeps
      // peak RSS flat across a large catch-up instead of stacking.
      if (messageQueueRef.current.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    isProcessingQueueRef.current = false;
  }, [handleIncomingMessage, batchPreUnsealSpaceMessages, preclassifyAndGatherState, applySpaceGroupResults, applyDMGroupResults]);

  /**
   * Throttled message handler - queues messages for processing
   * This prevents the UI from freezing when many messages arrive at once
   */
  const throttledMessageHandler = useCallback((message: EncryptedWebSocketMessage) => {
    const me = fullUserAddrRef.current?.slice(0, 8) ?? '???';
    // Diagnostic: confirm WS messages are reaching the client at all.
    if ('error' in message && message.error) {
      logger.debug(`[WS-in ${me}] error msg`, message.error);
      return;
    }

    // Per-space log transport frames carry a `type` discriminator and no
    // encryptedContent — route them before the decrypt pipeline.
    const frameType = (message as any).type;
    if (
      frameType === 'log-update' ||
      frameType === 'log-append-ack' ||
      frameType === 'log-since-result'
    ) {
      const hubAddress = (message as any).hub_address as string | undefined;
      const seqOrCount = frameType === 'log-since-result'
        ? `entries=${(message as any).entries?.length ?? 0} hasMore=${(message as any).has_more}`
        : `seq=${(message as any).seq}`;
      logger.debug(`[WS-in ${me}] ${frameType} hub=${hubAddress?.slice(0, 12) ?? '?'} ${seqOrCount}`);
      const handlers = logFrameHandlersRef.current;
      handlers.forEach((h) => {
        try { h(message as unknown as LogFrame); }
        catch (e) { logger.warn('[WS-in] log handler threw', e); }
      });
      return;
    }

    logger.debug(
      `[WS-in ${me}] inbox=${message.inboxAddress?.slice(0, 12)}... ts=${message.timestamp}`,
    );
    // Backpressure: drop oldest messages if queue is overloaded
    if (messageQueueRef.current.length >= MAX_MESSAGE_QUEUE_SIZE) {
      messageQueueRef.current.splice(0, messageQueueRef.current.length - MAX_MESSAGE_QUEUE_SIZE + 1);
    }
    messageQueueRef.current.push(message);
    // Start processing if not already in progress
    processMessageQueue();
  }, [processMessageQueue]);

  /**
   * Resubscribe to all previously subscribed inboxes
   * Called after reconnection
   *
   * Like desktop, we need to:
   * 1. Subscribe to device inbox
   * 2. Subscribe to all conversation-specific inboxes from stored keypairs
   * 3. Subscribe to all space inboxes for receiving space messages
   */
  const handleResubscribe = useCallback(async () => {
    const client = wsClientRef.current;
    if (!client || !client.isConnected) return;

    // Collect all inboxes we need to subscribe to
    const inboxes = new Set<string>();

    // Add device inbox
    if (ownInboxAddressRef.current) {
      inboxes.add(ownInboxAddressRef.current);
    }

    // Add any inboxes we were tracking in memory
    subscribedInboxesRef.current.forEach((addr) => inboxes.add(addr));

    // Add all conversation-specific inboxes from stored keypairs
    // These are inboxes we created when initiating conversations
    const conversationInboxes = encryptionStateStorage.getAllConversationInboxAddresses();
    for (const addr of conversationInboxes) {
      inboxes.add(addr);
    }

    // Add all space inboxes for receiving space/hub messages
    const spaceInboxes = getAllSpaceInboxAddresses();
    for (const addr of spaceInboxes) {
      inboxes.add(addr);
    }

    const inboxArray = Array.from(inboxes);
    const me = fullUserAddrRef.current?.slice(0, 8) ?? '???';
    logger.debug(
      `[WS-sub ${me}] resubscribing to ${inboxArray.length} inbox(es):`,
      JSON.stringify({
        deviceInbox: ownInboxAddressRef.current?.slice(0, 16) ?? null,
        all: inboxArray.map((a) => a.slice(0, 16)),
      }),
    );
    if (inboxArray.length > 0) {
      await client.subscribe(inboxArray);
    }
  }, []);

  /**
   * Get or create WebSocket client
   */
  const getOrCreateClient = useCallback(() => {
    if (wsClientRef.current) {
      return wsClientRef.current;
    }

    const config = getApiConfig();

    const client = createRNWebSocketClient({
      url: config.wsUrl,
      reconnectInterval: 2000,
      maxReconnectAttempts: Infinity,
      queueProcessInterval: 500,
    });

    // Set up handlers - use throttled handler to prevent CPU overload
    client.setMessageHandler(throttledMessageHandler);
    client.setResubscribeHandler(handleResubscribe);

    // Track state changes
    client.onStateChange((state) => {
      setConnectionState(state);
    });

    client.onError((error) => {
    });

    wsClientRef.current = client;
    return client;
  }, [throttledMessageHandler, handleResubscribe]);

  /**
   * Connect to WebSocket server
   */
  const connect = useCallback(async () => {
    // First, initialize device keys
    const keysReady = await initializeDeviceKeys();
    if (!keysReady) {
      return;
    }

    const client = getOrCreateClient();
    await client.connect();

    // Subscribe to own inbox to receive messages
    // Note: ownInboxAddressRef is set in initializeDeviceKeys
    const ownInboxAddress = ownInboxAddressRef.current;
    if (ownInboxAddress) {
      try {
        await client.subscribe([ownInboxAddress]);
        subscribedInboxesRef.current.add(ownInboxAddress);
      } catch (error) {
        // Failed to subscribe to device inbox
      }
    }

    // Subscribe to all space inboxes for receiving space/hub messages
    const spaceInboxes = getAllSpaceInboxAddresses();
    if (spaceInboxes.length > 0) {
      try {
        await client.subscribe(spaceInboxes);
        spaceInboxes.forEach((addr) => subscribedInboxesRef.current.add(addr));
      } catch (error) {
        // Failed to subscribe to space inboxes
      }
    }

    // Subscribe to all conversation inboxes
    const conversationInboxes = encryptionStateStorage.getAllConversationInboxAddresses();
    if (conversationInboxes.length > 0) {
      try {
        await client.subscribe(conversationInboxes);
        conversationInboxes.forEach((addr) => subscribedInboxesRef.current.add(addr));
      } catch (error) {
        // Failed to subscribe to conversation inboxes
      }
    }
  }, [getOrCreateClient, initializeDeviceKeys]);

  /**
   * Disconnect from WebSocket server
   */
  const disconnect = useCallback(() => {
    const client = wsClientRef.current;
    if (client) {
      client.disconnect();
    }
  }, []);

  /**
   * Enqueue an outbound message for sending
   */
  const enqueueOutbound = useCallback(
    (prepareMessage: () => Promise<string[]>) => {
      const client = wsClientRef.current;
      const me = fullUserAddrRef.current?.slice(0, 8) ?? '???';
      if (!client) {
        logger.debug(`[WS-send ${me}] dropped — no client`);
        return;
      }
      // Wrap to log what's actually going on the wire.
      client.enqueueOutbound(async () => {
        let envelopes: string[] = [];
        try {
          envelopes = await prepareMessage();
        } catch (err) {
          logger.debug(`[WS-send ${me}] prepareMessage threw`, err);
          throw err;
        }
        for (const env of envelopes) {
          try {
            const parsed = JSON.parse(env) as Record<string, unknown>;
            logger.debug(
              `[WS-send ${me}] inbox=${String(parsed.inbox_address ?? '???').slice(0, 12)} hub=${String(parsed.hub_address ?? '').slice(0, 12)} keys=${Object.keys(parsed).slice(0, 8).join(',')}`,
            );
          } catch {
            logger.debug(`[WS-send ${me}] non-JSON envelope (${env.length} chars)`);
          }
        }
        return envelopes;
      });
    },
    []
  );

  /**
   * Subscribe to inbox addresses
   */
  const subscribe = useCallback(async (inboxAddresses: string[]) => {
    const client = wsClientRef.current;
    const me = fullUserAddrRef.current?.slice(0, 8) ?? '???';
    logger.debug(
      `[WS-sub ${me}] subscribe request for:`,
      inboxAddresses.map((a) => a.slice(0, 12)),
      'connected=', !!client?.isConnected,
    );
    if (!client || !client.isConnected) {
      // Queue for later subscription
      inboxAddresses.forEach((addr) => subscribedInboxesRef.current.add(addr));
      return;
    }

    await client.subscribe(inboxAddresses);
    inboxAddresses.forEach((addr) => subscribedInboxesRef.current.add(addr));
  }, []);

  /**
   * Unsubscribe from inbox addresses
   */
  const unsubscribe = useCallback(async (inboxAddresses: string[]) => {
    const client = wsClientRef.current;
    if (client?.isConnected) {
      await client.unsubscribe(inboxAddresses);
    }

    inboxAddresses.forEach((addr) => subscribedInboxesRef.current.delete(addr));
  }, []);

  // triggerSyncRequest removed — peer-to-peer mesh sync is gone. Catch-up
  // is handled exclusively by the per-hub log transport (listen-hub +
  // log-since). Joiners do not request history from peers.

  // Connect/disconnect based on auth state
  useEffect(() => {
    if (isAuthenticated && user) {
      connect();
    } else {
      disconnect();
      deviceKeysInitialized.current = false;
    }

    return () => {
      disconnect();
    };
  }, [isAuthenticated, user, connect, disconnect]);

  // Handle app state changes (reconnect when app comes to foreground)
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'active' && isAuthenticated) {
        // Reconnect if disconnected
        const client = wsClientRef.current;
        if (client && !client.isConnected) {
          connect();
        }
      }
    };

    const subscription = AppState.addEventListener(
      'change',
      handleAppStateChange
    );

    return () => {
      subscription.remove();
    };
  }, [isAuthenticated, connect]);

  // Per-hub log transport: subscribe to log-update notifications and catch up
  // from our stored cursor. Ingestion fans out to the same message queue that
  // serves live `'group'` fan-out messages, so the existing decrypt/persist
  // pipeline applies unchanged. Old clients still hit the legacy `'group'`
  // path; the server dual-writes to the log so we don't double-process here
  // (the dedupe is messageId-based downstream).
  useEffect(() => {
    if (connectionState !== 'connected') return;

    let cancelled = false;
    const inflight = new Set<string>(); // hubAddress with an in-flight log-since

    const requestLogSince = async (hubAddress: string, since: number) => {
      if (cancelled || inflight.has(hubAddress)) return;
      const space = getSpaceByHubAddress(hubAddress);
      if (!space) return;
      const hubKey = getSpaceKey(space.spaceId, 'hub');
      if (!hubKey?.address || !hubKey.privateKey || !hubKey.publicKey) return;
      inflight.add(hubAddress);
      try {
        const frame = await buildLogSinceFrame(
          { address: hubKey.address, publicKey: hubKey.publicKey, privateKey: hubKey.privateKey },
          since,
          200,
        );
        enqueueOutbound(async () => [frame]);
      } catch {
        inflight.delete(hubAddress);
      }
    };

    const ingestEntries = (
      hubAddress: string,
      entries: Array<{ seq: number; ts: number; payload: { ts: number; data: any } }>,
    ) => {
      // Find which space this hub belongs to and its inbox address — the
      // existing decrypt path indexes by inbox address.
      const space = getSpaceByHubAddress(hubAddress);
      if (!space) return;
      const inboxKey = getSpaceKey(space.spaceId, 'inbox');
      if (!inboxKey?.address) return;

      for (const entry of entries) {
        const sealedEnvelope = entry.payload?.data;
        if (!sealedEnvelope) continue;
        // Tag with __logSeq / __logHub so processMessageQueue can advance the
        // hub cursor only after persistence — see post-batch hook there.
        const synthetic = {
          inboxAddress: inboxKey.address,
          encryptedContent: typeof sealedEnvelope === 'string'
            ? sealedEnvelope
            : JSON.stringify(sealedEnvelope),
          timestamp: entry.payload.ts ?? entry.ts,
          __logSeq: entry.seq,
          __logHub: hubAddress,
        } as EncryptedWebSocketMessage & { __logSeq: number; __logHub: string };

        if (messageQueueRef.current.length >= MAX_MESSAGE_QUEUE_SIZE) {
          messageQueueRef.current.splice(
            0,
            messageQueueRef.current.length - MAX_MESSAGE_QUEUE_SIZE + 1,
          );
        }
        messageQueueRef.current.push(synthetic);
      }
      if (entries.length > 0) {
        processMessageQueue();
      }
    };

    const unsubscribe = registerLogFrameHandler((frame) => {
      const hubAddress = (frame as any).hub_address;
      if (!hubAddress) return;
      if (frame.type === 'log-since-result') {
        inflight.delete(hubAddress);
        ingestEntries(hubAddress, frame.entries);
        if (frame.has_more && frame.entries.length > 0) {
          const last = frame.entries[frame.entries.length - 1].seq;
          requestLogSince(hubAddress, last);
        }
      } else if (frame.type === 'log-update') {
        const lastRead = getHubLastSeq(hubAddress);
        if (frame.seq > lastRead) {
          requestLogSince(hubAddress, lastRead);
        }
      } else if (frame.type === 'log-append-ack') {
        // Our own write succeeded — cursor will advance via the log-update
        // broadcast; nothing to do here for now.
      }
    });

    // Stabilize WS, then for each space: listen-hub + initial catch-up.
    // Wrapped end-to-end so a thrown helper can never crash the React tree.
    const setupTimeout = setTimeout(async () => {
      if (cancelled) return;
      try {
        const spaceIds = getSpaceIds();
        for (const spaceId of spaceIds) {
          if (cancelled) break;
          const hubKey = getSpaceKey(spaceId, 'hub');
          const inboxKey = getSpaceKey(spaceId, 'inbox');
          if (
            !hubKey?.address || !hubKey.privateKey || !hubKey.publicKey ||
            !inboxKey?.address
          ) continue;
          try {
            const listenFrame = await buildListenHubFrame(
              { address: hubKey.address, publicKey: hubKey.publicKey, privateKey: hubKey.privateKey },
              inboxKey.address,
            );
            logger.debug(`[hub-log] listen-hub hub=${hubKey.address.slice(0, 12)} inbox=${inboxKey.address.slice(0, 12)}`);
            enqueueOutbound(async () => [listenFrame]);
          } catch (e) {
            logger.warn('[hub-log] listen-hub build failed', e);
            continue;
          }
          const lastSeq = getHubLastSeq(hubKey.address);
          try {
            await requestLogSince(hubKey.address, lastSeq);
          } catch (e) {
            logger.warn('[hub-log] log-since build failed', e);
          }
        }
      } catch (e) {
        logger.warn('[hub-log] setup failed', e);
      }
    }, 1500);

    return () => {
      cancelled = true;
      clearTimeout(setupTimeout);
      unsubscribe();
    };
  }, [connectionState, registerLogFrameHandler, enqueueOutbound, processMessageQueue]);

  // On-connect catch-up is handled exclusively by the per-hub log effect
  // above — listen-hub + log-since fetches everything since the stored
  // cursor. No peer-to-peer sync; new joiners only see messages sent after
  // they joined.

  // Per-launch profile re-broadcast, fingerprinted on the broadcast-
  // relevant user fields. Heals the case where the user joined a space
  // before setting their profile (join control message captured empty
  // userIcon + displayName), AND the case where Farcaster auth hydrated
  // AFTER an earlier rebroadcast fired without farcasterFid populated.
  //
  // The previous implementation used a once-per-launch ref guard, which
  // meant a slow Farcaster hydration window (auth token validates after
  // the 4s rebroadcast timer) would record a fid-less signature in the
  // gate, and nothing in the rest of the session would re-fire to add
  // it. Fingerprinting on the broadcast-relevant fields lets the
  // useEffect re-run when those fields change, while the existing
  // signature gate inside maybeSendUpdateProfileMessage still
  // suppresses no-op resends per (sender, space).
  const lastProfileRebroadcastSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (connectionState !== 'connected') return;
    if (!user?.address) return;
    const displayName = user.displayName || user.username;
    const userIcon = user.profileImage;
    const fcFid = user.farcaster?.fid;
    const fcUsername = user.farcaster?.username;
    // Nothing useful to share at all. A Farcaster-only profile is still
    // worth broadcasting because peers' UserProfileModal renders the FC
    // row from the linkage alone.
    if (!displayName && !userIcon && !fcFid) return;

    // Fingerprint of the per-launch broadcast intent. Identical to the
    // last attempt → don't even import the service.
    const sig = JSON.stringify({
      d: displayName ?? '',
      i: userIcon ?? '',
      f: fcFid ?? 0,
      u: fcUsername ?? '',
    });
    if (lastProfileRebroadcastSigRef.current === sig) return;
    lastProfileRebroadcastSigRef.current = sig;

    const t = setTimeout(async () => {
      try {
        const { maybeSendUpdateProfileMessage, runProfileBroadcastMigrations } = await import('../services/space/spaceMessageService');
        const { getAllSpaces } = await import('../services/config/spaceStorage');
        // Apply any pending profile-broadcast migrations BEFORE the
        // rebroadcast loop so the gate's signature cache reflects the
        // current wire shape. Currently used to force a one-time
        // re-broadcast after add-farcaster-fields-v1 so devices learn
        // each other's Farcaster linkage. Each tag is idempotent —
        // running this on every connect is cheap and safe.
        runProfileBroadcastMigrations();
        const spaces = getAllSpaces();
        for (const space of spaces) {
          try {
            const res = await maybeSendUpdateProfileMessage({
              spaceId: space.spaceId,
              channelId: space.defaultChannelId,
              senderAddress: user.address,
              displayName: displayName || undefined,
              userIcon: userIcon || undefined,
              // Include Farcaster linkage if linked so peers can
              // surface it in UserProfileModal. Gate dedupes on
              // signature so this is a no-op once recorded.
              farcasterFid: user.farcaster?.fid,
              farcasterUsername: user.farcaster?.username,
            });
            if (res) {
              enqueueOutbound(async () => [res.wsEnvelope]);
            }
          } catch {
            // Per-space failure is non-fatal — others still get the broadcast.
          }
        }

        // Rebroadcast identity to all DM partners too (a user may have DM
        // partners but no spaces, which is why this runs unconditionally —
        // the early "no spaces" return was removed above). The DM service
        // has its own per-partner signature gate, so reconnects with
        // unchanged identity are no-ops on the wire. Name/icon only — bio is
        // gated to the public-profile path, matching the space rebroadcast.
        try {
          const { broadcastProfileToAllDMs } = await import('../services/dm/dmProfileService');
          await broadcastProfileToAllDMs(
            {
              selfAddress: user.address,
              displayName: displayName || undefined,
              userIcon: userIcon || undefined,
            },
            { enqueueOutbound, subscribe },
          );
        } catch {
          // DM rebroadcast best-effort; never affects the space rebroadcast.
        }
      } catch {
        // Module imports / spaces lookup failed; clear the fingerprint
        // so the next dep change retries instead of treating this
        // failed attempt as the canonical last broadcast.
        lastProfileRebroadcastSigRef.current = null;
      }
    }, 4000); // Stagger after the log catch-up's setupTimeout.

    return () => clearTimeout(t);
  }, [
    connectionState,
    user?.address,
    user?.displayName,
    user?.username,
    user?.profileImage,
    user?.farcaster?.fid,
    user?.farcaster?.username,
    enqueueOutbound,
    subscribe,
  ]);

  const value = useMemo<WebSocketContextValue>(
    () => ({
      connectionState,
      isConnected: connectionState === 'connected',
      connect,
      disconnect,
      enqueueOutbound,
      subscribe,
      unsubscribe,
      kickedFromSpaceId,
      clearKickedFromSpace,
      registerCallSignalingHandler,
      registerLogFrameHandler,
    }),
    [connectionState, connect, disconnect, enqueueOutbound, subscribe, unsubscribe, kickedFromSpaceId, clearKickedFromSpace, registerCallSignalingHandler, registerLogFrameHandler]
  );

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket(): WebSocketContextValue {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
}

export function useWebSocketConnection(): {
  state: WebSocketConnectionState;
  isConnected: boolean;
} {
  const { connectionState, isConnected } = useWebSocket();
  return { state: connectionState, isConnected };
}

export default WebSocketContext;
