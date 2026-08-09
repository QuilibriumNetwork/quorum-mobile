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

import { logger, type DMUpdateProfileMessage, type Message } from '@quilibrium/quorum-shared';
import { createMMKV, type MMKV } from 'react-native-mmkv';
import { getMMKVAdapter } from '../storage/mmkvAdapter';
import { getDeviceKeyset } from '../onboarding/secureStorage';
import {
  readGateRecord,
  shouldSendProfile,
  nextAttempts,
  type DmProfileGateRecord,
} from './dmProfileGate';

export interface DMProfilePayload {
  selfAddress: string;
  displayName?: string;
  userIcon?: string;
  bio?: string;
  /**
   * The sender's elected primary QNS name, bare (`alice`, never `alice.q`).
   *
   * Without this a `.q` cannot reach a DM partner at all. It travels otherwise
   * only in a published public profile, and the server refuses every publish
   * carrying one — so a DM would keep showing the global name while the same
   * person's `.q` rendered fine in a shared space.
   *
   * A CLAIM, not a fact: the recipient resolves it against QNS before rendering
   * it. Empty string is a deliberate un-election and must be sent, or dropping
   * a primary name would never reach the partner.
   */
  primaryUsername?: string;
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

  // Cast: `primaryUsername` is additive and not yet in shared's
  // DMUpdateProfileMessage, the same untyped-additive-field pattern the space
  // broadcast uses for its global* and Farcaster slots. Wire-compatible —
  // receivers that do not know the field ignore it.
  const content = {
    senderId: payload.selfAddress,
    type: 'dm-update-profile',
    ...(payload.displayName ? { displayName: payload.displayName } : {}),
    ...(payload.userIcon ? { userIcon: payload.userIcon } : {}),
    ...(payload.bio !== undefined ? { bio: payload.bio } : {}),
    // Presence, not truthiness: '' is an un-election and has to travel.
    ...(payload.primaryUsername !== undefined
      ? { primaryUsername: payload.primaryUsername }
      : {}),
  } as DMUpdateProfileMessage;

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
//
// The DECISION half of this gate — dedup, the bounded retry, and the migration
// off the pre-cap format — lives in ./dmProfileGate, kept free of MMKV (and so
// of native modules) so it is directly unit-testable. What stays here is the
// persistence shim.

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

/**
 * Guarded gate read. FAILS OPEN — a redundant identity push is harmless, a
 * missed one leaves the partner stuck on a placeholder.
 *
 * These wrappers are not decoration. `broadcastProfileToAllDMs` documents itself
 * as fire-and-forget and never-throwing, and three of its four call sites invoke
 * it with NO rejection handler (ProfileModal x2, UnifiedProfileEditModal — all
 * `void import(...).then(...)`). An MMKV failure on a bare `store.getString` /
 * `store.set` would therefore escape the per-partner try/catch below, abandon the
 * rest of the sweep, and surface as an unhandled promise rejection.
 *
 * Desktop takes the same posture inside its own readRecord/writeRecord.
 */
function readGate(
  store: MMKV,
  key: string,
  now: number
): { record: DmProfileGateRecord | null; migrated: boolean } {
  try {
    return readGateRecord(store.getString(key), now);
  } catch {
    return { record: null, migrated: false };
  }
}

/**
 * Guarded gate write. Swallows storage failures deliberately, so a failed WRITE
 * is never mistaken for a failed SEND: the message has already gone out at that
 * point, and routing the error through the send-failure path would leave the
 * gate open and produce a real duplicate send the counter never saw.
 */
function writeGate(store: MMKV, key: string, record: DmProfileGateRecord): void {
  try {
    store.set(key, JSON.stringify(record));
  } catch {
    // Gate stays as it was; the next connect re-evaluates.
  }
}

// Canonical signature of the exact wire payload. Field presence matters
// (avatar-only vs name-only have different signatures), and values matter.
// Exported for tests — see the note on the space-side twin.
export function payloadSignature(p: DMProfilePayload): string {
  const obj: Record<string, string> = {};
  if (p.displayName) obj.displayName = p.displayName;
  if (p.userIcon) obj.userIcon = p.userIcon;
  if (p.bio !== undefined) obj.bio = p.bio;
  // Must be part of the signature, or electing a primary name would broadcast
  // nothing whenever the rest of the payload is unchanged — the gate would read
  // it as "same as last time" and the partner would never learn the `.q`.
  //
  // Including it also doubles as the one-time migration the space path needed a
  // tag for: every stored signature predates this field, so none of them match
  // and the next rebroadcast goes out for every partner.
  if (p.primaryUsername !== undefined) obj.primaryUsername = p.primaryUsername;
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

  // One clock reading for the whole sweep, so every partner in this run is
  // judged against the same instant rather than drifting across a long loop.
  const now = Date.now();

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
  let sent = 0;
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

    // Dedup + bounded retry. Almost always a no-op on the wire: an unchanged
    // identity is re-sent at most MAX_SENDS_PER_IDENTITY times, spaced by
    // RESEND_INTERVAL_MS, then never again until the signature changes.
    const key = gateKey(payload.selfAddress, partnerAddress);
    const { record, migrated } = readGate(store, key, now);
    // Persist a migrated record even if we do not send, so it is anchored once
    // and can age out from there rather than being re-anchored on every read.
    if (migrated && record) writeGate(store, key, record);
    if (!shouldSendProfile(record, sig, now)) continue;

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
      // writeGate swallows storage errors on purpose — see its comment.
      writeGate(store, key, { sig, at: now, attempts: nextAttempts(record, sig) });
      sent += 1;
    } catch {
      // Per-partner failure (no session, encrypt error) is non-fatal — the
      // gate stays open for this partner so the next broadcast retries.
    }
  }

  // The only externally visible evidence this ran. Until this line existed the
  // DM half of a profile broadcast was completely silent: no log, no error, no
  // way to tell "sent to nobody because everyone was deduped" from "never
  // called at all" — and those two have very different causes.
  //
  // That mattered concretely. Electing a primary name failed to broadcast for
  // three separate reasons at once, and none of them produced a single line of
  // output on this path. The space twin logs `[ProfileSync] broadcast sent` /
  // `gate SKIPPED` per space, which is exactly what made the space-side failure
  // diagnosable; this is the DM equivalent.
  logger.log(
    `[DMProfileSync] broadcast to ${sent}/${partners.length} partner(s)` +
      (sent === 0 ? ' — all deduped or unreachable' : ''),
  );
}
