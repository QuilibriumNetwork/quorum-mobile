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
import { broadcastProfileToAllDMs } from '../services/dm/dmProfileService';
import { clearReveal } from '../services/dm/dmRevealLedger';

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
    getMessages: jest.fn(async ({ spaceId }: { spaceId: string }) => ({
      messages: spaceId === FRIEND ? [{ content: { senderId: SELF } }] : [{ content: { senderId: STRANGER } }],
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
