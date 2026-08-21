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
import { getDeviceKeyset, type DeviceKeyset } from '../onboarding/secureStorage';
import { ensureRevealBootstrap, hasRevealedTo, recordReveal } from './dmRevealLedger';
import {
  readGateRecord,
  shouldSendProfile,
  nextAttempts,
  type DmProfileGateRecord,
} from './dmProfileGate';
// Type-only: erased at compile time, so these carry none of the runtime cost
// (native-module side effects, circular-import risk) that the VALUES from
// these same modules are dynamically imported below to avoid.
import type { UserRegistration } from '../api/quorumClient';
import type { DeviceInfo } from '@/hooks/chat/useRecipientRegistration';
import type { sendEncryptedMessageToAllDevices } from '@/hooks/chat/useSendDirectMessage';

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

/**
 * Everything `sendProfileToPartner` needs beyond `partnerAddress` and
 * `payload`. Built by `buildSendProfileDeps` below (one MMKV store handle,
 * one clock reading, one set of resolved dynamic-import bindings) and
 * threaded through every partner a caller processes with it — for
 * `broadcastProfileToAllDMs` that means built once per sweep and reused for
 * every partner in that sweep, so extracting the per-partner body out of the
 * loop did not turn a single setup cost into a per-partner one.
 */
export interface SendProfileDeps extends DMBroadcastDeps {
  store: MMKV;
  /** One clock reading for the whole sweep — see broadcastProfileToAllDMs. */
  now: number;
  deviceKeyset: DeviceKeyset;
  apiClient: { fetchUserRegistration: (address: string) => Promise<UserRegistration> };
  toAllDeviceInfos: (registration: UserRegistration) => DeviceInfo[];
  sendEncryptedMessageToAllDevices: typeof sendEncryptedMessageToAllDevices;
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
 * Send the DM identity update to exactly one partner: dedup gate → fetch the
 * partner's device registration → build the wire message → send → record the
 * gate. Extracted from `broadcastProfileToAllDMs`'s loop body so Tasks 6-7 can
 * invoke a single-partner send directly (reveal-on-reply, inbound-new-session
 * auto-announce) without re-running the whole-sweep machinery.
 *
 * PRECONDITION — enforced by the caller, not here: the caller must already
 * know it is safe to reveal identity to `partnerAddress` (via
 * `ensureRevealBootstrap` / `hasRevealedTo` in `./dmRevealLedger`, or because
 * the caller IS the event that establishes consent, e.g. a just-recorded
 * deliberate send) before calling this. This function performs NO reveal-
 * ledger check of its own — deliberately, so it stays usable by callers that
 * have already established consent by a different route, and so there is
 * exactly one place (the caller) that owns the consent decision. Do not add
 * a redundant check here; a second copy of the decision is how the two
 * copies drift.
 *
 * Returns true only once a frame was actually enqueued and the gate recorded
 * — not merely "eligible to send" — so a caller can count real sends.
 */
export async function sendProfileToPartner(
  partnerAddress: string,
  payload: DMProfilePayload,
  deps: SendProfileDeps,
): Promise<boolean> {
  const { store, now, deviceKeyset, apiClient, toAllDeviceInfos, sendEncryptedMessageToAllDevices } = deps;
  const sig = payloadSignature(payload);

  // Dedup + bounded retry. Almost always a no-op on the wire: an unchanged
  // identity is re-sent at most MAX_SENDS_PER_IDENTITY times, spaced by
  // RESEND_INTERVAL_MS, then never again until the signature changes.
  const key = gateKey(payload.selfAddress, partnerAddress);
  const { record, migrated } = readGate(store, key, now);
  // Persist a migrated record even if we do not send, so it is anchored once
  // and can age out from there rather than being re-anchored on every read.
  if (migrated && record) writeGate(store, key, record);
  if (!shouldSendProfile(record, sig, now)) return false;

  try {
    let allTargetDevices: DeviceInfo[] = [];
    try {
      const reg = await apiClient.fetchUserRegistration(partnerAddress);
      if (reg) allTargetDevices = toAllDeviceInfos(reg);
    } catch {
      // Registration fetch failed — nothing to send this partner this round.
    }
    if (allTargetDevices.length === 0) return false;

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
      payload.userIcon,
    );

    // Record only after a successful enqueue so a throw retries next round.
    // writeGate swallows storage errors on purpose — see its comment.
    writeGate(store, key, { sig, at: now, attempts: nextAttempts(record, sig) });
    return true;
  } catch {
    // Per-partner failure (no session, encrypt error) is non-fatal — the
    // gate stays open for this partner so the next broadcast retries.
    return false;
  }
}

