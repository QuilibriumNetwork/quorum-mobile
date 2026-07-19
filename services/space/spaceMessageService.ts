/*
 * SpaceMessageService - Handles encrypted space message sending
 *
 * Provides functionality to:
 * - Send messages to space channels via Triple Ratchet + Hub encryption
 * - Sign messages with user keys
 * - Handle optimistic updates and error recovery
 *
 * Messages flow:
 * 1. Create message object with nonce and signature
 * 2. Encrypt with Triple Ratchet (shared per-space state)
 * 3. Seal encrypted message for hub delivery using sealHubEnvelope
 * 4. Send via postHub API endpoint
 */

import { sha256 } from '@noble/hashes/sha2.js';
import {
  buildMessageFingerprint,
  bytesToHex,
  hexToBytes,
  extractMentionsFromText,
  type EditMessage,
  type Mentions,
  type Message,
  type MessageContent,
  type PostMessage,
  type ReactionMessage,
  type MuteMessage,
  type RemoveMessage,
  type RemoveReactionMessage,
  type StickerMessage,
  type SpaceCallStartMessage,
  type SpaceCallEndMessage,
  // New sync types
  type SyncRequestPayload,
  type SyncInfoPayload,
  type SyncInitiatePayload,
  type SyncManifestPayload,
  type SyncDeltaPayload,
  type SyncManifest,
  type MemberDigest,
  type PeerEntry,
  chunkMessages,
} from '@quilibrium/quorum-shared';
import { getSpaceKey, getSpaceSigningKey } from '../config/spaceStorage';
import { encryptionStateStorage } from '../crypto/encryption-state-storage';
import { NativeCryptoProvider } from '../crypto/native-provider';

// Uses a loop instead of spread operator to avoid stack overflow on large arrays.
function bytesToBase64(bytes: Uint8Array | number[]): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Tracks sent TR envelope fingerprints to skip decrypting our own echoed messages
// (TR participants can't decrypt their own messages).
const sentEnvelopeFingerprints = new Set<string>();
const MAX_FINGERPRINTS = 1000; // Limit to prevent memory leaks

function getEnvelopeFingerprint(envelope: string): string {
  // Use first 100 chars as fingerprint (unique enough, fast to compute)
  return envelope.substring(0, 100);
}

export function trackSentEnvelope(envelope: string): void {
  const fingerprint = getEnvelopeFingerprint(envelope);
  sentEnvelopeFingerprints.add(fingerprint);

  // Clean up old fingerprints if we have too many
  if (sentEnvelopeFingerprints.size > MAX_FINGERPRINTS) {
    const toRemove = Array.from(sentEnvelopeFingerprints).slice(0, 100);
    toRemove.forEach(fp => sentEnvelopeFingerprints.delete(fp));
  }
}

export function isSentEnvelope(envelope: string): boolean {
  const fingerprint = getEnvelopeFingerprint(envelope);
  return sentEnvelopeFingerprints.has(fingerprint);
}

/**
 * Remove a fingerprint after we've processed the echo
 */
export function clearSentEnvelope(envelope: string): void {
  const fingerprint = getEnvelopeFingerprint(envelope);
  sentEnvelopeFingerprints.delete(fingerprint);
}

export interface SendSpaceMessageParams {
  spaceId: string;
  channelId: string;
  text: string;
  senderAddress: string;
  repliesToMessageId?: string;
  replyToAuthorAddress?: string;
  /** Space roles, used to extract role mentions from the message text */
  spaceRoles?: Array<{ roleId: string; roleTag: string }>;
  /** Space channels, used to extract channel mentions from the message text */
  spaceChannels?: Array<{ channelId: string; channelName: string }>;
  /**
   * Whether the sender may use @everyone (has the mention:everyone permission).
   * Computed at the call site (where the Space object lives) and passed to
   * extractMentionsFromText as `allowEveryone` — without it `mentions.everyone`
   * is never set and @everyone never notifies anyone.
   */
  allowEveryone?: boolean;
  /** Skip signing this message (per-message lock); gated on space.isRepudiable at the call site. */
  skipSigning?: boolean;
}

export interface SendSpaceMessageResult {
  message: Message;
  /** Stringified envelope ready to send via WebSocket */
  wsEnvelope: string;
}

export interface SendStickerMessageParams {
  spaceId: string;
  channelId: string;
  stickerId: string;
  senderAddress: string;
}

export interface SendStickerMessageResult {
  message: Message;
  /** Stringified envelope ready to send via WebSocket */
  wsEnvelope: string;
}

/**
 * Generate a random nonce for message uniqueness
 */
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Generate message ID hash from content via the shared canonical fingerprint
 * (`buildMessageFingerprint`), which both platforms use for signing AND
 * receive-side verification - a locally-built fingerprint that diverges by
 * even one byte makes honest signatures verify as forgeries on the other
 * platform. Control types scope-bind spaceId+channelId (replay protection);
 * post/embed/sticker keep the legacy format so existing messageIds are stable.
 * Returns both the hex messageId and the raw hash bytes for signing.
 */
