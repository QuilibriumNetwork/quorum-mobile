/**
 * The on-connect/on-rename broadcast sweep must not push identity to a
 * partner we never deliberately messaged. A conversation row is created by a
 * stranger's INBOUND message, so "has a row" is not consent — the ledger is.
 *
 * Only the boundaries are mocked (wire send, registration fetch, device
 * keyset, storage adapter). The real reveal-ledger bootstrap
 * (`ensureRevealBootstrap`) runs unmocked, deriving consent from the mocked
 * message history exactly as it would from real local history.
 */
import {
  broadcastProfileToAllDMs,
  onDeliberateDmSend,
  autoRevealOnInboundSession,
  __resetAutoRevealDebounce,
  buildSendProfileDeps,
  sendProfileToPartner,
} from '../services/dm/dmProfileService';
import { clearReveal, hasRevealedTo, recordReveal } from '../services/dm/dmRevealLedger';
import { MAX_SENDS_PER_IDENTITY, RESEND_INTERVAL_MS } from '../services/dm/dmProfileGate';

const SELF = 'QmMeMeMeEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const FRIEND = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const STRANGER = 'QmThemThemVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzz';

// Prefixed `mock` deliberately: jest's module-factory hoisting only allows
// referencing out-of-scope identifiers from inside jest.mock() when the name
// starts with "mock" (case-insensitive) — a bare `sendSpy` throws
// "module factory... not allowed to reference any out-of-scope variables" at
// transform time, before a single test runs.
const mockSendSpy = jest.fn().mockResolvedValue(undefined);

jest.mock('@/hooks/chat/useSendDirectMessage', () => ({
  sendEncryptedMessageToAllDevices: (...args: unknown[]) => mockSendSpy(...args),
}));
jest.mock('@/hooks/chat/useRecipientRegistration', () => ({
  toAllDeviceInfos: () => [
    { identityKey: [1], signedPreKey: [1], inboxAddress: 'inbox-x', inboxEncryptionKey: [1] },
  ],
}));
jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({ fetchUserRegistration: jest.fn().mockResolvedValue({ devices: [{}] }) }),
}));
jest.mock('@/services/storage/mmkvAdapter', () => ({
  getMMKVAdapter: () => ({
    getConversations: jest.fn().mockResolvedValue({
      conversations: [
        { address: FRIEND, conversationId: `${FRIEND}/${FRIEND}`, type: 'direct' },
        { address: STRANGER, conversationId: `${STRANGER}/${STRANGER}`, type: 'direct' },
      ],
    }),
    // Bootstrap history: we authored a message with FRIEND, none with STRANGER.
    // Keyed on `authenticatedSenderId` — the marker stamped at persist time
    // from the crypto layer — NOT on content.senderId, which any sender writes.
    getMessages: jest.fn(async ({ spaceId }: { spaceId: string }) => ({
      messages:
        spaceId === FRIEND
          ? [{ authenticatedSenderId: SELF }]
          : [{ authenticatedSenderId: STRANGER }],
    })),
  }),
}));
// dmProfileService.ts imports getDeviceKeyset statically from this module
// (not via dynamic import like the three above), but jest.mock matches on
// resolved file identity, not on which import form the source used — same
// pattern signOutTeardownOrder.test.tsx uses for the same module. Only the
// three fields the sweep actually reads (identityPublicKey, inboxAddress,
// inboxEncryptionPublicKey) are provided.
jest.mock('@/services/onboarding/secureStorage', () => ({
  getDeviceKeyset: jest.fn().mockResolvedValue({
    identityPublicKey: [9],
    inboxAddress: 'self-inbox',
    inboxEncryptionPublicKey: [9],
  }),
}));

describe('broadcast sweep x reveal ledger', () => {
  beforeEach(() => {
    mockSendSpy.mockClear();
    clearReveal(SELF);
  });

  it('sends to the revealed friend and SKIPS the never-replied stranger', async () => {
    await broadcastProfileToAllDMs(
      { selfAddress: SELF, displayName: 'Me', userIcon: 'icon' },
      { enqueueOutbound: jest.fn(), subscribe: jest.fn() },
    );
    const targets = mockSendSpy.mock.calls.map((c) => c[1]);
    expect(targets).toContain(FRIEND);
    expect(targets).not.toContain(STRANGER); // <- the control arm
  });
});

