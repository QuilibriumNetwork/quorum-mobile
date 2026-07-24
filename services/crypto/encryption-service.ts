/**
 * EncryptionService - Manages E2E encryption for direct messages
 *
 * Handles:
 * - Session establishment via X3DH key exchange
 * - Message encryption/decryption via Double Ratchet
 * - State persistence in MMKV
 *
 * Mirrors the desktop's MessageService encryption flow.
 */

import { NativeCryptoProvider } from './native-provider';
import {
  encryptionStateStorage,
  type EncryptionState,
  type SendingInbox,
  type ConversationInboxKeypair,
} from './encryption-state-storage';
import { ratchetMutex } from './ratchet-mutex';
import {
  isStaleInitEnvelope,
  getInstalledInitEnvelopeTs,
  recordInstalledInitEnvelopeTs,
} from './initEnvelopeGuard';
import { deriveAddress } from '../onboarding/keyService';

import type {
  DoubleRatchetStateAndMessage,
  DoubleRatchetStateAndEnvelope,
  SealedMessage,
  UnsealedEnvelope,
} from '@quilibrium/quorum-shared';

// Session key length for X3DH (96 bytes = 32 session + 32 send header + 32 recv header)
const SESSION_KEY_LENGTH = 96;

// Text encoder for message conversion
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface DeviceKeys {
  /** X448 identity key for X3DH - private key */
  identityPrivateKey: number[];
  /** X448 identity key for X3DH - public key */
  identityPublicKey: number[];
  /** X448 signed pre-key for X3DH - private key */
  preKeyPrivateKey: number[];
  /** X448 signed pre-key for X3DH - public key */
  preKeyPublicKey: number[];
  /** X448 inbox encryption key for unsealing - private key */
  inboxEncryptionPrivateKey: number[];
  /** X448 inbox encryption key for unsealing - public key */
  inboxEncryptionPublicKey: number[];
}

export interface RecipientInfo {
  address: string;
  identityKey: number[];
  signedPreKey: number[];
  inboxAddress: string;
  /** X448 public key for sealing envelopes to recipient's inbox */
  inboxEncryptionKey?: number[];
}

export interface EncryptedEnvelope {
  envelope: string;
  inboxAddress: string;
  ephemeralPublicKey?: number[];
  ephemeralPrivateKey?: number[];
}

/**
 * EncryptionService - Singleton service for E2E encryption
 */
class EncryptionService {
  private cryptoProvider: NativeCryptoProvider;
  private deviceKeys: DeviceKeys | null = null;

  constructor() {
    this.cryptoProvider = new NativeCryptoProvider();
  }

  /**
   * Set device keys (called after onboarding)
   */
  setDeviceKeys(keys: DeviceKeys): void {
    this.deviceKeys = keys;
  }

  /**
   * Check if device keys are set
   */
  hasDeviceKeys(): boolean {
    return this.deviceKeys !== null;
  }

  /**
   * Encrypt a message for a conversation
   *
   * If no session exists, establishes one using X3DH.
   * Returns encrypted envelope and updated state.
   *
   * @param senderDeviceInboxAddress - The sender's own device inbox where replies will arrive.
   *                                   Required for new sessions so we can save state for decrypting replies.
   */
  async encryptMessage(
    conversationId: string,
    recipientInfo: RecipientInfo,
    plaintext: string,
    senderDeviceInboxAddress?: string
  ): Promise<EncryptedEnvelope> {
    return ratchetMutex.runExclusive(conversationId, async () => {
    if (!this.deviceKeys) {
      throw new Error('Device keys not initialized');
    }

    const { inboxAddress } = recipientInfo;

    // Check for existing session using latestState which tracks the current session's inboxId
    // IMPORTANT: The state is keyed by OUR inbox (where we receive replies), not the recipient's inbox.
    // So we use latestState to find which inboxId has the current session.
    let encryptionState: EncryptionState | null = null;
    const latestState = encryptionStateStorage.getLatestState(conversationId);
    if (latestState) {
      encryptionState = encryptionStateStorage.getEncryptionState(
        conversationId,
        latestState.inboxId
      );
    }

    // Track if this is a new session (first message)
    let ephemeralPublicKey: number[] | undefined;
    let ephemeralPrivateKey: number[] | undefined;
    const isNewSession = !encryptionState;

    // If no session exists, establish one via X3DH
    if (isNewSession) {
      if (!senderDeviceInboxAddress) {
        throw new Error('senderDeviceInboxAddress is required for new sessions');
      }
      const sessionResult = await this.establishSession(
        conversationId,
        recipientInfo,
        senderDeviceInboxAddress
      );
      encryptionState = sessionResult.state;
      ephemeralPublicKey = sessionResult.ephemeralPublicKey;
      ephemeralPrivateKey = sessionResult.ephemeralPrivateKey;
    }

    // At this point encryptionState is guaranteed to be set
    // (either from storage or from establishSession)
    const state = encryptionState!;

    // Encrypt message using Double Ratchet
    const messageBytes = Array.from(textEncoder.encode(plaintext));


    const stateAndMessage: DoubleRatchetStateAndMessage = {
      ratchet_state: state.state,
      message: messageBytes,
    };

    const result = await this.cryptoProvider.doubleRatchetEncrypt(stateAndMessage);

    // Save updated state - preserve sendingInbox, tag, and X3DH ephemeral keys
    const newState: EncryptionState = {
      state: result.ratchet_state,
      timestamp: Date.now(),
      conversationId,
      inboxId: state.inboxId, // Keep original inboxId (our receiving inbox)
      sentAccept: state.sentAccept,
      sendingInbox: state.sendingInbox, // Preserve where to send
      tag: state.tag,
      // CRITICAL: Preserve X3DH ephemeral keys for unconfirmed sessions
      x3dhEphemeralPublicKey: state.x3dhEphemeralPublicKey,
      x3dhEphemeralPrivateKey: state.x3dhEphemeralPrivateKey,
    };
    encryptionStateStorage.saveEncryptionState(newState, true);

    return {
      envelope: result.envelope,
      inboxAddress,
      ephemeralPublicKey, // Only set for first message (new session)
      ephemeralPrivateKey, // Only set for first message (new session) - needed for sealing
    };
    });
  }