function generateMessageIdHash(
  nonce: string,
  senderAddress: string,
  content: MessageContent,
  spaceId: string,
  channelId: string
): { messageId: string; messageIdBytes: Uint8Array } {
  const fingerprint = buildMessageFingerprint({
    nonce,
    content: content as Parameters<typeof buildMessageFingerprint>[0]['content'],
    senderId: senderAddress,
    spaceId,
    channelId,
  });
  const hashBytes = sha256(new TextEncoder().encode(fingerprint));
  const messageId = bytesToHex(hashBytes);
  return { messageId, messageIdBytes: hashBytes };
}

/**
 * Convert hex string to number array
 */
function hexToNumberArray(hex: string): number[] {
  const bytes = hexToBytes(hex);
  return Array.from(bytes);
}

/**
 * Send a message to a space channel
 *
 * This function:
 * 1. Creates a signed message object
 * 2. Seals it for hub delivery using the space's hub key
 * 3. Sends it via the postHub API
 *
 * @param params - Message parameters
 * @returns The created message and API response
 */
export async function sendSpaceMessage(
  params: SendSpaceMessageParams
): Promise<SendSpaceMessageResult> {
  const { spaceId, channelId, text, senderAddress, repliesToMessageId, replyToAuthorAddress, spaceRoles, spaceChannels, allowEveryone, skipSigning } = params;

  const cryptoProvider = new NativeCryptoProvider();
  const timestamp = Date.now();
  const nonce = generateNonce();

  // 1. Get hub key for the space
  const hubKey = getSpaceKey(spaceId, 'hub');
  if (!hubKey) {
    throw new Error('Hub key not found for space. Cannot send messages.');
  }
  if (!hubKey.address || !hubKey.privateKey || !hubKey.publicKey) {
    throw new Error(`Hub key incomplete for space. Missing: ${!hubKey.address ? 'address ' : ''}${!hubKey.privateKey ? 'privateKey ' : ''}${!hubKey.publicKey ? 'publicKey' : ''}`);
  }

  // 1b. Get config key for hub envelope encryption
  const configKey = getSpaceKey(spaceId, 'config');

  // 2. Get the signing key: the user's per-space identity (join-bound, synced
  // across devices), NOT the per-device inbox/mailbox key — receivers resolve
  // signatures against the member table, which binds the join key only.
  const signingKey = getSpaceSigningKey(spaceId);
  if (!signingKey || !signingKey.privateKey || !signingKey.publicKey) {
    throw new Error('Signing key not found for space. Cannot sign messages.');
  }

  // 3. Build message content first (needed for messageId hash)
  const messageContent: PostMessage = {
    type: 'post',
    senderId: senderAddress,
    text,
    repliesToMessageId,
  };

  // 4. Generate message ID using SHA-256 hash (matches desktop implementation)
  const { messageId, messageIdBytes } = generateMessageIdHash(nonce, senderAddress, messageContent, spaceId, channelId);

  // 5. Build full message object
  const message: Message = {
    channelId,
    spaceId,
    messageId,
    digestAlgorithm: 'SHA-256',
    nonce,
    createdDate: timestamp,
    modifiedDate: timestamp,
    lastModifiedHash: '',
    content: messageContent,
    reactions: [],
    mentions: extractMentionsFromText(text, { spaceRoles, spaceChannels, allowEveryone }),
    publicKey: signingKey.publicKey,
    // Add reply metadata if this is a reply (used for display and notifications)
    ...(repliesToMessageId && replyToAuthorAddress
      ? {
          replyMetadata: {
            parentAuthor: replyToAuthorAddress,
            parentChannelId: channelId,
          },
        }
      : {}),
  };

  // 6. Sign the messageId hash (NOT the whole message JSON), unless this message
  // opted out via the per-message lock. Gated on space.isRepudiable at the call site.
  if (!skipSigning) {
    const messageIdBase64 = bytesToBase64(messageIdBytes);
    const inboxPrivateKeyBytes = hexToBytes(signingKey.privateKey);
    const inboxPrivateKeyBase64 = bytesToBase64(inboxPrivateKeyBytes);
    const signatureBase64 = await cryptoProvider.signEd448(inboxPrivateKeyBase64, messageIdBase64);

    const signatureBinary = atob(signatureBase64);
    let signatureHex = '';
    for (let i = 0; i < signatureBinary.length; i++) {
      signatureHex += signatureBinary.charCodeAt(i).toString(16).padStart(2, '0');
    }
    message.signature = signatureHex;
  }


  // Hub-envelope only (no TR): the config key rotates on kick, giving
  // forward secrecy without cross-device TR state sync.
  // Prepare message for sending (remove ephemeral fields)
  const messageToSend = { ...message };
  delete (messageToSend as Record<string, unknown>).sendStatus;
  delete (messageToSend as Record<string, unknown>).sendError;

  // Create hub message payload with the signed message directly
  const hubMessagePayload = JSON.stringify({
    type: 'message',
    message: messageToSend,
  });

  // 9. Seal the message for hub delivery
  const hubKeypair = {
    publicKey: hexToNumberArray(hubKey.publicKey),
    privateKey: hexToNumberArray(hubKey.privateKey),
  };

  const sealedMessage = await cryptoProvider.sealHubEnvelope(
    hubKey.address,
    hubKeypair,
    hubMessagePayload,
    configKey
      ? {
          publicKey: hexToNumberArray(configKey.publicKey),
          privateKey: hexToNumberArray(configKey.privateKey),
        }
      : undefined
  );

  const wsEnvelope = JSON.stringify({ type: 'log-append', ...sealedMessage });

  return {
    message,
    wsEnvelope,
  };
}

