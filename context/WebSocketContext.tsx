/**
 * WebSocketContext - Manages WebSocket connection for E2E encrypted messaging
 *
 * Provides:
 * - WebSocket connection management (connect, reconnect, disconnect)
 * - Encrypted message sending via enqueueOutbound
 * - Incoming message handling with decryption
 * - Inbox subscription management
 */

import { logger } from '@quilibrium/quorum-shared';
import { useQueryClient } from '@tanstack/react-query';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, AppState, AppStateStatus } from 'react-native';

import type {
  Conversation,
  EncryptedWebSocketMessage,
  KickMessage,
  Message,
  SealedMessage,
  Space,
  UnsealedEnvelope,
  WebSocketClient,
  WebSocketConnectionState,
  // Sync protocol types
  SyncRequestPayload,
  SyncInfoPayload,
  SyncInitiatePayload,
  SyncManifestPayload,
  SyncDeltaPayload,
  SyncSummary,
} from '@quilibrium/quorum-shared';
import {
  bytesToHex,
  createRNWebSocketClient,
  int64ToBytes,
  queryKeys,
  // Sync utilities
  SyncService,
  isSyncRequest,
  isSyncInfo,
  isSyncInitiate,
  isSyncManifest,
  isSyncDelta,
} from '@quilibrium/quorum-shared';
import { sha256 } from '@noble/hashes/sha2';
import { getQuorumClient } from '../services/api/quorumClient';
import { getAllSpaceInboxAddresses, getSpace, getSpaceIds, getSpaceKey, saveSpace, saveSpaceKey } from '../services/config/spaceStorage';
import { encryptionService, setE2ELogPrefix } from '../services/crypto/encryption-service';
import { encryptionStateStorage, type ConversationInboxKeypair } from '../services/crypto/encryption-state-storage';
import { NativeCryptoProvider, SyncSealedMessage } from '../services/crypto/native-provider';
import { NativeSigningProvider } from '../services/crypto/native-signing-provider';
import { getDeviceKeyset, type DeviceKeyset } from '../services/onboarding/secureStorage';
import {
  clearSentEnvelope,
  isSentEnvelope,
  // Old sync functions (to be removed)
  sendSyncInfoMessage,
  sendSyncMembersMessage,
  sendSyncMessagesMessage,
  sendSyncPeerMapMessage,
  // New sync protocol functions
  sendSyncRequestMessage,
  sendSyncInfoMessageV2,
  sendSyncInitiateMessage,
  sendSyncManifestMessage,
  sendSyncDeltaMessages,
} from '../services/space/spaceMessageService';
import { mmkvStorage } from '../services/offline/storage';
import { getMMKVAdapter } from '../services/storage/mmkvAdapter';
import { useAuth } from './AuthContext';
import { useStorageAdapter } from './StorageContext';