  /**
   * Encrypt a message for a specific device, always establishing a new session.
   *
   * This is used for multi-device support where we need to send to devices
   * that don't have an existing session, even if the conversation already
   * has sessions with other devices.
   *
   * @param conversationId - The conversation ID
   * @param recipientInfo - The target device's encryption info
   * @param plaintext - The message to encrypt
   * @param senderDeviceInboxAddress - The sender's inbox for this device session
   * @param deviceTag - A unique tag for this device (usually the device's inbox address)
   */
  async encryptMessageForNewDevice(
    conversationId: string,
    recipientInfo: RecipientInfo,
    plaintext: string,
    senderDeviceInboxAddress: string,
    deviceTag: string
  ): Promise<EncryptedEnvelope> {
    return ratchetMutex.runExclusive(conversationId, async () => {
    if (!this.deviceKeys) {
      throw new Error('Device keys not initialized');
    }

    const { inboxAddress } = recipientInfo;

    // Always establish a new session for this device
    const sessionResult = await this.establishSession(
      conversationId,
      recipientInfo,
      senderDeviceInboxAddress
    );

    const encryptionState = sessionResult.state;
    const ephemeralPublicKey = sessionResult.ephemeralPublicKey;
    const ephemeralPrivateKey = sessionResult.ephemeralPrivateKey;

    // Encrypt message using Double Ratchet
    const messageBytes = Array.from(textEncoder.encode(plaintext));

    const stateAndMessage: DoubleRatchetStateAndMessage = {
      ratchet_state: encryptionState.state,
      message: messageBytes,
    };

    const result = await this.cryptoProvider.doubleRatchetEncrypt(stateAndMessage);

    // Save state with the device tag so we can track sessions per-device
    // Note: We save under the senderDeviceInboxAddress (our inbox for this device)
    // but use the deviceTag to identify which device this session is for
    const newState: EncryptionState = {
      state: result.ratchet_state,
      timestamp: Date.now(),
      conversationId,
      inboxId: senderDeviceInboxAddress, // Our receiving inbox for this device
      sentAccept: false,
      sendingInbox: {
        inbox_address: recipientInfo.inboxAddress,
        inbox_encryption_key: recipientInfo.inboxEncryptionKey
          ? this.bytesToHex(recipientInfo.inboxEncryptionKey)
          : '',
        inbox_public_key: '', // Will be set when we receive their reply
        inbox_private_key: '', // Never have their private key
      },
      tag: deviceTag, // Tag with device inbox to identify this session
      x3dhEphemeralPublicKey: this.bytesToHex(ephemeralPublicKey),
      x3dhEphemeralPrivateKey: this.bytesToHex(ephemeralPrivateKey),
    };
    encryptionStateStorage.saveEncryptionState(newState, false); // Don't update latest - multi-device

    return {
      envelope: result.envelope,
      inboxAddress,
      ephemeralPublicKey,
      ephemeralPrivateKey,
    };
    });
  }

  /**
   * Decrypt a message from a conversation
   * Returns null if decryption fails (expected in multi-device scenarios)
   */
  async decryptMessage(
    conversationId: string,
    senderInboxAddress: string,
    envelope: string
  ): Promise<string | null> {
    return ratchetMutex.runExclusive(conversationId, async () => {
    // Get the encryption state for this specific inbox
    // IMPORTANT: Do NOT fall back to other states - each inbox has its own session
    // If we don't have a state for this inbox, the message cannot be decrypted
    const encryptionState = encryptionStateStorage.getEncryptionState(
      conversationId,
      senderInboxAddress
    );

    if (!encryptionState) {
      // No session for this inbox - expected in multi-device scenarios
      return null;
    }

    // Handle escaped envelope (backslash-quote sequences from JSON encoding)
    // This happens when the envelope was JSON-stringified during transport
    let cleanEnvelope = envelope;
    if (cleanEnvelope.includes('\\"') || cleanEnvelope.includes('\\\\')) {
      cleanEnvelope = cleanEnvelope
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }

    const stateAndEnvelope: DoubleRatchetStateAndEnvelope = {
      ratchet_state: encryptionState.state,
      envelope: cleanEnvelope,
    };

    const result = await this.cryptoProvider.doubleRatchetDecrypt(stateAndEnvelope);

    // Check for decryption failure (returned as result with empty message and error)
    const resultWithError = result as typeof result & { decryptionError?: string };
    if (resultWithError.decryptionError || result.message.length === 0) {
      // Expected in multi-device scenarios - return null instead of throwing
      return null;
    }

    // Convert bytes back to string FIRST, before saving state
    const decryptedText = textDecoder.decode(new Uint8Array(result.message));

    // CRITICAL: Check if decryption actually succeeded before saving state
    // The native module sometimes returns error strings instead of throwing
    // If we save corrupted state, future decryption attempts will also fail
    if (decryptedText.startsWith('Decryption failed')) {
      throw new Error(decryptedText);
    }

    // Save updated state under the ORIGINAL inboxId (where we SEND messages), not where we received from.
    // This is crucial because encryptWithExistingSession looks up state by latestState.inboxId,
    // and we need the updated ratchet state to be found there.
    const newState: EncryptionState = {
      state: result.ratchet_state,
      timestamp: Date.now(),
      conversationId,
      inboxId: encryptionState.inboxId, // Use ORIGINAL inboxId, not senderInboxAddress
      sentAccept: encryptionState.sentAccept,
      sendingInbox: encryptionState.sendingInbox, // IMPORTANT: Preserve sendingInbox for future sends
      tag: encryptionState.tag, // Preserve tag
      // Preserve X3DH ephemeral keys for unconfirmed sessions
      x3dhEphemeralPublicKey: encryptionState.x3dhEphemeralPublicKey,
      x3dhEphemeralPrivateKey: encryptionState.x3dhEphemeralPrivateKey,
    };
    // Save updated state but DON'T update latestState - this is a RECEIVE operation
    // The latestState tracks where to SEND messages (recipient's inbox), not where we received from
    encryptionStateStorage.saveEncryptionState(newState, false);

    return decryptedText;
    });
  }