/**
 * Send a sticker message to a space channel
 */
export async function sendStickerMessage(
  params: SendStickerMessageParams
): Promise<SendStickerMessageResult> {
  const { spaceId, channelId, stickerId, senderAddress } = params;

  const cryptoProvider = new NativeCryptoProvider();
  const timestamp = Date.now();
  const nonce = generateNonce();

  // 1. Get hub key for the space
  const hubKey = getSpaceKey(spaceId, 'hub');
  if (!hubKey || !hubKey.address || !hubKey.privateKey || !hubKey.publicKey) {
    throw new Error('Hub key not found or incomplete for space.');
  }

  // 1b. Get config key for hub envelope encryption
  const configKey = getSpaceKey(spaceId, 'config');

  // 2. Get the signing key: the user's per-space identity (join-bound, synced
  // across devices), NOT the per-device inbox/mailbox key — receivers resolve
  // signatures against the member table, which binds the join key only.
  const signingKey = getSpaceSigningKey(spaceId);
  if (!signingKey || !signingKey.privateKey || !signingKey.publicKey) {
    throw new Error('Signing key not found for space. Cannot sign messages.');
  }

  // 3. Build sticker message content first (needed for messageId hash)
  const messageContent: StickerMessage = {
    type: 'sticker',
    senderId: senderAddress,
    stickerId,
  };

  // 4. Generate message ID using SHA-256 hash (matches desktop implementation)
  const { messageId, messageIdBytes } = generateMessageIdHash(nonce, senderAddress, messageContent, spaceId, channelId);

  // 5. Build full message object
  const message: Message = {
    channelId,
    spaceId,
    messageId,
    digestAlgorithm: 'SHA-256',
    nonce,
    createdDate: timestamp,
    modifiedDate: timestamp,
    lastModifiedHash: '',
    content: messageContent,
    reactions: [],
    mentions: { memberIds: [], roleIds: [], channelIds: [] },
    publicKey: signingKey.publicKey,
  };

  // 6. Sign the messageId hash (NOT the whole message JSON)
  const messageIdBase64 = bytesToBase64(messageIdBytes);
  const inboxPrivateKeyBytes = hexToBytes(signingKey.privateKey);
  const inboxPrivateKeyBase64 = bytesToBase64(inboxPrivateKeyBytes);
  const signatureBase64 = await cryptoProvider.signEd448(inboxPrivateKeyBase64, messageIdBase64);

  const signatureBinary = atob(signatureBase64);
  let signatureHex = '';
  for (let i = 0; i < signatureBinary.length; i++) {
    signatureHex += signatureBinary.charCodeAt(i).toString(16).padStart(2, '0');
  }
  message.signature = signatureHex;


  // 7. Prepare message for sending
  const messageToSend = { ...message };
  delete (messageToSend as Record<string, unknown>).sendStatus;
  delete (messageToSend as Record<string, unknown>).sendError;

  // Create hub message payload
  const hubMessagePayload = JSON.stringify({
    type: 'message',
    message: messageToSend,
  });

  // Seal the message for hub delivery
  const hubKeypair = {
    publicKey: hexToNumberArray(hubKey.publicKey),
    privateKey: hexToNumberArray(hubKey.privateKey),
  };

  const sealedMessage = await cryptoProvider.sealHubEnvelope(
    hubKey.address,
    hubKeypair,
    configKey?.publicKey ? hexToNumberArray(configKey.publicKey) : undefined,
    hubMessagePayload
  );

  // Create WebSocket envelope
  const wsEnvelope = JSON.stringify({
    type: 'hub',
    hub_address: hubKey.address,
    message: sealedMessage,
  });

  return {
    message,
    wsEnvelope,
  };
}

/**
 * Create an optimistic message for immediate UI display
 */
export interface JoinParticipant {
  address: string;
  id: number;
  inboxAddress: string;
  inboxPubKey: string;  // Ed448 public key of inbox (hex)
  pubKey: string;       // X448 public key derived from secret (hex)
  inboxKey: string;     // X448 inbox encryption public key (hex)
  identityKey: string;  // Identity public key (hex)
  preKey: string;       // Pre-key public key (hex)
  userIcon: string;
  displayName: string;
  joinedAt: number;     // Join timestamp (ms since epoch) — must be in the signed blob (desktop verifies it)
  signature: string;    // Ed448 signature (base64)
}

export interface SendJoinMessageParams {
  spaceId: string;
  participant: JoinParticipant;
}

/**
 * Send a join control message to announce a new participant to the space
 * This is required for other participants to be able to:
 * 1. Add the new participant to their peer_id_map/id_peer_map
 * 2. Encrypt messages that the new participant can decrypt
 * 3. Decrypt messages FROM the new participant
 */
