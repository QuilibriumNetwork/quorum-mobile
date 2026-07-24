/**
 * EncryptionStateStorage - Manages Double Ratchet state persistence in MMKV
 *
 * Mirrors the desktop's IndexedDB storage pattern for encryption states.
 * States are keyed by conversationId + inboxId for multi-device support.
 *
 * Uses types from @quilibrium/quorum-shared for cross-platform compatibility.
 */

import { type MMKV } from 'react-native-mmkv';
import { createMirroredMMKV } from '@/services/storage/mirroredMMKV';
import {
  logger,
  type EncryptionState,
  type InboxMapping,
  type LatestState,
  type ConversationInboxKeypair,
  type KeyValueStorageProvider,
  ENCRYPTION_STORAGE_KEYS as KEYS,
} from '@quilibrium/quorum-shared';

// Re-export types from shared library for backwards compatibility
export type {
  SendingInbox,
  ReceivingInbox,
  EncryptionState,
  InboxMapping,
  LatestState,
  ConversationInboxKeypair,
} from '@quilibrium/quorum-shared';

// Debounced best-effort push re-registration. A brand-new conversation
// inbox must be registered with quorum-api so the peer's DMs can wake this
// device — push registration otherwise only runs at startup/token-rotation
// and would miss the new inbox until the next launch. Debounced so a burst
// of new conversations (e.g. initial restore/sync) collapses into a single
// registration sweep. Dynamically imported to avoid a static import cycle
// (notifications → crypto storage).
let pushReregisterTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleConversationInboxPushRegistration(): void {
  if (pushReregisterTimer) return;
  pushReregisterTimer = setTimeout(() => {
    pushReregisterTimer = null;
    void import('../notifications/pushRegistration')
      .then((m) => m.registerPushTokenWithQuorum({ force: true }))
      .catch(() => {});
  }, 3000);
}

/**
 * MMKVStorageProvider - MMKV implementation of KeyValueStorageProvider.
 *
 * Uses createMirroredMMKV so writes are mirrored into the iOS App
 * Group container; the NSE reads the mirror to decrypt incoming
 * pushes locally. On Android / when App Group is unavailable the
 * mirror is a silent no-op.
 */
class MMKVStorageProvider implements KeyValueStorageProvider {
  private mmkv: MMKV;

  constructor(id: string) {
    this.mmkv = createMirroredMMKV({ id });
  }

  getString(key: string): string | null {
    return this.mmkv.getString(key) ?? null;
  }

  set(key: string, value: string): void {
    this.mmkv.set(key, value);
  }

  remove(key: string): void {
    this.mmkv.remove(key);
  }

  getAllKeys(): string[] {
    return this.mmkv.getAllKeys();
  }

  clearAll(): void {
    this.mmkv.clearAll();
  }
}

/**
 * EncryptionStateStorage - MMKV-backed storage for encryption states
 *
 * Uses batched writes to avoid blocking the UI thread during message sync.
 * State updates are queued and flushed every 100ms or when 10 updates accumulate.
 */
class EncryptionStateStorage {
  private storage: KeyValueStorageProvider;

  // Batched write queue for performance
  private pendingWrites: Map<string, string> = new Map();
  private flushTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_DELAY_MS = 100;
  private readonly MAX_PENDING_WRITES = 10;

  // In-memory index: inboxId -> Set of conversationIds for O(1) lookup
  private inboxIndex: Map<string, Set<string>> | null = null;

  constructor() {
    // Separate MMKV instance for encryption states (encrypted at rest)
    this.storage = new MMKVStorageProvider('quorum-encryption');
  }

  /**
   * Queue a write operation for batched execution
   * This prevents UI jank during heavy sync operations
   */
  private queueWrite(key: string, value: string): void {
    this.pendingWrites.set(key, value);

    // Flush immediately if we've accumulated enough writes
    if (this.pendingWrites.size >= this.MAX_PENDING_WRITES) {
      this.flushWrites();
      return;
    }

    // Otherwise schedule a flush
    if (!this.flushTimeout) {
      this.flushTimeout = setTimeout(() => this.flushWrites(), this.FLUSH_DELAY_MS);
    }
  }

