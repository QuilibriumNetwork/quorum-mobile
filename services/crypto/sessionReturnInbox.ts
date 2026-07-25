/**
 * Which conversation inbox a DM session advertises as its return address.
 *
 * The rule: a session's return inbox is the inbox its OWN state row is keyed
 * by — never one shared per conversation.
 *
 * A Double Ratchet session is strictly linear, so a peer with N devices needs N
 * sessions. Rows are keyed `(conversationId, inboxId)`, so advertising one
 * conversation-wide inbox made every device of that peer re-initialize into the
 * SAME row: last writer won, the other devices' sessions were silently
 * destroyed, and every message to them was lost. A phone plus a laptop is
 * enough to trigger it. Desktop mints a keyset per session and never had this.
 *
 * Deriving the inbox from the row is also what lets a session reach the
 * confirmed state: the peer replies to the address we advertised, and
 * confirmSenderSession() finds the row to confirm BY that address.
 */

import { encryptionStateStorage } from './encryption-state-storage';
import { deriveAddress } from '@/services/onboarding/keyService';
import type { ConversationInboxKeypair } from '@quilibrium/quorum-shared';

/** The minimum of NativeCryptoProvider needed to mint an inbox keyset. */
export interface InboxKeyGenerator {
  generateX448(): Promise<{ public_key: number[]; private_key: number[] }>;
  generateEd448(): Promise<{ public_key: number[]; private_key: number[] }>;
}

/**
 * The keypair of a session's own return inbox, or null when we can't use it.
 *
 * Null covers rows written before per-address keypairs existed (#177): their
 * keypair lived only in the last-writer-wins per-conversation slot and may have
 * been overwritten, and a keyset missing its Ed448 half can never be confirmed
 * by the peer. Either way the caller mints a fresh inbox and the session
 * re-initializes onto it.
 */
export function sessionReturnInbox(
  state: { inboxId?: string } | null | undefined
): ConversationInboxKeypair | null {
  if (!state?.inboxId) return null;
  const keypair = encryptionStateStorage.getConversationInboxKeypairByAddress(state.inboxId);
  if (!keypair?.encryptionPublicKey?.length || !keypair.encryptionPrivateKey?.length) return null;
  if (!keypair.signingPublicKey?.length || !keypair.signingPrivateKey?.length) return null;
  return keypair;
}

/**
 * Mint and persist a fresh return inbox for a new session.
 *
 * X448 for sealing, Ed448 for signing; the address derives from the Ed448 key
 * so inbox writes can be signature-verified, exactly like a device inbox.
 */
export async function mintSessionReturnInbox(
  conversationId: string,
  generator: InboxKeyGenerator
): Promise<ConversationInboxKeypair> {
  const [encryption, signing] = await Promise.all([
    generator.generateX448(),
    generator.generateEd448(),
  ]);

  const keypair: ConversationInboxKeypair = {
    conversationId,
    inboxAddress: deriveAddress(new Uint8Array(signing.public_key)),
    encryptionPublicKey: encryption.public_key,
    encryptionPrivateKey: encryption.private_key,
    signingPublicKey: signing.public_key,
    signingPrivateKey: signing.private_key,
  };

  encryptionStateStorage.saveConversationInboxKeypair(keypair);
  encryptionStateStorage.saveInboxMapping(keypair.inboxAddress, conversationId);
  return keypair;
}

/**
 * The return inbox for a session we are re-initializing: its own inbox when we
 * still hold those keys, otherwise a fresh one.
 *
 * `minted` tells the caller whether a subscription is still owed — a reused
 * inbox is already subscribed, a fresh one is not, and the peer's confirming
 * reply is lost if nothing is listening.
 *
 * Idempotent: the resolved inbox is stored under its own address, so the next
 * send resolves to the same one. Inbox mappings are only ever added, never
 * deleted — the peer may still be writing to an older address (desktop #252).
 */
export async function resolveSessionReturnInbox(
  conversationId: string,
  state: { inboxId?: string } | null | undefined,
  generator: InboxKeyGenerator
): Promise<{ inbox: ConversationInboxKeypair; minted: boolean }> {
  const existing = sessionReturnInbox(state);
  if (existing) {
    // Re-assert routing: a lost mapping silently drops the peer's replies.
    encryptionStateStorage.saveInboxMapping(existing.inboxAddress, conversationId);
    return { inbox: existing, minted: false };
  }
  return { inbox: await mintSessionReturnInbox(conversationId, generator), minted: true };
}
