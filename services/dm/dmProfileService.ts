/*
 * DM profile broadcast — identity sync over established DM sessions.
 *
 * When the user changes their GLOBAL profile (displayName / userIcon / bio),
 * desktop sends a `dm-update-profile` control message over each existing
 * Double-Ratchet DM session so partners' conversation rows stay current. This
 * is mobile's port of that send path (desktop: MessageService.broadcastProfileToAllDMs).
 *
 * Mirrors three existing mobile patterns:
 *  - the control-message envelope shape from services/calling/call-signaling.ts
 *    (unsigned synthetic-messageId control message; the envelope sender is the
 *    cryptographic authentication, not a per-message signature),
 *  - the device-target assembly + sendEncryptedMessageToAllDevices call from
 *    CallContext.sendSignal,
 *  - the MMKV dedup gate from services/space/spaceMessageService.ts so the
 *    on-connect rebroadcast doesn't re-send unchanged identity to every DM
 *    partner on every reconnect (each send is a real wire message + push).
 *
 * Field semantics (match desktop + mobile's space update-profile handler):
 *  - displayName / userIcon: truthy guard — empty/omitted = "leave unchanged".
 *  - bio: `!== undefined` — empty string `''` = deliberate clear, omitted = unchanged.
 */

import type { DMUpdateProfileMessage, Message } from '@quilibrium/quorum-shared';
import { createMMKV, type MMKV } from 'react-native-mmkv';
import { getMMKVAdapter } from '../storage/mmkvAdapter';
import { getDeviceKeyset } from '../onboarding/secureStorage';

export interface DMProfilePayload {
  selfAddress: string;
  displayName?: string;
  userIcon?: string;
  bio?: string;
}

export interface DMBroadcastDeps {
  enqueueOutbound: (prepareMessage: () => Promise<string[]>) => void;
  subscribe: (inboxAddresses: string[]) => Promise<void>;
}