  /**
   * Establish a new session using X3DH
   *
   * @param senderDeviceInboxAddress - The sender's own device inbox where replies will arrive.
   *                                   We save state under this inbox so we can decrypt replies.
   */
  private async establishSession(
    conversationId: string,
    recipientInfo: RecipientInfo,
    senderDeviceInboxAddress: string
  ): Promise<{ state: EncryptionState; ephemeralPublicKey: number[]; ephemeralPrivateKey: number[] }> {
    if (!this.deviceKeys) {
      throw new Error('Device keys not initialized');
    }

    // Generate ephemeral key for X3DH
    const ephemeralKey = await this.cryptoProvider.generateX448();

    // Perform sender-side X3DH
    const sessionKeyResult = await this.cryptoProvider.senderX3DH({
      sending_identity_private_key: this.deviceKeys.identityPrivateKey,
      sending_ephemeral_private_key: ephemeralKey.private_key,
      receiving_identity_key: recipientInfo.identityKey,
      receiving_signed_pre_key: recipientInfo.signedPreKey,
      session_key_length: SESSION_KEY_LENGTH,
    });

    // The result might be JSON-quoted, hex, or base64 - handle all cases
    let sessionKeyBytes: Uint8Array;
    let sessionKeyData = sessionKeyResult;

    // Remove JSON quotes if present
    if (sessionKeyData.startsWith('"') && sessionKeyData.endsWith('"')) {
      sessionKeyData = sessionKeyData.slice(1, -1);
    }

    // Check if it's hex (all hex chars and even length, typically 192 chars for 96 bytes)
    const isHex = /^[0-9a-fA-F]+$/.test(sessionKeyData) && sessionKeyData.length % 2 === 0;
    if (isHex) {
      sessionKeyBytes = new Uint8Array(this.hexToBytes(sessionKeyData));
    } else {
      sessionKeyBytes = this.base64ToBytes(sessionKeyData);
    }

    // Decode session key (96 bytes: 32 session + 32 send header + 32 recv header)
    const sessionKey = Array.from(sessionKeyBytes.slice(0, 32));
    const sendingHeaderKey = Array.from(sessionKeyBytes.slice(32, 64));
    const receivingHeaderKey = Array.from(sessionKeyBytes.slice(64, 96));

    // Initialize Double Ratchet as sender
    const ratchetState = await this.cryptoProvider.newDoubleRatchet({
      session_key: sessionKey,
      sending_header_key: sendingHeaderKey,
      next_receiving_header_key: receivingHeaderKey,
      is_sender: true,
      sending_ephemeral_private_key: ephemeralKey.private_key,
      receiving_ephemeral_key: recipientInfo.signedPreKey, // Use signed pre-key as initial receiving ephemeral
    });

    const timestamp = Date.now();

    // Create sendingInbox structure for sealing future messages to recipient
    // We store their inbox encryption key for sealing envelopes
    // Note: For initiator, inbox_public_key stays empty until we receive their reply
    const sendingInbox: SendingInbox = {
      inbox_address: recipientInfo.inboxAddress,
      inbox_encryption_key: recipientInfo.inboxEncryptionKey
        ? this.bytesToHex(recipientInfo.inboxEncryptionKey)
        : '', // Will need to be set for sealing to work
      inbox_public_key: '', // Will be set when we receive their reply (session confirmation)
      inbox_private_key: '', // Never have their private key
    };

    // Save ONE encryption state, keyed by OUR receiving inbox (senderDeviceInboxAddress)
    // This is the ONLY state for this conversation.
    // - When we SEND: look up by OUR inbox, use sendingInbox to know WHERE to send
    // - When we RECEIVE: look up by OUR inbox (where message arrives)
    // This ensures the ratchet state stays synchronized.
    //
    // IMPORTANT: Store the X3DH ephemeral keypair for reuse in subsequent init envelopes.
    // Until the session is confirmed (sentAccept or inbox_public_key set), ALL init envelopes
    // must use the SAME ephemeral key so the receiver derives the same session key via X3DH.
    const encryptionState: EncryptionState = {
      state: ratchetState,
      timestamp,
      conversationId,
      inboxId: senderDeviceInboxAddress, // Key by OUR receiving inbox
      sentAccept: false,
      sendingInbox, // Store recipient's inbox info for sealing (WHERE to send)
      tag: senderDeviceInboxAddress,
      x3dhEphemeralPublicKey: this.bytesToHex(ephemeralKey.public_key),
      x3dhEphemeralPrivateKey: this.bytesToHex(ephemeralKey.private_key),
    };
    encryptionStateStorage.saveEncryptionState(encryptionState, true);
    encryptionStateStorage.saveInboxMapping(senderDeviceInboxAddress, conversationId);

    return {
      state: encryptionState,
      ephemeralPublicKey: ephemeralKey.public_key,
      ephemeralPrivateKey: ephemeralKey.private_key,
    };
  }