// API Configuration (matches quorumClient.ts)
const API_CONFIG = {
  wsUrl: 'wss://api.quorummessenger.com/ws',
};

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

  // Sync
  triggerSyncRequest: (spaceId: string, channelId: string) => Promise<void>;

  // Kick events - space ID that user was kicked from, null when acknowledged
  kickedFromSpaceId: string | null;
  clearKickedFromSpace: () => void;
}

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
    logger.log('[WS] Delete request:', {
      inbox_address: inboxAddress.substring(0, 12) + '...',
      timestamps,
      messageToSign: messageToSign.substring(0, 50) + '...',
      publicKeyLength: publicKeyHex.length,
      signatureLength: signatureHex.length,
    });
    await client.deleteInboxMessages(deletePayload);

    logger.log(`[WS] Deleted ${timestamps.length} message(s) from inbox`);
  } catch (error) {
    // Log but don't fail - message deletion is best-effort
    logger.warn('[WS] Failed to delete inbox messages:', error);
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

    logger.log(`[WS] Deleted ${timestamps.length} space message(s) from inbox:`, inboxAddress.substring(0, 12));
  } catch (error) {
    // Log but don't fail - message deletion is best-effort
    logger.warn('[WS] Failed to delete space inbox messages:', error);
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

    logger.log(`[WS] Deleted ${timestamps.length} conversation message(s) from inbox:`, inboxAddress.substring(0, 12));
  } catch (error) {
    // Log but don't fail - message deletion is best-effort
    logger.warn('[WS] Failed to delete conversation inbox messages:', error);
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

  // WebSocket client instance (singleton for the app)
  const wsClientRef = useRef<WebSocketClient | null>(null);

  // Track subscribed inbox addresses
  const subscribedInboxesRef = useRef<Set<string>>(new Set());

  // Initialize device keys for encryption
  const deviceKeysInitialized = useRef(false);

  // Store our own inbox address for checking initialization messages
  const ownInboxAddressRef = useRef<string | null>(null);

  // Track sent space message envelopes to skip decrypting our own echoed messages
  // We store a hash of the envelope content since we can't decrypt our own TR messages
  const sentSpaceEnvelopesRef = useRef<Set<string>>(new Set());

  // Track processed sync requests to prevent duplicate handling within a short window
  // Key is `${spaceId}:${expiry}:${inboxAddress}` for sync-request
  // Value is timestamp when processed, entries expire after 30 seconds
  const processedSyncRequestsRef = useRef<Map<string, number>>(new Map());
  const SYNC_REQUEST_DEDUP_EXPIRY_MS = 30000; // 30 seconds for sync-request (based on message expiry)
  // Track sync-initiate operations that are currently in-flight to prevent parallel processing
  const syncInitiateInFlightRef = useRef<Set<string>>(new Set());

  // SyncService instance for new hash-based delta sync protocol
  const syncServiceRef = useRef<SyncService | null>(null);

  /**
   * Handle sync initiation callback from SyncService
   * This is called when candidates are collected and we should start sync
   */
  const handleInitiateSync = useCallback(async (spaceId: string, targetInbox: string) => {
    logger.log(`[WS] handleInitiateSync called for space ${spaceId.substring(0, 12)}, target ${targetInbox.substring(0, 12)}`);

    try {
      const syncService = syncServiceRef.current;
      if (!syncService) {
        logger.warn('[WS] handleInitiateSync: No SyncService');
        return;
      }

      const inboxKey = getSpaceKey(spaceId, 'inbox');
      if (!inboxKey?.address) {
        logger.warn('[WS] handleInitiateSync: No inbox key');
        return;
      }

      const space = getSpace(spaceId);
      const channelId = space?.defaultChannelId || spaceId;

      // Get peer IDs from encryption state
      const encryptionStateData = encryptionStateStorage.getEncryptionState(
        `space:${spaceId}:${channelId}`,
        inboxKey.address
      );
      let peerIds: number[] = [];
      if (encryptionStateData?.state) {
        try {
          const parsed = JSON.parse(encryptionStateData.state);
          const ratchetState = parsed.state ? JSON.parse(parsed.state) : parsed;
          if (ratchetState.peer_id_map) {
            peerIds = Object.values(ratchetState.peer_id_map as Record<string, number>);
          }
        } catch (e) {
          logger.log('[WS] handleInitiateSync: Failed to parse peer IDs');
        }
      }

      // Build sync-initiate payload
      const initiateResult = await syncService.buildSyncInitiate(
        spaceId,
        channelId,
        inboxKey.address,
        peerIds
      );

      if (!initiateResult) {
        logger.log('[WS] handleInitiateSync: buildSyncInitiate returned null');
        return;
      }

      logger.log(`[WS] handleInitiateSync: Sending sync-initiate to ${initiateResult.target.substring(0, 12)}`);

      const syncInitiateEnvelope = await sendSyncInitiateMessage(
        spaceId,
        initiateResult.target,
        initiateResult.payload
      );

      const client = wsClientRef.current;
      if (client?.isConnected) {
        client.enqueueOutbound(async () => [syncInitiateEnvelope]);
        logger.log('[WS] handleInitiateSync: sync-initiate sent!');
      }
    } catch (error) {
      console.error('[WS] handleInitiateSync failed:', error);
    }
  }, []);

  // Initialize SyncService lazily when storage is available
  const getSyncService = useCallback(() => {
    if (!syncServiceRef.current && storage) {
      syncServiceRef.current = new SyncService({
        storage,
        maxMessages: 1000,
        requestExpiry: 30000,
        onInitiateSync: handleInitiateSync,
      });
    }
    return syncServiceRef.current;
  }, [storage, handleInitiateSync]);

  /**
   * Initialize device keys and set them in the encryption service
   */
  const initializeDeviceKeys = useCallback(async () => {
    logger.log('[WS] initializeDeviceKeys called, already initialized:', deviceKeysInitialized.current);

    if (deviceKeysInitialized.current) {
      // Verify keys are actually set
      const hasKeys = encryptionService.hasDeviceKeys();
      logger.log('[WS] Keys already initialized, hasDeviceKeys:', hasKeys);
      if (!hasKeys) {
        // Reset flag to force re-initialization
        logger.warn('[WS] Keys flag set but no keys - resetting');
        deviceKeysInitialized.current = false;
      } else {
        return true;
      }
    }

    try {
      const keyset = await getDeviceKeyset();
      logger.log('[WS] Got keyset:', !!keyset);
      if (!keyset) {
        logger.warn('Device keyset not found - encryption not available');
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

      logger.log('[WS] Device keys set, hasDeviceKeys:', encryptionService.hasDeviceKeys());

      // Store our inbox address for checking init messages
      ownInboxAddressRef.current = keyset.inboxAddress;

      deviceKeysInitialized.current = true;
      return true;
    } catch (error) {
      logger.log('Failed to initialize device keys:', error);
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
        logger.log(`[WS:${getAddr()}] Received message:`, {
          inboxAddress: message.inboxAddress,
          hasEncryptedContent: !!message.encryptedContent,
          contentType: typeof message.encryptedContent,
          contentPreview: typeof message.encryptedContent === 'string'
            ? message.encryptedContent.substring(0, 100)
            : 'not a string',
        });

        if (!message.encryptedContent) {
          logger.warn('[WS] Received message without encrypted content');
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
          logger.log(`[WS:${getAddr()}] *** SPACE INBOX MESSAGE ***`, {
            inboxAddress: message.inboxAddress?.substring(0, 12),
            contentLength: message.encryptedContent?.length,
            sealedMessageKeys: Object.keys(sealedMessage),
          });

          // Find which space this inbox belongs to
          let spaceIds: string[];
          try {
            spaceIds = getSpaceIds();
          } catch (e) {
            logger.log(`[WS:${getAddr()}] getSpaceIds() failed:`, e);
            return;
          }

          logger.log(`[WS:${getAddr()}] Looking for space with inbox ${message.inboxAddress?.substring(0, 12)}, have ${spaceIds.length} spaces`);

          try {

            let spaceId: string | null = null;
            let hubKey: { publicKey: string; privateKey: string; address?: string } | null = null;
            let spaceInboxKey: { publicKey: string; privateKey: string; address?: string } | null = null;

            for (const sid of spaceIds) {
              const inboxKey = getSpaceKey(sid, 'inbox');
              logger.log(`[WS:${getAddr()}] Space ${sid.substring(0, 12)} inbox: ${inboxKey?.address?.substring(0, 12) || 'none'}`);
              if (inboxKey?.address === message.inboxAddress) {
                spaceId = sid;
                hubKey = getSpaceKey(sid, 'hub');
                spaceInboxKey = inboxKey;
                logger.log(`[WS:${getAddr()}] Found matching space! hubKey:`, {
                  hasAddress: !!hubKey?.address,
                  hasPublicKey: !!hubKey?.publicKey,
                  hasPrivateKey: !!hubKey?.privateKey,
                });
                break;
              }
            }

            if (!spaceId || !hubKey) {
              logger.log('[WS] Could not find space for inbox:', message.inboxAddress?.substring(0, 12));
              logger.log('[WS] Available space inboxes:', spaceIds.map(sid => {
                const ik = getSpaceKey(sid, 'inbox');
                return `${sid.substring(0, 8)}:${ik?.address?.substring(0, 8) || 'none'}`;
              }));
              return;
            }

            if (!hubKey.privateKey) {
              logger.log('[WS] Hub key missing privateKey for space:', spaceId.substring(0, 12));
              return;
            }

            logger.log(`[WS:${getAddr()}] Processing space message for space:`, spaceId.substring(0, 12));

            // Get config key for hub envelope decryption
            const configKey = getSpaceKey(spaceId, 'config');
            logger.log(`[WS:${getAddr()}] Config key exists:`, !!configKey, 'publicKey length:', configKey?.publicKey?.length, 'privateKey length:', configKey?.privateKey?.length, 'pubPrefix:', configKey?.publicKey?.substring(0, 16), 'privPrefix:', configKey?.privateKey?.substring(0, 16));

            // Verify the stored public key matches what we derive from the private key
            if (configKey?.privateKey) {
              const cryptoCheck = new NativeCryptoProvider();
              const privKeyBase64 = btoa(String.fromCharCode(...hexToBytes(configKey.privateKey)));
              const derivedPubBase64 = await cryptoCheck.getPublicKeyX448(privKeyBase64);
              const derivedPubBinary = atob(derivedPubBase64);
              let derivedPubHex = '';
              for (let i = 0; i < derivedPubBinary.length; i++) {
                derivedPubHex += derivedPubBinary.charCodeAt(i).toString(16).padStart(2, '0');
              }
              logger.log(`[WS:${getAddr()}] Derived pubKey from privKey:`, derivedPubHex.substring(0, 16), 'stored pubKey:', configKey.publicKey?.substring(0, 16), 'match:', derivedPubHex === configKey.publicKey);
            }

            // DEBUG: Also log hub key info to compare
            logger.log(`[WS:${getAddr()}] Hub key publicKey prefix:`, hubKey.publicKey?.substring(0, 16));

            // Check the outer envelope type to determine how to unseal
            const outerEnvelopeType = (sealedMessage as { type?: string }).type;
            logger.log(`[WS:${getAddr()}] Outer envelope type:`, outerEnvelopeType);

            const cryptoProvider = new NativeCryptoProvider();
            const hubPrivateKeyBytes = hexToBytes(hubKey.privateKey);
            let unsealedPayload: string;

            if (outerEnvelopeType === 'sync') {
              // Sync envelope - directed message using unsealSyncEnvelope with config key
              logger.log(`[WS:${getAddr()}] Using unsealSyncEnvelope for sync message`);
              const syncSealedMessage = sealedMessage as unknown as SyncSealedMessage;
              unsealedPayload = await cryptoProvider.unsealSyncEnvelope(
                hubPrivateKeyBytes,
                syncSealedMessage,
                configKey ? Array.from(hexToBytes(configKey.privateKey)) : undefined
              );
            } else {
              // Hub broadcast envelope - use unsealHubEnvelope with config key
              logger.log(`[WS:${getAddr()}] Using unsealHubEnvelope for broadcast message`);
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

            logger.log(`[WS:${getAddr()}] Unsealed envelope, payload length:`, unsealedPayload.length);
            logger.log(`[WS:${getAddr()}] Unsealed payload preview:`, unsealedPayload.substring(0, 200));

            // Parse the unsealed payload - it should be { type: 'message', message: tripleRatchetEnvelope }
            const payload = JSON.parse(unsealedPayload) as {
              type: string;
              message: string | Message;
            };

            // Handle control messages (join, leave, kick, sync, etc.)
            if (payload.type === 'control') {
              logger.log(`[WS:${getAddr()}] Processing control message`);
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
              logger.log(`[WS:${getAddr()}] Control message type:`, controlType);

              switch (controlType) {
                case 'join': {
                  // A new participant joined - update peer maps and member list
                  logger.log(`[WS:${getAddr()}] Received join control message`);
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
                      logger.warn('[WS] Join message missing participant data');
                      break;
                    }

                    logger.log(`[WS:${getAddr()}] New participant joined:`, {
                      address: participant.address,
                      id: participant.id,
                      displayName: participant.displayName,
                    });

                    // Skip if this is our own join message echoed back
                    if (participant.address === user?.address) {
                      logger.log(`[WS:${getAddr()}] Ignoring own join message`);
                      break;
                    }

                    // Update the Triple Ratchet state with new peer
                    const spaceConversationId = `${spaceId}/${spaceId}`;
                    const encryptionStates = encryptionStateStorage.getEncryptionStates(spaceConversationId);

                    if (encryptionStates.length > 0) {
                      try {
                        const stateData = encryptionStates[0];
                        // Parse the nested state structure
                        let ratchetState: Record<string, unknown>;
                        const parsed = JSON.parse(stateData.state);
                        if (parsed.state && typeof parsed.state === 'string') {
                          ratchetState = JSON.parse(parsed.state);
                        } else {
                          ratchetState = parsed;
                        }

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

                        logger.log(`[WS:${getAddr()}] Updated peer maps for new participant (preserved template/evals)`);

                        // CRITICAL: Also update fallback state with new peer
                        // The fallback state is used for decryption when the main state has evolved
                        // If the fallback doesn't have the new peer in peer_id_map, decryption fails with "Malformed header"
                        const fallbackState = encryptionStateStorage.getFallbackState(spaceConversationId, stateData.inboxId);
                        if (fallbackState) {
                          try {
                            let fallbackRatchetState: Record<string, unknown>;
                            const fallbackParsed = JSON.parse(fallbackState.state);
                            if (fallbackParsed.state && typeof fallbackParsed.state === 'string') {
                              fallbackRatchetState = JSON.parse(fallbackParsed.state);
                            } else {
                              fallbackRatchetState = fallbackParsed;
                            }

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
                            const updatedFallbackState = fallbackParsed.state
                              ? JSON.stringify({ state: JSON.stringify(fallbackRatchetState) })
                              : JSON.stringify(fallbackRatchetState);

                            encryptionStateStorage.saveFallbackState({
                              ...fallbackState,
                              state: updatedFallbackState,
                              timestamp: Date.now(),
                            });

                            logger.log(`[WS:${getAddr()}] Updated fallback peer maps for new participant (critical for decrypt!)`);
                          } catch (fallbackUpdateError) {
                            logger.log('[WS] Failed to update fallback peer maps:', fallbackUpdateError);
                          }
                        } else {
                          logger.warn(`[WS:${getAddr()}] No fallback state found to update with new peer`);
                        }
                      } catch (peerMapError) {
                        logger.log('[WS] Failed to update peer maps:', peerMapError);
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

                    // Invalidate space members cache
                    queryClient.invalidateQueries({ queryKey: queryKeys.spaces.members(spaceId) });

                    logger.log(`[WS:${getAddr()}] Saved new member to storage`);

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
                    queryClient.invalidateQueries({ queryKey: queryKeys.messages.infinite(spaceId, channelId) });
                    logger.log(`[WS:${getAddr()}] Saved join event as message`);
                  } catch (joinError) {
                    logger.log('[WS] Error processing join message:', joinError);
                  }
                  break;
                }

                case 'leave': {
                  // A participant left the space - mark their inbox as empty
                  logger.log(`[WS:${getAddr()}] Received leave control message`);
                  try {
                    const leavePayload = controlPayload.message as {
                      type: 'leave';
                      participant?: { address: string };
                      address?: string;
                    };

                    const leavingAddress = leavePayload.participant?.address || leavePayload.address;
                    if (!leavingAddress) {
                      logger.warn('[WS] Leave message missing address');
                      break;
                    }

                    logger.log(`[WS:${getAddr()}] Participant left:`, leavingAddress);

                    // Update member in storage - set inbox_address to empty string to mark inactive
                    const adapter = getMMKVAdapter();
                    const existingMember = await adapter.getSpaceMember(spaceId, leavingAddress);
                    if (existingMember) {
                      await adapter.saveSpaceMember(spaceId, {
                        ...existingMember,
                        inbox_address: '', // Empty = left/inactive
                      });
                    }

                    // Invalidate space members cache
                    queryClient.invalidateQueries({ queryKey: queryKeys.spaces.members(spaceId) });

                    logger.log(`[WS:${getAddr()}] Marked member as left`);
                  } catch (leaveError) {
                    logger.log('[WS] Error processing leave message:', leaveError);
                  }
                  break;
                }

                case 'kick': {
                  // A participant was kicked from the space
                  const kickedAddress = controlPayload.message.kick;
                  logger.log(`[WS:${getAddr()}] Received kick control message:`, kickedAddress);

                  if (!kickedAddress) {
                    logger.warn('[WS] Kick message missing kicked address');
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
                      } catch (e) {
                        logger.log('[WS] Failed to get user address from storage:', e);
                      }
                    }
                    logger.log(`[WS:${getAddr()}] Current user address:`, ownAddress);
                    logger.log(`[WS:${getAddr()}] Kick comparison:`, kickedAddress === ownAddress, 'kicked:', kickedAddress, 'user:', ownAddress);

                    // Check if we are being kicked
                    if (ownAddress && kickedAddress === ownAddress) {
                      logger.warn(`[WS:${getAddr()}] *** WE HAVE BEEN KICKED FROM SPACE ***`);

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
                        logger.log(`[WS:${getAddr()}] Unsubscribing from space inbox:`, spaceInboxAddress.substring(0, 12));
                        try {
                          await wsClientRef.current.unsubscribe([spaceInboxAddress]);
                          subscribedInboxesRef.current.delete(spaceInboxAddress);
                        } catch (unsubError) {
                          console.error('[WS] Error unsubscribing from space inbox:', unsubError);
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

                        logger.log(`[WS:${getAddr()}] Cleaned up local data after kick`);

                        // Invalidate all space-related queries
                        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all() });

                        // Set kicked space ID so consumers can navigate away
                        setKickedFromSpaceId(spaceId);
                      } catch (cleanupError) {
                        console.error('[WS] Error cleaning up after kick:', cleanupError);
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

                      logger.log(`[WS:${getAddr()}] Marked member as kicked:`, kickedAddress);
                    }

                    // Invalidate space members cache
                    queryClient.invalidateQueries({ queryKey: queryKeys.spaces.members(spaceId) });
                  } catch (kickError) {
                    logger.log('[WS] Error processing kick message:', kickError);
                  }
                  break;
                }

                case 'sync-peer-map': {
                  // Peer map synchronization - update local peer_id_map and id_peer_map
                  logger.log(`[WS:${getAddr()}] Received sync-peer-map control message`);
                  try {
                    const peerMapData = controlPayload.message.peerMap;
                    if (!peerMapData) {
                      logger.warn('[WS] sync-peer-map missing peerMap data');
                      break;
                    }

                    const spaceConversationId = `${spaceId}/${spaceId}`;
                    const encryptionStates = encryptionStateStorage.getEncryptionStates(spaceConversationId);

                    if (encryptionStates.length > 0) {
                      const stateData = encryptionStates[0];
                      // Parse the nested state structure
                      let ratchetState: Record<string, unknown>;
                      const parsed = JSON.parse(stateData.state);
                      if (parsed.state && typeof parsed.state === 'string') {
                        ratchetState = JSON.parse(parsed.state);
                      } else {
                        ratchetState = parsed;
                      }

                      // MERGE peer maps instead of replacing - preserve our own entries
                      // This is critical when syncing with a peer that doesn't have us in their map yet
                      const existingIdPeerMap = (ratchetState.id_peer_map || {}) as Record<string, unknown>;
                      const existingPeerIdMap = (ratchetState.peer_id_map || {}) as Record<string, unknown>;
                      const incomingIdPeerMap = (peerMapData.id_peer_map || {}) as Record<string, unknown>;
                      const incomingPeerIdMap = (peerMapData.peer_id_map || {}) as Record<string, unknown>;

                      logger.log(`[WS:${getAddr()}] sync-peer-map: Merging peer maps`);
                      logger.log(`[WS:${getAddr()}] sync-peer-map: Existing id_peer_map has ${Object.keys(existingIdPeerMap).length} entries`);
                      logger.log(`[WS:${getAddr()}] sync-peer-map: Incoming id_peer_map has ${Object.keys(incomingIdPeerMap).length} entries`);

                      ratchetState.id_peer_map = {
                        ...existingIdPeerMap,
                        ...incomingIdPeerMap,
                      };
                      ratchetState.peer_id_map = {
                        ...existingPeerIdMap,
                        ...incomingPeerIdMap,
                      };

                      logger.log(`[WS:${getAddr()}] sync-peer-map: Merged id_peer_map now has ${Object.keys(ratchetState.id_peer_map as object).length} entries`);

                      // Sync critical ratchet state fields for decryption to work
                      // These fields are needed for Triple Ratchet to derive the correct keys
                      if (peerMapData.root_key) {
                        logger.log(`[WS:${getAddr()}] sync-peer-map: Updating root_key`);
                        ratchetState.root_key = peerMapData.root_key;
                      }
                      if (peerMapData.dkg_ratchet) {
                        logger.log(`[WS:${getAddr()}] sync-peer-map: Updating dkg_ratchet`);
                        ratchetState.dkg_ratchet = peerMapData.dkg_ratchet;
                        ratchetState.next_dkg_ratchet = peerMapData.dkg_ratchet; // Keep in sync
                      }
                      if (peerMapData.receiving_group_key) {
                        ratchetState.receiving_group_key = peerMapData.receiving_group_key;
                      }
                      if (peerMapData.receiving_chain_key) {
                        logger.log(`[WS:${getAddr()}] sync-peer-map: Updating receiving_chain_key`);
                        ratchetState.receiving_chain_key = peerMapData.receiving_chain_key;
                      }
                      if (peerMapData.current_header_key) {
                        ratchetState.current_header_key = peerMapData.current_header_key;
                      }
                      if (peerMapData.next_header_key) {
                        ratchetState.next_header_key = peerMapData.next_header_key;
                      }
                      if (peerMapData.async_dkg_pubkey) {
                        ratchetState.async_dkg_pubkey = peerMapData.async_dkg_pubkey;
                      }
                      if (peerMapData.threshold) {
                        ratchetState.threshold = peerMapData.threshold;
                      }

                      // Save updated state - PRESERVE template and evals for invite generation!
                      let updatedState: string;
                      if (parsed.state) {
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

                      logger.log(`[WS:${getAddr()}] Updated peer maps from sync (preserved template/evals)`);

                      // CRITICAL: Also update fallback state with synced peer maps
                      const fallbackState = encryptionStateStorage.getFallbackState(spaceConversationId, stateData.inboxId);
                      if (fallbackState) {
                        try {
                          let fallbackRatchetState: Record<string, unknown>;
                          const fallbackParsed = JSON.parse(fallbackState.state);
                          if (fallbackParsed.state && typeof fallbackParsed.state === 'string') {
                            fallbackRatchetState = JSON.parse(fallbackParsed.state);
                          } else {
                            fallbackRatchetState = fallbackParsed;
                          }

                          // MERGE fallback peer maps instead of replacing
                          const existingFallbackIdPeerMap = (fallbackRatchetState.id_peer_map || {}) as Record<string, unknown>;
                          const existingFallbackPeerIdMap = (fallbackRatchetState.peer_id_map || {}) as Record<string, unknown>;

                          fallbackRatchetState.id_peer_map = {
                            ...existingFallbackIdPeerMap,
                            ...incomingIdPeerMap,
                          };
                          fallbackRatchetState.peer_id_map = {
                            ...existingFallbackPeerIdMap,
                            ...incomingPeerIdMap,
                          };

                          // Also sync ratchet state fields to fallback
                          if (peerMapData.root_key) {
                            fallbackRatchetState.root_key = peerMapData.root_key;
                          }
                          if (peerMapData.dkg_ratchet) {
                            fallbackRatchetState.dkg_ratchet = peerMapData.dkg_ratchet;
                            fallbackRatchetState.next_dkg_ratchet = peerMapData.dkg_ratchet;
                          }
                          if (peerMapData.receiving_group_key) {
                            fallbackRatchetState.receiving_group_key = peerMapData.receiving_group_key;
                          }
                          if (peerMapData.receiving_chain_key) {
                            fallbackRatchetState.receiving_chain_key = peerMapData.receiving_chain_key;
                          }
                          if (peerMapData.current_header_key) {
                            fallbackRatchetState.current_header_key = peerMapData.current_header_key;
                          }
                          if (peerMapData.next_header_key) {
                            fallbackRatchetState.next_header_key = peerMapData.next_header_key;
                          }
                          if (peerMapData.async_dkg_pubkey) {
                            fallbackRatchetState.async_dkg_pubkey = peerMapData.async_dkg_pubkey;
                          }
                          if (peerMapData.threshold) {
                            fallbackRatchetState.threshold = peerMapData.threshold;
                          }

                          // Save updated fallback state
                          const updatedFallbackState = fallbackParsed.state
                            ? JSON.stringify({ state: JSON.stringify(fallbackRatchetState) })
                            : JSON.stringify(fallbackRatchetState);

                          encryptionStateStorage.saveFallbackState({
                            ...fallbackState,
                            state: updatedFallbackState,
                            timestamp: Date.now(),
                          });

                          logger.log(`[WS:${getAddr()}] Updated fallback peer maps from sync (merged)`);
                        } catch (fallbackSyncError) {
                          logger.log('[WS] Failed to update fallback peer maps from sync:', fallbackSyncError);
                        }
                      }
                    }
                  } catch (syncPeerMapError) {
                    logger.log('[WS] Error processing sync-peer-map:', syncPeerMapError);
                  }
                  break;
                }

                case 'sync': {
                  // Sync trigger - synchronize all data to the requesting inbox
                  logger.log(`[WS:${getAddr()}] Received sync control message`);
                  try {
                    const syncPayload = controlPayload.message as {
                      type: 'sync';
                      inboxAddress?: string;
                    };

                    const targetInbox = syncPayload.inboxAddress;
                    if (!targetInbox) {
                      logger.warn('[WS] sync message missing inboxAddress');
                      break;
                    }

                    logger.log(`[WS:${getAddr()}] Synchronizing data to inbox:`, targetInbox.substring(0, 12));

                    // Get encryption state for peer map
                    const spaceConversationId = `${spaceId}/${spaceId}`;
                    const encryptionStates = encryptionStateStorage.getEncryptionStates(spaceConversationId);

                    if (encryptionStates.length > 0) {
                      const stateData = encryptionStates[0];

                      // Use FALLBACK state for sync - this is what's actually used for encryption
                      const fallbackState = encryptionStateStorage.getFallbackState(spaceConversationId, stateData.inboxId);
                      const stateToSync = fallbackState || stateData;

                      let ratchetState: Record<string, unknown>;
                      const parsed = JSON.parse(stateToSync.state);
                      if (parsed.state && typeof parsed.state === 'string') {
                        ratchetState = JSON.parse(parsed.state);
                      } else {
                        ratchetState = parsed;
                      }

                      logger.log(`[WS:${getAddr()}] sync: Using ${fallbackState ? 'FALLBACK' : 'current'} state for sync`);
                      logger.log(`[WS:${getAddr()}] sync: root_key preview: ${(ratchetState.root_key as string)?.substring(0, 20)}`);

                      const client = wsClientRef.current;
                      if (client && client.isConnected) {
                        // 1. Send peer map with critical ratchet state for decryption
                        if (ratchetState.id_peer_map && ratchetState.peer_id_map) {
                          const peerMapEnvelope = await sendSyncPeerMapMessage(spaceId, targetInbox, {
                            id_peer_map: ratchetState.id_peer_map,
                            peer_id_map: ratchetState.peer_id_map,
                            // Include critical fields for ratchet sync
                            root_key: ratchetState.root_key,
                            dkg_ratchet: ratchetState.dkg_ratchet,
                            receiving_group_key: ratchetState.receiving_group_key,
                            receiving_chain_key: ratchetState.receiving_chain_key,
                            current_header_key: ratchetState.current_header_key,
                            next_header_key: ratchetState.next_header_key,
                            async_dkg_pubkey: ratchetState.async_dkg_pubkey,
                            threshold: ratchetState.threshold,
                          });
                          client.enqueueOutbound(async () => [peerMapEnvelope]);
                          logger.log(`[WS:${getAddr()}] Sent sync-peer-map with ratchet state`);
                        }

                        // 2. Send members
                        const adapter = getMMKVAdapter();
                        const members = await adapter.getSpaceMembers(spaceId);
                        logger.log(`[WS:${getAddr()}] sync-initiate: Got ${members.length} members to sync`);
                        if (members.length > 0) {
                          // Use field names that match desktop's expectations
                          const memberData = members.map(m => ({
                            user_address: m.address,
                            display_name: m.display_name,
                            user_icon: m.profile_image,
                            inbox_address: m.inbox_address,
                          }));
                          logger.log(`[WS:${getAddr()}] sync-initiate: Member data sample:`, JSON.stringify(memberData[0]));
                          const memberEnvelopes = await sendSyncMembersMessage(spaceId, targetInbox, memberData);
                          for (const env of memberEnvelopes) {
                            client.enqueueOutbound(async () => [env]);
                          }
                          logger.log(`[WS:${getAddr()}] Sent ${memberEnvelopes.length} sync-members chunk(s)`);
                        }

                        // 3. Send messages
                        const space = getSpace(spaceId);
                        const channelId = space?.defaultChannelId || spaceId;
                        const messagesResult = await storage.getMessages({
                          spaceId,
                          channelId,
                          limit: 1000,
                        });
                        if (messagesResult.messages.length > 0) {
                          const messageEnvelopes = await sendSyncMessagesMessage(
                            spaceId,
                            targetInbox,
                            channelId,
                            messagesResult.messages
                          );
                          for (const env of messageEnvelopes) {
                            client.enqueueOutbound(async () => [env]);
                          }
                          logger.log(`[WS:${getAddr()}] Sent ${messageEnvelopes.length} sync-messages chunk(s)`);
                        }
                      }
                    }
                  } catch (syncError) {
                    logger.log('[WS] Error processing sync:', syncError);
                  }
                  break;
                }

                case 'sync-request': {
                  // Another participant is requesting sync - respond with sync-info if we have useful data
                  // New protocol: uses SyncService with hash-based summary for delta sync
                  logger.log(`[WS:${getAddr()}] === SYNC-REQUEST RECEIVED ===`);
                  logger.log(`[WS:${getAddr()}] sync-request controlPayload.message:`, JSON.stringify(controlPayload.message, null, 2));
                  try {
                    // Handle both old and new protocol formats
                    const syncRequestPayload = controlPayload.message as SyncRequestPayload & {
                      // Legacy fields
                      memberCount?: number;
                      messageCount?: number;
                    };

                    const theirInboxAddress = syncRequestPayload.inboxAddress;
                    logger.log(`[WS:${getAddr()}] sync-request from: ${theirInboxAddress?.substring(0, 12)}`);
                    logger.log(`[WS:${getAddr()}] sync-request payload:`, {
                      type: syncRequestPayload.type,
                      inboxAddress: theirInboxAddress?.substring(0, 12),
                      expiry: syncRequestPayload.expiry,
                      expiryValid: syncRequestPayload.expiry > Date.now(),
                      hasSummary: !!syncRequestPayload.summary,
                      summary: syncRequestPayload.summary,
                    });

                    // Check expiry
                    if (!syncRequestPayload.expiry || syncRequestPayload.expiry < Date.now()) {
                      logger.log(`[WS:${getAddr()}] sync-request EXPIRED, skipping`);
                      break;
                    }

                    // Deduplication
                    const syncRequestKey = `${spaceId}:${syncRequestPayload.expiry}:${theirInboxAddress}`;
                    const now = Date.now();
                    const lastProcessed = processedSyncRequestsRef.current.get(syncRequestKey);
                    if (lastProcessed && (now - lastProcessed) < SYNC_REQUEST_DEDUP_EXPIRY_MS) {
                      logger.log(`[WS:${getAddr()}] Skipping duplicate sync-request`);
                      break;
                    }
                    processedSyncRequestsRef.current.set(syncRequestKey, now);
                    // Clean up old entries
                    for (const [key, timestamp] of processedSyncRequestsRef.current) {
                      if (now - timestamp > SYNC_REQUEST_DEDUP_EXPIRY_MS) {
                        processedSyncRequestsRef.current.delete(key);
                      }
                    }

                    const inboxKey = getSpaceKey(spaceId, 'inbox');
                    if (!inboxKey || !theirInboxAddress || inboxKey.address === theirInboxAddress) {
                      logger.log(`[WS:${getAddr()}] sync-request: SKIPPING - self or no inbox key`);
                      break;
                    }

                    const syncService = getSyncService();
                    if (!syncService) {
                      logger.log(`[WS:${getAddr()}] sync-request: No SyncService available`);
                      break;
                    }

                    const space = getSpace(spaceId);
                    const channelId = space?.defaultChannelId || spaceId;

                    // Build sync-info response using new protocol if summary provided
                    logger.log(`[WS:${getAddr()}] sync-request: Building response, hasSummary=${!!syncRequestPayload.summary}`);
                    if (syncRequestPayload.summary) {
                      // New protocol with SyncSummary
                      logger.log(`[WS:${getAddr()}] sync-request: Calling buildSyncInfo for space=${spaceId.substring(0, 12)}, channel=${channelId.substring(0, 12)}`);
                      const syncInfoPayload = await syncService.buildSyncInfo(
                        spaceId,
                        channelId,
                        inboxKey.address!,
                        syncRequestPayload.summary
                      );

                      logger.log(`[WS:${getAddr()}] sync-request: buildSyncInfo returned:`, syncInfoPayload ? {
                        type: syncInfoPayload.type,
                        inboxAddress: syncInfoPayload.inboxAddress?.substring(0, 12),
                        summary: syncInfoPayload.summary,
                      } : 'null');

                      if (!syncInfoPayload) {
                        logger.log(`[WS:${getAddr()}] sync-request: Nothing to sync (new protocol) - our data matches or is less than theirs`);
                        break;
                      }

                      logger.log(`[WS:${getAddr()}] sync-request: Sending sync-info V2 response to ${theirInboxAddress.substring(0, 12)}`);
                      const syncInfoEnvelope = await sendSyncInfoMessageV2(
                        spaceId,
                        theirInboxAddress,
                        syncInfoPayload
                      );

                      const client = wsClientRef.current;
                      if (client && client.isConnected) {
                        client.enqueueOutbound(async () => [syncInfoEnvelope]);
                        logger.log(`[WS:${getAddr()}] sync-request: sync-info V2 sent!`);
                      }
                    } else {
                      // Legacy protocol - fall back to old behavior
                      const adapter = getMMKVAdapter();
                      const members = await adapter.getSpaceMembers(spaceId);
                      const messagesResult = await adapter.getMessages({ spaceId, channelId });

                      if (members.length === 0 && messagesResult.messages.length === 0) {
                        logger.log(`[WS:${getAddr()}] sync-request: SKIPPING - no data (legacy)`);
                        break;
                      }

                      logger.log(`[WS:${getAddr()}] sync-request: Sending sync-info response (legacy)`);
                      const syncInfoEnvelope = await sendSyncInfoMessage(
                        spaceId,
                        theirInboxAddress,
                        messagesResult.messages.length,
                        members.length
                      );

                      const client = wsClientRef.current;
                      if (client && client.isConnected) {
                        client.enqueueOutbound(async () => [syncInfoEnvelope]);
                        logger.log(`[WS:${getAddr()}] sync-request: sync-info sent (legacy)!`);
                      }
                    }
                  } catch (syncRequestError) {
                    logger.log(`[WS:${getAddr()}] sync-request ERROR:`, syncRequestError);
                  }
                  break;
                }

                case 'sync-info': {
                  // Sync info response - another participant responded to our sync-request
                  // Add them as a candidate and SyncService will trigger sync-initiate
                  logger.log(`[WS:${getAddr()}] === SYNC-INFO RECEIVED ===`);
                  try {
                    const syncInfoPayload = controlPayload.message as SyncInfoPayload & {
                      // Legacy fields
                      messageCount?: number;
                      memberCount?: number;
                    };

                    logger.log(`[WS:${getAddr()}] sync-info from: ${syncInfoPayload.inboxAddress?.substring(0, 12)}`);
                    logger.log(`[WS:${getAddr()}] sync-info payload:`, {
                      inboxAddress: syncInfoPayload.inboxAddress?.substring(0, 12),
                      summary: syncInfoPayload.summary,
                      messageCount: syncInfoPayload.messageCount,
                      memberCount: syncInfoPayload.memberCount,
                    });

                    const syncService = getSyncService();
                    if (!syncService) {
                      logger.log(`[WS:${getAddr()}] sync-info: No SyncService available`);
                      break;
                    }

                    // Check if we have an active session for this space
                    if (!syncService.hasActiveSession(spaceId)) {
                      logger.log(`[WS:${getAddr()}] sync-info: No active sync session for space, ignoring`);
                      break;
                    }

                    // Build candidate from sync-info
                    // Support both new protocol (summary) and legacy (messageCount/memberCount)
                    const candidate = {
                      inboxAddress: syncInfoPayload.inboxAddress,
                      summary: syncInfoPayload.summary || {
                        messageCount: syncInfoPayload.messageCount || 0,
                        memberCount: syncInfoPayload.memberCount || 0,
                        newestMessageTimestamp: 0,
                        oldestMessageTimestamp: 0,
                        manifestHash: '',
                      },
                    };

                    logger.log(`[WS:${getAddr()}] sync-info: Adding candidate`, {
                      inboxAddress: candidate.inboxAddress?.substring(0, 12),
                      messageCount: candidate.summary.messageCount,
                      memberCount: candidate.summary.memberCount,
                    });

                    // Add candidate - SyncService will schedule sync-initiate via callback
                    syncService.addCandidate(spaceId, candidate);
                    logger.log(`[WS:${getAddr()}] sync-info: Candidate added, sync-initiate will be triggered`);
                  } catch (syncInfoError) {
                    logger.log(`[WS:${getAddr()}] sync-info ERROR:`, syncInfoError);
                  }
                  break;
                }

                case 'sync-initiate': {
                  // Sync initiation from another participant - they want our data
                  // New protocol: receives their manifest, we respond with our manifest
                  // Old protocol: just sends raw data
                  logger.log(`[WS:${getAddr()}] === SYNC-INITIATE RECEIVED ===`);
                  const initiatePayload = controlPayload.message as SyncInitiatePayload & {
                    // Legacy: old protocol just had inboxAddress
                  };

                  const targetInbox = initiatePayload.inboxAddress;
                  if (!targetInbox) {
                    logger.log(`[WS:${getAddr()}] sync-initiate: No target inbox, skipping`);
                    break;
                  }

                  // Check if we're already processing a sync-initiate for this space+target
                  const syncKey = `${spaceId}:${targetInbox}`;
                  if (syncInitiateInFlightRef.current.has(syncKey)) {
                    logger.log(`[WS:${getAddr()}] sync-initiate: Already in-flight for ${targetInbox.substring(0, 12)}, skipping duplicate`);
                    break;
                  }
                  syncInitiateInFlightRef.current.add(syncKey);
                  logger.log(`[WS:${getAddr()}] sync-initiate: Added to in-flight set, processing for ${targetInbox.substring(0, 12)}`);

                  try {
                    const client = wsClientRef.current;
                    if (!client || !client.isConnected) {
                      logger.log(`[WS:${getAddr()}] sync-initiate: No client connection`);
                      break;
                    }

                    // Check if this is new protocol (has manifest) or legacy
                    if (initiatePayload.manifest) {
                      // NEW PROTOCOL: Respond with sync-manifest
                      logger.log(`[WS:${getAddr()}] sync-initiate: New protocol - responding with manifest`);
                      const syncService = getSyncService();
                      if (!syncService) {
                        logger.log(`[WS:${getAddr()}] sync-initiate: No SyncService available`);
                        break;
                      }

                      const space = getSpace(spaceId);
                      const channelId = space?.defaultChannelId || spaceId;

                      // Get our peer IDs from encryption state
                      const spaceConversationId = `${spaceId}/${spaceId}`;
                      const encryptionStates = encryptionStateStorage.getEncryptionStates(spaceConversationId);
                      let peerIds: number[] = [];
                      if (encryptionStates.length > 0) {
                        const parsed = JSON.parse(encryptionStates[0].state);
                        const ratchetState = parsed.state ? JSON.parse(parsed.state) : parsed;
                        if (ratchetState.id_peer_map) {
                          peerIds = Object.keys(ratchetState.id_peer_map).map(Number);
                        }
                      }

                      // Get our inbox address
                      const ourInboxKey = getSpaceKey(spaceId, 'inbox');
                      if (!ourInboxKey?.address) {
                        logger.log(`[WS:${getAddr()}] sync-initiate: No inbox key found`);
                        break;
                      }

                      // Build and send our manifest
                      const manifestPayload = await syncService.buildSyncManifest(spaceId, channelId, peerIds, ourInboxKey.address);
                      const manifestEnvelope = await sendSyncManifestMessage(
                        spaceId,
                        targetInbox,
                        manifestPayload
                      );
                      client.enqueueOutbound(async () => [manifestEnvelope]);
                      logger.log(`[WS:${getAddr()}] sync-initiate: Sent sync-manifest response`);

                      // Also build and send delta with data they're missing
                      // The initiator's manifest is in initiatePayload.manifest
                      const ourPeerEntries = new Map<number, { peerId: number; publicKey: string }>();
                      if (encryptionStates.length > 0) {
                        const parsed = JSON.parse(encryptionStates[0].state);
                        const ratchetState = parsed.state ? JSON.parse(parsed.state) : parsed;
                        if (ratchetState.id_peer_map) {
                          for (const [idStr, pubKey] of Object.entries(ratchetState.id_peer_map)) {
                            const peerId = parseInt(idStr, 10);
                            ourPeerEntries.set(peerId, { peerId, publicKey: pubKey as string });
                          }
                        }
                      }

                      const deltaPayloads = await syncService.buildSyncDelta(
                        spaceId,
                        channelId,
                        initiatePayload.manifest,
                        initiatePayload.memberDigests || [],
                        initiatePayload.peerIds || [],
                        ourPeerEntries
                      );

                      logger.log(`[WS:${getAddr()}] sync-initiate: Built ${deltaPayloads.length} delta payload(s) to send`);

                      if (deltaPayloads.length > 0) {
                        const deltaEnvelopes = await sendSyncDeltaMessages(
                          spaceId,
                          targetInbox,
                          deltaPayloads
                        );

                        for (const envelope of deltaEnvelopes) {
                          client.enqueueOutbound(async () => [envelope]);
                        }
                        logger.log(`[WS:${getAddr()}] sync-initiate: Sent ${deltaEnvelopes.length} delta envelope(s)`)
                      }

                      // Also send sync-peer-map with ratchet state for encryption key sync
                      if (encryptionStates.length > 0) {
                        const stateData = encryptionStates[0];
                        const spaceConversationId = `${spaceId}/${spaceId}`;
                        const fallbackState = encryptionStateStorage.getFallbackState(spaceConversationId, stateData.inboxId);
                        const stateToSync = fallbackState || stateData;

                        const parsed = JSON.parse(stateToSync.state);
                        const ratchetState = parsed.state ? JSON.parse(parsed.state) : parsed;

                        if (ratchetState.id_peer_map && ratchetState.peer_id_map) {
                          logger.log(`[WS:${getAddr()}] sync-initiate: Sending sync-peer-map with ratchet state`);
                          const peerMapEnvelope = await sendSyncPeerMapMessage(spaceId, targetInbox, {
                            id_peer_map: ratchetState.id_peer_map,
                            peer_id_map: ratchetState.peer_id_map,
                            root_key: ratchetState.root_key,
                            dkg_ratchet: ratchetState.dkg_ratchet,
                            receiving_group_key: ratchetState.receiving_group_key,
                            receiving_chain_key: ratchetState.receiving_chain_key,
                            current_header_key: ratchetState.current_header_key,
                            next_header_key: ratchetState.next_header_key,
                            async_dkg_pubkey: ratchetState.async_dkg_pubkey,
                            threshold: ratchetState.threshold,
                          });
                          client.enqueueOutbound(async () => [peerMapEnvelope]);
                          logger.log(`[WS:${getAddr()}] sync-initiate: Sent sync-peer-map`);
                        }
                      }
                    } else {
                      // LEGACY PROTOCOL: Send raw data
                      logger.log(`[WS:${getAddr()}] sync-initiate: Legacy protocol - sending raw data`);
                      const spaceConversationId = `${spaceId}/${spaceId}`;
                      const encryptionStates = encryptionStateStorage.getEncryptionStates(spaceConversationId);

                      if (encryptionStates.length > 0) {
                        const stateData = encryptionStates[0];

                        // Use FALLBACK state for sync - this is what's actually used for encryption
                        const fallbackState = encryptionStateStorage.getFallbackState(spaceConversationId, stateData.inboxId);
                        const stateToSync = fallbackState || stateData;

                        let ratchetState: Record<string, unknown>;
                        const parsed = JSON.parse(stateToSync.state);
                        if (parsed.state && typeof parsed.state === 'string') {
                          ratchetState = JSON.parse(parsed.state);
                        } else {
                          ratchetState = parsed;
                        }

                        logger.log(`[WS:${getAddr()}] sync-initiate: Using ${fallbackState ? 'FALLBACK' : 'current'} state for sync`);
                        logger.log(`[WS:${getAddr()}] sync-initiate: root_key preview: ${(ratchetState.root_key as string)?.substring(0, 20)}`);

                        if (ratchetState.id_peer_map && ratchetState.peer_id_map) {
                          logger.log(`[WS:${getAddr()}] sync-initiate: Sending sync data to ${targetInbox.substring(0, 12)}`);
                          const peerMapEnvelope = await sendSyncPeerMapMessage(spaceId, targetInbox, {
                            id_peer_map: ratchetState.id_peer_map,
                            peer_id_map: ratchetState.peer_id_map,
                            // Include critical fields for ratchet sync
                            root_key: ratchetState.root_key,
                            dkg_ratchet: ratchetState.dkg_ratchet,
                            receiving_group_key: ratchetState.receiving_group_key,
                            receiving_chain_key: ratchetState.receiving_chain_key,
                            current_header_key: ratchetState.current_header_key,
                            next_header_key: ratchetState.next_header_key,
                            async_dkg_pubkey: ratchetState.async_dkg_pubkey,
                            threshold: ratchetState.threshold,
                          });
                          client.enqueueOutbound(async () => [peerMapEnvelope]);

                          const adapter = getMMKVAdapter();
                          const members = await adapter.getSpaceMembers(spaceId);
                          if (members.length > 0) {
                            const memberData = members.map(m => ({
                              user_address: m.address,
                              display_name: m.display_name,
                              user_icon: m.profile_image,
                              inbox_address: m.inbox_address,
                            }));
                            const memberEnvelopes = await sendSyncMembersMessage(spaceId, targetInbox, memberData);
                            for (const env of memberEnvelopes) {
                              client.enqueueOutbound(async () => [env]);
                            }
                          }

                          const space = getSpace(spaceId);
                          const channelId = space?.defaultChannelId || spaceId;
                          const messagesResult = await storage.getMessages({
                            spaceId,
                            channelId,
                            limit: 1000,
                          });
                          if (messagesResult.messages.length > 0) {
                            const messageEnvelopes = await sendSyncMessagesMessage(
                              spaceId,
                              targetInbox,
                              channelId,
                              messagesResult.messages
                            );
                            for (const env of messageEnvelopes) {
                              client.enqueueOutbound(async () => [env]);
                            }
                          }
                          logger.log(`[WS:${getAddr()}] === SYNC-INITIATE COMPLETE (legacy) ===`);
                        }
                      }
                    }
                  } catch (initiateError) {
                    logger.log('[WS] Error processing sync-initiate:', initiateError);
                  } finally {
                    setTimeout(() => {
                      syncInitiateInFlightRef.current.delete(syncKey);
                      logger.log(`[WS:${getAddr()}] sync-initiate: Removed ${targetInbox.substring(0, 12)} from in-flight set`);
                    }, 5000);
                  }
                  break;
                }

                case 'sync-members': {
                  // Batch of members from sync
                  logger.log(`[WS:${getAddr()}] Received sync-members control message`);
                  try {
                    // Handle both naming conventions (desktop uses underscore, mobile used camelCase)
                    const syncMembersPayload = controlPayload.message as {
                      type: 'sync-members';
                      members?: {
                        // Desktop naming (underscore)
                        user_address?: string;
                        display_name?: string;
                        user_icon?: string;
                        inbox_address?: string;
                        // Legacy mobile naming (camelCase) - for backwards compatibility
                        address?: string;
                        displayName?: string;
                        userIcon?: string;
                        inboxAddress?: string;
                      }[];
                    };

                    if (syncMembersPayload.members && syncMembersPayload.members.length > 0) {
                      const adapter = getMMKVAdapter();
                      for (const member of syncMembersPayload.members) {
                        // Support both naming conventions
                        await adapter.saveSpaceMember(spaceId, {
                          address: member.user_address || member.address || '',
                          display_name: member.display_name || member.displayName,
                          profile_image: member.user_icon || member.userIcon,
                          inbox_address: member.inbox_address || member.inboxAddress || '',
                        });
                      }
                      logger.log(`[WS:${getAddr()}] Synced ${syncMembersPayload.members.length} members`);
                      queryClient.invalidateQueries({ queryKey: queryKeys.spaces.members(spaceId) });
                    }
                  } catch (syncMembersError) {
                    logger.log('[WS] Error processing sync-members:', syncMembersError);
                  }
                  break;
                }

                case 'sync-messages': {
                  // Batch of messages from sync (LEGACY - kept for backwards compatibility)
                  logger.log(`[WS:${getAddr()}] Received sync-messages control message (legacy)`);
                  try {
                    const syncMessagesPayload = controlPayload.message as {
                      type: 'sync-messages';
                      messages?: Message[];
                      channelId?: string;
                    };

                    if (syncMessagesPayload.messages && syncMessagesPayload.messages.length > 0) {
                      const space = getSpace(spaceId);
                      const channelId = syncMessagesPayload.channelId || space?.defaultChannelId || spaceId;

                      for (const msg of syncMessagesPayload.messages) {
                        await storage.saveMessage(
                          { ...msg, spaceId, channelId },
                          msg.createdDate || Date.now(),
                          spaceId,
                          'space',
                          space?.iconUrl || '',
                          space?.spaceName || spaceId.substring(0, 8)
                        );
                      }
                      logger.log(`[WS:${getAddr()}] Synced ${syncMessagesPayload.messages.length} messages (legacy)`);

                      // Invalidate messages cache
                      queryClient.invalidateQueries({
                        queryKey: queryKeys.messages.infinite(spaceId, channelId),
                      });
                    }
                  } catch (syncMessagesError) {
                    logger.log('[WS] Error processing sync-messages:', syncMessagesError);
                  }
                  break;
                }

                case 'sync-manifest': {
                  // NEW PROTOCOL: Received manifest from peer - compute and send delta
                  logger.log(`[WS:${getAddr()}] === SYNC-MANIFEST RECEIVED ===`);
                  try {
                    const manifestPayload = controlPayload.message as SyncManifestPayload;
                    const syncService = getSyncService();

                    if (!syncService) {
                      logger.log(`[WS:${getAddr()}] sync-manifest: No SyncService available`);
                      break;
                    }

                    const client = wsClientRef.current;
                    if (!client || !client.isConnected) {
                      logger.log(`[WS:${getAddr()}] sync-manifest: No client connection`);
                      break;
                    }

                    const inboxKey = getSpaceKey(spaceId, 'inbox');
                    if (!inboxKey?.address) {
                      logger.log(`[WS:${getAddr()}] sync-manifest: No inbox key`);
                      break;
                    }

                    // Get sender's inbox address to respond to
                    // We need to find who sent this - the initiator who sent sync-initiate
                    // For now, we'll need the sender info from the manifest itself or envelope
                    // TODO: The payload should include inboxAddress for response routing
                    logger.log(`[WS:${getAddr()}] sync-manifest: received manifest with ${manifestPayload.manifest.digests.length} digests`);

                    // Get our peer entries for delta calculation
                    const spaceConversationId = `${spaceId}/${spaceId}`;
                    const encryptionStates = encryptionStateStorage.getEncryptionStates(spaceConversationId);
                    const ourPeerEntries = new Map<number, { peerId: number; publicKey: string }>();
                    if (encryptionStates.length > 0) {
                      const parsed = JSON.parse(encryptionStates[0].state);
                      const ratchetState = parsed.state ? JSON.parse(parsed.state) : parsed;
                      if (ratchetState.id_peer_map) {
                        for (const [idStr, pubKey] of Object.entries(ratchetState.id_peer_map)) {
                          const peerId = parseInt(idStr, 10);
                          ourPeerEntries.set(peerId, { peerId, publicKey: pubKey as string });
                        }
                      }
                    }

                    // Build delta payloads
                    const space = getSpace(spaceId);
                    const channelId = manifestPayload.manifest.channelId || space?.defaultChannelId || spaceId;

                    const deltaPayloads = await syncService.buildSyncDelta(
                      spaceId,
                      channelId,
                      manifestPayload.manifest,
                      manifestPayload.memberDigests,
                      manifestPayload.peerIds,
                      ourPeerEntries
                    );

                    logger.log(`[WS:${getAddr()}] sync-manifest: Built ${deltaPayloads.length} delta payload(s)`);

                    // Get target from manifest payload (preferred) or fall back to session
                    const syncTarget = manifestPayload.inboxAddress || syncService.getSyncTarget(spaceId);
                    if (!syncTarget) {
                      logger.log(`[WS:${getAddr()}] sync-manifest: No sync target (inboxAddress or session), cannot send delta`);
                      break;
                    }

                    logger.log(`[WS:${getAddr()}] sync-manifest: Sending ${deltaPayloads.length} delta(s) to ${syncTarget.substring(0, 12)}`);

                    // Send all delta payloads
                    if (deltaPayloads.length > 0) {
                      const deltaEnvelopes = await sendSyncDeltaMessages(
                        spaceId,
                        syncTarget,
                        deltaPayloads
                      );

                      for (const envelope of deltaEnvelopes) {
                        client.enqueueOutbound(async () => [envelope]);
                      }
                      logger.log(`[WS:${getAddr()}] sync-manifest: Sent ${deltaEnvelopes.length} delta envelope(s)`);
                    }

                    // Also send sync-peer-map with ratchet state for encryption key sync
                    if (encryptionStates.length > 0) {
                      const stateData = encryptionStates[0];
                      const fallbackState = encryptionStateStorage.getFallbackState(spaceConversationId, stateData.inboxId);
                      const stateToSync = fallbackState || stateData;

                      const parsed = JSON.parse(stateToSync.state);
                      const ratchetState = parsed.state ? JSON.parse(parsed.state) : parsed;

                      if (ratchetState.id_peer_map && ratchetState.peer_id_map) {
                        logger.log(`[WS:${getAddr()}] sync-manifest: Sending sync-peer-map with ratchet state`);
                        const peerMapEnvelope = await sendSyncPeerMapMessage(spaceId, syncTarget, {
                          id_peer_map: ratchetState.id_peer_map,
                          peer_id_map: ratchetState.peer_id_map,
                          root_key: ratchetState.root_key,
                          dkg_ratchet: ratchetState.dkg_ratchet,
                          receiving_group_key: ratchetState.receiving_group_key,
                          receiving_chain_key: ratchetState.receiving_chain_key,
                          current_header_key: ratchetState.current_header_key,
                          next_header_key: ratchetState.next_header_key,
                          async_dkg_pubkey: ratchetState.async_dkg_pubkey,
                          threshold: ratchetState.threshold,
                        });
                        client.enqueueOutbound(async () => [peerMapEnvelope]);
                        logger.log(`[WS:${getAddr()}] sync-manifest: Sent sync-peer-map`);
                      }
                    }

                    // Mark sync as complete
                    syncService.setSyncInProgress(spaceId, false);
                    logger.log(`[WS:${getAddr()}] sync-manifest: Sync complete`);
                  } catch (manifestError) {
                    logger.log('[WS] Error processing sync-manifest:', manifestError);
                  }
                  break;
                }

                case 'sync-delta': {
                  // NEW PROTOCOL: Received delta from peer - apply to local storage
                  logger.log(`[WS:${getAddr()}] === SYNC-DELTA RECEIVED ===`);
                  try {
                    const deltaPayload = controlPayload.message as SyncDeltaPayload;
                    const syncService = getSyncService();

                    if (!syncService) {
                      logger.log(`[WS:${getAddr()}] sync-delta: No SyncService available`);
                      break;
                    }

                    const space = getSpace(spaceId);

                    // Apply message delta
                    if (deltaPayload.messageDelta) {
                      const msgDelta = deltaPayload.messageDelta;
                      const channelId = msgDelta.channelId || space?.defaultChannelId || spaceId;
                      logger.log(`[WS:${getAddr()}] sync-delta: Applying ${msgDelta.newMessages.length} new, ${msgDelta.updatedMessages.length} updated, ${msgDelta.deletedMessageIds.length} deleted messages`);

                      for (const msg of msgDelta.newMessages) {
                        await storage.saveMessage(
                          { ...msg, spaceId, channelId },
                          msg.createdDate || Date.now(),
                          spaceId,
                          'space',
                          space?.iconUrl || '',
                          space?.spaceName || spaceId.substring(0, 8)
                        );
                      }

                      for (const msg of msgDelta.updatedMessages) {
                        await storage.saveMessage(
                          { ...msg, spaceId, channelId },
                          msg.createdDate || Date.now(),
                          spaceId,
                          'space',
                          space?.iconUrl || '',
                          space?.spaceName || spaceId.substring(0, 8)
                        );
                      }

                      for (const msgId of msgDelta.deletedMessageIds) {
                        await storage.deleteMessage(msgId);
                      }

                      queryClient.invalidateQueries({
                        queryKey: queryKeys.messages.infinite(spaceId, channelId),
                      });
                    }

                    // Apply reaction delta
                    if (deltaPayload.reactionDelta) {
                      logger.log(`[WS:${getAddr()}] sync-delta: Applying reaction delta`);
                      await syncService.applyReactionDelta(deltaPayload.reactionDelta);
                      const channelId = deltaPayload.reactionDelta.channelId || space?.defaultChannelId || spaceId;
                      queryClient.invalidateQueries({
                        queryKey: queryKeys.messages.infinite(spaceId, channelId),
                      });
                    }

                    // Apply member delta
                    if (deltaPayload.memberDelta) {
                      logger.log(`[WS:${getAddr()}] sync-delta: Applying ${deltaPayload.memberDelta.members.length} member updates`);
                      const adapter = getMMKVAdapter();
                      for (const member of deltaPayload.memberDelta.members) {
                        await adapter.saveSpaceMember(spaceId, member);
                      }
                      queryClient.invalidateQueries({ queryKey: queryKeys.spaces.members(spaceId) });
                    }

                    // Apply peer map delta (update encryption state)
                    if (deltaPayload.peerMapDelta && deltaPayload.peerMapDelta.added.length > 0) {
                      logger.log(`[WS:${getAddr()}] sync-delta: Applying ${deltaPayload.peerMapDelta.added.length} peer map additions`);
                      const spaceConversationId = `${spaceId}/${spaceId}`;
                      const encryptionStates = encryptionStateStorage.getEncryptionStates(spaceConversationId);

                      if (encryptionStates.length > 0) {
                        const stateData = encryptionStates[0];
                        const parsed = JSON.parse(stateData.state);
                        let ratchetState = parsed.state ? JSON.parse(parsed.state) : parsed;

                        // Add new peers
                        for (const peer of deltaPayload.peerMapDelta.added) {
                          if (!ratchetState.id_peer_map) ratchetState.id_peer_map = {};
                          if (!ratchetState.peer_id_map) ratchetState.peer_id_map = {};
                          ratchetState.id_peer_map[peer.peerId] = peer.publicKey;
                          ratchetState.peer_id_map[peer.publicKey] = peer.peerId;
                        }

                        // Save updated state
                        const wasNested = !!parsed.state;
                        const newStateStr = JSON.stringify(ratchetState);
                        const stateToSave = wasNested
                          ? JSON.stringify({ state: newStateStr, template: parsed.template, evals: parsed.evals })
                          : newStateStr;

                        encryptionStateStorage.saveEncryptionState({
                          conversationId: spaceConversationId,
                          inboxId: stateData.inboxId,
                          state: stateToSave,
                          timestamp: Date.now(),
                        });
                        logger.log(`[WS:${getAddr()}] sync-delta: Saved updated peer map`);
                      }
                    }

                    if (deltaPayload.isFinal) {
                      logger.log(`[WS:${getAddr()}] sync-delta: Received final delta - sync complete`);
                    }
                  } catch (deltaError) {
                    logger.log('[WS] Error processing sync-delta:', deltaError);
                  }
                  break;
                }

                case 'verify-kicked': {
                  // Verify kicked status for users
                  logger.log(`[WS:${getAddr()}] Received verify-kicked control message`);
                  try {
                    const verifyPayload = controlPayload.message as {
                      type: 'verify-kicked';
                      kickedAddresses?: string[];
                    };

                    if (verifyPayload.kickedAddresses && verifyPayload.kickedAddresses.length > 0) {
                      const adapter = getMMKVAdapter();
                      for (const address of verifyPayload.kickedAddresses) {
                        const member = await adapter.getSpaceMember(spaceId, address);
                        if (member) {
                          await adapter.saveSpaceMember(spaceId, {
                            ...member,
                            isKicked: true,
                            inbox_address: '',
                          });
                        }
                      }
                      logger.log(`[WS:${getAddr()}] Verified ${verifyPayload.kickedAddresses.length} kicked users`);
                      queryClient.invalidateQueries({ queryKey: queryKeys.spaces.members(spaceId) });
                    }
                  } catch (verifyError) {
                    logger.log('[WS] Error processing verify-kicked:', verifyError);
                  }
                  break;
                }

                case 'rekey': {
                  // Re-encryption after kick - update encryption state with new keys
                  logger.log(`[WS:${getAddr()}] Received rekey control message`);
                  try {
                    const rekeyPayload = controlPayload.message as {
                      type: 'rekey';
                      info?: string; // Inbox-sealed envelope containing new configKey and state
                      kick?: string; // Optional: user being kicked in this rekey
                    };

                    if (!rekeyPayload.info) {
                      logger.warn('[WS] rekey message missing info');
                      break;
                    }

                    // Get device keyset for unsealing
                    const deviceKeyset = await getDeviceKeyset();
                    if (!deviceKeyset) {
                      logger.log('[WS] Cannot process rekey - no device keyset');
                      break;
                    }
                    if (!deviceKeyset.inboxEncryptionPrivateKey || !Array.isArray(deviceKeyset.inboxEncryptionPrivateKey) || deviceKeyset.inboxEncryptionPrivateKey.length === 0) {
                      logger.log('[WS] Cannot process rekey - inboxEncryptionPrivateKey missing or invalid');
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
                      logger.warn('[WS] rekey sealedInfo missing required fields:', {
                        hasEphemeralKey: !!ephemeralPubKey,
                        hasCiphertext: !!ciphertext.ciphertext,
                        hasIV: !!ciphertext.initialization_vector,
                        rawInfo: rekeyPayload.info.substring(0, 200),
                      });
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
                      logger.log(`[WS:${getAddr()}] Saved new config key`);
                    }

                    // 2. Update the Triple Ratchet state
                    if (innerEnvelope.state) {
                      const template = JSON.parse(innerEnvelope.state) as Record<string, unknown>;

                      // Set peer_key from device's inbox encryption private key
                      if (!deviceKeyset.inboxEncryptionPrivateKey || !Array.isArray(deviceKeyset.inboxEncryptionPrivateKey) || deviceKeyset.inboxEncryptionPrivateKey.length === 0) {
                        logger.warn('[WS] Cannot update state - inboxEncryptionPrivateKey missing or invalid');
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

                      // Also update fallback state for consistency
                      encryptionStateStorage.saveFallbackState({
                        conversationId: spaceConversationId,
                        inboxId,
                        state: newState,
                        timestamp: Date.now(),
                      });

                      logger.log(`[WS:${getAddr()}] Updated encryption state from rekey`);
                    }

                    // 3. Handle kick if included
                    if (rekeyPayload.kick) {
                      const kickedAddress = rekeyPayload.kick;
                      logger.log(`[WS:${getAddr()}] Rekey includes kick for:`, kickedAddress);

                      // Get our address - use ref first, then MMKV storage fallback
                      let ownAddress = fullUserAddrRef.current;
                      if (!ownAddress) {
                        try {
                          const storedUser = mmkvStorage.getItem('auth:user');
                          if (storedUser) {
                            const parsed = JSON.parse(storedUser);
                            ownAddress = parsed.address;
                          }
                        } catch (e) {
                          logger.log('[WS] Failed to get user address from storage:', e);
                        }
                      }

                      if (ownAddress && kickedAddress === ownAddress) {
                        logger.warn(`[WS:${getAddr()}] *** WE HAVE BEEN KICKED (via rekey) ***`);
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
                        queryClient.invalidateQueries({ queryKey: queryKeys.messages.infinite(spaceId, channelId) });
                        logger.log(`[WS:${getAddr()}] Saved kick event as message`);
                      }
                      queryClient.invalidateQueries({ queryKey: queryKeys.spaces.members(spaceId) });
                    }

                    logger.log(`[WS:${getAddr()}] Rekey processed successfully`);
                  } catch (rekeyError) {
                    logger.log('[WS] Error processing rekey:', rekeyError);
                    if (rekeyError instanceof Error) {
                      logger.log('[WS] Rekey error details:', rekeyError.message);
                    }
                  }
                  break;
                }

                case 'space-manifest':
                  // Space configuration update
                  logger.log(`[WS:${getAddr()}] *** RECEIVED space-manifest control message ***`);
                  logger.log(`[WS:${getAddr()}] Full controlPayload.message:`, JSON.stringify(controlPayload.message).substring(0, 500));
                  try {
                    const manifest = controlPayload.message.manifest;
                    logger.log(`[WS:${getAddr()}] manifest exists:`, !!manifest);
                    if (!manifest) {
                      logger.log('[WS] space-manifest missing manifest data');
                      logger.log('[WS] controlPayload.message keys:', Object.keys(controlPayload.message || {}));
                      break;
                    }

                    logger.log(`[WS:${getAddr()}] manifest keys:`, Object.keys(manifest));
                    logger.log(`[WS:${getAddr()}] manifest.space_manifest length:`, manifest.space_manifest?.length);
                    logger.log(`[WS:${getAddr()}] manifest.owner_public_key:`, manifest.owner_public_key?.substring(0, 30));
                    logger.log(`[WS:${getAddr()}] manifest.timestamp:`, manifest.timestamp);

                    // Get space registration to verify owner
                    const quorumClient = getQuorumClient();
                    logger.log(`[WS:${getAddr()}] Fetching space registration for:`, spaceId);
                    const spaceReg = await quorumClient.getSpaceRegistration(spaceId);
                    logger.log(`[WS:${getAddr()}] spaceReg owner_public_keys:`, spaceReg?.owner_public_keys?.map(k => k.substring(0, 30)));
                    if (!spaceReg?.owner_public_keys?.includes(manifest.owner_public_key)) {
                      logger.log('[WS] space-manifest owner not authorized');
                      logger.log('[WS] manifest.owner_public_key:', manifest.owner_public_key);
                      logger.log('[WS] spaceReg.owner_public_keys:', spaceReg?.owner_public_keys);
                      break;
                    }
                    logger.log(`[WS:${getAddr()}] Owner authorized, verifying signature...`);

                    // Verify signature - native module expects base64 encoded values
                    const signingProvider = new NativeSigningProvider();
                    const messageToVerify = new Uint8Array([
                      ...new TextEncoder().encode(manifest.space_manifest),
                      ...int64ToBytes(manifest.timestamp),
                    ]);
                    logger.log(`[WS:${getAddr()}] messageToVerify length:`, messageToVerify.length);

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

                    logger.log(`[WS:${getAddr()}] publicKeyBase64 length:`, publicKeyBase64.length);
                    logger.log(`[WS:${getAddr()}] messageBase64 length:`, messageBase64.length);
                    logger.log(`[WS:${getAddr()}] signatureBase64 length:`, signatureBase64.length);

                    const isValid = await signingProvider.verifyEd448(
                      publicKeyBase64,
                      messageBase64,
                      signatureBase64
                    );
                    logger.log(`[WS:${getAddr()}] Signature valid:`, isValid);

                    if (!isValid) {
                      logger.log('[WS] space-manifest signature verification failed');
                      break;
                    }

                    // Decrypt the manifest using config key
                    const configKey = getSpaceKey(spaceId, 'config');
                    logger.log(`[WS:${getAddr()}] configKey exists:`, !!configKey);
                    logger.log(`[WS:${getAddr()}] configKey.publicKey:`, configKey?.publicKey?.substring(0, 30));
                    if (!configKey) {
                      logger.log('[WS] space-manifest missing config key');
                      break;
                    }

                    logger.log(`[WS:${getAddr()}] Parsing space_manifest ciphertext...`);
                    const ciphertext = JSON.parse(manifest.space_manifest) as {
                      ciphertext: string;
                      initialization_vector: string;
                      associated_data: string;
                    };
                    logger.log(`[WS:${getAddr()}] ciphertext parsed, IV length:`, ciphertext.initialization_vector?.length);

                    const cryptoProvider = new NativeCryptoProvider();
                    logger.log(`[WS:${getAddr()}] Decrypting with config key...`);
                    const decryptedBytes = await cryptoProvider.decryptInboxMessage({
                      inbox_private_key: Array.from(hexToBytes(configKey.privateKey)),
                      ephemeral_public_key: Array.from(hexToBytes(manifest.ephemeral_public_key)),
                      ciphertext,
                    });
                    logger.log(`[WS:${getAddr()}] Decrypted ${decryptedBytes.length} bytes`);

                    const decryptedText = new TextDecoder().decode(new Uint8Array(decryptedBytes));
                    logger.log(`[WS:${getAddr()}] Decrypted text preview:`, decryptedText.substring(0, 200));
                    const updatedSpace = JSON.parse(decryptedText) as Space;

                    // Save updated space
                    logger.log(`[WS:${getAddr()}] Saving updated space...`);
                    saveSpace(updatedSpace);
                    logger.log(`[WS:${getAddr()}] *** SAVED updated space manifest ***:`, {
                      spaceId: updatedSpace.spaceId,
                      spaceName: updatedSpace.spaceName,
                      emojisCount: updatedSpace.emojis?.length ?? 0,
                      emojiNames: updatedSpace.emojis?.map(e => e.name),
                    });

                    // Invalidate React Query cache using proper query keys
                    queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all });
                    queryClient.invalidateQueries({ queryKey: queryKeys.spaces.detail(spaceId) });
                    logger.log(`[WS:${getAddr()}] Invalidated React Query cache for spaces`);
                  } catch (err) {
                    logger.log('[WS] Error processing space-manifest:', err);
                    if (err instanceof Error) {
                      logger.log('[WS] Error stack:', err.stack);
                    }
                  }
                  break;

                default:
                  logger.log(`[WS:${getAddr()}] Unhandled control message type:`, controlType);
              }

              // Delete control message from inbox after successful processing
              if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                deleteSpaceInboxMessages(
                  spaceInboxKey.address,
                  [message.timestamp],
                  { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                ).catch(err => logger.warn('[WS] Failed to delete control message:', err));
              }

              return;
            }

            if (payload.type !== 'message') {
              logger.log(`[WS:${getAddr()}] Non-message/control payload type:`, payload.type);
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
              logger.log(`[WS:${getAddr()}] Message is plaintext (envelope-only encryption)`);
              spaceMessage = payload.message as Message;

              // Check if this is our own message echo
              const senderId = (spaceMessage.content as { senderId?: string })?.senderId;
              if (senderId && senderId === user?.address) {
                logger.log(`[WS:${getAddr()}] Skipping own plaintext message echo:`, spaceMessage.messageId);
                if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                  deleteSpaceInboxMessages(
                    spaceInboxKey.address,
                    [message.timestamp],
                    { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                  ).catch(err => logger.warn('[WS] Failed to delete own plaintext echo:', err));
                }
                return;
              }
            } else {
              // Message is TR-encrypted, need to decrypt with Triple Ratchet
              // Get Triple Ratchet state for this space
              const spaceConversationId = `${spaceId}/${spaceId}`;
              const encryptionStates = encryptionStateStorage.getEncryptionStates(spaceConversationId);

              logger.log(`[WS:${getAddr()}] Encryption states for space:`, {
                conversationId: spaceConversationId,
                statesCount: encryptionStates.length,
                firstStatePreview: encryptionStates[0]?.state?.substring(0, 100),
              });

              if (encryptionStates.length === 0) {
                logger.log('[WS] No encryption state for space and message is not plaintext:', spaceId.substring(0, 12));
                return;
              }

              // Decrypt with Triple Ratchet
              let ratchetState: unknown;
              try {
                ratchetState = JSON.parse(encryptionStates[0].state);
              } catch (parseError) {
                logger.log(`[WS:${getAddr()}] Failed to parse ratchet state:`, parseError);
                logger.log(`[WS:${getAddr()}] Raw state:`, encryptionStates[0].state.substring(0, 200));
                return;
              }

              if (!ratchetState || typeof ratchetState !== 'object') {
                logger.log(`[WS:${getAddr()}] Invalid ratchet state - not an object:`, typeof ratchetState);
                logger.log(`[WS:${getAddr()}] State value:`, encryptionStates[0].state.substring(0, 200));
                return;
              }

              const tripleRatchetEnvelope = typeof payload.message === 'string'
                ? payload.message
                : JSON.stringify(payload.message);

              // Check if this is our own echoed message - skip decryption
              // (Triple Ratchet participants can't decrypt their own messages)
              if (isSentEnvelope(tripleRatchetEnvelope)) {
              logger.log(`[WS:${getAddr()}] Skipping decryption of our own echoed message`);
              clearSentEnvelope(tripleRatchetEnvelope);
              // Still need to delete from inbox even for our own messages
              if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                deleteSpaceInboxMessages(
                  spaceInboxKey.address,
                  [message.timestamp],
                  { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                ).catch(err => logger.warn('[WS] Failed to delete own sent envelope:', err));
              }
              return;
            }

            const ratchetStateObj = ratchetState as Record<string, unknown>;
            logger.log(`[WS:${getAddr()}] Decrypting with Triple Ratchet:`, {
              envelopeLength: tripleRatchetEnvelope.length,
              envelopePreview: tripleRatchetEnvelope.substring(0, 100),
              ratchetStateKeys: Object.keys(ratchetStateObj),
              hasNestedState: 'state' in ratchetStateObj,
            });

            let decryptResult;
            let usedFallback = false; // Track whether we used fallback for decrypt
            // Get the actual state - it may be nested as { state: "..." }
            // State must be a string (JSON), so stringify if it's an object
            // Declare outside try block so it's accessible in the save section
            const rawState = ratchetStateObj.state ?? ratchetStateObj;
            const actualState: string = typeof rawState === 'string' ? rawState : JSON.stringify(rawState);

            try {
              logger.log(`[WS:${getAddr()}] Actual decrypt state (first 200):`, actualState.substring(0, 200));

              // Debug: Parse state to check peer_id_map and our identity
              try {
                const parsedState = JSON.parse(actualState);

                // Check our peer_key - derive public key to compare with peer_id_map
                if (parsedState.peer_key) {
                  logger.log(`[WS:${getAddr()}] DEBUG peer_key (first 40):`, parsedState.peer_key.substring(0, 40));
                }

                if (parsedState.peer_id_map) {
                  logger.log(`[WS:${getAddr()}] peer_id_map entries:`, Object.keys(parsedState.peer_id_map).length);
                  const peerIdMapKeys = Object.keys(parsedState.peer_id_map);
                  logger.log(`[WS:${getAddr()}] peer_id_map keys (first 40 chars):`, peerIdMapKeys.map(k => k.substring(0, 40)));
                  logger.log(`[WS:${getAddr()}] peer_id_map values (IDs):`, peerIdMapKeys.map(k => parsedState.peer_id_map[k]));
                } else {
                  logger.warn(`[WS:${getAddr()}] No peer_id_map in decrypt state!`);
                }

                if (parsedState.id_peer_map) {
                  logger.log(`[WS:${getAddr()}] id_peer_map IDs:`, Object.keys(parsedState.id_peer_map));
                } else {
                  logger.warn(`[WS:${getAddr()}] No id_peer_map in decrypt state!`);
                }

                // Check root_key
                if (parsedState.root_key) {
                  logger.log(`[WS:${getAddr()}] DEBUG root_key preview:`, parsedState.root_key.substring(0, 30));
                  logger.log(`[WS:${getAddr()}] DEBUG root_key length:`, parsedState.root_key.length);
                } else {
                  logger.log(`[WS:${getAddr()}] DEBUG root_key is MISSING!`);
                }

                // Check receiving_ephemeral_keys
                if (parsedState.receiving_ephemeral_keys) {
                  const numKeys = Object.keys(parsedState.receiving_ephemeral_keys).length;
                  logger.log(`[WS:${getAddr()}] DEBUG receiving_ephemeral_keys count:`, numKeys);
                  logger.log(`[WS:${getAddr()}] DEBUG receiving_ephemeral_keys keys (first 40):`, Object.keys(parsedState.receiving_ephemeral_keys).map(k => k.substring(0, 40)));
                } else {
                  logger.log(`[WS:${getAddr()}] DEBUG receiving_ephemeral_keys is MISSING!`);
                }

                // Check receiving_group_key - critical for AEAD decrypt
                if (parsedState.receiving_group_key) {
                  logger.log(`[WS:${getAddr()}] DEBUG receiving_group_key preview:`, parsedState.receiving_group_key.substring(0, 40));
                  logger.log(`[WS:${getAddr()}] DEBUG receiving_group_key length:`, parsedState.receiving_group_key.length);
                } else {
                  logger.log(`[WS:${getAddr()}] DEBUG receiving_group_key is MISSING - this will cause AEAD errors!`);
                }

                // Check sending_chain_key
                if (parsedState.sending_chain_key) {
                  logger.log(`[WS:${getAddr()}] DEBUG sending_chain_key preview:`, parsedState.sending_chain_key.substring(0, 30));
                } else {
                  logger.log(`[WS:${getAddr()}] DEBUG sending_chain_key is MISSING!`);
                }

                // Check receiving_chain_key
                if (parsedState.receiving_chain_key) {
                  const numChains = Object.keys(parsedState.receiving_chain_key).length;
                  logger.log(`[WS:${getAddr()}] DEBUG receiving_chain_key entries:`, numChains);
                  logger.log(`[WS:${getAddr()}] DEBUG receiving_chain_key keys (first 40):`, Object.keys(parsedState.receiving_chain_key).map(k => k.substring(0, 40)));
                } else {
                  logger.log(`[WS:${getAddr()}] DEBUG receiving_chain_key is MISSING!`);
                }

                // Check current_header_key and next_header_key - LOG FULL KEY for comparison with sender
                logger.log(`[WS:${getAddr()}] DEBUG RECV current_header_key exists:`, !!parsedState.current_header_key);
                logger.log(`[WS:${getAddr()}] DEBUG RECV current_header_key FULL:`, parsedState.current_header_key);
                logger.log(`[WS:${getAddr()}] DEBUG RECV current_header_key length:`, parsedState.current_header_key?.length);
                logger.log(`[WS:${getAddr()}] DEBUG RECV next_header_key exists:`, !!parsedState.next_header_key);
                logger.log(`[WS:${getAddr()}] DEBUG RECV next_header_key FULL:`, parsedState.next_header_key);
                logger.log(`[WS:${getAddr()}] DEBUG should_ratchet:`, parsedState.should_ratchet);

                // Check async DKG fields - these affect header key changes
                logger.log(`[WS:${getAddr()}] DEBUG async_dkg_ratchet:`, parsedState.async_dkg_ratchet);
                logger.log(`[WS:${getAddr()}] DEBUG async_dkg_pubkey exists:`, !!parsedState.async_dkg_pubkey);
                logger.log(`[WS:${getAddr()}] DEBUG should_dkg_ratchet:`, parsedState.should_dkg_ratchet ? Object.keys(parsedState.should_dkg_ratchet).length : 'N/A');
                logger.log(`[WS:${getAddr()}] DEBUG threshold:`, parsedState.threshold);

                // Check dkg_ratchet
                if (parsedState.dkg_ratchet) {
                  const dkgRatchet = typeof parsedState.dkg_ratchet === 'string'
                    ? JSON.parse(parsedState.dkg_ratchet)
                    : parsedState.dkg_ratchet;
                  logger.log(`[WS:${getAddr()}] DEBUG dkg_ratchet.id:`, dkgRatchet.id);
                  logger.log(`[WS:${getAddr()}] DEBUG dkg_ratchet.total:`, dkgRatchet.total);
                  logger.log(`[WS:${getAddr()}] DEBUG dkg_ratchet.round:`, dkgRatchet.round);
                  logger.log(`[WS:${getAddr()}] DEBUG dkg_ratchet.threshold:`, dkgRatchet.threshold);
                  logger.log(`[WS:${getAddr()}] DEBUG dkg_ratchet.scalar (first 30):`, dkgRatchet.scalar?.substring?.(0, 30));
                  logger.log(`[WS:${getAddr()}] DEBUG dkg_ratchet.scalar length:`, dkgRatchet.scalar?.length);
                  logger.log(`[WS:${getAddr()}] DEBUG dkg_ratchet.point type:`, typeof dkgRatchet.point);
                  logger.log(`[WS:${getAddr()}] DEBUG dkg_ratchet.point preview:`, JSON.stringify(dkgRatchet.point)?.substring?.(0, 50));
                  logger.log(`[WS:${getAddr()}] DEBUG dkg_ratchet.secret (first 30):`, dkgRatchet.secret?.substring?.(0, 30));
                }
              } catch (e) {
                logger.log(`[WS:${getAddr()}] Failed to parse state for debug:`, e);
              }

              decryptResult = await cryptoProvider.tripleRatchetDecrypt({
                ratchet_state: actualState,
                envelope: tripleRatchetEnvelope,
              });

              // Validate the decrypt result - check for error patterns
              const ratchetStateStr = typeof decryptResult.ratchet_state === 'string'
                ? decryptResult.ratchet_state
                : JSON.stringify(decryptResult.ratchet_state);

              if (ratchetStateStr.includes('invalid') || ratchetStateStr.includes('error')) {
                logger.log(`[WS:${getAddr()}] Decrypt returned error in ratchet_state:`, ratchetStateStr.substring(0, 200));
                throw new Error(`Triple Ratchet decrypt failed: ${ratchetStateStr.substring(0, 100)}`);
              }

            } catch (decryptError) {
              logger.log(`[WS:${getAddr()}] Triple Ratchet decrypt FAILED:`, decryptError);
              logger.log(`[WS:${getAddr()}] Ratchet state for debugging:`, JSON.stringify(ratchetStateObj).substring(0, 500));

              // Try fallback state if available (header keys may have changed after encrypt)
              const fallbackState = encryptionStateStorage.getFallbackState(spaceConversationId, encryptionStates[0].inboxId);
              if (fallbackState) {
                logger.log(`[WS:${getAddr()}] Trying fallback state for decrypt...`);
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
                  logger.log(`[WS:${getAddr()}] RECEIVER fallback critical fields:`, {
                    current_header_key: fallbackParsed.current_header_key,
                    root_key: fallbackParsed.root_key,  // CRITICAL: must match sender for key derivation
                    receiving_group_key_exists: !!fallbackParsed.receiving_group_key,
                    receiving_group_key_preview: fallbackParsed.receiving_group_key?.substring?.(0, 30),
                    receiving_chain_key_entries: Object.keys(fallbackParsed.receiving_chain_key || {}).length,
                    receiving_ephemeral_keys_entries: Object.keys(fallbackParsed.receiving_ephemeral_keys || {}).length,
                    peer_id_map_entries: Object.keys(fallbackParsed.peer_id_map || {}).length,
                    sending_chain_key_exists: !!fallbackParsed.sending_chain_key,
                    should_ratchet: fallbackParsed.should_ratchet,
                  });

                  decryptResult = await cryptoProvider.tripleRatchetDecrypt({
                    ratchet_state: fallbackActualState,
                    envelope: tripleRatchetEnvelope,
                  });

                  // Log raw result for debugging
                  logger.log(`[WS:${getAddr()}] Fallback decrypt raw result:`, {
                    ratchetStateType: typeof decryptResult.ratchet_state,
                    messageType: typeof decryptResult.message,
                    messageIsArray: Array.isArray(decryptResult.message),
                    messageLength: decryptResult.message?.length,
                  });

                  // Validate fallback decrypt result
                  const fallbackRatchetStateStr = typeof decryptResult.ratchet_state === 'string'
                    ? decryptResult.ratchet_state
                    : JSON.stringify(decryptResult.ratchet_state);

                  // Log the first 300 chars of ratchet_state to see if it's an error
                  logger.log(`[WS:${getAddr()}] Fallback ratchet_state (first 300):`, fallbackRatchetStateStr.substring(0, 300));

                  // Check for error patterns (case-insensitive) or empty message
                  const lowerState = fallbackRatchetStateStr.toLowerCase();
                  if (lowerState.includes('invalid') || lowerState.includes('error') || lowerState.includes('crypto error')) {
                    logger.log(`[WS:${getAddr()}] Fallback decrypt returned error in state:`, fallbackRatchetStateStr.substring(0, 200));
                    throw new Error(`Fallback Triple Ratchet decrypt failed: ${fallbackRatchetStateStr.substring(0, 100)}`);
                  }

                  // Also check if message is empty - this indicates decrypt actually failed
                  if (!decryptResult.message || decryptResult.message.length === 0) {
                    logger.log(`[WS:${getAddr()}] Fallback decrypt returned empty message - treating as failure`);
                    logger.log(`[WS:${getAddr()}] Fallback ratchet state preview:`, fallbackRatchetStateStr.substring(0, 300));
                    throw new Error('Fallback Triple Ratchet decrypt returned empty message');
                  }

                  logger.log(`[WS:${getAddr()}] Fallback decrypt SUCCEEDED with ${decryptResult.message.length} bytes`);
                  usedFallback = true; // Mark that we used fallback
                  // DO NOT delete fallback state - keep it for future decrypts
                  // The peer (desktop) may not be advancing its ratchet
                } catch (fallbackError) {
                  logger.log(`[WS:${getAddr()}] Fallback decrypt also FAILED:`, fallbackError);
                  throw decryptError; // Throw original error
                }
              } else {
                throw decryptError;
              }
            }

            // Save updated ratchet state (only if decryption was successful AND we didn't use fallback)
            // When fallback is used, we should NOT update the main state because:
            // 1. The fallback state is frozen at join/create time
            // 2. The peer encrypts with their fallback (frozen) state
            // 3. If we update our main state from fallback decrypts, it will diverge
            // 4. This causes subsequent main-state decrypts to fail with different chain positions
            if (!usedFallback) {
              const ratchetStateStr = typeof decryptResult.ratchet_state === 'string'
                ? decryptResult.ratchet_state
                : JSON.stringify(decryptResult.ratchet_state);

              // Don't save if it looks like an error
              if (!ratchetStateStr.includes('invalid') && ratchetStateStr.startsWith('{')) {
                // Preserve the nesting structure AND template/evals for invite generation!
                const wasNested = 'state' in ratchetStateObj;
                let stateToSave: string;
                if (wasNested) {
                  // Get original parsed structure to preserve template/evals
                  const originalParsed = JSON.parse(encryptionStates[0].state);
                  stateToSave = JSON.stringify({
                    state: ratchetStateStr,
                    template: originalParsed.template,
                    evals: originalParsed.evals,
                  });
                } else {
                  stateToSave = ratchetStateStr;
                }

                // Note: Fallback state is saved at join time in useSpaceActions.ts
                // We keep it forever and never overwrite it - it's the original working state

                encryptionStateStorage.saveEncryptionState({
                  conversationId: spaceConversationId,
                  inboxId: encryptionStates[0].inboxId,
                  state: stateToSave,
                  timestamp: Date.now(),
                });
              }
            } else {
              logger.log(`[WS:${getAddr()}] Skipping main state save - used fallback decrypt`);
            }

              // Parse decrypted message
              logger.log(`[WS:${getAddr()}] Decrypt result:`, {
                messageType: typeof decryptResult.message,
                messageLength: decryptResult.message?.length,
                messagePreview: Array.isArray(decryptResult.message)
                  ? decryptResult.message.slice(0, 50)
                  : String(decryptResult.message).substring(0, 100),
                ratchetStateType: typeof decryptResult.ratchet_state,
              });

              if (!decryptResult.message || decryptResult.message.length === 0) {
                logger.log(`[WS:${getAddr()}] Decrypt returned empty message`);
                return;
              }

              const decryptedBytes = new Uint8Array(decryptResult.message);
              const decryptedText = new TextDecoder().decode(decryptedBytes);
              logger.log(`[WS:${getAddr()}] Decrypted text (first 200):`, decryptedText.substring(0, 200));

              try {
                spaceMessage = JSON.parse(decryptedText) as Message;
              } catch (parseError) {
                logger.log(`[WS:${getAddr()}] Failed to parse decrypted message:`, parseError);
                logger.log(`[WS:${getAddr()}] Decrypted text length:`, decryptedText.length);
                logger.log(`[WS:${getAddr()}] Decrypted text (full):`, decryptedText);
                return;
              }

              logger.log(`[WS:${getAddr()}] Decrypted space message:`, spaceMessage.messageId, 'type:', spaceMessage.content?.type);

              // Check if this is our own message (echoed back from hub)
              const senderId = (spaceMessage.content as { senderId?: string })?.senderId;
              if (senderId && senderId === user?.address) {
                logger.log(`[WS:${getAddr()}] Skipping own message echo:`, spaceMessage.messageId);
                // Still need to delete from inbox even for our own echoes
                if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                  deleteSpaceInboxMessages(
                    spaceInboxKey.address,
                    [message.timestamp],
                    { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                  ).catch(err => logger.warn('[WS] Failed to delete own echo:', err));
                }
                return;
              }
            } // End of TR decryption else block

            // Get space info for storage
            const space = getSpace(spaceId);
            const channelId = spaceMessage.channelId || space?.defaultChannelId || spaceId;
            const messagesKey = queryKeys.messages.infinite(spaceId, channelId);

            interface MessagesPage {
              messages: Message[];
              nextCursor?: string | null;
              prevCursor?: string | null;
            }

            interface InfiniteMessagesData {
              pages: MessagesPage[];
              pageParams: unknown[];
            }

            // Handle special message types that modify existing messages
            const contentType = spaceMessage.content?.type;

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
                logger.log(`[WS:${getAddr()}] Skipping duplicate message:`, spaceMessage.messageId);
                // Still need to delete from inbox even for duplicates, otherwise they keep reappearing
                if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                  deleteSpaceInboxMessages(
                    spaceInboxKey.address,
                    [message.timestamp],
                    { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                  ).catch(err => logger.warn('[WS] Failed to delete duplicate message:', err));
                }
                return;
              }
            }

            if (contentType === 'reaction') {
              // Add reaction to target message
              const reactionContent = spaceMessage.content as { messageId: string; reaction: string; senderId: string };
              logger.log(`[WS:${getAddr()}] Adding reaction:`, reactionContent.reaction, 'to message:', reactionContent.messageId);

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
                ).catch(err => logger.warn('[WS] Failed to delete reaction message:', err));
              }
              return;
            }

            if (contentType === 'remove-reaction') {
              // Remove reaction from target message
              const reactionContent = spaceMessage.content as { messageId: string; reaction: string; senderId: string };
              logger.log(`[WS:${getAddr()}] Removing reaction:`, reactionContent.reaction, 'from message:', reactionContent.messageId);

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
                ).catch(err => logger.warn('[WS] Failed to delete remove-reaction message:', err));
              }
              return;
            }

            if (contentType === 'edit-message') {
              // Update existing message with edit
              const editContent = spaceMessage.content as { originalMessageId: string; editedText: string | string[]; editedAt: number };
              logger.log(`[WS:${getAddr()}] Editing message:`, editContent.originalMessageId);

              queryClient.setQueryData<InfiniteMessagesData>(messagesKey, (old) => {
                if (!old) return old;
                return {
                  ...old,
                  pages: old.pages.map((page) => ({
                    ...page,
                    messages: page.messages.map((msg) => {
                      if (msg.messageId === editContent.originalMessageId && msg.content.type === 'post') {
                        return {
                          ...msg,
                          modifiedDate: editContent.editedAt,
                          content: {
                            ...msg.content,
                            text: editContent.editedText,
                          },
                          edits: [
                            ...(msg.edits || []),
                            {
                              text: editContent.editedText,
                              modifiedDate: editContent.editedAt,
                              lastModifiedHash: '',
                            },
                          ],
                        };
                      }
                      return msg;
                    }),
                  })),
                };
              });
              // Delete edit-message from inbox after processing
              if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                deleteSpaceInboxMessages(
                  spaceInboxKey.address,
                  [message.timestamp],
                  { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                ).catch(err => logger.warn('[WS] Failed to delete edit-message:', err));
              }
              return;
            }

            if (contentType === 'remove-message') {
              // Remove message from cache and storage
              const removeContent = spaceMessage.content as { removeMessageId: string };
              logger.log(`[WS:${getAddr()}] Removing message:`, removeContent.removeMessageId);

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
              logger.log(`[WS:${getAddr()}] Deleted message from storage:`, removeContent.removeMessageId);
              // Delete remove-message from inbox after processing
              if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
                deleteSpaceInboxMessages(
                  spaceInboxKey.address,
                  [message.timestamp],
                  { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
                ).catch(err => logger.warn('[WS] Failed to delete remove-message:', err));
              }
              return;
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

            logger.log(`[WS:${getAddr()}] Saved space message to storage`);

            // Update React Query cache
            queryClient.setQueryData<InfiniteMessagesData>(messagesKey, (old) => {
              if (!old) {
                return {
                  pages: [{ messages: [spaceMessage], nextCursor: null, prevCursor: null }],
                  pageParams: [undefined],
                };
              }

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

            // Invalidate queries to refresh UI
            queryClient.invalidateQueries({ queryKey: ['spaces'] });
            // Also invalidate messages query to ensure UI re-renders
            queryClient.invalidateQueries({ queryKey: messagesKey });

            logger.log(`[WS:${getAddr()}] Space message processed successfully`);

            // Delete message from inbox after successful processing
            if (spaceInboxKey?.address && spaceInboxKey.publicKey && spaceInboxKey.privateKey) {
              deleteSpaceInboxMessages(
                spaceInboxKey.address,
                [message.timestamp],
                { publicKey: spaceInboxKey.publicKey, privateKey: spaceInboxKey.privateKey }
              ).catch(err => logger.warn('[WS] Failed to delete space message:', err));
            }

          } catch (spaceError) {
            logger.log(`[WS:${getAddr()}] Failed to process space message:`, spaceError);
            if (spaceError instanceof Error) {
              logger.log(`[WS:${getAddr()}] Error stack:`, spaceError.stack);
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

        // A message is an init message if:
        // 1. It arrives on our device inbox, AND
        // 2. The envelope format is MessageCiphertext (has ciphertext + initialization_vector)
        // NOTE: We use envelope format as the primary discriminator, NOT inbox mapping.
        // This is because multiple different senders can send init messages to our device inbox,
        // and we may have an inbox mapping from a previous conversation that doesn't apply.
        const isInitMessage = isOnDeviceInbox && isInitEnvelope;

        // Log message structure for debugging
        const sealedAny = sealedMessage as unknown as Record<string, unknown>;
        logger.log(`[WS:${getAddr()}] Message structure:`, {
          hasInboxAddress: !!sealedMessage.inbox_address,
          hasEphemeralKey: !!sealedMessage.ephemeral_public_key,
          hasEnvelope: !!sealedMessage.envelope,
          hasHubAddress: !!sealedAny.hub_address,
          isOnDeviceInbox,
          hasExistingSession: !!existingMapping,
          isDoubleRatchetEnvelope,
          isInitEnvelope,
          isInitMessage,
          ourInbox: ownInboxAddressRef.current?.substring(0, 12),
          messageInbox: message.inboxAddress?.substring(0, 12),
        });

        // Check if this is a message we sent ourselves (echo from server)
        // The server broadcasts messages to all subscribers including the sender
        // For initialization messages (new conversations), the sealed message has inbox_address field
        // pointing to the RECIPIENT's inbox. If we sent it, inbox_address won't be our own inbox.
        // For subsequent messages, there's an envelope field at the root level with hub_address.
        //
        // IMPORTANT: We must NOT filter out messages arriving at our conversation-specific inboxes!
        // When we initiate a conversation, we create a per-conversation inbox and subscribe to it.
        // Replies from the recipient will arrive at that inbox and have inbox_address + ephemeral_public_key.
        const isOurConversationInbox = encryptionStateStorage.getConversationInboxKeypairByAddress(message.inboxAddress) !== null;

        if (isOurConversationInbox) {
          logger.log(`[WS:${getAddr()}] Message arriving at our conversation inbox: ${message.inboxAddress?.substring(0, 12)}`);
        }

        if (!isOnDeviceInbox && !isOurConversationInbox && sealedMessage.inbox_address && sealedMessage.ephemeral_public_key) {
          // This looks like an outbound initialization message format (has inbox_address field)
          // and it's NOT addressed to our inbox or a conversation inbox we created, so it's an echo
          logger.log('[WS] Ignoring echoed outbound message (init format to other inbox)');
          return;
        }

        // Also check for echoed subsequent messages with hub_address (messages we sent back)
        // These have envelope and hub_address but no inbox_address at root level
        if (!isOnDeviceInbox && sealedMessage.envelope && sealedAny.hub_address !== undefined) {
          // This is a subsequent message format on an inbox we're subscribed to
          // that isn't our own device inbox. Check if we have a session for this inbox.
          // Also check if this is a conversation inbox we created - those are legitimate.
          if (!existingMapping && !isOurConversationInbox) {
            logger.log('[WS] Ignoring message on unknown inbox (likely echo):', message.inboxAddress?.substring(0, 12));
            return;
          }
        }

        let conversationId = '';
        let decryptedMessage: Message;

        // Track user profile info (display name, icon) from InitializationEnvelope
        let userProfileFromEnvelope: { displayName?: string; userIcon?: string } | undefined;

        if (isInitMessage) {
          // === Path 1: First message from new sender ===
          logger.log(`[E2E:${getAddr()}] Received initialization envelope on device inbox`);

          try {
            // Unseal the envelope using our inbox encryption key
            const unsealed = await encryptionService.unsealInitializationEnvelope(sealedMessage);
            logger.log(`[E2E:${getAddr()}] Envelope unsealed, sender:`, unsealed.user_address);

            // Initialize recipient session (performs X3DH and sets up Double Ratchet)
            // Pass the inbox address where we received this message so state is stored correctly
            const sessionResult = await encryptionService.initializeRecipientSession(
              unsealed,
              message.inboxAddress  // Our device inbox where we received this init
            );

            conversationId = sessionResult.conversationId;
            userProfileFromEnvelope = sessionResult.userProfile;

            // Log the decrypted message for debugging
            logger.log(`[E2E:${getAddr()}] sessionResult.message preview:`, sessionResult.message.substring(0, 200));
            if (userProfileFromEnvelope) {
              logger.log(`[E2E:${getAddr()}] User profile from envelope:`, userProfileFromEnvelope);
            }

            // The message should now be properly decrypted plaintext JSON
            decryptedMessage = JSON.parse(sessionResult.message) as Message;

            logger.log(`[E2E:${getAddr()}] Session initialized for conversation:`, conversationId);

            // IMPORTANT: Subscribe to our conversation inbox for receiving future replies
            // The receiver needs to listen on their own conversation inbox, not the sender's
            if (sessionResult.ourConversationInbox) {
              logger.log(`[E2E:${getAddr()}] Subscribing to our conversation inbox:`, sessionResult.ourConversationInbox.substring(0, 12));
              const client = wsClientRef.current;
              if (client && client.isConnected) {
                await client.subscribe([sessionResult.ourConversationInbox]);
                subscribedInboxesRef.current.add(sessionResult.ourConversationInbox);
                logger.log(`[E2E:${getAddr()}] Subscribed to conversation inbox successfully`);
              }
            }
          } catch (initError) {
            logger.log(`[E2E:${getAddr()}] Failed to initialize session from envelope:`, initError);
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
            logger.log(`[E2E:${getAddr()}] Double Ratchet envelope on device inbox, using trial decryption`);

            // Get all states that have this inbox ID
            const statesForInbox = encryptionStateStorage.getStatesByInboxId(message.inboxAddress);
            logger.log(`[E2E:${getAddr()}] Found ${statesForInbox.length} states for inbox ${message.inboxAddress.substring(0, 12)}`);

            for (const { conversationId: convId } of statesForInbox) {
              try {
                logger.log(`[E2E:${getAddr()}] Trying conversation: ${convId.substring(0, 20)}`);

                // Try to decrypt with this session
                const result = await encryptionService.decryptMessage(
                  convId,
                  message.inboxAddress,
                  sealedMessage.envelope
                );

                // Check if decryption actually succeeded (not an error message)
                if (result && result.length > 0 && !result.startsWith('Decryption failed')) {
                  logger.log(`[E2E:${getAddr()}] Trial decryption succeeded for conversation: ${convId.substring(0, 20)}`);
                  decryptedText = result;
                  conversationId = convId;
                  break;
                }
              } catch (decryptError) {
                // Decryption failed for this conversation, try next
                logger.log(`[E2E:${getAddr()}] Trial failed for ${convId.substring(0, 20)}:`,
                  decryptError instanceof Error ? decryptError.message : String(decryptError));
                continue;
              }
            }

            if (!decryptedText) {
              logger.warn(
                `[E2E:${getAddr()}] Cannot decrypt: no matching session found for device inbox.`,
                message.inboxAddress?.substring(0, 12)
              );
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
              logger.log(`[E2E:${getAddr()}] Sealed message at conversation inbox, unsealing with conversation keypair`);

              try {
                // Unseal using our conversation inbox private key
                const unsealedContent = await unsealWithConversationKeypair(sealedMessage, conversationKeypair);

                if (unsealedContent.type === 'dr') {
                  // === Raw Double Ratchet envelope (confirmed session) ===
                  logger.log(`[E2E:${getAddr()}] Unsealed raw DR envelope, length:`, unsealedContent.envelope.length);

                  // Get conversation ID from the keypair
                  conversationId = conversationKeypair.conversationId;

                  // Get the encryption state for this conversation at this inbox
                  const encState = encryptionStateStorage.getEncryptionState(conversationId, message.inboxAddress);
                  if (!encState) {
                    logger.log(`[E2E:${getAddr()}] No encryption state for conversation inbox`);
                    return;
                  }

                  // Decrypt the Double Ratchet envelope
                  decryptedText = await encryptionService.decryptMessage(
                    conversationId,
                    message.inboxAddress,
                    unsealedContent.envelope
                  );

                  logger.log(`[E2E:${getAddr()}] Decrypted confirmed session message`);
                } else {
                  // === InitializationEnvelope (unconfirmed session) ===
                  const unsealed = unsealedContent.envelope;
                  logger.log(`[E2E:${getAddr()}] Unsealed InitEnvelope from:`, unsealed.user_address);

                  // Determine conversation ID from the unsealed envelope
                  conversationId = `${unsealed.user_address}/${unsealed.user_address}`;

                  // Check if we already have an encryption state for this conversation
                  // If so, use existing session to decrypt (don't do X3DH again)
                  const existingStates = encryptionStateStorage.getEncryptionStates(conversationId);
                  const hasExistingSession = existingStates.length > 0;

                  logger.log(`[E2E:${getAddr()}] Conversation ${conversationId.substring(0, 20)}... hasExistingSession: ${hasExistingSession}`);

                  if (hasExistingSession) {
                    // === Use existing session to decrypt ===
                    // The message is wrapped in InitEnvelope but we already have a session
                    logger.log(`[E2E:${getAddr()}] Using existing session to decrypt init envelope message`);

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
                          logger.log(`[E2E:${getAddr()}] Decrypted with existing session on inbox:`, encState.inboxId.substring(0, 12));
                          successInboxId = encState.inboxId;

                          // Extract user profile from envelope
                          userProfileFromEnvelope = (unsealed.display_name || unsealed.user_icon)
                            ? { displayName: unsealed.display_name, userIcon: unsealed.user_icon }
                            : undefined;
                          break;
                        }
                      } catch (decryptErr) {
                        logger.log(`[E2E:${getAddr()}] Trial decrypt failed for inbox ${encState.inboxId.substring(0, 12)}:`,
                          decryptErr instanceof Error ? decryptErr.message : String(decryptErr));
                      }
                    }

                    if (!decryptedText || decryptedText.startsWith('Decryption failed') || !successInboxId) {
                      logger.log(`[E2E:${getAddr()}] Failed to decrypt with any existing session`);
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
                        logger.log(`[E2E:${getAddr()}] Updated sendingInbox from InitEnvelope:`, unsealed.return_inbox_address.substring(0, 12));
                      }
                    }
                  } else {
                    // === First message from this sender - initialize new session ===
                    logger.log(`[E2E:${getAddr()}] No existing session, initializing recipient session`);

                    const sessionResult = await encryptionService.initializeRecipientSession(
                      unsealed,
                      message.inboxAddress  // Our conversation inbox where we received this
                    );

                    conversationId = sessionResult.conversationId;
                    decryptedText = sessionResult.message;
                    userProfileFromEnvelope = sessionResult.userProfile;

                    // Subscribe to our conversation inbox for receiving future replies
                    if (sessionResult.ourConversationInbox) {
                      logger.log(`[E2E:${getAddr()}] Subscribing to our conversation inbox:`, sessionResult.ourConversationInbox.substring(0, 12));
                      const client = wsClientRef.current;
                      if (client && client.isConnected) {
                        await client.subscribe([sessionResult.ourConversationInbox]);
                        subscribedInboxesRef.current.add(sessionResult.ourConversationInbox);
                        logger.log(`[E2E:${getAddr()}] Subscribed to conversation inbox successfully`);
                      }
                    }
                  }
                }

                logger.log(`[E2E:${getAddr()}] Processed message, conversationId:`, conversationId);
                if (userProfileFromEnvelope) {
                  logger.log(`[E2E:${getAddr()}] User profile from envelope:`, userProfileFromEnvelope);
                }
              } catch (unsealError) {
                logger.log(`[E2E:${getAddr()}] Failed to unseal conversation inbox message:`, unsealError);
                return;
              }
            } else {
              // Standard non-device inbox message (Double Ratchet envelope)
              // This shouldn't happen often - messages should go to conversation inboxes
              const mapping = encryptionStateStorage.getInboxMapping(message.inboxAddress);

              if (!mapping) {
                logger.warn(
                  `[E2E] No inbox mapping found for address: ${message.inboxAddress}`
                );
                return;
              }

              conversationId = mapping.conversationId;

              // Log envelope details before decryption
              logger.log(`[E2E:${getAddr()}] Decrypting subsequent message:`, {
                conversationId: conversationId.substring(0, 30),
                inboxAddress: message.inboxAddress?.substring(0, 12),
                envelopeType: typeof sealedMessage.envelope,
                envelopeLength: sealedMessage.envelope?.length,
                envelopePreview: sealedMessage.envelope?.substring(0, 200),
                isDoubleRatchetEnvelope,
                isInitEnvelope,
              });

              // Decrypt using existing session
              try {
                decryptedText = await encryptionService.decryptMessage(
                  conversationId,
                  message.inboxAddress,
                  sealedMessage.envelope
                );
              } catch (decryptError) {
                // Log detailed error info
                logger.log(`[E2E:${getAddr()}] Decryption failed:`, {
                  error: decryptError instanceof Error ? decryptError.message : String(decryptError),
                  conversationId: conversationId.substring(0, 30),
                  inboxAddress: message.inboxAddress?.substring(0, 12),
                });
                // If this is a "no state" error, it's likely stale data - skip gracefully
                if (decryptError instanceof Error && decryptError.message.includes('No encryption state')) {
                  logger.warn(`[E2E:${getAddr()}] Skipping message with no matching session (likely stale data)`);
                  return;
                }
                throw decryptError;
              }
            }
          }

          logger.log(`[E2E:${getAddr()}] Decrypted text length:`, decryptedText?.length);
          logger.log(`[E2E:${getAddr()}] Decrypted text (first 200 chars):`, decryptedText?.substring(0, 200));

          if (!decryptedText || decryptedText.length === 0 || decryptedText.startsWith('Decryption failed')) {
            logger.log(`[E2E:${getAddr()}] Decryption returned empty or error result:`, decryptedText?.substring(0, 50));
            return;
          }

          decryptedMessage = JSON.parse(decryptedText) as Message;

          // Handle same-user multi-device sync:
          // When receiving a message from our own address (different device),
          // the conversation should be with the actual recipient (channelId), not ourselves.
          // This matches desktop behavior in MessageService.ts lines 2082-2086
          const senderAddress = conversationId.split('/')[0];
          if (senderAddress === user?.address && decryptedMessage.channelId) {
            const actualRecipient = decryptedMessage.channelId;
            logger.log(`[E2E:${getAddr()}] Self-sync detected. Redirecting conversationId from ${senderAddress.substring(0, 12)} to ${actualRecipient.substring(0, 12)}`);
            conversationId = `${actualRecipient}/${actualRecipient}`;
          }
        }

        // Extract sender address from conversation ID (may have been updated for self-sync)
        const senderAddress = conversationId.split('/')[0];

        // === Handle DM control messages (reactions, removes) ===
        const contentType = decryptedMessage.content?.type;
        
        if (contentType === 'reaction') {
          const reactionContent = decryptedMessage.content as { messageId: string; reaction: string; senderId: string };
          logger.log(`[E2E:${getAddr()}] Adding DM reaction:`, reactionContent.reaction, 'to message:', reactionContent.messageId);

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
              return reactions;
            }
            return [
              ...reactions,
              {
                emojiId: reactionContent.reaction,
                emojiName: reactionContent.reaction,
                spaceId: senderAddress,
                count: 1,
                memberIds: [reactionContent.senderId],
              },
            ];
          };

          // Update React Query cache
          const dmMessagesKey = queryKeys.messages.infinite(senderAddress, senderAddress);
          queryClient.setQueryData(dmMessagesKey, (old: { pages: { messages: Message[] }[] } | undefined) => {
            if (!old) return old;
            return {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                messages: page.messages.map((msg) =>
                  msg.messageId === reactionContent.messageId
                    ? { ...msg, reactions: computeNewReactions(msg.reactions) }
                    : msg
                ),
              })),
            };
          });

          // Persist to storage
          const targetMessage = await storage.getMessage({
            spaceId: senderAddress,
            channelId: senderAddress,
            messageId: reactionContent.messageId,
          });
          if (targetMessage) {
            await storage.saveMessage(
              { ...targetMessage, reactions: computeNewReactions(targetMessage.reactions) },
              targetMessage.createdDate,
              senderAddress,
              'direct',
              '',
              ''
            );
          }
          return;
        }

        if (contentType === 'remove-reaction') {
          const reactionContent = decryptedMessage.content as { messageId: string; reaction: string; senderId: string };
          logger.log(`[E2E:${getAddr()}] Removing DM reaction:`, reactionContent.reaction);

          const computeRemovedReactions = (currentReactions: Message['reactions']) => {
            return (currentReactions || [])
              .map((r) => {
                if (r.emojiId !== reactionContent.reaction) return r;
                const newMemberIds = r.memberIds.filter((id) => id !== reactionContent.senderId);
                return newMemberIds.length === 0 ? null : { ...r, count: newMemberIds.length, memberIds: newMemberIds };
              })
              .filter((r): r is NonNullable<typeof r> => r !== null);
          };

          const dmMessagesKey = queryKeys.messages.infinite(senderAddress, senderAddress);
          queryClient.setQueryData(dmMessagesKey, (old: { pages: { messages: Message[] }[] } | undefined) => {
            if (!old) return old;
            return {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                messages: page.messages.map((msg) =>
                  msg.messageId === reactionContent.messageId
                    ? { ...msg, reactions: computeRemovedReactions(msg.reactions) }
                    : msg
                ),
              })),
            };
          });

          const targetMessage = await storage.getMessage({
            spaceId: senderAddress,
            channelId: senderAddress,
            messageId: reactionContent.messageId,
          });
          if (targetMessage) {
            await storage.saveMessage(
              { ...targetMessage, reactions: computeRemovedReactions(targetMessage.reactions) },
              targetMessage.createdDate,
              senderAddress,
              'direct',
              '',
              ''
            );
          }
          return;
        }

        if (contentType === 'remove-message') {
          const removeContent = decryptedMessage.content as { removeMessageId: string };
          logger.log(`[E2E:${getAddr()}] Removing DM message:`, removeContent.removeMessageId);

          const dmMessagesKey = queryKeys.messages.infinite(senderAddress, senderAddress);
          queryClient.setQueryData(dmMessagesKey, (old: { pages: { messages: Message[] }[] } | undefined) => {
            if (!old) return old;
            return {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                messages: page.messages.filter((msg) => msg.messageId !== removeContent.removeMessageId),
              })),
            };
          });

          await storage.deleteMessage(removeContent.removeMessageId);
          return;
        }

        // Save conversation to storage (creates new or updates existing)
        const existingConversation = await storage.getConversation(conversationId);
        if (!existingConversation) {
          // Create new conversation for this sender
          // Use profile data from InitializationEnvelope if available
          const newConversation: Conversation = {
            conversationId,
            address: senderAddress,
            displayName: userProfileFromEnvelope?.displayName || senderAddress.substring(0, 8),
            icon: userProfileFromEnvelope?.userIcon || '',
            timestamp: decryptedMessage.createdDate || Date.now(),
            type: 'direct',
          };
          await storage.saveConversation(newConversation);
          logger.log(`[WS:${getAddr()}] Created new conversation:`, conversationId, 'with displayName:', newConversation.displayName);
        } else {
          // Update existing conversation - update profile if we have new info
          const updatedConversation: Conversation = {
            ...existingConversation,
            timestamp: decryptedMessage.createdDate || Date.now(),
            // Update display name and icon if we have new profile data
            displayName: userProfileFromEnvelope?.displayName || existingConversation.displayName,
            icon: userProfileFromEnvelope?.userIcon || existingConversation.icon,
          };
          await storage.saveConversation(updatedConversation);
          logger.log(`[WS:${getAddr()}] Updated conversation:`, conversationId);
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
        logger.log(`[WS:${getAddr()}] Saved message:`, decryptedMessage.messageId);

        // Update React Query cache with the new message
        // IMPORTANT: Use the same query key format as useSendDirectMessage hook
        // The send hook uses queryKeys.messages.infinite(recipientAddress, recipientAddress)
        // When receiving, the sender is the "other person" (their recipientAddress from our perspective)
        const messagesKey = queryKeys.messages.infinite(senderAddress, senderAddress);
        logger.log(`[WS:${getAddr()}] Updating cache with key:`, messagesKey);

        interface MessagesPage {
          messages: Message[];
          nextCursor?: string | null;
          prevCursor?: string | null;
        }

        interface InfiniteMessagesData {
          pages: MessagesPage[];
          pageParams: unknown[];
        }

        queryClient.setQueryData<InfiniteMessagesData>(messagesKey, (old) => {
          if (!old) {
            return {
              pages: [
                {
                  messages: [decryptedMessage],
                  nextCursor: null,
                  prevCursor: null,
                },
              ],
              pageParams: [undefined],
            };
          }

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

        // Update conversation list to show latest message
        // NOTE: We intentionally do NOT invalidate messagesKey here because:
        // 1. We already updated the cache with setQueryData above
        // 2. Invalidating would trigger a refetch that could race with storage writes
        // 3. This was causing messages to "disappear" during alternating send/receive
        queryClient.invalidateQueries({
          queryKey: queryKeys.conversations.all('direct'),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.conversations.detail(conversationId),
        });

        logger.log(`[WS:${getAddr()}] Received and processed message:`, decryptedMessage.messageId);

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
            // Fire and forget - don't block on deletion
            deleteConversationInboxMessages(message.inboxAddress, [message.timestamp], signingKey).catch(err => {
              logger.warn('[WS] Background conversation inbox delete failed:', err);
            });
          } else {
            // Device inbox - use device keyset signing key for deletion
            const deviceKeyset = await getDeviceKeyset();
            if (deviceKeyset) {
              // Fire and forget - don't block on deletion
              deleteInboxMessages(message.inboxAddress, [message.timestamp], deviceKeyset).catch(err => {
                logger.warn('[WS] Background inbox delete failed:', err);
              });
            }
          }
        }
      } catch (error) {
        logger.log('Failed to process incoming message:', error);
      }
    },
    [queryClient, storage]
  );

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
      logger.log(`[WS] Resubscribing to conversation inbox: ${addr.substring(0, 12)}`);
    }

    // Add all space inboxes for receiving space/hub messages
    const spaceInboxes = getAllSpaceInboxAddresses();
    for (const addr of spaceInboxes) {
      inboxes.add(addr);
      logger.log(`[WS] Resubscribing to space inbox: ${addr.substring(0, 12)}`);
    }

    const inboxArray = Array.from(inboxes);
    if (inboxArray.length > 0) {
      logger.log(`[WS] Resubscribing to ${inboxArray.length} inbox(es)`);
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

    const config = API_CONFIG;

    const client = createRNWebSocketClient({
      url: config.wsUrl,
      reconnectInterval: 2000,
      maxReconnectAttempts: Infinity,
      queueProcessInterval: 500,
    });

    // Set up handlers
    client.setMessageHandler(handleIncomingMessage);
    client.setResubscribeHandler(handleResubscribe);

    // Track state changes
    client.onStateChange((state) => {
      setConnectionState(state);
    });

    client.onError((error) => {
      logger.log('WebSocket error:', error);
    });

    wsClientRef.current = client;
    return client;
  }, [handleIncomingMessage, handleResubscribe]);

  /**
   * Connect to WebSocket server
   */
  const connect = useCallback(async () => {
    // First, initialize device keys
    const keysReady = await initializeDeviceKeys();
    if (!keysReady) {
      logger.warn('Cannot connect - device keys not available');
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
        logger.log('[WS] Subscribed to own inbox:', ownInboxAddress);
      } catch (error) {
        logger.log('[WS] Failed to subscribe to own inbox:', error);
      }
    }

    // Subscribe to all space inboxes for receiving space/hub messages
    const spaceInboxes = getAllSpaceInboxAddresses();
    logger.log(`[WS] Found ${spaceInboxes.length} space inbox(es) to subscribe to`);
    if (spaceInboxes.length > 0) {
      try {
        await client.subscribe(spaceInboxes);
        spaceInboxes.forEach((addr) => subscribedInboxesRef.current.add(addr));
        logger.log(`[WS] Subscribed to ${spaceInboxes.length} space inbox(es):`, spaceInboxes.map(a => a.substring(0, 12)));
      } catch (error) {
        logger.log('[WS] Failed to subscribe to space inboxes:', error);
      }
    } else {
      logger.log('[WS] No space inboxes to subscribe to');
    }

    // Subscribe to all conversation inboxes
    const conversationInboxes = encryptionStateStorage.getAllConversationInboxAddresses();
    if (conversationInboxes.length > 0) {
      try {
        await client.subscribe(conversationInboxes);
        conversationInboxes.forEach((addr) => subscribedInboxesRef.current.add(addr));
        logger.log(`[WS] Subscribed to ${conversationInboxes.length} conversation inbox(es)`);
      } catch (error) {
        logger.log('[WS] Failed to subscribe to conversation inboxes:', error);
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
      if (!client) {
        logger.warn('WebSocket client not initialized');
        return;
      }
      client.enqueueOutbound(prepareMessage);
    },
    []
  );

  /**
   * Subscribe to inbox addresses
   */
  const subscribe = useCallback(async (inboxAddresses: string[]) => {
    const client = wsClientRef.current;
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

  /**
   * Trigger a sync request for a space/channel
   * Used when joining a space to sync existing messages
   */
  const triggerSyncRequest = useCallback(async (spaceId: string, channelId: string) => {
    logger.log(`[WS] triggerSyncRequest for space ${spaceId.substring(0, 12)}, channel ${channelId.substring(0, 12)}`);

    try {
      // Get our inbox address for this space
      const inboxKey = getSpaceKey(spaceId, 'inbox');
      if (!inboxKey?.address) {
        logger.warn(`[WS] triggerSyncRequest: No inbox key for space ${spaceId.substring(0, 12)}`);
        return;
      }

      const syncService = getSyncService();
      if (!syncService) {
        logger.warn(`[WS] triggerSyncRequest: No SyncService available`);
        return;
      }

      // Build the sync request payload
      const syncRequestPayload = await syncService.buildSyncRequest(
        spaceId,
        channelId,
        inboxKey.address
      );

      logger.log(`[WS] triggerSyncRequest: Built payload`, {
        inboxAddress: inboxKey.address.substring(0, 12),
        expiry: syncRequestPayload.expiry,
        summary: syncRequestPayload.summary,
      });

      // Build and send the sync request message
      const syncRequestEnvelope = await sendSyncRequestMessage(spaceId, syncRequestPayload);

      enqueueOutbound(async () => [syncRequestEnvelope]);

      logger.log(`[WS] triggerSyncRequest: Sent sync-request for space ${spaceId.substring(0, 12)}`);
    } catch (error) {
      console.error(`[WS] triggerSyncRequest failed:`, error);
    }
  }, [getSyncService, enqueueOutbound]);

  // Set the E2E log prefix when user becomes available
  useEffect(() => {
    if (user?.address) {
      setE2ELogPrefix(user.address);
    }
  }, [user?.address]);

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

  // Trigger sync for all spaces shortly after connection is established
  // This fetches member data and messages from other devices in the space
  useEffect(() => {
    if (connectionState !== 'connected') return;

    const syncTimeoutId = setTimeout(() => {
      logger.log('[WS] Triggering sync for all spaces after connection');

      try {
        const spaceIds = getSpaceIds();
        logger.log(`[WS] Found ${spaceIds.length} spaces to sync`);

        for (const spaceId of spaceIds) {
          const space = getSpace(spaceId);
          if (space?.defaultChannelId) {
            logger.log(`[WS] Triggering sync for space ${spaceId.substring(0, 12)}`);
            triggerSyncRequest(spaceId, space.defaultChannelId);
          }
        }
      } catch (error) {
        console.error('[WS] Failed to trigger sync for spaces:', error);
      }
    }, 3000); // 3 seconds - enough for connection to stabilize

    return () => {
      clearTimeout(syncTimeoutId);
    };
  }, [connectionState, triggerSyncRequest]);

  const value = useMemo<WebSocketContextValue>(
    () => ({
      connectionState,
      isConnected: connectionState === 'connected',
      connect,
      disconnect,
      enqueueOutbound,
      subscribe,
      unsubscribe,
      triggerSyncRequest,
      kickedFromSpaceId,
      clearKickedFromSpace,
    }),
    [connectionState, connect, disconnect, enqueueOutbound, subscribe, unsubscribe, triggerSyncRequest, kickedFromSpaceId, clearKickedFromSpace]
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