  /**
   * Flush all pending writes to storage
   * Called automatically after delay or when max pending reached
   */
  private flushWrites(): void {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    if (this.pendingWrites.size === 0) return;

    // Batch write all pending updates
    for (const [key, value] of this.pendingWrites) {
      this.storage.set(key, value);
    }
    this.pendingWrites.clear();
  }

  /**
   * Force flush pending writes (call before reading updated state)
   */
  flushPendingWrites(): void {
    this.flushWrites();
  }

  // Encryption States

  /**
   * Get encryption state for a specific conversation+inbox pair
   */
  getEncryptionState(conversationId: string, inboxId: string): EncryptionState | null {
    const key = `${KEYS.ENCRYPTION_STATE}${conversationId}:${inboxId}`;

    // Check pending writes first (most recent state)
    const pendingData = this.pendingWrites.get(key);
    if (pendingData) {
      try {
        return JSON.parse(pendingData) as EncryptionState;
      } catch {
        // Pending write data is malformed — fall through to storage read
      }
    }

    const data = this.storage.getString(key);
    if (!data) return null;
    try {
      return JSON.parse(data) as EncryptionState;
    } catch {
      return null;
    }
  }

  /**
   * Get all encryption states for a conversation
   */
  getEncryptionStates(conversationId: string): EncryptionState[] {
    // [SEND-TIMING] temporary slow-call logging — strip before merge. One
    // synchronous MMKV read + JSON.parse per row, on the JS thread; a
    // churned conversation was seen with 8052 rows.
    const t0 = Date.now();
    const inboxIds = this.getConversationInboxIds(conversationId);
    const states: EncryptionState[] = [];

    for (const inboxId of inboxIds) {
      const state = this.getEncryptionState(conversationId, inboxId);
      if (state) {
        states.push(state);
      }
    }

    const took = Date.now() - t0;
    if (took > 50 || inboxIds.length > 100) {
      logger.warn(
        `[SEND-TIMING] getEncryptionStates(${conversationId.slice(0, 12)}…): rows=${states.length} keys=${inboxIds.length} took=${took}ms`,
      );
    }
    return states;
  }

  /**
   * Save encryption state
   * @param updateLatest - Whether to update the "latest state" tracker (used for determining where to send).
   *                       Set to false when saving state after receiving/decrypting a message.
   * @param immediate - If true, writes immediately instead of batching (use for critical sends)
   */
  saveEncryptionState(state: EncryptionState, updateLatest: boolean = true, immediate: boolean = false): void {
    const key = `${KEYS.ENCRYPTION_STATE}${state.conversationId}:${state.inboxId}`;
    const value = JSON.stringify(state);

    if (immediate) {
      // Immediate write for critical operations (e.g., before sending)
      this.storage.set(key, value);
    } else {
      // Batched write for performance during sync
      this.queueWrite(key, value);
    }

    // Update conversation inbox list
    this.addInboxToConversation(state.conversationId, state.inboxId);

    // Only update latest state when sending (not when receiving)
    // The "latest state" is used to determine where to SEND messages
    if (updateLatest) {
      this.updateLatestState(state.conversationId, state.inboxId, state.timestamp);
    }
  }

  /**
   * Delete encryption state
   */
  deleteEncryptionState(conversationId: string, inboxId: string): void {
    const key = `${KEYS.ENCRYPTION_STATE}${conversationId}:${inboxId}`;
    this.storage.remove(key);

    // Remove from conversation inbox list
    this.removeInboxFromConversation(conversationId, inboxId);
  }

  /**
   * Delete all encryption states for a conversation
   */
  deleteAllEncryptionStates(conversationId: string): void {
    const inboxIds = this.getConversationInboxIds(conversationId);

    for (const inboxId of inboxIds) {
      const key = `${KEYS.ENCRYPTION_STATE}${conversationId}:${inboxId}`;
      this.storage.remove(key);
    }

    // Clear the inbox list
    this.storage.remove(`${KEYS.CONVERSATION_INBOXES}${conversationId}`);

    // Clear latest state
    this.storage.remove(`${KEYS.LATEST_STATE}${conversationId}`);

    // Invalidate in-memory index
    this.inboxIndex = null;
  }