export async function sendJoinMessage(
  params: SendJoinMessageParams
): Promise<string> {
  const { spaceId, participant } = params;

  const cryptoProvider = new NativeCryptoProvider();

  // Get hub key for the space
  const hubKey = getSpaceKey(spaceId, 'hub');
  if (!hubKey) {
    throw new Error('Hub key not found for space. Cannot send join message.');
  }
  if (!hubKey.address || !hubKey.privateKey || !hubKey.publicKey) {
    throw new Error('Hub key incomplete for space.');
  }

  // Get config key for hub envelope encryption
  const configKey = getSpaceKey(spaceId, 'config');

  // Create control message payload
  const controlMessage = {
    type: 'control',
    message: {
      type: 'join',
      participant,
    },
  };

  const hubMessagePayload = JSON.stringify(controlMessage);

  // Seal the message for hub delivery
  const hubKeypair = {
    publicKey: hexToNumberArray(hubKey.publicKey),
    privateKey: hexToNumberArray(hubKey.privateKey),
  };

  const sealedMessage = await cryptoProvider.sealHubEnvelope(
    hubKey.address,
    hubKeypair,
    hubMessagePayload,
    configKey
      ? {
          publicKey: hexToNumberArray(configKey.publicKey),
          privateKey: hexToNumberArray(configKey.privateKey),
        }
      : undefined
  );

  const wsEnvelope = JSON.stringify({ type: 'log-append', ...sealedMessage });

  return wsEnvelope;
}

export function createOptimisticMessage(
  params: SendSpaceMessageParams,
  tempMessageId: string
): Message {
  const { spaceId, channelId, text, senderAddress, repliesToMessageId, replyToAuthorAddress, spaceRoles, spaceChannels, allowEveryone } = params;
  const timestamp = Date.now();

  return {
    channelId,
    spaceId,
    messageId: tempMessageId,
    digestAlgorithm: 'sha256',
    nonce: '',
    createdDate: timestamp,
    modifiedDate: timestamp,
    lastModifiedHash: '',
    content: {
      type: 'post',
      senderId: senderAddress,
      text,
      repliesToMessageId,
    },
    reactions: [],
    mentions: extractMentionsFromText(text, { spaceRoles, spaceChannels, allowEveryone }),
    sendStatus: 'sending',
    // Add reply metadata if this is a reply (for display purposes)
    ...(repliesToMessageId && replyToAuthorAddress
      ? {
          replyMetadata: {
            parentAuthor: replyToAuthorAddress,
            parentChannelId: channelId,
          },
        }
      : {}),
  };
}

// Generic Message Sending

export interface SendGenericMessageParams {
  spaceId: string;
  channelId: string;
  senderAddress: string;
  content: MessageContent;
  /** Mentions extracted from the message text, when the content carries text
   *  (edit, embed caption). Defaults to empty for text-less content (reactions,
   *  deletes, calls, profile updates). */
  mentions?: Mentions;
  /** Skip signing (per-message lock). Already gated on space.isRepudiable by the caller. */
  skipSigning?: boolean;
}

export interface SendGenericMessageResult {
  message: Message;
  wsEnvelope: string;
}

// Common flow: sign, encrypt, seal.
async function sendGenericMessage(
  params: SendGenericMessageParams
): Promise<SendGenericMessageResult> {
  const { spaceId, channelId, senderAddress, content, mentions, skipSigning } = params;

  const cryptoProvider = new NativeCryptoProvider();
  const timestamp = Date.now();
  const nonce = generateNonce();

  // Get hub key for the space
  const hubKey = getSpaceKey(spaceId, 'hub');
  if (!hubKey || !hubKey.address || !hubKey.privateKey || !hubKey.publicKey) {
    throw new Error('Hub key not found or incomplete for space.');
  }

  // Get config key for hub envelope encryption
  const configKey = getSpaceKey(spaceId, 'config');

  // Get the signing key (per-space identity, not the per-device mailbox key)
  const signingKey = getSpaceSigningKey(spaceId);
  if (!signingKey || !signingKey.privateKey || !signingKey.publicKey) {
    throw new Error('Signing key not found for space. Cannot sign messages.');
  }

  // Generate message ID using SHA-256 hash (matches desktop implementation)
  const { messageId, messageIdBytes } = generateMessageIdHash(nonce, senderAddress, content, spaceId, channelId);

  // Build full message object
  const message: Message = {
    channelId,
    spaceId,
    messageId,
    digestAlgorithm: 'SHA-256',
    nonce,
    createdDate: timestamp,
    modifiedDate: timestamp,
    lastModifiedHash: '',
    content,
    reactions: [],
    mentions: mentions ?? { memberIds: [], roleIds: [], channelIds: [] },
    publicKey: signingKey.publicKey,
  };

  // Sign the messageId hash (NOT the whole message JSON), unless this message
  // opted out via the per-message lock. Gated on space.isRepudiable by the caller.
  if (!skipSigning) {
    const messageIdBase64 = bytesToBase64(messageIdBytes);
    const inboxPrivateKeyBytes = hexToBytes(signingKey.privateKey);
    const inboxPrivateKeyBase64 = bytesToBase64(inboxPrivateKeyBytes);
    const signatureBase64 = await cryptoProvider.signEd448(inboxPrivateKeyBase64, messageIdBase64);

    const signatureBinary = atob(signatureBase64);
    let signatureHex = '';
    for (let i = 0; i < signatureBinary.length; i++) {
      signatureHex += signatureBinary.charCodeAt(i).toString(16).padStart(2, '0');
    }
    message.signature = signatureHex;
  }


  // Hub-envelope only (no TR): config key rotates on kick.
  // Prepare message for sending (remove ephemeral fields)
  const messageToSend = { ...message };
  delete (messageToSend as Record<string, unknown>).sendStatus;
  delete (messageToSend as Record<string, unknown>).sendError;

  const hubMessagePayload = JSON.stringify({
    type: 'message',
    message: messageToSend,
  });

  // Seal for hub delivery
  const hubKeypair = {
    publicKey: hexToNumberArray(hubKey.publicKey),
    privateKey: hexToNumberArray(hubKey.privateKey),
  };

  const sealedMessage = await cryptoProvider.sealHubEnvelope(
    hubKey.address,
    hubKeypair,
    hubMessagePayload,
    configKey
      ? {
          publicKey: hexToNumberArray(configKey.publicKey),
          privateKey: hexToNumberArray(configKey.privateKey),
        }
      : undefined
  );

  const wsEnvelope = JSON.stringify({ type: 'log-append', ...sealedMessage });

  return { message, wsEnvelope };
}