describe('reveal-on-reply', () => {
  beforeEach(() => {
    mockSendSpy.mockClear();
    clearReveal(SELF);
  });

  it('first deliberate send: sets the ledger and fires exactly one identity push', async () => {
    const deps = { enqueueOutbound: jest.fn(), subscribe: jest.fn() };

    await onDeliberateDmSend(STRANGER, { selfAddress: SELF, displayName: 'Me', userIcon: 'icon' }, deps);
    expect(hasRevealedTo(SELF, STRANGER)).toBe(true);
    expect(mockSendSpy).toHaveBeenCalledTimes(1);

    // Second send in the same conversation: ledger already set -> no further push.
    // This is the dedup arm — a version that pushed on every send would still
    // pass the first half of this test but fail here.
    await onDeliberateDmSend(STRANGER, { selfAddress: SELF, displayName: 'Me', userIcon: 'icon' }, deps);
    expect(mockSendSpy).toHaveBeenCalledTimes(1);
  });
});

describe('auto-reveal on inbound new session', () => {
  beforeEach(() => {
    mockSendSpy.mockClear();
    clearReveal(SELF);
    __resetAutoRevealDebounce();
  });

  it('announces immediately to a REVEALED partner (friend on a new device)', async () => {
    recordReveal(SELF, FRIEND, 1_000);
    await autoRevealOnInboundSession(FRIEND, payload(), deps(), historyWithSelfMessage());
    expect(mockSendSpy).toHaveBeenCalledTimes(1);
  });

  it('stays SILENT for a stranger opening a session at us', async () => {
    await autoRevealOnInboundSession(STRANGER, payload(), deps(), inboundOnlyHistory());
    expect(mockSendSpy).not.toHaveBeenCalled(); // ← the control arm
  });

  it('debounces per partner: a redelivered init envelope fires no second push', async () => {
    recordReveal(SELF, FRIEND, 1_000);
    await autoRevealOnInboundSession(FRIEND, payload(), deps(), historyWithSelfMessage());
    await autoRevealOnInboundSession(FRIEND, payload(), deps(), historyWithSelfMessage());
    expect(mockSendSpy).toHaveBeenCalledTimes(1);
  });

  // Task 6 gap: clearDmProfileBroadcastState-on-transition had no test that
  // could catch its own regression. autoRevealOnInboundSession clears the
  // same per-partner send-gate on its own trigger, so this exercises that
  // clear through a real exhausted gate rather than reaching into storage
  // internals: three real sends (the gate's own MAX_SENDS_PER_IDENTITY cap)
  // exhaust it, a fourth is refused, then the auto-reveal path still gets
  // through because it clears the exhausted record first.
  it('clears an exhausted send-gate on the auto-reveal path too', async () => {
    recordReveal(SELF, FRIEND, 1_000);
    const p = payload();
    const baseDeps = await buildSendProfileDeps(deps());
    expect(baseDeps).not.toBeNull();
    if (!baseDeps) return;

    let t = 1_000;
    for (let i = 0; i < MAX_SENDS_PER_IDENTITY; i++) {
      await sendProfileToPartner(FRIEND, p, { ...baseDeps, now: t });
      t += RESEND_INTERVAL_MS;
    }
    mockSendSpy.mockClear();

    // Confirm the gate really is exhausted before leaning on it: a
    // same-signature send at the same cadence is refused.
    const blocked = await sendProfileToPartner(FRIEND, p, { ...baseDeps, now: t });
    expect(blocked).toBe(false);
    expect(mockSendSpy).not.toHaveBeenCalled();

    await autoRevealOnInboundSession(FRIEND, p, deps(), historyWithSelfMessage());
    expect(mockSendSpy).toHaveBeenCalledTimes(1);
  });
});

function payload() {
  return { selfAddress: SELF, displayName: 'Me', userIcon: 'icon' };
}
function deps() {
  return { enqueueOutbound: jest.fn(), subscribe: jest.fn() };
}
function historyWithSelfMessage() {
  return async () => ({ messages: [{ authenticatedSenderId: SELF }] });
}
function inboundOnlyHistory() {
  return async () => ({ messages: [{ authenticatedSenderId: STRANGER }] });
}
/**
 * A stranger's message that CLAIMS we wrote it — the forgery. Its payload names
 * us; the crypto layer says otherwise, and the marker records the crypto layer.
 * History like this must never bootstrap a reveal.
 */
function forgedHistory() {
  return async () => ({
    messages: [{ content: { senderId: SELF }, authenticatedSenderId: STRANGER }],
  });
}