/**
 * Assemble a `SendProfileDeps` bag from just `{ enqueueOutbound, subscribe }`:
 * resolve the device keyset, the three dynamically-imported send bindings,
 * and the gate store — everything `sendProfileToPartner` needs beyond
 * `partnerAddress`/`payload` but that no caller outside this file can reach
 * on its own. `dmProfileBroadcastStore` is a private module singleton
 * (`getStore()` above is not exported), and the three dynamic imports exist
 * only to keep native-module-heavy hooks out of this file's top-level import
 * graph — a caller re-doing them by hand would have to know both of those
 * implementation details and keep them in sync with this file by hand.
 *
 * ONE assembly path for this setup: `broadcastProfileToAllDMs` below calls
 * this too (once per sweep, not once per partner — see `SendProfileDeps`'s
 * doc comment for why that matters), rather than keeping an inline copy that
 * could drift from what a single-partner caller (Tasks 6-7: reveal-on-reply,
 * inbound-new-session auto-announce) gets.
 *
 * Returns null when setup genuinely cannot proceed (no device keyset — e.g.
 * onboarding incomplete or secure storage unavailable), so a caller gets one
 * honest failure signal instead of a half-built deps object.
 *
 * Does NOT check the reveal ledger. Whether it is safe to reveal to a given
 * partner is a per-partner decision (see `sendProfileToPartner`'s docstring
 * for who owns it) and does not belong in a per-sweep/per-call setup step.
 */
export async function buildSendProfileDeps(
  base: DMBroadcastDeps,
): Promise<SendProfileDeps | null> {
  // One clock reading for whatever this deps bag ends up covering — a whole
  // sweep for broadcastProfileToAllDMs, or a single send for a Task 6/7
  // caller — so every partner judged against it drifts from the same instant
  // rather than from Date.now() called fresh per partner.
  const now = Date.now();

  let deviceKeyset: DeviceKeyset | null;
  try {
    deviceKeyset = await getDeviceKeyset();
  } catch {
    return null;
  }
  if (!deviceKeyset) return null;

  const { sendEncryptedMessageToAllDevices } = await import('@/hooks/chat/useSendDirectMessage');
  const { toAllDeviceInfos } = await import('@/hooks/chat/useRecipientRegistration');
  const { getQuorumClient } = await import('@/services/api/quorumClient');

  return {
    ...base,
    store: getStore(),
    now,
    deviceKeyset,
    apiClient: getQuorumClient(),
    toAllDeviceInfos,
    sendEncryptedMessageToAllDevices,
  };
}

/**
 * Called after a successful chat/embed send in a DM. THE deliberate act the
 * privacy rule keys on: replying (or initiating) is consent to be seen.
 *
 * On the ledger's unset->set transition the partner's send-gate is CLEARED
 * first: the gate may be exhausted from the era when cross-client pushes
 * were silently eaten, and an exhausted gate must not block the one reveal
 * the user just consented to. Fire-and-forget; never throws into the send
 * path that calls it — a failed identity push must never surface as a failed
 * message send.
 *
 * Takes the same `DMBroadcastDeps` shape the two send hooks already hold
 * (`enqueueOutbound`/`subscribe` from `useWebSocket`) and assembles the rest
 * of `sendProfileToPartner`'s `SendProfileDeps` itself via
 * `buildSendProfileDeps` — a send hook has no reason to know how to build a
 * device keyset / api client / gate store just to fire this one push.
 *
 * If already revealed: no-op. The ledger already reflects consent, so this
 * returns immediately without touching the gate or the wire — the common
 * case on every message after the first reply to a given partner.
 */
export async function onDeliberateDmSend(
  partnerAddress: string,
  payload: DMProfilePayload,
  deps: DMBroadcastDeps,
): Promise<void> {
  try {
    if (hasRevealedTo(payload.selfAddress, partnerAddress)) return;
    recordReveal(payload.selfAddress, partnerAddress, Date.now());
    clearDmProfileBroadcastState(payload.selfAddress, partnerAddress);
    const sendDeps = await buildSendProfileDeps(deps);
    if (!sendDeps) return;
    await sendProfileToPartner(partnerAddress, payload, sendDeps);
  } catch {
    // Never break a message send over an identity push; the on-connect
    // sweep retries through the (now-open) gate.
  }
}