// Reaction Messages

export interface SendReactionParams {
  spaceId: string;
  channelId: string;
  targetMessageId: string;
  reaction: string;
  senderAddress: string;
}

/**
 * Send a reaction to a message
 */
export async function sendReaction(
  params: SendReactionParams
): Promise<SendGenericMessageResult> {
  const { spaceId, channelId, targetMessageId, reaction, senderAddress } = params;

  const content: ReactionMessage = {
    type: 'reaction',
    senderId: senderAddress,
    messageId: targetMessageId,
    reaction,
  };

  return sendGenericMessage({ spaceId, channelId, senderAddress, content });
}

/**
 * Remove a reaction from a message
 */
export async function removeReaction(
  params: SendReactionParams
): Promise<SendGenericMessageResult> {
  const { spaceId, channelId, targetMessageId, reaction, senderAddress } = params;

  const content: RemoveReactionMessage = {
    type: 'remove-reaction',
    senderId: senderAddress,
    messageId: targetMessageId,
    reaction,
  };

  return sendGenericMessage({ spaceId, channelId, senderAddress, content });
}

// Edit Messages

export interface SendEditMessageParams {
  spaceId: string;
  channelId: string;
  originalMessageId: string;
  editedText: string;
  senderAddress: string;
  /** Space roles/channels for resolving @role and #channel mentions in the
   *  edited text (so an edit that adds/changes a mention still notifies). */
  spaceRoles?: Array<{ roleId: string; roleTag: string }>;
  spaceChannels?: Array<{ channelId: string; channelName: string }>;
  /** Sender may use @everyone (has mention:everyone) — gates @everyone in edits. */
  allowEveryone?: boolean;
  /**
   * Edit inherit rule: `!shouldSignEdit(original)` — an edit inherits the
   * signed/unsigned state of the message it edits, so a deliberately-unsigned
   * (deniable) message never silently gains a signature that would both
   * badge it as signed and leak linkage to the original content hash.
   */
  skipSigning?: boolean;
}

/**
 * Send an edit for an existing message
 */
export async function sendEditMessage(
  params: SendEditMessageParams
): Promise<SendGenericMessageResult> {
  const { spaceId, channelId, originalMessageId, editedText, senderAddress, spaceRoles, spaceChannels, allowEveryone, skipSigning } = params;

  const editedAt = Date.now();
  const editNonce = generateNonce();

  const content: EditMessage = {
    type: 'edit-message',
    senderId: senderAddress,
    originalMessageId,
    editedText,
    editedAt,
    editNonce,
  };

  return sendGenericMessage({
    spaceId,
    channelId,
    senderAddress,
    content,
    mentions: extractMentionsFromText(editedText, { spaceRoles, spaceChannels, allowEveryone }),
    skipSigning,
  });
}

// Delete Messages

export interface SendDeleteMessageParams {
  spaceId: string;
  channelId: string;
  targetMessageId: string;
  senderAddress: string;
}

/**
 * Send a delete/remove message
 */
export async function sendDeleteMessage(
  params: SendDeleteMessageParams
): Promise<SendGenericMessageResult> {
  const { spaceId, channelId, targetMessageId, senderAddress } = params;

  const content: RemoveMessage = {
    type: 'remove-message',
    senderId: senderAddress,
    removeMessageId: targetMessageId,
  };

  return sendGenericMessage({ spaceId, channelId, senderAddress, content });
}

// Mute User (moderation)

export interface SendMuteMessageParams {
  spaceId: string;
  channelId: string;
  /** The user being muted/unmuted. */
  targetUserId: string;
  senderAddress: string;
  action: 'mute' | 'unmute';
  /** Mute duration in ms. Omit / undefined = forever. Ignored for unmute. */
  duration?: number;
}

/**
 * Broadcast a moderation mute/unmute. The sender must hold the `user:mute` role
 * permission; receivers RE-VALIDATE that on receipt (we never trust the sender's
 * client). Mirrors desktop's MuteMessage so a mute crosses platforms. The muteId
 * is a fresh nonce used by receivers for replay/dedup protection.
 */
export async function sendMuteMessage(
  params: SendMuteMessageParams
): Promise<SendGenericMessageResult> {
  const { spaceId, channelId, targetUserId, senderAddress, action, duration } = params;

  const content: MuteMessage = {
    type: 'mute',
    senderId: senderAddress,
    targetUserId,
    muteId: generateNonce(),
    timestamp: Date.now(),
    action,
    ...(action === 'mute' && duration !== undefined ? { duration } : {}),
  };

  return sendGenericMessage({ spaceId, channelId, senderAddress, content });
}

