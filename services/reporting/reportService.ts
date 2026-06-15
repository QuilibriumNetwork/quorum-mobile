/**
 * Report submission for moderation.
 *
 * Two flavors:
 *   - "cast": Farcaster cast. Public content; we send the cast hash + author
 *     FID + reporter context. No ciphertext.
 *   - "message": Quorum chat message (space or DM). The reported message's
 *     plaintext is encrypted under a fresh AES-GCM key generated client-side
 *     for THIS report only; both ciphertext and key are shipped to the
 *     server. The server can decrypt the reported message but learns nothing
 *     about other messages — the per-message ephemeral key is never reused
 *     and never derived from any space/DM session key. This intentionally
 *     mirrors how Signal-style "user-driven moderation" works for E2E
 *     systems without breaking forward secrecy.
 *
 * Payload is signed by the reporter's Ed448 inbox-style identity key (same
 * key used for /users/:address registration), so the server can pin the
 * report to a real account.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { getQuorumClient } from '@/services/api/quorumClient';
import { NativeCryptoProvider } from '@/services/crypto/native-provider';
import { ensurePrivateKey } from '@/services/onboarding/keyService';
import { base64ToHex, numberArrayToBase64 } from '@/utils/encoding';
import { hexToBytes, bytesToHex } from '@quilibrium/quorum-shared';

export type ReportReason = 'spam' | 'harassment' | 'illegal' | 'other';

export interface CastReportInput {
  type: 'cast';
  castHash: string;
  castAuthorFid?: number;
  reason: ReportReason;
  freeText?: string;
  reporterAddress: string;
}

export interface MessageReportInput {
  type: 'message';
  // Decrypted plaintext we already have in our local cache. The service
  // re-encrypts it under a per-report AES key before sending.
  plaintext: string;
  // Targeting metadata so a moderator can locate the message in their
  // own logs or in the source space/DM if necessary.
  spaceId?: string;
  channelId?: string;
  conversationId?: string;
  messageId: string;
  senderAddress?: string;
  reason: ReportReason;
  freeText?: string;
  reporterAddress: string;
}

export type ReportInput = CastReportInput | MessageReportInput;

interface ReportPayload {
  id: string;
  type: 'cast' | 'message';
  reporter_address: string;
  reason: ReportReason;
  free_text: string;
  cast_hash?: string;
  cast_author_fid?: number;
  space_id?: string;
  channel_id?: string;
  conversation_id?: string;
  message_id?: string;
  sender_address?: string;
  encrypted_payload?: string;
  encryption_key?: string;
  iv?: string;
  reported_at: number;
  signature: string;
}

function int64BE(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function signWithUserKey(payload: Uint8Array): Promise<string> {
  const privateKeyHex = await ensurePrivateKey();
  if (!privateKeyHex) throw new Error('Private key not found');
  const privateKeyBase64 = numberArrayToBase64(Array.from(hexToBytes(privateKeyHex)));
  const messageBase64 = numberArrayToBase64(Array.from(payload));
  const crypto = new NativeCryptoProvider();
  const sigBase64 = await crypto.signEd448(privateKeyBase64, messageBase64);
  return base64ToHex(sigBase64);
}

function generateReportId(): string {
  // 16 random bytes hex-encoded — unique enough for collision-free chronological keys.
  return bytesToHex(randomBytes(16));
}

/**
 * Build the canonical signed-bytes for a report. MUST stay in lockstep with
 * the server's reconstruction in main.go:handleReport.
 */
function canonicalize(p: ReportPayload): Uint8Array {
  const target =
    p.type === 'cast'
      ? `cast:${p.cast_hash ?? ''}:${p.cast_author_fid ?? 0}`
      : `msg:${p.space_id ?? ''}:${p.channel_id ?? ''}:${p.conversation_id ?? ''}:${p.message_id ?? ''}:${p.sender_address ?? ''}`;
  const enc = new TextEncoder();
  return concatBytes(
    enc.encode(
      `report:${p.id}:${p.type}:${p.reporter_address}:${target}:${p.reason}:${p.free_text}:${p.encrypted_payload ?? ''}:${p.encryption_key ?? ''}:${p.iv ?? ''}:`,
    ),
    int64BE(p.reported_at),
  );
}

/**
 * Encrypt the reported message plaintext under a fresh AES-GCM key. Returns
 * hex-encoded ciphertext, key, and IV ready to ship in the report. The key
 * is generated here and only known to the reporter and (after submission)
 * the server — it is NEVER persisted on the client and is independent of
 * any space/DM session key.
 */
function encryptReportedMessage(plaintext: string): {
  encryptedPayload: string;
  encryptionKey: string;
  iv: string;
} {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const ct = gcm(key, iv).encrypt(new TextEncoder().encode(plaintext));
  return {
    encryptedPayload: bytesToHex(ct),
    encryptionKey: bytesToHex(key),
    iv: bytesToHex(iv),
  };
}

/**
 * Submit a report. Throws on validation or network error.
 */
export async function submitReport(input: ReportInput): Promise<{ id: string }> {
  const id = generateReportId();
  const reportedAt = Date.now();
  const freeText = (input.freeText ?? '').trim();
  if (freeText.length > 2000) {
    throw new Error('Reason detail too long (max 2000 characters)');
  }

  const payload: ReportPayload = {
    id,
    type: input.type,
    reporter_address: input.reporterAddress,
    reason: input.reason,
    free_text: freeText,
    reported_at: reportedAt,
    signature: '', // filled below
  };

  if (input.type === 'cast') {
    payload.cast_hash = input.castHash;
    if (input.castAuthorFid != null) {
      payload.cast_author_fid = input.castAuthorFid;
    }
  } else {
    const { encryptedPayload, encryptionKey, iv } = encryptReportedMessage(input.plaintext);
    payload.encrypted_payload = encryptedPayload;
    payload.encryption_key = encryptionKey;
    payload.iv = iv;
    payload.message_id = input.messageId;
    if (input.spaceId) payload.space_id = input.spaceId;
    if (input.channelId) payload.channel_id = input.channelId;
    if (input.conversationId) payload.conversation_id = input.conversationId;
    if (input.senderAddress) payload.sender_address = input.senderAddress;
  }

  payload.signature = await signWithUserKey(canonicalize(payload));

  await getQuorumClient().postReport(payload as unknown as Record<string, unknown>);
  return { id };
}
