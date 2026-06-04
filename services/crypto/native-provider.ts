/**
 * NativeCryptoProvider - Implements CryptoProvider using React Native native modules
 *
 * Uses the QuorumCrypto Expo module which wraps uniffi-generated bindings
 * to the Rust channel crate.
 */

// Import types from the shared library
// These types match the CryptoProvider interface
import type {
  CryptoProvider,
  Ed448Keypair,
  X448Keypair,
  SenderX3DHParams,
  ReceiverX3DHParams,
  NewDoubleRatchetParams,
  DoubleRatchetStateAndMessage,
  DoubleRatchetStateAndEnvelope,
  NewTripleRatchetParams,
  TripleRatchetStateAndMetadata,
  TripleRatchetStateAndMessage,
  TripleRatchetStateAndEnvelope,
  InboxMessageEncryptRequest,
  InboxMessageDecryptRequest,
} from '@quilibrium/quorum-shared';

import { arrayToBase64, base64ToArray, base64ToHex } from '@/utils/encoding';
import QuorumCrypto from '../../modules/quorum-crypto/src';
import { sha512 as nobleSha512 } from '@noble/hashes/sha2.js';
import { logger } from '@quilibrium/quorum-shared';
/**
 * DecryptionError - A silent error for expected decryption failures
 *
 * In multi-device scenarios, devices receive messages encrypted for other devices.
 * These decryption failures are expected and shouldn't be logged as errors.
 * This custom error class allows callers to identify and handle these silently.
 */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

// Fields that should remain as strings even if they contain JSON
// These are used by Double/Triple Ratchet operations where the state must stay serialized
const KEEP_AS_STRING_FIELDS = new Set(['ratchet_state', 'envelope']);

/**
 * Parse native result and check for errors
 * Handles nested JSON encoding where inner values are JSON strings
 */
function parseNativeResult<T>(result: string): T {
  // Fast-path error check (only check short strings for error patterns)
  if (result.length < 200 && (
    result.startsWith('invalid') ||
    result.startsWith('error') ||
    result.includes('failed') ||
    result.includes('Error')
  )) {
    throw new Error(result);
  }

  // Try standard JSON parsing first (hot path)
  try {
    const parsed = JSON.parse(result);

    // Only transform if it's a plain object (not array, not primitive)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      let needsTransform = false;
      // Quick check: does any non-kept value look like JSON?
      for (const [key, value] of Object.entries(parsed)) {
        if (!KEEP_AS_STRING_FIELDS.has(key) && typeof value === 'string' && value.length > 0 && (value.charCodeAt(0) === 123 || value.charCodeAt(0) === 91)) {
          needsTransform = true;
          break;
        }
      }

      if (!needsTransform) return parsed as T;

      const transformed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (KEEP_AS_STRING_FIELDS.has(key)) {
          transformed[key] = value;
        } else if (typeof value === 'string' && value.length > 0 && (value.charCodeAt(0) === 123 || value.charCodeAt(0) === 91)) {
          try {
            transformed[key] = JSON.parse(value);
          } catch {
            transformed[key] = value;
          }
        } else {
          transformed[key] = value;
        }
      }
      return transformed as T;
    }

    return parsed as T;
  } catch {
    const extractedResult = tryExtractNestedJson(result);
    if (extractedResult !== null) {
      return extractedResult as T;
    }

    if (result.startsWith('"') && result.endsWith('"')) {
      return result.slice(1, -1) as unknown as T;
    }
    throw new Error(`Failed to parse native result: ${result}`);
  }
}

/**
 * Try to extract nested JSON from malformed native results
 * Handles the case where inner JSON objects are not properly escaped
 */
function tryExtractNestedJson(result: string): Record<string, unknown> | null {
  // Match pattern like {"ratchet_state":"{...}","envelope":"{...}"}
  // where the inner JSON is not escaped

  if (!result.startsWith('{') || !result.endsWith('}')) {
    return null;
  }

  try {
    const extracted: Record<string, unknown> = {};

    // Find all key-value pairs where value is an unescaped JSON object
    // Pattern: "key":"{ or "key":"[
    const keyPattern = /"(\w+)":"(\{|\[)/g;
    let match;
    const keys: { key: string; start: number; isObject: boolean }[] = [];

    while ((match = keyPattern.exec(result)) !== null) {
      keys.push({
        key: match[1],
        start: match.index + match[0].length - 1, // Position of { or [
        isObject: match[2] === '{',
      });
    }

    // For each key, find the matching closing brace
    for (let i = 0; i < keys.length; i++) {
      const { key, start, isObject } = keys[i];
      const openBrace = isObject ? '{' : '[';
      const closeBrace = isObject ? '}' : ']';

      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = start;

      for (let j = start; j < result.length; j++) {
        const char = result[j];

        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === '\\') {
          escaped = true;
          continue;
        }

        if (char === '"' && !escaped) {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === openBrace) {
            depth++;
          } else if (char === closeBrace) {
            depth--;
            if (depth === 0) {
              end = j;
              break;
            }
          }
        }
      }

      if (end > start) {
        const jsonStr = result.slice(start, end + 1);
        // Keep ratchet_state and envelope as strings, parse others
        if (KEEP_AS_STRING_FIELDS.has(key)) {
          extracted[key] = jsonStr;
        } else {
          try {
            extracted[key] = JSON.parse(jsonStr);
          } catch {
            extracted[key] = jsonStr;
          }
        }
      }
    }

    return Object.keys(extracted).length > 0 ? extracted : null;
  } catch {
    return null;
  }
}

/**
 * Parse double ratchet results, keeping ratchet_state and envelope as strings
 */