// Update Profile Messages

export interface SendUpdateProfileParams {
  spaceId: string;
  channelId: string;
  senderAddress: string;
  // All profile fields optional. Empty/undefined values are NOT included
  // in the broadcast — sending an empty field would clobber the
  // recipients' stored value (the receiver treats present fields as the
  // new value, so omission is the only safe way to leave a field
  // alone). Pass only what you actually want changed.
  displayName?: string;
  userIcon?: string;
  bio?: string;
  // Global-identity slots (two-slot design — see
  // identity-resolution-and-profile-sync doc). These carry the sender's
  // CURRENT GLOBAL name/avatar/bio, stored by receivers separately from the
  // per-space override fields above. A global rename sends ONLY these (never
  // the override fields), so it reaches spacemates live WITHOUT being mistaken
  // for a deliberate per-space override. Empty string is a deliberate global
  // clear; undefined = no change.
  globalDisplayName?: string;
  globalUserIcon?: string;
  globalBio?: string;
  // Farcaster linkage — included automatically when the user has a
  // linked Farcaster account. Lets other members see "@username · FID"
  // on the user's profile card and tap through to the Farcaster feed
  // profile view.
  farcasterFid?: number;
  farcasterUsername?: string;
}

/**
 * Send an update-profile message to a space channel
 * This notifies other members of the space about a profile change
 */
export async function sendUpdateProfileMessage(
  params: SendUpdateProfileParams
): Promise<SendGenericMessageResult> {
  const {
    spaceId, channelId, senderAddress,
    displayName, userIcon, bio,
    globalDisplayName, globalUserIcon, globalBio,
    farcasterFid, farcasterUsername,
  } = params;

  // displayName/userIcon use `!== undefined` (not a truthy check) so a caller
  // that explicitly passes '' — a deliberate clear (removed avatar / cleared
  // per-space name) — puts the empty value on the wire and clears it for other
  // members. Callers that mean "no change" MUST pass undefined, never ''.
  // (The on-connect rebroadcast in WebSocketContext passes `x || undefined`,
  // so it stays omission-based and can't clobber a stored value with an
  // incidental empty.) bio already worked this way. The global* slots use the
  // same `!== undefined` presence rule.
  const content = {
    type: 'update-profile' as const,
    senderId: senderAddress,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(userIcon !== undefined ? { userIcon } : {}),
    ...(bio !== undefined && { bio }),
    ...(globalDisplayName !== undefined ? { globalDisplayName } : {}),
    ...(globalUserIcon !== undefined ? { globalUserIcon } : {}),
    ...(globalBio !== undefined ? { globalBio } : {}),
    ...(farcasterFid !== undefined && farcasterFid > 0 ? { farcasterFid } : {}),
    ...(farcasterUsername ? { farcasterUsername } : {}),
  };

  // Cast: global* slots are additive and not yet in shared's UpdateProfileMessage
  // (additive shared PR pending, non-blocking). Wire-compatible: receivers read
  // them untyped. Matches the untyped-additive-field pattern used elsewhere.
  return sendGenericMessage({ spaceId, channelId, senderAddress, content: content as MessageContent });
}

// MMKV-backed gate that records the last profile-update payload broadcast
// to each (spaceId, senderAddress). The on-connect rebroadcast fires every
// time WebSocketContext mounts the connected effect (provider remount,
// auth change, reconnect), and the save-profile handlers fire whenever the
// user taps save — even when nothing changed. Recipients still apply the
// payload (the receive handler is upsert-aware), but every broadcast is a
// message on the wire that generates a push notification for every member
// of every space. This gate suppresses sends whose payload matches the
// most recent successful broadcast for that destination.
import { createMMKV, type MMKV } from 'react-native-mmkv';
let profileBroadcastStateStore: MMKV | null = null;
function getProfileBroadcastStore(): MMKV {
  if (!profileBroadcastStateStore) {
    profileBroadcastStateStore = createMMKV({ id: 'quorum-profile-broadcast' });
  }
  return profileBroadcastStateStore;
}

function profileBroadcastKey(spaceId: string, senderAddress: string): string {
  return `${senderAddress}:${spaceId}`;
}

// Canonical signature of the exact payload that will go on the wire.
// Field presence matters (avatar-only vs name-only sends have different
// signatures), and field values matter. Stable JSON: keys sorted.
function profileBroadcastSignature(p: SendUpdateProfileParams): string {
  const obj: Record<string, string> = {};
  // `!== undefined` (not truthy) so an explicit clear ('') produces a distinct
  // signature and isn't deduped away — matches the wire builder above.
  if (p.displayName !== undefined) obj.displayName = p.displayName;
  if (p.userIcon !== undefined) obj.userIcon = p.userIcon;
  if (p.bio !== undefined) obj.bio = p.bio;
  if (p.globalDisplayName !== undefined) obj.globalDisplayName = p.globalDisplayName;
  if (p.globalUserIcon !== undefined) obj.globalUserIcon = p.globalUserIcon;
  if (p.globalBio !== undefined) obj.globalBio = p.globalBio;
  if (p.farcasterFid !== undefined && p.farcasterFid > 0) {
    obj.farcasterFid = String(p.farcasterFid);
  }
  if (p.farcasterUsername) obj.farcasterUsername = p.farcasterUsername;
  const sortedKeys = Object.keys(obj).sort();
  return JSON.stringify(obj, sortedKeys);
}