// One auto-reveal per partner per hour. An init envelope can be REDELIVERED
// (the receive path bounds replays but does not eliminate them), and each
// one looks like "a new session appeared" — without this, a flapping inbox
// turns one new device into a push storm.
const AUTO_REVEAL_DEBOUNCE_MS = 60 * 60 * 1000;
// Keyed on partnerAddress ALONE (process-global) — narrower than the reveal
// ledger, which keys on the (self, partner) pair (see dmRevealLedger.ts).
// On a device with multiple signed-in accounts this means a reveal that just
// fired for account A's relationship with partner P also suppresses a
// legitimate first reveal for account B's separate relationship with that
// same P, for up to an hour. Left this way deliberately (matches the brief),
// not by oversight, because it fails SAFE: it never mixes identity across
// accounts, it only ever delays a push, and the same on-connect sweep that
// recovers a failed send (see the early-timestamp comment below) recovers a
// suppressed one too. Do not widen this key without confirming
// multi-account-on-one-device is worth the extra per-pair Map churn.
const autoRevealLastFired = new Map<string, number>();

/** Test hook: the debounce map is process-lifetime state. */
export function __resetAutoRevealDebounce(): void {
  autoRevealLastFired.clear();
}

/**
 * A partner just opened a NEW inbound session at us (their new device, or a
 * reinstall). If the ledger says we already deliberately revealed to them,
 * answer immediately — consent belongs to the relationship, not the session,
 * so their fresh device should not have to wait for our next rename or
 * reply. If the ledger says stranger: total silence.
 *
 * `deps` is deliberately the narrow `DMBroadcastDeps`, not `SendProfileDeps`:
 * this is called from a long-lived receive callback in WebSocketContext.tsx
 * that must never hold more than `{ enqueueOutbound, subscribe }` across a
 * render (see that file's stale-closure note on `fullUserAddrRef`). The rest
 * of what a real send needs — device keyset, api client, gate store — is
 * assembled here via `buildSendProfileDeps`, the same shape
 * `onDeliberateDmSend` already uses for the same reason.
 */
export async function autoRevealOnInboundSession(
  partnerAddress: string,
  payload: DMProfilePayload,
  deps: DMBroadcastDeps,
  getMessages: (p: {
    spaceId: string;
    channelId: string;
    limit?: number;
  }) => Promise<{ messages: Partial<Message>[] }>,
): Promise<void> {
  try {
    const now = Date.now();
    const last = autoRevealLastFired.get(partnerAddress) ?? 0;
    if (now - last < AUTO_REVEAL_DEBOUNCE_MS) return;

    const revealed = await ensureRevealBootstrap(payload.selfAddress, partnerAddress, getMessages);
    if (!revealed) return;

    // Set the debounce stamp BEFORE the send below has even started, not
    // after it succeeds. Tradeoff, taken deliberately: a transient failure
    // here (no device keyset yet, registration fetch/API-client construction
    // failure inside buildSendProfileDeps or sendProfileToPartner) costs a
    // real, legitimate first reveal for up to an hour, because the next
    // redelivery of the same init envelope will be debounced away too. The
    // alternative — stamping only after a confirmed send — would let a
    // redelivery storm re-attempt on every single envelope while the failure
    // persists, which is exactly the push-storm this debounce exists to
    // prevent. Fails SAFE either way (a missed reveal, never a leak), and
    // the reply trigger plus the on-connect sweep are independent backstops
    // that do not depend on this timestamp at all.
    autoRevealLastFired.set(partnerAddress, now);
    // The gate may hold "already announced 3x" from before this session
    // existed — that record is about OLD sessions and must not gag the new one.
    clearDmProfileBroadcastState(payload.selfAddress, partnerAddress);

    const sendDeps = await buildSendProfileDeps(deps);
    if (!sendDeps) return;
    await sendProfileToPartner(partnerAddress, payload, sendDeps);
  } catch {
    // Best-effort. The reply trigger and on-connect sweep remain as backstops.
  }
}

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

  // Built once, threaded through every partner in this sweep — see
  // buildSendProfileDeps and SendProfileDeps's doc comments for why this is
  // not a per-partner cost.
  const sendDeps = await buildSendProfileDeps(deps);
  if (!sendDeps) return;

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

  let sent = 0;

  for (const conv of partners) {
    const partnerAddress = conv.address;
    // Skip rows we can't DM: missing address, ourselves, or Farcaster threads
    // (not E2EE DM sessions — an encrypted control message is meaningless there).
    if (!partnerAddress || partnerAddress === payload.selfAddress) continue;
    if (conv.source === 'farcaster') continue;

    // Privacy: identity goes only to partners this user has DELIBERATELY
    // messaged. A conversation row is created by a stranger's inbound
    // message, so having a row is not consent — the reveal ledger is.
    const revealed = await ensureRevealBootstrap(
      payload.selfAddress,
      partnerAddress,
      (p) => adapter.getMessages(p),
    );
    if (!revealed) continue;

    if (await sendProfileToPartner(partnerAddress, payload, sendDeps)) sent += 1;
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