  // Inbox Mapping

  /**
   * Get conversation ID for an inbox
   */
  getInboxMapping(inboxId: string): InboxMapping | null {
    const key = `${KEYS.INBOX_MAPPING}${inboxId}`;
    const data = this.storage.getString(key);
    if (!data) return null;
    try {
      return JSON.parse(data) as InboxMapping;
    } catch {
      return null;
    }
  }

  /**
   * Save inbox to conversation mapping
   */
  saveInboxMapping(inboxId: string, conversationId: string): void {
    const key = `${KEYS.INBOX_MAPPING}${inboxId}`;
    const mapping: InboxMapping = { inboxId, conversationId };
    this.storage.set(key, JSON.stringify(mapping));
  }

  /**
   * Delete inbox mapping
   */
  deleteInboxMapping(inboxId: string): void {
    const key = `${KEYS.INBOX_MAPPING}${inboxId}`;
    this.storage.remove(key);
  }

  // Latest State

  /**
   * Get latest state for a conversation
   */
  getLatestState(conversationId: string): LatestState | null {
    const key = `${KEYS.LATEST_STATE}${conversationId}`;
    const data = this.storage.getString(key);
    if (!data) return null;
    try {
      return JSON.parse(data) as LatestState;
    } catch {
      return null;
    }
  }

  /**
   * Update latest state if newer
   */
  private updateLatestState(conversationId: string, inboxId: string, timestamp: number): void {
    const current = this.getLatestState(conversationId);
    if (!current || timestamp > current.timestamp) {
      const key = `${KEYS.LATEST_STATE}${conversationId}`;
      const state: LatestState = { conversationId, inboxId, timestamp };
      this.storage.set(key, JSON.stringify(state));
    }
  }

  // Conversation Inbox List

  /**
   * Get all inbox IDs for a conversation
   */
  private getConversationInboxIds(conversationId: string): string[] {
    const key = `${KEYS.CONVERSATION_INBOXES}${conversationId}`;
    const data = this.storage.getString(key);
    if (!data) return [];
    try {
      return JSON.parse(data) as string[];
    } catch {
      return [];
    }
  }

  /**
   * Add inbox to conversation list
   */
  private addInboxToConversation(conversationId: string, inboxId: string): void {
    const inboxIds = this.getConversationInboxIds(conversationId);
    if (!inboxIds.includes(inboxId)) {
      inboxIds.push(inboxId);
      const key = `${KEYS.CONVERSATION_INBOXES}${conversationId}`;
      this.storage.set(key, JSON.stringify(inboxIds));
      // Invalidate in-memory index
      this.inboxIndex = null;
    }
  }

  /**
   * Remove inbox from conversation list
   */
  private removeInboxFromConversation(conversationId: string, inboxId: string): void {
    const inboxIds = this.getConversationInboxIds(conversationId);
    const index = inboxIds.indexOf(inboxId);
    if (index !== -1) {
      inboxIds.splice(index, 1);
      const key = `${KEYS.CONVERSATION_INBOXES}${conversationId}`;
      if (inboxIds.length > 0) {
        this.storage.set(key, JSON.stringify(inboxIds));
      } else {
        this.storage.remove(key);
      }
      // Invalidate in-memory index
      this.inboxIndex = null;
    }
  }

  // Conversation Inbox Keypairs

  /**
   * Save a per-conversation inbox keypair
   * This keypair is used to receive replies for a specific conversation
   */
  saveConversationInboxKeypair(keypair: ConversationInboxKeypair): void {
    const key = `${KEYS.CONVERSATION_INBOX_KEY}${keypair.conversationId}`;
    // First time we've seen this conversation's inbox → make sure its push
    // binding gets registered so the peer's messages wake this device.
    const isNew = this.storage.getString(key) == null;
    this.storage.set(key, JSON.stringify(keypair));
    if (isNew) {
      scheduleConversationInboxPushRegistration();
    }
  }