function parseDoubleRatchetResult(result: string): DoubleRatchetStateAndEnvelope {
  if (!result.startsWith('{') || !result.endsWith('}')) {
    throw new Error(`Invalid double ratchet result format: ${result.substring(0, 100)}`);
  }

  // The native module now returns properly escaped JSON, so use JSON.parse directly
  try {
    const parsed = JSON.parse(result) as { ratchet_state: string; envelope: string };

    if (typeof parsed.ratchet_state !== 'string') {
      throw new Error('ratchet_state is not a string');
    }
    if (typeof parsed.envelope !== 'string') {
      throw new Error('envelope is not a string');
    }

    return {
      ratchet_state: parsed.ratchet_state,
      envelope: parsed.envelope,
    };
  } catch (e) {
    throw new Error(`Failed to parse double ratchet result: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Result type for double ratchet decrypt that can indicate failure without throwing
 */
type DecryptResult =
  | { success: true; data: DoubleRatchetStateAndMessage }
  | { success: false; error: string };

/**
 * Parse double ratchet decrypt results, keeping ratchet_state as string
 * Returns a result object instead of throwing to avoid React Native error logging
 */
function parseDoubleRatchetDecryptResult(result: string): DecryptResult {
  if (!result.startsWith('{') || !result.endsWith('}')) {
    return { success: false, error: `Invalid double ratchet decrypt result format: ${result.substring(0, 100)}` };
  }

  try {
    // The native module now emits `message` as a base64 string instead
    // of a JSON int array. For a 1MB plaintext this avoids JSON.parse
    // building a million boxed Numbers + a separate Uint8Array — both
    // were heavy on the JS heap during decrypt batches.
    const parsed = JSON.parse(result) as {
      ratchet_state: string;
      message: string | number[];
    };

    if (typeof parsed.ratchet_state !== 'string') {
      return { success: false, error: 'ratchet_state is not a string' };
    }

    let messageBytes: number[];
    if (typeof parsed.message === 'string') {
      // Base64-decode to a Uint8Array, then convert to number[] which is
      // the public DoubleRatchetStateAndMessage shape callers expect.
      const decoded = base64ToBytes(parsed.message);
      messageBytes = Array.from(decoded);
    } else if (Array.isArray(parsed.message)) {
      messageBytes = parsed.message;
    } else {
      return { success: false, error: 'message is neither string nor array' };
    }

    // Check if the message is actually an error from the Rust layer.
    // The Rust code can return errors as the message content (byte array).
    if (messageBytes.length > 0) {
      const messageStr = new TextDecoder().decode(new Uint8Array(messageBytes));
      if (messageStr.startsWith('Decryption failed:') ||
          messageStr.startsWith('invalid') ||
          messageStr.includes('aead::Error')) {
        return { success: false, error: `Double ratchet decryption error: ${messageStr}` };
      }
    }

    return {
      success: true,
      data: {
        ratchet_state: parsed.ratchet_state,
        message: messageBytes,
      },
    };
  } catch (e) {
    return { success: false, error: `Failed to parse double ratchet decrypt result: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Base64 → Uint8Array. Uses the global atob (available on RN's Hermes
 *  via the `react-native-quick-base64` polyfill registered at app init)
 *  with a fallback that hand-rolls the decode if atob isn't present. */
function base64ToBytes(b64: string): Uint8Array {
  // atob is available in Hermes and most JS runtimes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const atobFn = (globalThis as any).atob as ((s: string) => string) | undefined;
  if (atobFn) {
    const bin = atobFn(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Buffer fallback — present in the Node-style polyfills RN ships.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const BufferImpl = (globalThis as any).Buffer;
  if (BufferImpl) {
    return new Uint8Array(BufferImpl.from(b64, 'base64'));
  }
  throw new Error('No base64 decoder available in this JS runtime');
}

/**
 * NativeCryptoProvider - Implements CryptoProvider using QuorumCrypto native module
 */
export class NativeCryptoProvider implements CryptoProvider {
  // Key Generation

  async generateX448(): Promise<X448Keypair> {
    const result = await QuorumCrypto.generateX448();
    const keypair = parseNativeResult<{ public_key: number[]; private_key: number[] }>(result);
    return {
      type: 'x448',
      public_key: keypair.public_key,
      private_key: keypair.private_key,
    };
  }

  async generateEd448(): Promise<Ed448Keypair> {
    const result = await QuorumCrypto.generateEd448();
    const keypair = parseNativeResult<{ public_key: number[]; private_key: number[] }>(result);
    return {
      type: 'ed448',
      public_key: keypair.public_key,
      private_key: keypair.private_key,
    };
  }

  async getPublicKeyX448(privateKey: string): Promise<string> {
    const result = await QuorumCrypto.getPublicKeyX448(privateKey);
    // Check for errors
    if (result.startsWith('invalid') || result.includes('error')) {
      throw new Error(result);
    }
    // The Rust function returns a JSON-encoded base64 string
    try {
      return JSON.parse(result) as string;
    } catch {
      return result;
    }
  }

  async getPublicKeyEd448(privateKey: string): Promise<string> {
    const result = await QuorumCrypto.getPublicKeyEd448(privateKey);
    // Check for errors
    if (result.startsWith('invalid') || result.includes('error')) {
      throw new Error(result);
    }
    // The Rust function returns a JSON-encoded base64 string
    try {
      return JSON.parse(result) as string;
    } catch {
      return result;
    }
  }

  /**
   * Sign a message with Ed448
   * @param privateKey - Base64 encoded private key
   * @param message - Base64 encoded message to sign
   * @returns Base64 encoded signature
   */
  async signEd448(privateKey: string, message: string): Promise<string> {
    const result = await QuorumCrypto.signEd448(privateKey, message);
    // Check for errors
    if (result.startsWith('invalid') || result.includes('error')) {
      throw new Error(result);
    }
    // The Rust function returns a JSON-encoded base64 string (like `"SGVsbG8="`)
    // We need to JSON.parse to get the actual base64 value
    try {
      return JSON.parse(result) as string;
    } catch {
      // If JSON parsing fails, maybe it's already raw base64, return as-is
      return result;
    }
  }

  // X3DH Key Agreement

  async senderX3DH(params: SenderX3DHParams): Promise<string> {
    const input = JSON.stringify({
      sending_identity_private_key: params.sending_identity_private_key,
      sending_ephemeral_private_key: params.sending_ephemeral_private_key,
      receiving_identity_key: params.receiving_identity_key,
      receiving_signed_pre_key: params.receiving_signed_pre_key,
      session_key_length: params.session_key_length,
    });
    const result = await QuorumCrypto.senderX3dh(input);
    if (result.startsWith('invalid') || result.includes('error')) {
      throw new Error(result);
    }
    return result;
  }

  async receiverX3DH(params: ReceiverX3DHParams): Promise<string> {
    const input = JSON.stringify({
      sending_identity_private_key: params.sending_identity_private_key,
      sending_signed_private_key: params.sending_signed_private_key,
      receiving_identity_key: params.receiving_identity_key,
      receiving_ephemeral_key: params.receiving_ephemeral_key,
      session_key_length: params.session_key_length,
    });
    const result = await QuorumCrypto.receiverX3dh(input);
    if (result.startsWith('invalid') || result.includes('error')) {
      throw new Error(result);
    }
    return result;
  }

  // Double Ratchet

  async newDoubleRatchet(params: NewDoubleRatchetParams): Promise<string> {
    const input = JSON.stringify({
      session_key: params.session_key,
      sending_header_key: params.sending_header_key,
      next_receiving_header_key: params.next_receiving_header_key,
      is_sender: params.is_sender,
      sending_ephemeral_private_key: params.sending_ephemeral_private_key,
      receiving_ephemeral_key: params.receiving_ephemeral_key,
    });
    const result = await QuorumCrypto.newDoubleRatchet(input);
    if (result.startsWith('invalid') || result.includes('error')) {
      throw new Error(result);
    }
    return result;
  }

  async doubleRatchetEncrypt(
    stateAndMessage: DoubleRatchetStateAndMessage
  ): Promise<DoubleRatchetStateAndEnvelope> {
    // The native module expects ratchet_state to be a STRING (JSON-encoded)
    // When we JSON.stringify the whole input, the ratchet_state gets double-encoded
    // This is the expected format based on desktop SDK behavior
    const input = JSON.stringify({
      ratchet_state: stateAndMessage.ratchet_state,
      message: stateAndMessage.message,
    });
    const result = await QuorumCrypto.doubleRatchetEncrypt(input);
    // Use special parsing that keeps ratchet_state and envelope as strings
    const parsed = parseDoubleRatchetResult(result);
    return parsed;
  }

  async doubleRatchetDecrypt(
    stateAndEnvelope: DoubleRatchetStateAndEnvelope
  ): Promise<DoubleRatchetStateAndMessage> {
    // The native module expects ratchet_state to be a STRING (JSON-encoded)
    // When we JSON.stringify the whole input, the ratchet_state gets double-encoded
    // This is the expected format based on desktop SDK behavior
    const input = JSON.stringify({
      ratchet_state: stateAndEnvelope.ratchet_state,
      envelope: stateAndEnvelope.envelope,
    });
    const result = await QuorumCrypto.doubleRatchetDecrypt(input);
    // Use special parsing that keeps ratchet_state as string
    // Returns a result object to avoid throwing errors for expected failures
    const parsed = parseDoubleRatchetDecryptResult(result);
    if (!parsed.success) {
      // Return a special result that indicates decryption failure
      // Callers should check for this instead of catching exceptions
      return {
        ratchet_state: stateAndEnvelope.ratchet_state, // Return original state unchanged
        message: [], // Empty message indicates failure
        decryptionError: parsed.error, // Include error message for logging
      } as DoubleRatchetStateAndMessage & { decryptionError?: string };
    }
    return parsed.data;
  }

  // Triple Ratchet

  async newTripleRatchet(params: NewTripleRatchetParams): Promise<TripleRatchetStateAndMetadata> {
    const input = JSON.stringify({
      peers: params.peers,
      peer_key: params.peer_key,
      identity_key: params.identity_key,
      signed_pre_key: params.signed_pre_key,
      threshold: params.threshold,
      async_dkg_ratchet: params.async_dkg_ratchet,
    });
    const result = await QuorumCrypto.newTripleRatchet(input);
    return parseNativeResult<TripleRatchetStateAndMetadata>(result);
  }

  async tripleRatchetInitRound1(
    state: TripleRatchetStateAndMetadata
  ): Promise<TripleRatchetStateAndMetadata> {
    const input = JSON.stringify(state);
    const result = await QuorumCrypto.tripleRatchetInitRound1(input);
    return parseNativeResult<TripleRatchetStateAndMetadata>(result);
  }

  async tripleRatchetInitRound2(
    state: TripleRatchetStateAndMetadata
  ): Promise<TripleRatchetStateAndMetadata> {
    const input = JSON.stringify(state);
    const result = await QuorumCrypto.tripleRatchetInitRound2(input);
    return parseNativeResult<TripleRatchetStateAndMetadata>(result);
  }

  async tripleRatchetInitRound3(
    state: TripleRatchetStateAndMetadata
  ): Promise<TripleRatchetStateAndMetadata> {
    const input = JSON.stringify(state);
    const result = await QuorumCrypto.tripleRatchetInitRound3(input);
    return parseNativeResult<TripleRatchetStateAndMetadata>(result);
  }

  async tripleRatchetInitRound4(
    state: TripleRatchetStateAndMetadata
  ): Promise<TripleRatchetStateAndMetadata> {
    const input = JSON.stringify(state);
    const result = await QuorumCrypto.tripleRatchetInitRound4(input);
    return parseNativeResult<TripleRatchetStateAndMetadata>(result);
  }

  async tripleRatchetEncrypt(
    stateAndMessage: TripleRatchetStateAndMessage
  ): Promise<TripleRatchetStateAndEnvelope> {
    const input = JSON.stringify({
      ratchet_state: stateAndMessage.ratchet_state,
      message: stateAndMessage.message,
    });
    const result = await QuorumCrypto.tripleRatchetEncrypt(input);
    return parseNativeResult<TripleRatchetStateAndEnvelope>(result);
  }

  async tripleRatchetDecrypt(
    stateAndEnvelope: TripleRatchetStateAndEnvelope
  ): Promise<TripleRatchetStateAndMessage> {
    const input = JSON.stringify({
      ratchet_state: stateAndEnvelope.ratchet_state,
      envelope: stateAndEnvelope.envelope,
    });
    const result = await QuorumCrypto.tripleRatchetDecrypt(input);
    // Native side now emits `message` as a base64 string (same shape
    // as doubleRatchetDecrypt). Decode here so callers continue to
    // see `number[]`.
    const parsed = JSON.parse(result) as {
      ratchet_state: string;
      message: string | number[];
    };
    const messageBytes: number[] =
      typeof parsed.message === 'string'
        ? Array.from(base64ToBytes(parsed.message))
        : (parsed.message as number[]);
    return {
      ratchet_state: parsed.ratchet_state,
      message: messageBytes,
    } as TripleRatchetStateAndMessage;
  }

  async tripleRatchetResize(
    _state: TripleRatchetStateAndMetadata
  ): Promise<TripleRatchetStateAndMetadata> {
    throw new Error('tripleRatchetResize not yet implemented; use tripleRatchetResizeForInvites');
  }

  /**
   * Resize the triple ratchet to generate invite evals pool
   *
   * @param ratchetState - The current ratchet state (JSON string)
   * @param other - The other party's scalar (hex string)
   * @param id - The starting ID for evals
   * @param total - The total number of evals to generate
   * @returns Array of eval byte arrays (each eval is a number[])
   */
  async tripleRatchetResizeForInvites(
    ratchetState: string,
    other: string,
    id: number,
    total: number
  ): Promise<number[][]> {
    const input = JSON.stringify({
      ratchet_state: ratchetState,
      other: other,
      id: id,
      total: total,
    });
    const result = await QuorumCrypto.tripleRatchetResize(input);
    // Native side returns a JSON array of base64-encoded byte arrays
    // (one per eval). Decode each to number[] to preserve the public
    // signature.
    const parsed = JSON.parse(result) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).map((entry) => {
      if (typeof entry === 'string') {
        return Array.from(base64ToBytes(entry));
      }
      if (Array.isArray(entry)) {
        // Legacy int-array shape — kept just in case older native code
        // is in the build during a transition.
        return entry as number[];
      }
      return [];
    });
  }

  // Inbox Message Encryption

  async encryptInboxMessage(request: InboxMessageEncryptRequest): Promise<string> {
    const input = JSON.stringify({
      inbox_public_key: request.inbox_public_key,
      ephemeral_private_key: request.ephemeral_private_key,
      plaintext: request.plaintext,
    });
    const result = await QuorumCrypto.encryptInboxMessage(input);
    if (result.startsWith('invalid') || result.includes('error')) {
      throw new Error(result);
    }
    return result;
  }

  async decryptInboxMessage(request: InboxMessageDecryptRequest): Promise<number[]> {
    const input = JSON.stringify({
      inbox_private_key: request.inbox_private_key,
      ephemeral_public_key: request.ephemeral_public_key,
      ciphertext: request.ciphertext,
    });
    const result = await QuorumCrypto.decryptInboxMessage(input);
    // Rust returns the decrypted bytes on success. Two formats exist
    // in the wild depending on the binding's build vintage: a base64
    // string (newer iOS .a, smaller wire size) or a JSON-int-array
    // (older Android .so). Errors come back as plain-text strings.
    // Discriminate structurally: a `[` prefix is the int-array form,
    // the base64 alphabet is the base64 form, anything else is an
    // error message.
    if (result.length > 0 && result.charCodeAt(0) === 91 /* '[' */) {
      try {
        return JSON.parse(result) as number[];
      } catch {
        throw new Error(result);
      }
    }
    if (/^[A-Za-z0-9+/]*={0,2}$/.test(result)) {
      return Array.from(base64ToBytes(result));
    }
    throw new Error(result);
  }

  // Inbox Envelope Sealing

  /**
   * Seal an inbox envelope for a specific recipient
   *
   * This encrypts a message to a recipient's X448 public key so only they can decrypt it.
   * Used for rekey operations where sensitive state needs to be sent to specific members.
   *
   * @param recipientPubKeyBase64 - The recipient's X448 public key (base64)
   * @param message - The plaintext message to encrypt
   * @returns InboxSealedEnvelope ready for transmission
   */
  async sealInboxEnvelope(
    recipientPubKeyBase64: string,
    message: string
  ): Promise<InboxSealedEnvelope> {
    // 1. Generate ephemeral X448 keypair
    const ephemeralKeypair = await this.generateX448();

    // 2. Convert recipient public key from base64 to number array
    const recipientPubKey = base64ToArray(recipientPubKeyBase64);

    // 3. Encrypt message using inbox encryption
    const messageBytes = new TextEncoder().encode(message);
    const encryptedEnvelope = await this.encryptInboxMessage({
      inbox_public_key: recipientPubKey,
      ephemeral_private_key: ephemeralKeypair.private_key,
      plaintext: Array.from(messageBytes),
    });

    // 4. Build and return the sealed envelope
    return {
      inbox_public_key: base64ToHex(recipientPubKeyBase64),
      ephemeral_public_key: arrayToHex(ephemeralKeypair.public_key),
      envelope: encryptedEnvelope,
    };
  }

  /**
   * Unseal an inbox envelope using the recipient's private key
   *
   * @param recipientPrivKey - The recipient's X448 private key (number array)
   * @param envelope - The sealed envelope to decrypt
   * @returns Decrypted plaintext as string
   */
  async unsealInboxEnvelope(
    recipientPrivKey: number[],
    envelope: InboxSealedEnvelope
  ): Promise<string> {
    // 1. Parse ephemeral public key from hex
    const ephemeralPublicKey = hexToArray(envelope.ephemeral_public_key);

    // 2. Parse encrypted envelope
    const ciphertext = JSON.parse(envelope.envelope) as {
      ciphertext: string;
      initialization_vector: string;
      associated_data?: string;
    };

    // 3. Decrypt using inbox decryption
    const decryptedBytes = await this.decryptInboxMessage({
      inbox_private_key: recipientPrivKey,
      ephemeral_public_key: ephemeralPublicKey,
      ciphertext,
    });

    // 4. Convert to string
    return new TextDecoder().decode(new Uint8Array(decryptedBytes));
  }

  // Hub Envelope Sealing

  /**
   * Seal a message for hub delivery
   *
   * This creates a HubSealedMessage that can be sent via postHub API:
   * 1. Derives X448 public key from Ed448 private key via SHA-512
   * 2. Generates ephemeral X448 keypair
   * 3. Encrypts message using inbox encryption (sealed sender)
   * 4. Signs the envelope with the hub Ed448 key
   *
   * @param hubAddress - The hub address
   * @param hubKeypair - The Ed448 keypair for the hub
   * @param message - The plaintext message to seal
   * @returns HubSealedMessage ready for API transmission
   */
  async sealHubEnvelope(
    hubAddress: string,
    hubKeypair: { publicKey: number[]; privateKey: number[] },
    message: string,
    configKey?: { publicKey: number[]; privateKey: number[] }
  ): Promise<HubSealedMessage> {
    // Use config key for encryption if provided, otherwise derive from hub key for backwards compatibility
    let x448PublicKey: number[];

    if (configKey) {
      // Use config key directly for encryption
      x448PublicKey = configKey.publicKey;
    } else {
      // Legacy: Derive X448 public key from Ed448 private key via SHA-512
      // The X448 key is derived from first 56 bytes of SHA-512(ed448_private_key)
      const privateKeyBytes = new Uint8Array(hubKeypair.privateKey);
      const sha512Hash = this.sha512(privateKeyBytes);
      const x448PrivateKeyBytes = sha512Hash.slice(0, 56);

      // Get X448 public key from the derived private key
      const x448PrivateKeyBase64 = arrayToBase64(Array.from(x448PrivateKeyBytes));
      const x448PublicKeyBase64Result = await QuorumCrypto.getPublicKeyX448(x448PrivateKeyBase64);
      const x448PublicKeyBase64 = parseNativeResult<string>(x448PublicKeyBase64Result);
      x448PublicKey = base64ToArray(x448PublicKeyBase64);
    }

    // 2. Generate ephemeral X448 keypair
    const ephemeralKeypair = await this.generateX448();

    // 3. Encrypt message using inbox encryption
    const messageBytes = new TextEncoder().encode(message);
    const encryptedEnvelope = await this.encryptInboxMessage({
      inbox_public_key: x448PublicKey,
      ephemeral_private_key: ephemeralKeypair.private_key,
      plaintext: Array.from(messageBytes),
    });

    // 4. Sign the encrypted envelope with Ed448 key
    const hubPrivateKeyBase64 = arrayToBase64(hubKeypair.privateKey);
    const envelopeBase64 = btoa(encryptedEnvelope);
    const signatureBase64 = await this.signEd448(hubPrivateKeyBase64, envelopeBase64);
    const signatureHex = base64ToHex(signatureBase64);

    // 5. Build and return HubSealedMessage
    return {
      hub_address: hubAddress,
      hub_public_key: arrayToHex(hubKeypair.publicKey),
      ephemeral_public_key: arrayToHex(ephemeralKeypair.public_key),
      envelope: encryptedEnvelope,
      hub_signature: signatureHex,
    };
  }

  /**
   * Compute SHA-512 hash
   */
  private sha512(data: Uint8Array): Uint8Array {
    return nobleSha512(data);
  }

  /**
   * Seal a sync envelope for directed delivery to a specific inbox
   *
   * Unlike sealHubEnvelope (broadcast), this creates a message directed to a specific inbox
   * and includes owner authentication for verification.
   *
   * Uses the config key (X448) for encryption if provided, which ensures kicked users
   * cannot decrypt sync messages after their removal from the space.
   */
  async sealSyncEnvelope(
    inboxAddress: string,
    hubAddress: string,
    hubKeypair: { publicKey: number[]; privateKey: number[] },
    ownerKeypair: { publicKey: number[]; privateKey: number[] },
    message: string,
    configPublicKey?: number[]
  ): Promise<SyncSealedMessage> {
    // Use config key if provided, otherwise fall back to hub-derived key (legacy)
    let x448PublicKey: number[];
    if (configPublicKey) {
      x448PublicKey = configPublicKey;
    } else {
      // Legacy: Derive X448 public key from hub Ed448 private key via SHA-512
      const hubPrivateKeyBytes = new Uint8Array(hubKeypair.privateKey);
      const sha512Hash = this.sha512(hubPrivateKeyBytes);
      const x448PrivateKeyBytes = sha512Hash.slice(0, 56);

      // Get X448 public key from the derived private key
      const x448PrivateKeyBase64 = arrayToBase64(Array.from(x448PrivateKeyBytes));
      const x448PublicKeyBase64Result = await QuorumCrypto.getPublicKeyX448(x448PrivateKeyBase64);
      const x448PublicKeyBase64 = parseNativeResult<string>(x448PublicKeyBase64Result);
      x448PublicKey = base64ToArray(x448PublicKeyBase64);
    }

    // 2. Generate ephemeral X448 keypair
    const ephemeralKeypair = await this.generateX448();

    // 3. Encrypt message using inbox encryption
    const messageBytes = new TextEncoder().encode(message);
    const encryptedEnvelope = await this.encryptInboxMessage({
      inbox_public_key: x448PublicKey,
      ephemeral_private_key: ephemeralKeypair.private_key,
      plaintext: Array.from(messageBytes),
    });

    // 4. Sign the encrypted envelope with owner Ed448 key
    // The envelope is a JSON string - encode as UTF-8 bytes then to base64 (matches desktop)
    const ownerPrivateKeyBase64 = arrayToBase64(ownerKeypair.privateKey);
    const envelopeBytes = new TextEncoder().encode(encryptedEnvelope);
    const envelopeBase64 = arrayToBase64(Array.from(envelopeBytes));
    const signatureBase64 = await this.signEd448(ownerPrivateKeyBase64, envelopeBase64);
    const signatureHex = base64ToHex(signatureBase64);

    // 5. Build and return SyncSealedMessage
    return {
      inbox_address: inboxAddress,
      hub_address: hubAddress,
      owner_public_key: arrayToHex(ownerKeypair.publicKey),
      ephemeral_public_key: arrayToHex(ephemeralKeypair.public_key),
      envelope: encryptedEnvelope,
      owner_signature: signatureHex,
    };
  }

  // Hub Envelope Unsealing

  /**
   * Unseal a hub message received from WebSocket
   *
   * This decrypts a HubSealedMessage that was sent via the hub:
   * 1. Derives X448 private key from Ed448 private key via SHA-512
   * 2. Decrypts the envelope using inbox decryption
   *
   * @param hubPrivateKey - The Ed448 private key bytes for the hub
   * @param ephemeralPublicKey - The sender's ephemeral X448 public key (hex)
   * @param encryptedEnvelope - The encrypted envelope (JSON MessageCiphertext)
   * @returns Decrypted plaintext as string
   */
  async unsealHubEnvelope(
    hubPrivateKey: number[],
    ephemeralPublicKeyHex: string,
    encryptedEnvelope: string,
    configPrivateKey?: number[]
  ): Promise<string> {
    // Use config key for decryption if provided, otherwise derive from hub key for backwards compatibility
    let x448PrivateKey: number[];

    if (configPrivateKey) {
      // Use config key directly for decryption
      x448PrivateKey = configPrivateKey;
    } else {
      // Legacy: Derive X448 private key from Ed448 private key via SHA-512
      const privateKeyBytes = new Uint8Array(hubPrivateKey);
      const sha512Hash = this.sha512(privateKeyBytes);
      x448PrivateKey = Array.from(sha512Hash.slice(0, 56));
    }

    // 2. Parse ephemeral public key from hex
    const ephemeralPublicKey = hexToArray(ephemeralPublicKeyHex);

    // 3. Parse encrypted envelope
    const ciphertext = JSON.parse(encryptedEnvelope) as {
      ciphertext: string;
      initialization_vector: string;
      associated_data?: string;
    };

    // 4. Decrypt using inbox decryption
    const decryptedBytes = await this.decryptInboxMessage({
      inbox_private_key: x448PrivateKey,
      ephemeral_public_key: ephemeralPublicKey,
      ciphertext,
    });

    // 5. Convert to string
    return new TextDecoder().decode(new Uint8Array(decryptedBytes));
  }

  // Sync Envelope Unsealing

  /**
   * Unseal a sync envelope received from WebSocket
   *
   * This decrypts a SyncSealedMessage that was sent via directed delivery:
   * 1. Uses config key if provided, otherwise derives X448 private key from Ed448 private key via SHA-512
   * 2. Decrypts the envelope using inbox decryption
   *
   * Note: The encryption is the same as hub envelopes - the difference is
   * in the outer message structure (owner signature vs hub signature).
   *
   * @param hubPrivateKey - The Ed448 private key bytes for the hub
   * @param syncEnvelope - The sync sealed message
   * @param configPrivateKey - Optional X448 config private key for decryption (preferred over hub-derived key)
   * @returns Decrypted plaintext as string
   */
  async unsealSyncEnvelope(
    hubPrivateKey: number[],
    syncEnvelope: SyncSealedMessage,
    configPrivateKey?: number[]
  ): Promise<string> {
    // 1. Use config key if provided, otherwise derive X448 private key from Ed448 private key via SHA-512
    let x448PrivateKey: number[];
    if (configPrivateKey) {
      x448PrivateKey = configPrivateKey;
    } else {
      // Legacy: Derive X448 private key from Ed448 private key via SHA-512
      const privateKeyBytes = new Uint8Array(hubPrivateKey);
      const sha512Hash = this.sha512(privateKeyBytes);
      x448PrivateKey = Array.from(sha512Hash.slice(0, 56));
    }

    // 2. Parse ephemeral public key from hex
    const ephemeralPublicKey = hexToArray(syncEnvelope.ephemeral_public_key);

    // 3. Parse encrypted envelope
    const ciphertext = JSON.parse(syncEnvelope.envelope) as {
      ciphertext: string;
      initialization_vector: string;
      associated_data?: string;
    };

    // 4. Decrypt using inbox decryption
    const decryptedBytes = await this.decryptInboxMessage({
      inbox_private_key: x448PrivateKey,
      ephemeral_public_key: ephemeralPublicKey,
      ciphertext,
    });

    // 5. Convert to string
    return new TextDecoder().decode(new Uint8Array(decryptedBytes));
  }

  // Batch Operations

  /**
   * Batch unseal multiple hub/sync envelopes in a single native call.
   * This eliminates N JS-native bridge crossings for N messages.
   *
   * Key derivation (SHA-512 of hub key → X448, or use config key) is done
   * once natively for the entire batch.
   *
   * @param hubPrivateKey - Ed448 private key bytes for the hub
   * @param messages - Array of {ephemeral_public_key (hex), envelope (JSON ciphertext string)}
   * @param configPrivateKey - Optional X448 config private key (preferred over hub-derived)
   * @returns Array of results, each either {plaintext} or {error}
   */
  async batchUnsealEnvelopes(
    hubPrivateKey: number[],
    messages: { ephemeral_public_key: string; envelope: string }[],
    configPrivateKey?: number[]
  ): Promise<({ plaintext: string } | { error: string })[]> {
    if (messages.length === 0) return [];

    type UnsealResult = { plaintext: string } | { error: string };

    // Chunk the batch so a large reconnect-catchup doesn't hand
    // Android's org.json a multi-MB tree to tokenize on the input side
    // (it eagerly boxes the whole tree into primitives and OOMs the JVM
    // heap — the same reason batchProcessMessages chunks). The native
    // side independently caps the *output* size. Results are
    // concatenated in message order, so the caller's index→entry
    // alignment is preserved across chunks.
    const MAX_BATCH_JSON_BYTES = 1_500_000;

    const callChunk = async (chunk: typeof messages): Promise<UnsealResult[]> => {
      const input = JSON.stringify({
        hub_private_key: hubPrivateKey,
        config_private_key: configPrivateKey ?? null,
        messages: chunk.map(m => ({
          ephemeral_public_key: m.ephemeral_public_key,
          envelope: m.envelope,
        })),
      });
      const result = await QuorumCrypto.batchUnsealEnvelopes(input);
      const parsed = JSON.parse(result) as { results?: UnsealResult[] };
      return parsed.results ?? [];
    };

    const out: UnsealResult[] = [];
    let chunk: typeof messages = [];
    let chunkBytes = 0;
    const flush = async () => {
      if (chunk.length === 0) return;
      out.push(...(await callChunk(chunk)));
      chunk = [];
      chunkBytes = 0;
    };
    for (const m of messages) {
      // Approximate this message's contribution to the input JSON.
      const size = m.ephemeral_public_key.length + m.envelope.length + 64;
      // Keep at least one message per chunk even if it alone exceeds the
      // cap (a single oversized envelope still parses fine; only the
      // accumulated tree is the risk).
      if (chunk.length > 0 && chunkBytes + size > MAX_BATCH_JSON_BYTES) {
        await flush();
      }
      chunk.push(m);
      chunkBytes += size;
    }
    await flush();
    return out;
  }

  // Batch Process Messages

  /**
   * Process an entire batch of messages in a single native call.
   * Handles unseal + TR/DR decrypt for all messages.
   * 1 bridge crossing per batch regardless of batch size.
   */
  async batchProcessMessages(input: BatchProcessInput): Promise<BatchProcessOutput> {
    // Chunk inputs > 1.5MB across native calls. Android's org.json eagerly
    // tokenizes the entire tree into boxed primitives and OOMs the JVM
    // heap on large reconnect-catchup batches. Two-level split:
    // inter-group (each group is independent), and intra-group (slice a
    // single busy group's messages, re-reading TR state from MMKV between
    // chunks since Rust persists it before each native call resolves).
    const MAX_BATCH_JSON_BYTES = 1_500_000;
    const fullInputStr = JSON.stringify(input);

    if (fullInputStr.length <= MAX_BATCH_JSON_BYTES) {
      return await this._callBatchProcessMessages(fullInputStr);
    }

    const merged: BatchProcessOutput = {
      space_results: [],
      dm_results: [],
    };
    let anyTruncated = false;

    const callSub = async (sub: BatchProcessInput) => {
      const subStr = JSON.stringify(sub);
      const subOut = await this._callBatchProcessMessages(subStr);
      merged.space_results.push(...subOut.space_results);
      merged.dm_results.push(...subOut.dm_results);
      if (subOut.truncated) anyTruncated = true;
    };

    for (const sg of input.space_groups) {
      const sgStr = JSON.stringify({
        user_address: input.user_address,
        space_groups: [sg],
        dm_groups: [],
      });
      if (sgStr.length <= MAX_BATCH_JSON_BYTES) {
        await callSub({
          user_address: input.user_address,
          space_groups: [sg],
          dm_groups: [],
        });
        continue;
      }

      const sliceOutput = await this._processSpaceGroupInSlices(input.user_address, sg);
      merged.space_results.push(...sliceOutput.space_results);
      if (sliceOutput.truncated) anyTruncated = true;
    }

    // DM groups don't share state across groups, so pack 5 per call —
    // stays well under the parse threshold even with init envelopes.
    const DM_CHUNK_SIZE = 5;
    for (let i = 0; i < input.dm_groups.length; i += DM_CHUNK_SIZE) {
      await callSub({
        user_address: input.user_address,
        space_groups: [],
        dm_groups: input.dm_groups.slice(i, i + DM_CHUNK_SIZE),
      });
    }

    if (anyTruncated) merged.truncated = true;
    return merged;
  }

  /**
   * Slice a single space group's messages, refreshing the TR state
   * from MMKV between chunks so each chunk starts from the correct
   * ratchet position. A single oversized message falls through as a
   * chunk-of-one and may surface `truncated`.
   */
  private async _processSpaceGroupInSlices(
    userAddress: string,
    group: BatchSpaceGroup,
  ): Promise<{ space_results: BatchSpaceGroupResult[]; truncated: boolean }> {
    // TR state dominates memory; envelopes are small. 25 per chunk
    // stays under the parse threshold for typical TR-state sizes.
    const MESSAGES_PER_SLICE = 25;

    // Lazy import to keep the door open for storage to depend on us.
    const { encryptionStateStorage } = await import('./encryption-state-storage');

    let currentState = group.tr_state;
    let currentFallback = group.tr_fallback_state;
    let currentIsNested = group.tr_state_is_nested;

    const allMessages: BatchSpaceMessageResult[] = [];
    let anyTruncated = false;

    for (let i = 0; i < group.messages.length; i += MESSAGES_PER_SLICE) {
      const slice = group.messages.slice(i, i + MESSAGES_PER_SLICE);
      const subGroup: BatchSpaceGroup = {
        ...group,
        tr_state: currentState,
        tr_fallback_state: currentFallback,
        tr_state_is_nested: currentIsNested,
        messages: slice,
      };
      const subOut = await this._callBatchProcessMessages(JSON.stringify({
        user_address: userAddress,
        space_groups: [subGroup],
        dm_groups: [],
      }));
      const subSpaceResult = subOut.space_results[0];
      if (subSpaceResult) {
        allMessages.push(...subSpaceResult.messages);
      }
      if (subOut.truncated) anyTruncated = true;

      const isLastSlice = i + MESSAGES_PER_SLICE >= group.messages.length;
      if (!isLastSlice) {
        const fresh = this._readFreshTRState(encryptionStateStorage, group.space_id);
        if (fresh) {
          currentState = fresh.state;
          currentFallback = fresh.fallbackState;
          currentIsNested = fresh.isNested;
        }
      }
    }

    return {
      space_results: [{
        space_id: group.space_id,
        messages: allMessages,
      }],
      truncated: anyTruncated,
    };
  }

  /**
   * Re-read a space's TR state from MMKV. Mirrors the gathering
   * logic in WebSocketContext.preclassifyAndGatherState — same
   * convention of using the first encryption state and unwrapping
   * the nested {state, template, evals} envelope when present.
   */
  private _readFreshTRState(
    encryptionStateStorage: typeof import('./encryption-state-storage').encryptionStateStorage,
    spaceId: string,
  ): { state: string; fallbackState: string | null; isNested: boolean } | null {
    const spaceConversationId = `${spaceId}/${spaceId}`;
    const states = encryptionStateStorage.getEncryptionStates(spaceConversationId);
    if (states.length === 0) return null;
    const first = states[0];

    let state = first.state;
    let isNested = false;
    try {
      const parsed = JSON.parse(state);
      if (parsed && typeof parsed === 'object' && typeof parsed.state === 'string') {
        state = parsed.state;
        isNested = true;
      }
    } catch {
      // Not JSON-parseable; treat as flat state string.
    }

    let fallbackState: string | null = null;
    const fb = encryptionStateStorage.getFallbackState(spaceConversationId, first.inboxId);
    if (fb) {
      let fbState = fb.state;
      try {
        const parsed = JSON.parse(fbState);
        if (parsed && typeof parsed === 'object' && typeof parsed.state === 'string') {
          fbState = parsed.state;
        }
      } catch { /* */ }
      fallbackState = fbState;
    }

    return { state, fallbackState, isNested };
  }

  private async _callBatchProcessMessages(inputStr: string): Promise<BatchProcessOutput> {
    const result = await QuorumCrypto.batchProcessMessages(inputStr);
    const parsed = JSON.parse(result) as BatchProcessOutput;
    if (parsed.truncated) {
      // Native side hit its output-size cap and one or more messages
      // came back with empty decrypted content. Log loudly until the
      // caller wires per-message refetch; this is the structural seam
      // where OOM-prevention meets "I might be missing message bodies".
      logger.warn(
        '[batchProcessMessages] native side returned truncated:true — some messages have empty decrypted_message. Refetch needed.',
      );
    }
    return parsed;
  }
}

// Batch Process Types

/** A space message to be processed natively */
export interface BatchSpaceMessage {
  inbox_address: string;
  timestamp: number;
  envelope_type: 'hub' | 'sync';
  ephemeral_public_key: string; // hex
  envelope: string; // JSON ciphertext
}

/** A space group: all messages for a single spaceId */
export interface BatchSpaceGroup {
  space_id: string;
  hub_private_key: number[];
  config_private_key: number[] | null;
  tr_state: string;           // Current TR ratchet state (JSON string)
  tr_fallback_state: string | null; // Frozen fallback state
  tr_state_is_nested: boolean; // Whether state was wrapped in {state:...,template:...,evals:...}
  sent_envelope_fingerprints: string[]; // First 100 chars of sent TR envelopes for self-echo detection
  messages: BatchSpaceMessage[];
}

/** Result for a single space message */
export interface BatchSpaceMessageResult {
  status: 'decrypted' | 'control' | 'self_echo' | 'unseal_failed' | 'decrypt_failed' | 'plaintext';
  decrypted_message?: string;  // JSON string of the decrypted Message
  control_payload?: string;    // JSON string of control payload
  used_fallback?: boolean;
  timestamp: number;
}

/** Result for a space group (native writes TR state to MMKV directly) */
export interface BatchSpaceGroupResult {
  space_id: string;
  messages: BatchSpaceMessageResult[];
}

/** A DM message to be processed natively */
export interface BatchDMMessage {
  inbox_address: string;
  timestamp: number;
  encrypted_content: string;    // Raw SealedMessage JSON
  is_double_ratchet_envelope: boolean;
  is_init_envelope: boolean;
}

/** DR state entry for trial decryption */
export interface BatchDRState {
  conversation_id: string;
  inbox_id: string;
  state: string; // DR ratchet state JSON string
}

/** A DM group: messages for a conversation + inbox type */
export interface BatchDMGroup {
  conversation_id: string;
  message_type: 'device_inbox' | 'conversation_inbox';
  device_inbox_private_key: number[] | null;
  device_inbox_encryption_private_key: number[] | null; // For unsealing init envelopes
  conversation_inbox_private_key: number[] | null;
  conversation_inbox_signing_private_key: number[] | null;
  identity_private_key: number[];
  pre_key_private_key: number[];
  dr_states: BatchDRState[];
  messages: BatchDMMessage[];
}

/** Input for batchProcessMessages native call */
export interface BatchProcessInput {
  user_address: string;
  space_groups: BatchSpaceGroup[];
  dm_groups: BatchDMGroup[];
}

/** Result for a single DM message */
export interface BatchDMMessageResult {
  status: 'decrypted' | 'init_decrypted' | 'decrypt_failed' | 'no_state' | 'unseal_failed';
  decrypted_message?: string;  // JSON string of the decrypted Message
  used_state_inbox_id?: string;
  user_profile?: { display_name?: string; user_icon?: string };
  return_inbox?: { inbox_address: string; inbox_encryption_key: string; inbox_public_key?: string };
  conversation_id?: string; // For init messages: the resolved conversation ID
  timestamp?: number; // Original message timestamp for inbox deletion matching
}

/** Result for a DM group (native writes DR states + session to MMKV directly) */
export interface BatchDMGroupResult {
  conversation_id: string;
  new_conversation_inbox?: string; // Address for WS subscription (init messages)
  messages: BatchDMMessageResult[];
}

/** Output of batchProcessMessages native call */
export interface BatchProcessOutput {
  space_results: BatchSpaceGroupResult[];
  dm_results: BatchDMGroupResult[];
  /**
   * Set when the batch hit the native-side output-size cap and dropped
   * one or more `decrypted_message` field contents. The metadata for
   * those messages (status, timestamp, conversation_id) is still
   * present — callers should refetch the affected messages
   * individually via `decryptInboxMessage` / DR / TR paths.
   */
  truncated?: boolean;
}

/**
 * Inbox sealed envelope for directed message to a specific recipient
 */
export interface InboxSealedEnvelope {
  inbox_public_key: string;
  ephemeral_public_key: string;
  envelope: string;
}

/**
 * Hub sealed message format for postHub API (broadcast)
 */
export interface HubSealedMessage {
  hub_address: string;
  hub_public_key: string;
  ephemeral_public_key: string;
  envelope: string;
  hub_signature: string;
}

/**
 * Sync sealed message format for directed delivery to a specific inbox
 */
export interface SyncSealedMessage {
  inbox_address: string;
  hub_address: string;
  owner_public_key: string;
  ephemeral_public_key: string;
  envelope: string;
  owner_signature: string;
}


/**
 * Convert number array to hex string
 */
function arrayToHex(arr: number[]): string {
  return arr.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert hex string to number array
 */
function hexToArray(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16));
  }
  return bytes;
}