/**
 * Same as sendUpdateProfileMessage, but skips when the exact payload was
 * already broadcast to this (spaceId, senderAddress). Returns null on skip.
 * Records the new signature only after a successful send so a failure
 * leaves the gate open for retry.
 */
export async function maybeSendUpdateProfileMessage(
  params: SendUpdateProfileParams
): Promise<SendGenericMessageResult | null> {
  const sig = profileBroadcastSignature(params);
  // Nothing to broadcast — empty payload would no-op on receivers anyway.
  if (sig === '{}') return null;

  const store = getProfileBroadcastStore();
  const key = profileBroadcastKey(params.spaceId, params.senderAddress);
  const last = store.getString(key);
  if (last === sig) return null;

  const result = await sendUpdateProfileMessage(params);
  store.set(key, sig);
  return result;
}

/** Clear the gate for a (spaceId, senderAddress) — used when the user
 *  leaves a space or signs out so a fresh rejoin re-broadcasts. */
export function clearProfileBroadcastState(spaceId: string, senderAddress: string): void {
  getProfileBroadcastStore().remove(profileBroadcastKey(spaceId, senderAddress));
}

/**
 * One-time migrations of the profile-broadcast cache. Each migration
 * tag is a string that gets recorded in MMKV once it runs; subsequent
 * launches see the tag and skip.
 *
 * Used today to force every device to re-broadcast its per-space
 * profile after we extended the update-profile shape with optional
 * farcasterFid / farcasterUsername. Existing devices have the old
 * payload signature stored, so without this clear, the gate would
 * suppress the new broadcast as "same as last time" — even though
 * the wire payload now carries the new Farcaster fields.
 *
 * Implementation: clearing the signature for every (sender, space)
 * lets the next normal rebroadcast pass through unconditionally and
 * record the new (richer) signature.
 */
const MIGRATIONS_KEY = '__migrations';

export function runProfileBroadcastMigrations(): void {
  const store = getProfileBroadcastStore();
  const raw = store.getString(MIGRATIONS_KEY);
  let done: Record<string, true> = {};
  if (raw) {
    try {
      done = JSON.parse(raw) as Record<string, true>;
    } catch {
      done = {};
    }
  }

  // Tag bumped whenever the update-profile wire shape gains a field.
  // Force a one-time re-broadcast on every device so peers learn the
  // new fields without the user having to manually re-save.
  const tag = 'add-farcaster-fields-v1';
  if (done[tag]) return;

  // Wipe every recorded signature. The next on-connect rebroadcast
  // sees an empty cache and fires for every space, then records the
  // new signatures (which include Farcaster fields when linked).
  for (const k of store.getAllKeys()) {
    if (k === MIGRATIONS_KEY) continue;
    store.remove(k);
  }

  done[tag] = true;
  store.set(MIGRATIONS_KEY, JSON.stringify(done));
}

// Embed Messages

export interface SendEmbedMessageParams {
  spaceId: string;
  channelId: string;
  senderAddress: string;
  imageUrl?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  width?: string;
  height?: string;
  repliesToMessageId?: string;
  /** Optional text to accompany the image */
  text?: string;
  /** Space roles/channels for resolving @role and #channel mentions in the
   *  caption (so an image caption that mentions someone still notifies). */
  spaceRoles?: Array<{ roleId: string; roleTag: string }>;
  spaceChannels?: Array<{ channelId: string; channelName: string }>;
  /** Sender may use @everyone (has mention:everyone) — gates @everyone in captions. */
  allowEveryone?: boolean;
  /** Skip signing (per-message lock); gated on space.isRepudiable by the caller. */
  skipSigning?: boolean;
}

/**
 * Split a base64 data URL ("data:<mime>;base64,<data>") into its mimeType and
 * raw base64 payload. Returns null if the input is not a base64 data URL
 * (e.g. a remote http(s) URL), in which case there is nothing to inline.
 */
function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/**
 * Send an image as a `post` + `embeddedMedia` (the converged cross-platform
 * shape — see .agents/tasks/2026-06-13-converge-image-caption-to-post-embeddedmedia.md).
 *
 * Desktop already emits this shape and mobile's renderer reads `embeddedMedia`
 * (toDisplayMessage). We stop emitting `type:'embed'` for sending; the embed
 * renderer stays for receiving old persisted `embed` messages.
 *
 * `imageUrl`/`thumbnailUrl` arrive as base64 data URLs; we inline the raw
 * base64 in `embeddedMedia[].data` exactly like desktop (thumbnail entry first
 * when present, then the full image, sharing one `key`).
 */
export async function sendEmbedMessage(
  params: SendEmbedMessageParams
): Promise<SendGenericMessageResult> {
  const {
    spaceId,
    channelId,
    senderAddress,
    imageUrl,
    thumbnailUrl,
    repliesToMessageId,
    text,
    spaceRoles,
    spaceChannels,
    allowEveryone,
    skipSigning,
  } = params;

  const content = buildPostWithEmbeddedMedia(senderAddress, imageUrl, thumbnailUrl, text, repliesToMessageId);
  return sendGenericMessage({
    spaceId,
    channelId,
    senderAddress,
    content,
    mentions: text ? extractMentionsFromText(text, { spaceRoles, spaceChannels, allowEveryone }) : undefined,
    skipSigning,
  });
}