  /**
   * Get the inbox keypair for a conversation
   */
  getConversationInboxKeypair(conversationId: string): ConversationInboxKeypair | null {
    const key = `${KEYS.CONVERSATION_INBOX_KEY}${conversationId}`;
    const data = this.storage.getString(key);
    if (!data) return null;
    try {
      return JSON.parse(data) as ConversationInboxKeypair;
    } catch {
      return null;
    }
  }

  /**
   * Delete conversation inbox keypair
   */
  deleteConversationInboxKeypair(conversationId: string): void {
    const key = `${KEYS.CONVERSATION_INBOX_KEY}${conversationId}`;
    this.storage.remove(key);
  }

  /**
   * Find a conversation inbox keypair by inbox address
   * Used when we need to decrypt a message that arrived at a conversation-specific inbox
   */
  getConversationInboxKeypairByAddress(inboxAddress: string): ConversationInboxKeypair | null {
    // Get all keys and find the one with matching inbox address
    const allKeys = this.storage.getAllKeys();
    for (const key of allKeys) {
      if (key.startsWith(KEYS.CONVERSATION_INBOX_KEY)) {
        const data = this.storage.getString(key);
        if (data) {
          try {
            const keypair = JSON.parse(data) as ConversationInboxKeypair;
            if (keypair.inboxAddress === inboxAddress) {
              return keypair;
            }
          } catch {
            // Skip malformed entries
          }
        }
      }
    }
    return null;
  }

  /**
   * Get every stored conversation inbox keypair in a single sweep.
   * Callers that need both the address and the keypair should use this
   * instead of calling getAllConversationInboxAddresses() and then
   * getConversationInboxKeypairByAddress() per address — the latter is
   * O(N) per lookup and turns the natural loop into O(N²).
   */
  getAllConversationInboxKeypairs(): ConversationInboxKeypair[] {
    const out: ConversationInboxKeypair[] = [];
    const allKeys = this.storage.getAllKeys();
    for (const key of allKeys) {
      if (!key.startsWith(KEYS.CONVERSATION_INBOX_KEY)) continue;
      const data = this.storage.getString(key);
      if (!data) continue;
      try {
        out.push(JSON.parse(data) as ConversationInboxKeypair);
      } catch {
        // Skip malformed entries
      }
    }
    return out;
  }

  /**
   * Get all conversation inbox addresses
   * Used for resubscribing to all inboxes we created when initiating conversations
   */
  getAllConversationInboxAddresses(): string[] {
    const addresses: string[] = [];
    const allKeys = this.storage.getAllKeys();
    for (const key of allKeys) {
      if (key.startsWith(KEYS.CONVERSATION_INBOX_KEY)) {
        const data = this.storage.getString(key);
        if (data) {
          try {
            const keypair = JSON.parse(data) as ConversationInboxKeypair;
            addresses.push(keypair.inboxAddress);
          } catch {
            // Skip malformed entries
          }
        }
      }
    }
    return addresses;
  }

  // Utility

  /**
   * Clear all encryption storage (for sign out)
   */
  clearAll(): void {
    this.storage.clearAll();
    // Invalidate in-memory index
    this.inboxIndex = null;
  }

  /**
   * Check if we have any encryption state for a conversation
   */
  hasEncryptionState(conversationId: string): boolean {
    const inboxIds = this.getConversationInboxIds(conversationId);
    return inboxIds.length > 0;
  }

  /**
   * Build the in-memory index mapping inboxId -> Set of conversationIds.
   * Called lazily on first getStatesByInboxId after invalidation.
   */
  private buildInboxIndex(): Map<string, Set<string>> {
    const index = new Map<string, Set<string>>();
    const allKeys = this.storage.getAllKeys();

    for (const key of allKeys) {
      if (key.startsWith(KEYS.CONVERSATION_INBOXES)) {
        const conversationId = key.substring(KEYS.CONVERSATION_INBOXES.length);
        const inboxIds = this.getConversationInboxIds(conversationId);
        for (const iid of inboxIds) {
          let convSet = index.get(iid);
          if (!convSet) {
            convSet = new Set<string>();
            index.set(iid, convSet);
          }
          convSet.add(conversationId);
        }
      }
    }

    return index;
  }

