/**
 * ratchetMutex — app-level per-conversation lock for Double Ratchet state.
 *
 * Double Ratchet state is strictly linear: every operation (encrypt on send,
 * decrypt on receive) must read the latest saved state, advance it, and save
 * the result atomically. Mobile runs these concurrently — a user send, a
 * receive-decrypt from the WebSocket handler, and receipt sends fired by the
 * ReceiptService timer all funnel through the same conversation's ratchet.
 * Two operations that read the same state snapshot fork the ratchet: whichever
 * save lands last silently erases the other's advance, and the peer then gets
 * `aead::Error` on subsequent frames (a forked/dead session). This is the
 * mobile mirror of desktop's 6-month "DM never arrives" bug.
 *
 * Wrap every read-state → native-ratchet-op → save-state critical section in
 * `ratchetMutex.runExclusive(conversationId, fn)`. Different conversations
 * don't block each other; operations on the same conversation run FIFO.
 *
 * DO NOT hold the lock across transport delivery (enqueueOutbound / socket
 * send) — the critical section is crypto + MMKV only. Callers acquire the lock
 * inside the outbound-prepare callback around the encrypt, and release before
 * the sealed bytes reach the wire.
 *
 * Serializes within THIS JS context only. The Android background notification
 * task (BackgroundMessageService) runs in a separate context, but it never
 * decrypts DMs or advances the ratchet (presence-only), so no cross-context
 * lock is needed today. If background DM decryption is ever added, this JS
 * mutex will NOT cover it — a native/single-writer mechanism would be required.
 */

import { KeyedMutex } from '@quilibrium/quorum-shared';

export const ratchetMutex = new KeyedMutex();