function generateNonce(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Build the unsigned `dm-update-profile` control Message for one partner.
 * Same envelope shape as a call-signal (synthetic messageId, channelId/spaceId
 * = recipient, no signature/publicKey — control messages are never persisted).
 */
function buildDmProfileMessage(
  payload: DMProfilePayload,
  recipientAddress: string,
): Message {
  const nonce = generateNonce();
  const now = Date.now();

  const content: DMUpdateProfileMessage = {
    senderId: payload.selfAddress,
    type: 'dm-update-profile',
    ...(payload.displayName ? { displayName: payload.displayName } : {}),
    ...(payload.userIcon ? { userIcon: payload.userIcon } : {}),
    ...(payload.bio !== undefined ? { bio: payload.bio } : {}),
  };

  return {
    messageId: `dm-profile-${nonce}`,
    channelId: recipientAddress,
    spaceId: recipientAddress,
    digestAlgorithm: 'SHA-256',
    nonce,
    createdDate: now,
    modifiedDate: now,
    lastModifiedHash: '',
    // The DMUpdateProfileMessage control type is intentionally NOT part of the
    // MessageContent union (it's never persisted/rendered), so cast through.
    content: content as unknown as Message['content'],
    reactions: [],
    mentions: { memberIds: [], roleIds: [], channelIds: [] },
  };
}

// ── Dedup gate ──────────────────────────────────────────────────────────────
// The on-connect rebroadcast fires on every reconnect/remount, and the save
// handlers fire on every tap-save. Without a gate, a partner gets the same
// identity re-sent (= a real DM + push) on every reconnect. Skip a send whose
// payload matches the last one recorded for that (self, partner). Recorded only
// after a successful enqueue so a failure leaves the gate open for retry.

let dmProfileBroadcastStore: MMKV | null = null;
function getStore(): MMKV {
  if (!dmProfileBroadcastStore) {
    dmProfileBroadcastStore = createMMKV({ id: 'quorum-dm-profile-broadcast' });
  }
  return dmProfileBroadcastStore;
}

function gateKey(selfAddress: string, partnerAddress: string): string {
  return `${selfAddress}:${partnerAddress}`;
}

// Canonical signature of the exact wire payload. Field presence matters
// (avatar-only vs name-only have different signatures), and values matter.
function payloadSignature(p: DMProfilePayload): string {
  const obj: Record<string, string> = {};
  if (p.displayName) obj.displayName = p.displayName;
  if (p.userIcon) obj.userIcon = p.userIcon;
  if (p.bio !== undefined) obj.bio = p.bio;
  const sortedKeys = Object.keys(obj).sort();
  return JSON.stringify(obj, sortedKeys);
}

/** Clear the gate for one partner (or all of self's partners) so a fresh
 *  session re-broadcasts. Currently unused but mirrors the space service. */
export function clearDmProfileBroadcastState(selfAddress: string, partnerAddress?: string): void {
  const store = getStore();
  if (partnerAddress) {
    store.remove(gateKey(selfAddress, partnerAddress));
    return;
  }
  const prefix = `${selfAddress}:`;
  for (const k of store.getAllKeys()) {
    if (k.startsWith(prefix)) store.remove(k);
  }
}

// ── Send ─────────────────────────────────────────────────────────────────────

/**
 * Broadcast a global profile change to every direct-DM partner with whom we
 * have (or can establish) an encryption session.
 *
 * Fire-and-forget: never throws, never blocks the caller's UI. Per-partner
 * failures (no session, registration fetch failure) are swallowed so one bad
 * partner can't block the rest — exactly like the space broadcast loop.
 */
export async function broadcastProfileToAllDMs(
  payload: DMProfilePayload,
  deps: DMBroadcastDeps,
): Promise<void> {
  const sig = payloadSignature(payload);
  // Empty payload would no-op on every receiver — nothing to send.
  if (sig === '{}') return;

  let deviceKeyset: Awaited<ReturnType<typeof getDeviceKeyset>>;
  try {
    deviceKeyset = await getDeviceKeyset();
  } catch {
    return;
  }
  if (!deviceKeyset) return;

  const adapter = getMMKVAdapter();

  // Read ALL direct conversations in one pass. getConversations slices to
  // `limit` (default 50) from an in-memory array, so a single large limit
  // returns everything with nextCursor === null. We deliberately avoid the
  // cursor-paging loop: the adapter's cursor uses `timestamp <= cursor`, which
  // re-starts at the same index when two conversations share a timestamp
  // (import/sync can produce that), so paging could revisit rows. One big read
  // sidesteps that entirely.
  const { conversations: partners } = await adapter.getConversations({
    type: 'direct',
    limit: 100000,
  });

  const store = getStore();
  const { sendEncryptedMessageToAllDevices } = await import('@/hooks/chat/useSendDirectMessage');
  const { toAllDeviceInfos } = await import('@/hooks/chat/useRecipientRegistration');
  const { getQuorumClient } = await import('@/services/api/quorumClient');
  const apiClient = getQuorumClient();

  for (const conv of partners) {
    const partnerAddress = conv.address;
    // Skip rows we can't DM: missing address, ourselves, or Farcaster threads
    // (not E2EE DM sessions — an encrypted control message is meaningless there).
    if (!partnerAddress || partnerAddress === payload.selfAddress) continue;
    if (conv.source === 'farcaster') continue;

    // Dedup: already sent this exact identity to this partner.
    if (store.getString(gateKey(payload.selfAddress, partnerAddress)) === sig) continue;

    try {
      let allTargetDevices: {
        identityKey: number[];
        signedPreKey: number[];
        inboxAddress: string;
        inboxEncryptionKey: number[];
      }[] = [];
      try {
        const reg = await apiClient.fetchUserRegistration(partnerAddress);
        if (reg) allTargetDevices = toAllDeviceInfos(reg);
      } catch {
        // Registration fetch failed — nothing to send this partner this round.
      }
      if (allTargetDevices.length === 0) continue;

      const conversationId = `${partnerAddress}/${partnerAddress}`;
      const message = buildDmProfileMessage(payload, partnerAddress);

      await sendEncryptedMessageToAllDevices(
        conversationId,
        partnerAddress,
        message,
        allTargetDevices,
        deps.enqueueOutbound,
        deps.subscribe,
        {
          identityPublicKey: deviceKeyset.identityPublicKey,
          inboxAddress: deviceKeyset.inboxAddress,
          inboxEncryptionPublicKey: deviceKeyset.inboxEncryptionPublicKey,
        },
        payload.selfAddress,
        payload.displayName,
      );

      // Record only after a successful enqueue so a throw retries next round.
      store.set(gateKey(payload.selfAddress, partnerAddress), sig);
    } catch {
      // Per-partner failure (no session, encrypt error) is non-fatal — the
      // gate stays open for this partner so the next broadcast retries.
    }
  }
}