  /**
   * Handle receiving a session initialization (receiver side of X3DH)
   */
  async receiveSessionInit(
    conversationId: string,
    senderInfo: {
      identityKey: number[];
      ephemeralKey: number[];
      inboxAddress: string;
    }
  ): Promise<void> {
    return ratchetMutex.runExclusive(conversationId, async () => {
    if (!this.deviceKeys) {
      throw new Error('Device keys not initialized');
    }

    // Perform receiver-side X3DH
    const sessionKeyBase64 = await this.cryptoProvider.receiverX3DH({
      sending_identity_private_key: this.deviceKeys.identityPrivateKey,
      sending_signed_private_key: this.deviceKeys.preKeyPrivateKey,
      receiving_identity_key: senderInfo.identityKey,
      receiving_ephemeral_key: senderInfo.ephemeralKey,
      session_key_length: SESSION_KEY_LENGTH,
    });

    // Decode session key
    const sessionKeyBytes = this.base64ToBytes(sessionKeyBase64);
    const sessionKey = Array.from(sessionKeyBytes.slice(0, 32));
    const sendingHeaderKey = Array.from(sessionKeyBytes.slice(32, 64));
    const receivingHeaderKey = Array.from(sessionKeyBytes.slice(64, 96));

    // Initialize Double Ratchet as receiver (do NOT swap header keys - same order as sender)
    const ratchetState = await this.cryptoProvider.newDoubleRatchet({
      session_key: sessionKey,
      sending_header_key: sendingHeaderKey, // Same order as sender
      next_receiving_header_key: receivingHeaderKey, // Same order as sender
      is_sender: false,
      sending_ephemeral_private_key: this.deviceKeys.preKeyPrivateKey,
      receiving_ephemeral_key: senderInfo.ephemeralKey,
    });

    // Save encryption state - this IS session init, so we DO want to set latestState
    // because senderInfo.inboxAddress is where we should send replies to
    const encryptionState: EncryptionState = {
      state: ratchetState,
      timestamp: Date.now(),
      conversationId,
      inboxId: senderInfo.inboxAddress,
      sentAccept: false,
    };

    encryptionStateStorage.saveEncryptionState(encryptionState, true);
    encryptionStateStorage.saveInboxMapping(senderInfo.inboxAddress, conversationId);
    });
  }