  /**
   * Get all encryption states that have a specific inbox ID
   * This is used for trial decryption on the device inbox
   * since multiple conversations can share the same device inbox
   *
   * Returns array of (conversationId, state) pairs
   */
  getStatesByInboxId(inboxId: string): Array<{ conversationId: string; state: EncryptionState }> {
    // [SEND-TIMING] temporary slow-call logging — strip before merge
    const t0 = Date.now();
    // Build index lazily on first call (or after invalidation)
    if (!this.inboxIndex) {
      this.inboxIndex = this.buildInboxIndex();
      logger.warn(`[SEND-TIMING] buildInboxIndex took=${Date.now() - t0}ms`);
    }

    const conversationIds = this.inboxIndex.get(inboxId);
    if (!conversationIds) return [];

    const results: Array<{ conversationId: string; state: EncryptionState }> = [];
    for (const conversationId of conversationIds) {
      const state = this.getEncryptionState(conversationId, inboxId);
      if (state) {
        results.push({ conversationId, state });
      }
    }

    const took = Date.now() - t0;
    if (took > 50) {
      logger.warn(
        `[SEND-TIMING] getStatesByInboxId(${inboxId.slice(0, 12)}…): results=${results.length} took=${took}ms`,
      );
    }
    return results;
  }

  // Ephemeral Key State Cache
  // Used to cache ratchet states by sender's ephemeral public key.
  // This handles the case where multiple init envelopes arrive with the same
  // ephemeral key (e.g., messages sent before receiver's reply arrives).
  // Without this, each message would re-do X3DH and get ratchet state 0,
  // but messages 2+ were encrypted with advanced ratchet states.

  /**
   * Save encryption state keyed by ephemeral public key
   * This allows us to reuse the advanced ratchet state for subsequent messages
   * from the same X3DH session.
   */
  saveEphemeralKeyState(ephemeralKey: string, conversationId: string, state: EncryptionState): void {
    const key = `ephemeral:${conversationId}:${ephemeralKey}`;
    this.storage.set(key, JSON.stringify(state));
  }

  /**
   * Get encryption state by ephemeral public key
   * Returns the last saved state for this ephemeral key, which has the advanced ratchet.
   */
  getEphemeralKeyState(ephemeralKey: string, conversationId: string): EncryptionState | null {
    const key = `ephemeral:${conversationId}:${ephemeralKey}`;
    const data = this.storage.getString(key);
    if (!data) return null;
    try {
      return JSON.parse(data) as EncryptionState;
    } catch {
      return null;
    }
  }

  /**
   * Delete ephemeral key state (call when session is fully established with reply)
   */
  deleteEphemeralKeyState(ephemeralKey: string, conversationId: string): void {
    const key = `ephemeral:${conversationId}:${ephemeralKey}`;
    this.storage.remove(key);
  }

  // Fallback State (for header key sync issues)

  /**
   * Save a fallback encryption state that can be used if decrypt fails with the current state.
   * This is used when header keys change during encrypt but the peer hasn't received the update yet.
   */
  saveFallbackState(state: EncryptionState): void {
    const key = `${KEYS.ENCRYPTION_STATE}${state.conversationId}:${state.inboxId}:fallback`;
    // Use batched write for fallback states (non-critical)
    this.queueWrite(key, JSON.stringify(state));
  }

  /**
   * Get fallback encryption state for a conversation+inbox pair
   */
  getFallbackState(conversationId: string, inboxId: string): EncryptionState | null {
    const key = `${KEYS.ENCRYPTION_STATE}${conversationId}:${inboxId}:fallback`;
    const data = this.storage.getString(key);
    if (!data) return null;
    try {
      return JSON.parse(data) as EncryptionState;
    } catch {
      return null;
    }
  }

  /**
   * Delete fallback state (call when sync is confirmed)
   */
  deleteFallbackState(conversationId: string, inboxId: string): void {
    const key = `${KEYS.ENCRYPTION_STATE}${conversationId}:${inboxId}:fallback`;
    this.storage.remove(key);
  }
}

// Export singleton instance
export const encryptionStateStorage = new EncryptionStateStorage();
export default encryptionStateStorage;