/**
 * Build the `post` + `embeddedMedia` content from base64-data-URL image inputs.
 * Shared by the send path and the optimistic-update path so the local sender
 * and remote receiver render identically. Falls back to a plain `post` (no
 * media) if `imageUrl` is missing or not an inlinable data URL.
 */
export function buildPostWithEmbeddedMedia(
  senderAddress: string,
  imageUrl?: string,
  thumbnailUrl?: string,
  text?: string,
  repliesToMessageId?: string
): PostMessage {
  const embeddedMedia: NonNullable<PostMessage['embeddedMedia']> = [];
  const image = imageUrl ? parseDataUrl(imageUrl) : null;
  if (image) {
    // One shared key links the thumbnail to its full image (the large-GIF case).
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const thumb = thumbnailUrl ? parseDataUrl(thumbnailUrl) : null;
    // Only emit a thumbnail entry when it's DISTINCT from the full image.
    // Mobile's GIF processing sets thumbnailUrl === imageUrl (no separate static
    // frame is generated), so a thumbnail entry there would just duplicate the
    // full GIF bytes on the wire AND make receivers read it as a thumbnailed
    // "large GIF". Dropping the duplicate avoids the double payload and the
    // mis-classification. (GIF animation itself is a separate, pre-existing
    // render concern — see the GIF bug report.)
    if (thumb && thumb.data !== image.data) {
      embeddedMedia.push({ type: 'image-thumbnail', key, data: thumb.data, mimeType: thumb.mimeType });
    }
    embeddedMedia.push({ type: 'image', key, data: image.data, mimeType: image.mimeType });
  }

  const content: PostMessage = {
    type: 'post',
    senderId: senderAddress,
    text: text ?? '',
    ...(repliesToMessageId ? { repliesToMessageId } : {}),
    ...(embeddedMedia.length > 0 ? { embeddedMedia } : {}),
  };
  return content;
}

// Space Call Messages

export interface SendSpaceCallStartParams {
  spaceId: string;
  channelId: string;
  senderAddress: string;
  mediaType: 'audio' | 'video';
}

/**
 * Send a space-call-start message to a channel
 */
export async function sendSpaceCallStartMessage(
  params: SendSpaceCallStartParams
): Promise<SendGenericMessageResult> {
  const { spaceId, channelId, senderAddress, mediaType } = params;
  const callId = `${senderAddress}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const content: SpaceCallStartMessage = {
    type: 'space-call-start',
    senderId: senderAddress,
    callId,
    mediaType,
  };

  return sendGenericMessage({ spaceId, channelId, senderAddress, content });
}

export interface SendSpaceCallEndParams {
  spaceId: string;
  channelId: string;
  senderAddress: string;
  callId: string;
}

/**
 * Send a space-call-end message to a channel
 */
export async function sendSpaceCallEndMessage(
  params: SendSpaceCallEndParams
): Promise<SendGenericMessageResult> {
  const { spaceId, channelId, senderAddress, callId } = params;

  const content: SpaceCallEndMessage = {
    type: 'space-call-end',
    senderId: senderAddress,
    callId,
  };

  return sendGenericMessage({ spaceId, channelId, senderAddress, content });
}


// Space Manifest Control Messages

export interface SpaceManifest {
  space_address: string;
  space_manifest: string;
  ephemeral_public_key: string;
  timestamp: number;
  owner_public_key: string;
  owner_signature: string;
}

/**
 * Send a space-manifest control message to the hub
 * This broadcasts the updated space manifest to all space members
 * Matches desktop SpaceService.submitUpdateSpace behavior
 */
export async function sendSpaceManifestMessage(
  spaceId: string,
  manifest: SpaceManifest
): Promise<string> {
  const cryptoProvider = new NativeCryptoProvider();

  // Get hub key for the space
  const hubKey = getSpaceKey(spaceId, 'hub');
  if (!hubKey) {
    throw new Error('Hub key not found for space. Cannot send space manifest.');
  }
  if (!hubKey.address || !hubKey.privateKey || !hubKey.publicKey) {
    throw new Error('Hub key incomplete for space.');
  }

  // Get config key for hub envelope encryption
  const configKey = getSpaceKey(spaceId, 'config');

  // Create control message payload (matches desktop format)
  const controlMessage = {
    type: 'control',
    message: {
      type: 'space-manifest',
      manifest,
    },
  };

  const hubMessagePayload = JSON.stringify(controlMessage);

  // Seal the message for hub delivery
  const hubKeypair = {
    publicKey: hexToNumberArray(hubKey.publicKey),
    privateKey: hexToNumberArray(hubKey.privateKey),
  };

  const sealedMessage = await cryptoProvider.sealHubEnvelope(
    hubKey.address,
    hubKeypair,
    hubMessagePayload,
    configKey
      ? {
          publicKey: hexToNumberArray(configKey.publicKey),
          privateKey: hexToNumberArray(configKey.privateKey),
        }
      : undefined
  );

  const wsEnvelope = JSON.stringify({ type: 'log-append', ...sealedMessage });

  return wsEnvelope;
}