  /**
   * Confirm an unconfirmed Double Ratchet SENDER session from the peer's
   * first reply — mobile port of the SDK's ConfirmDoubleRatchetSenderSession
   * (quilibrium-js-sdk-channels channel.ts) as used by desktop
   * (MessageService.ts Confirm branch).
   *
   * The initiator's state starts with sendingInbox.inbox_public_key === ''
   * ("unconfirmed"); while unconfirmed, every send is wrapped in an
   * InitializationEnvelope. The peer's first reply (itself init-wrapped)
   * carries the peer's full return_inbox_* — processing it here fills the
   * sendingInbox, sets sentAccept, and ends the init-wrapping on both sides.
   *
   * Composed entirely from existing primitives (DR decrypt + state
   * bookkeeping); no new cryptography. Returns null whenever this is not a
   * confirmable case, so callers fall back to the pre-existing behavior.
   */
  async confirmSenderSession(
    conversationId: string,
    receivedOnInboxAddress: string,
    unsealed: UnsealedEnvelope
  ): Promise<{ message: string; userProfile?: { displayName?: string; userIcon?: string } } | null> {
    return ratchetMutex.runExclusive(conversationId, async () => {
      const state = encryptionStateStorage.getEncryptionState(conversationId, receivedOnInboxAddress);
      // Only an UNCONFIRMED sender session is a confirm case (SDK throws
      // 'inbox key already set' otherwise; we return null and let the
      // normal DR/init paths handle it).
      if (!state) return null;
      if (state.sendingInbox?.inbox_public_key) return null;

      // SDK validation: ALL initialization fields must be present — a
      // partial envelope must not half-confirm the session.
      if (
        !unsealed.return_inbox_address ||
        !unsealed.return_inbox_encryption_key ||
        !unsealed.return_inbox_private_key ||
        !unsealed.return_inbox_public_key ||
        !unsealed.tag ||
        !unsealed.message ||
        !unsealed.user_address
      ) {
        return null;
      }

      // Decrypt the inner DR envelope with the sender session's ratchet.
      let envelopeStr = unsealed.message;
      if (envelopeStr.includes('\\')) {
        envelopeStr = envelopeStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      const decryptResult = await this.cryptoProvider.doubleRatchetDecrypt({
        ratchet_state: state.state,
        envelope: envelopeStr,
      });
      const resultWithError = decryptResult as typeof decryptResult & { decryptionError?: string };
      if (resultWithError.decryptionError || decryptResult.message.length === 0) {
        // Signal rule: a bad frame never destroys the session — leave the
        // state untouched and let the caller fall back.
        return null;
      }
      const decryptedMessage = textDecoder.decode(new Uint8Array(decryptResult.message));

      // Persist the CONFIRMED state immediately, inside the lock (desktop
      // parity: accept plaintext + store state changes is one atomic step).
      // Keep the row's OWN tag (the target device inbox): the send path
      // selects sessions by tag, so overwriting it with the PEER's tag
      // (unsealed.tag) un-linked the confirmed row from its device and the
      // next send re-initialized from scratch — sessions could never stay
      // confirmed. Desktop preserves the session's own tag here.
      const confirmedState: EncryptionState = {
        state: decryptResult.ratchet_state,
        timestamp: Date.now(),
        conversationId,
        inboxId: state.inboxId,
        sentAccept: true,
        sendingInbox: {
          inbox_address: unsealed.return_inbox_address,
          inbox_encryption_key: unsealed.return_inbox_encryption_key,
          inbox_public_key: unsealed.return_inbox_public_key,
          inbox_private_key: unsealed.return_inbox_private_key,
        },
        tag: state.tag ?? unsealed.tag,
      };
      encryptionStateStorage.saveEncryptionState(confirmedState, true);
      // Route future received replies on the peer's return inbox to this
      // conversation.
      encryptionStateStorage.saveInboxMapping(unsealed.return_inbox_address, conversationId);

      const userProfile = (unsealed.display_name || unsealed.user_icon)
        ? { displayName: unsealed.display_name, userIcon: unsealed.user_icon }
        : undefined;
      return { message: decryptedMessage, userProfile };
    });
  }

  /**
   * Check if a session exists for a conversation
   */
  hasSession(conversationId: string): boolean {
    return encryptionStateStorage.hasEncryptionState(conversationId);
  }

  /**
   * Delete all encryption state for a conversation
   */
  deleteSession(conversationId: string): void {
    encryptionStateStorage.deleteAllEncryptionStates(conversationId);
  }

  /**
   * Reset a DM session's ratchet state, allowing a fresh session to be established.
   * Call this when decryption fails and you need to start over.
   *
   * This clears:
   * - All encryption states (ratchet state) for the conversation
   * - Ephemeral key caches
   *
   * This preserves:
   * - Conversation inbox keypairs (addresses still valid)
   * - Inbox mappings (routing still works)
   *
   * After reset, the next message will establish a fresh X3DH session.
   */
  resetSession(conversationId: string): void {
    // Get all states to find ephemeral keys to clean up
    const states = encryptionStateStorage.getEncryptionStates(conversationId);
    for (const state of states) {
      // Clean up ephemeral key cache if we have the key stored
      if (state.x3dhEphemeralPublicKey) {
        encryptionStateStorage.deleteEphemeralKeyState(state.x3dhEphemeralPublicKey, conversationId);
      }
    }

    // Delete all encryption states (ratchet states)
    encryptionStateStorage.deleteAllEncryptionStates(conversationId);

    // NOTE: We intentionally do NOT delete:
    // - Conversation inbox keypairs (the addresses are still valid for receiving)
    // - Inbox mappings (routing still needs to work)
  }

  /**
   * Get the return inbox address for a conversation (for sending reset messages)
   */
  getReturnInboxForConversation(conversationId: string): string | null {
    const states = encryptionStateStorage.getEncryptionStates(conversationId);
    for (const state of states) {
      if (state.sendingInbox?.inbox_address) {
        return state.sendingInbox.inbox_address;
      }
    }
    return null;
  }

  // Initialization Envelope Handling

  /**
   * Unseal an initialization envelope (first message from a new sender)
   *
   * This decrypts the SealedMessage using our device's inbox encryption key
   * to get the UnsealedEnvelope containing sender info and message.
   */
  async unsealInitializationEnvelope(
    sealedMessage: SealedMessage
  ): Promise<UnsealedEnvelope> {
    if (!this.deviceKeys) {
      throw new Error('Device keys not initialized');
    }

    // Parse the ephemeral public key from hex string to bytes
    const ephemeralPublicKey = this.hexToBytes(sealedMessage.ephemeral_public_key);

    // The encryptInboxMessage returns a JSON string that might be quoted
    // Try to parse it, handling potential double-encoding
    let ciphertext: { ciphertext: string; initialization_vector: string; associated_data?: string };
    let envelopeStr = sealedMessage.envelope;

    // If the envelope starts with a quote, it might be a quoted JSON string
    if (envelopeStr.startsWith('"') && envelopeStr.endsWith('"')) {
      envelopeStr = JSON.parse(envelopeStr) as string;
    }

    try {
      ciphertext = JSON.parse(envelopeStr);
    } catch (parseError) {
      throw new Error(`Failed to parse sealed envelope: ${parseError}`);
    }

    // Decrypt the envelope using our inbox encryption private key and sender's ephemeral key
    const decryptedBytes = await this.cryptoProvider.decryptInboxMessage({
      inbox_private_key: this.deviceKeys.inboxEncryptionPrivateKey,
      ephemeral_public_key: ephemeralPublicKey,
      ciphertext,
    });

    // Parse the decrypted bytes as JSON to get the UnsealedEnvelope
    const decryptedString = textDecoder.decode(new Uint8Array(decryptedBytes));
    const envelope = JSON.parse(decryptedString) as UnsealedEnvelope;

    // CRITICAL: Desktop uses the SAME ephemeral key for BOTH:
    // 1. Inbox sealing (encrypting the envelope)
    // 2. X3DH session establishment
    //
    // The ephemeral_public_key is at the TOP LEVEL of SealedMessage, NOT inside the envelope.
    // We ALWAYS use sealedMessage.ephemeral_public_key for X3DH, regardless of what's in the envelope.
    envelope.ephemeral_public_key = sealedMessage.ephemeral_public_key;

    return envelope;
  }

  /**
   * Initialize a recipient session from an unsealed envelope
   *
   * This is called when we receive the first message from a new sender.
   * It performs receiver-side X3DH and initializes the Double Ratchet.
   *
   * Returns the decrypted message, session info, and sender's user profile.
   * Returns null if decryption fails (expected in multi-device scenarios).
   */
  async initializeRecipientSession(
    unsealed: UnsealedEnvelope,
    receivedOnInboxAddress: string,  // The inbox where we received this init message
    // Server-assigned envelope timestamp; when provided, the staleness guard
    // refuses redelivered/zombie init envelopes (returns 'stale') instead of
    // letting them re-run X3DH over a newer session.
    envelopeTimestamp?: number
  ): Promise<'stale' | {
    conversationId: string;
    message: string;
    senderAddress: string;
    returnInbox: {
      address: string;
      encryptionKey: string;
      publicKey: string;
      privateKey: string;
    };
    // Our conversation inbox that we need to subscribe to for receiving replies
    ourConversationInbox: string;
    // User profile data from the InitializationEnvelope
    userProfile?: {
      displayName?: string;
      userIcon?: string;
    };
  } | null> {
    // Derive conversation ID from sender address (needed as the mutex key
    // before we enter the critical section).
    const conversationId = `${unsealed.user_address}/${unsealed.user_address}`;

    return ratchetMutex.runExclusive(conversationId, async () => {
    if (!this.deviceKeys) {
      throw new Error('Device keys not initialized');
    }

    // FIRST: Check if we have a cached state for this specific ephemeral key
    // This handles multiple messages sent with the same X3DH session before our reply.
    // Without this, message 2+ would fail because we'd re-derive ratchet state 0
    // but the messages were encrypted with advanced ratchet states.
    const ephemeralCachedState = encryptionStateStorage.getEphemeralKeyState(
      unsealed.ephemeral_public_key,
      conversationId
    );

    if (ephemeralCachedState) {
      // Decrypt using the cached (advanced) ratchet state
      let envelopeStr = unsealed.message;
      if (envelopeStr.includes('\\')) {
        envelopeStr = envelopeStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }

      const stateAndEnvelope: DoubleRatchetStateAndEnvelope = {
        ratchet_state: ephemeralCachedState.state,
        envelope: envelopeStr,
      };

      const decryptResult = await this.cryptoProvider.doubleRatchetDecrypt(stateAndEnvelope);

      // Check for decryption failure (returned as result with empty message and error)
      const resultWithError = decryptResult as typeof decryptResult & { decryptionError?: string };
      if (resultWithError.decryptionError || decryptResult.message.length === 0) {
        // Decryption failed - fall through to try other methods
        // Continue to next decryption attempt below
      } else {
        const decryptedMessage = textDecoder.decode(new Uint8Array(decryptResult.message));

        // Save the ADVANCED ratchet state back to ephemeral cache for next message
        const updatedState: EncryptionState = {
          ...ephemeralCachedState,
          state: decryptResult.ratchet_state,
          timestamp: Date.now(),
        };
        encryptionStateStorage.saveEphemeralKeyState(unsealed.ephemeral_public_key, conversationId, updatedState);
        // Also save to regular state storage
        encryptionStateStorage.saveEncryptionState(updatedState, false);

        // Get our conversation inbox for the return value
        const cachedConversationInbox = encryptionStateStorage.getConversationInboxKeypair(conversationId);

        return {
          conversationId,
          message: decryptedMessage,
          senderAddress: unsealed.user_address,
          returnInbox: {
            address: unsealed.return_inbox_address,
            encryptionKey: unsealed.return_inbox_encryption_key,
            publicKey: unsealed.return_inbox_public_key,
            privateKey: unsealed.return_inbox_private_key,
          },
          ourConversationInbox: cachedConversationInbox?.inboxAddress || ephemeralCachedState.inboxId,
          userProfile: {
            displayName: unsealed.display_name,
            userIcon: unsealed.user_icon,
          },
        };
      }
      // If decryption failed, fall through to try other methods
    }

    // Check if we already have a session with this sender
    // If so, we should decrypt with the existing Double Ratchet instead of doing fresh X3DH

    const allStates = encryptionStateStorage.getEncryptionStates(conversationId);

    // IMPORTANT: Try to find a state that matches the inbox we received this on
    // This handles the case where desktop is sending to mobile's device inbox
    // and we need to use the session state for that specific inbox
    const stateForReceivedInbox = allStates.find(s => s.inboxId === receivedOnInboxAddress || s.tag === receivedOnInboxAddress);

    const latestState = encryptionStateStorage.getLatestState(conversationId);

    // Determine which state to use for decryption:
    // 1. First, try to find a state matching the received inbox (exact match)
    // 2. If no exact match but we have states, use the latest state
    //    This handles the case where:
    //    - Sender is sending to our DEVICE inbox (from registration)
    //    - But our session state is keyed by CONVERSATION inbox (per-conversation)
    //    - The sender doesn't know about our conversation inbox yet
    // 3. If no states at all, we'll do fresh X3DH below
    let stateToUse = stateForReceivedInbox;

    if (!stateToUse && latestState && allStates.length > 0) {
      // No exact match, but we have a session for this conversation
      // Try the latest state - the sender may be using our device inbox
      const latestFullState = encryptionStateStorage.getEncryptionState(conversationId, latestState.inboxId);
      if (latestFullState) {
        stateToUse = latestFullState;
      }
    }

    if (stateToUse) {
      const existingState = stateToUse;

      // Decrypt using existing session (no X3DH needed)
      let envelopeStr = unsealed.message;
      if (envelopeStr.includes('\\')) {
        envelopeStr = envelopeStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }

      const stateAndEnvelope: DoubleRatchetStateAndEnvelope = {
        ratchet_state: existingState.state,
        envelope: envelopeStr,
      };

      const decryptResult = await this.cryptoProvider.doubleRatchetDecrypt(stateAndEnvelope);

      // Check for decryption failure (returned as result with empty message and error)
      const resultWithError = decryptResult as typeof decryptResult & { decryptionError?: string };
      if (resultWithError.decryptionError || decryptResult.message.length === 0) {
        // Existing session decrypt failed - fall through to X3DH
      } else {
        const decryptedMessage = textDecoder.decode(new Uint8Array(decryptResult.message));

        // Save updated state (preserve existing inboxId, sendingInbox, and X3DH ephemeral keys)
        const updatedState: EncryptionState = {
          state: decryptResult.ratchet_state,
          timestamp: Date.now(),
          conversationId,
          inboxId: existingState.inboxId,
          sentAccept: existingState.sentAccept,
          sendingInbox: existingState.sendingInbox,
          tag: existingState.tag,
          x3dhEphemeralPublicKey: existingState.x3dhEphemeralPublicKey,
          x3dhEphemeralPrivateKey: existingState.x3dhEphemeralPrivateKey,
        };
        encryptionStateStorage.saveEncryptionState(updatedState, false); // Don't update latestState for receive

        // Get our conversation inbox for the return value
        const conversationInbox = encryptionStateStorage.getConversationInboxKeypair(conversationId);

        const userProfile = (unsealed.display_name || unsealed.user_icon)
          ? { displayName: unsealed.display_name, userIcon: unsealed.user_icon }
          : undefined;

        return {
          conversationId,
          message: decryptedMessage,
          senderAddress: unsealed.user_address,
          returnInbox: {
            address: unsealed.return_inbox_address,
            encryptionKey: unsealed.return_inbox_encryption_key,
            publicKey: unsealed.return_inbox_public_key,
            privateKey: unsealed.return_inbox_private_key,
          },
          ourConversationInbox: conversationInbox?.inboxAddress || existingState.inboxId,
          userProfile,
        };
      }
    }

    // No existing session usable (or existing-session decrypt failed) — the
    // code below runs full X3DH, which INSTALLS session state and repoints
    // latestState for this conversation. Staleness guard (desktop parity,
    // see initEnvelopeGuard.ts): a redelivered or zombie init envelope must
    // never re-run X3DH over a newer session — that resurrects a ratchet the
    // sender no longer holds and forks the pair. Refuse anything not strictly
    // newer than what we already hold; the caller deletes the refused
    // envelope from the server so it cannot be redelivered (mine defused).
    if (envelopeTimestamp !== undefined) {
      const knownTimestamps = [
        ...allStates.map((s) => s.timestamp),
        ...getInstalledInitEnvelopeTs(conversationId),
      ];
      if (isStaleInitEnvelope(envelopeTimestamp, knownTimestamps)) {
        return 'stale';
      }
    }

    // Parse keys from hex strings to byte arrays
    const senderIdentityKey = this.hexToBytes(unsealed.identity_public_key);
    const senderEphemeralKey = this.hexToBytes(unsealed.ephemeral_public_key);

    // Perform receiver-side X3DH
    const sessionKeyBase64 = await this.cryptoProvider.receiverX3DH({
      sending_identity_private_key: this.deviceKeys.identityPrivateKey,
      sending_signed_private_key: this.deviceKeys.preKeyPrivateKey,
      receiving_identity_key: senderIdentityKey,
      receiving_ephemeral_key: senderEphemeralKey,
      session_key_length: SESSION_KEY_LENGTH,
    });

    // Decode session key (96 bytes: 32 session + 32 send header + 32 recv header)
    const sessionKeyBytes = this.base64ToBytes(sessionKeyBase64);
    const sessionKey = Array.from(sessionKeyBytes.slice(0, 32));
    const sendingHeaderKey = Array.from(sessionKeyBytes.slice(32, 64));
    const receivingHeaderKey = Array.from(sessionKeyBytes.slice(64, 96));

    // IMPORTANT: Do NOT swap header keys for receiver
    // The X3DH derivation order is consistent between sender and receiver
    // Both sides use the same key positions (32-64 for sending, 64-96 for receiving)

    // Initialize Double Ratchet as receiver (DO NOT swap header keys - desktop doesn't)
    const ratchetState = await this.cryptoProvider.newDoubleRatchet({
      session_key: sessionKey,
      sending_header_key: sendingHeaderKey, // Same order as sender
      next_receiving_header_key: receivingHeaderKey, // Same order as sender
      is_sender: false,
      sending_ephemeral_private_key: this.deviceKeys.preKeyPrivateKey,
      receiving_ephemeral_key: senderEphemeralKey,
    });

    // The unsealed.message is actually a Double Ratchet envelope that needs to be decrypted
    // Decrypt the first message using the newly initialized ratchet

    // Handle escaped JSON in the message (backslash-quote sequences)
    let envelopeStr = unsealed.message;
    if (envelopeStr.includes('\\')) {
      envelopeStr = envelopeStr
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }

    const stateAndEnvelope: DoubleRatchetStateAndEnvelope = {
      ratchet_state: ratchetState,
      envelope: envelopeStr,
    };

    const decryptResult = await this.cryptoProvider.doubleRatchetDecrypt(stateAndEnvelope);

    // Check for decryption failure (returned as result with empty message and error)
    const resultWithError = decryptResult as typeof decryptResult & { decryptionError?: string };
    if (resultWithError.decryptionError || decryptResult.message.length === 0) {
      // Expected in multi-device scenarios - return null instead of throwing
      return null;
    }

    const decryptedMessage = textDecoder.decode(new Uint8Array(decryptResult.message));

    // Create sendingInbox structure for sealing future replies
    // This is the sender's inbox info we'll use to seal messages to them.
    // SDK model: the init envelope carries the sender's FULL return-inbox key
    // set (including the signing keys), so a recipient session is born
    // send-ready — no separate confirmation round-trip is needed in this
    // direction. Leaving the keys empty here (the previous behavior) made
    // the send path treat this session as unconfirmed forever.
    const sendingInbox: SendingInbox = {
      inbox_address: unsealed.return_inbox_address,
      inbox_encryption_key: unsealed.return_inbox_encryption_key,
      inbox_public_key: unsealed.return_inbox_public_key || '',
      inbox_private_key: unsealed.return_inbox_private_key || '',
    };

    // IMPORTANT: Generate conversation inbox keypairs for the receiver
    // This is used when replying to the sender. Like the sender, the receiver
    // needs their own per-conversation inbox for receiving subsequent messages.
    // We generate both X448 (encryption) and Ed448 (signing) keypairs to match desktop's InboxKeyset.
    const conversationInboxKeypair = await this.cryptoProvider.generateX448();
    const conversationSigningKeypair = await this.cryptoProvider.generateEd448();
    // IMPORTANT: Derive address from Ed448 signing key (not X448 encryption key)
    // This matches device inbox derivation and allows proper signature verification for inbox operations
    const conversationInboxAddress = deriveAddress(new Uint8Array(conversationSigningKeypair.public_key));

    // Store the conversation inbox keypair (both encryption and signing keys)
    const storedKeypair: ConversationInboxKeypair = {
      conversationId,
      inboxAddress: conversationInboxAddress,
      encryptionPublicKey: conversationInboxKeypair.public_key,
      encryptionPrivateKey: conversationInboxKeypair.private_key,
      signingPublicKey: conversationSigningKeypair.public_key,
      signingPrivateKey: conversationSigningKeypair.private_key,
    };
    encryptionStateStorage.saveConversationInboxKeypair(storedKeypair);

    // Save encryption state with the updated ratchet state from decryption
    // IMPORTANT: State is keyed by our CONVERSATION inbox (not device inbox)
    // because that's where subsequent messages will be routed when we have
    // a per-conversation inbox. This matches the sender's pattern.
    const encryptionState: EncryptionState = {
      state: decryptResult.ratchet_state,
      timestamp: Date.now(),
      conversationId,
      inboxId: conversationInboxAddress,  // Key by OUR conversation inbox
      sentAccept: false,
      sendingInbox,  // Where we SEND replies (sender's return inbox)
      // SDK model: the envelope tag is the SENDER'S DEVICE INBOX and is the
      // session's identity — the send path selects sessions by
      // tag === target device inbox, so storing it is what lets a reply
      // reuse this (send-ready) session instead of spinning up a parallel
      // sender session. The previous value (our own conversation inbox)
      // made this row invisible to sends.
      tag: unsealed.tag || conversationInboxAddress,
    };

    // Save encryption state - this is the PRIMARY state for this conversation
    // The sendingInbox field tells us where to send, so we don't need a separate "latest" state
    encryptionStateStorage.saveEncryptionState(encryptionState, true);

    // Remember this envelope's server timestamp so an exact redelivery is
    // recognized as stale even inside the skew tolerance window (state rows
    // carry local Date.now, not the envelope timestamp desktop keys off).
    if (envelopeTimestamp !== undefined) {
      recordInstalledInitEnvelopeTs(conversationId, envelopeTimestamp);
    }

    // IMPORTANT: Also save to ephemeral key cache so subsequent messages with same
    // ephemeral key can use this advanced ratchet state instead of re-doing X3DH
    encryptionStateStorage.saveEphemeralKeyState(unsealed.ephemeral_public_key, conversationId, encryptionState);

    // Map the conversation inbox to this conversation for lookup
    encryptionStateStorage.saveInboxMapping(conversationInboxAddress, conversationId);
    // Also map the sender's return inbox so we can route received messages
    encryptionStateStorage.saveInboxMapping(unsealed.return_inbox_address, conversationId);

    // Extract user profile from the envelope (if present)
    // Desktop stores these as display_name and user_icon in the InitializationEnvelope
    const userProfile = (unsealed.display_name || unsealed.user_icon)
      ? {
          displayName: unsealed.display_name,
          userIcon: unsealed.user_icon,
        }
      : undefined;

    return {
      conversationId,
      message: decryptedMessage,
      senderAddress: unsealed.user_address,
      returnInbox: {
        address: unsealed.return_inbox_address,
        encryptionKey: unsealed.return_inbox_encryption_key,
        publicKey: unsealed.return_inbox_public_key,
        privateKey: unsealed.return_inbox_private_key,
      },
      ourConversationInbox: conversationInboxAddress,
      userProfile,
    };
    });
  }

  /**
   * Get device keys (for external use in unsealing)
   */
  getDeviceKeys(): DeviceKeys | null {
    return this.deviceKeys;
  }

  // Utility Methods

  private hexToBytes(hex: string): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.substr(i, 2), 16));
    }
    return bytes;
  }

  private bytesToHex(bytes: number[]): string {
    return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private base64ToBytes(base64: string): Uint8Array {
    // Clean up the base64 string - remove any quotes that may be around it
    let cleanBase64 = base64;
    if (cleanBase64.startsWith('"') && cleanBase64.endsWith('"')) {
      cleanBase64 = cleanBase64.slice(1, -1);
    }

    // Remove any whitespace
    cleanBase64 = cleanBase64.replace(/\s/g, '');

    // Validate base64 characters
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64)) {
      throw new Error(`Invalid base64 string: ${cleanBase64.substring(0, 20)}...`);
    }

    const binaryString = atob(cleanBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  private bytesToBase64(bytes: number[]): string {
    const binaryString = String.fromCharCode(...bytes);
    return btoa(binaryString);
  }
}

// Export singleton instance
export const encryptionService = new EncryptionService();
export default encryptionService;
