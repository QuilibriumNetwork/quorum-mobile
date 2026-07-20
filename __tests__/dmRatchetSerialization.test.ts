/**
 * Serialization test for DM Double Ratchet state operations.
 *
 * The KeyedMutex logic itself is unit-tested in quorum-shared. This test proves
 * MOBILE's wiring: that encryptionService.decryptMessage actually routes its
 * read-state -> ratchet-op -> save-state critical section through the shared
 * ratchetMutex, so two operations racing on the SAME conversation can't fork
 * the ratchet (the desktop "DM never arrives" bug), while operations on
 * DIFFERENT conversations still run concurrently.
 *
 * The model: ratchet state is a monotonically increasing counter stored as a
 * string. Each decrypt reads the current state, yields to the event loop (the
 * real native call is async — this is the interleaving window), then saves
 * state+1. Serialized => 0 -> 1 -> 2. Forked (no lock) => both read 0, both
 * save 1, one advance silently lost.
 *
 * Only the two boundaries are mocked (the native crypto provider and the MMKV
 * state store); the real encryption-service and the real ratchetMutex run.
 */

const textEncoder = new TextEncoder();

// --- in-memory ratchet state store, keyed by `${conversationId}::${inboxId}` ---
const store = new Map<string, { state: string; inboxId: string; conversationId: string }>();
const key = (conversationId: string, inboxId: string) => `${conversationId}::${inboxId}`;

const mockGetEncryptionState = jest.fn((conversationId: string, inboxId: string) => {
  return store.get(key(conversationId, inboxId)) ?? null;
});
const mockSaveEncryptionState = jest.fn(
  (newState: { state: string; inboxId: string; conversationId: string }) => {
    store.set(key(newState.conversationId, newState.inboxId), newState);
  },
);

jest.mock('../services/crypto/encryption-state-storage', () => ({
  encryptionStateStorage: {
    getEncryptionState: (c: string, i: string) => mockGetEncryptionState(c, i),
    saveEncryptionState: (s: { state: string; inboxId: string; conversationId: string }) =>
      mockSaveEncryptionState(s),
  },
}));

// deriveAddress is imported at module top of encryption-service but unused on
// the decrypt path — stub it so the module loads.
jest.mock('../services/onboarding/keyService', () => ({
  deriveAddress: jest.fn(() => 'addr'),
}));

// Concurrency gauge — records the peak number of decrypts in flight at once.
// Deterministic (no wall-clock assertions): serialized ops peak at 1, truly
// concurrent ops peak at 2.
const gauge = { inFlight: 0, max: 0 };

// Native provider: decrypt reads the incoming ratchet_state counter, waits a
// tick (forces interleaving if unserialized), and returns state+1 with a
// non-empty plaintext so decryptMessage treats it as a success.
const mockDoubleRatchetDecrypt = jest.fn(
  async (arg: { ratchet_state: string; envelope: string }) => {
    gauge.inFlight += 1;
    gauge.max = Math.max(gauge.max, gauge.inFlight);
    const current = Number(arg.ratchet_state);
    await new Promise((r) => setTimeout(r, 5)); // interleaving window
    gauge.inFlight -= 1;
    return {
      ratchet_state: String(current + 1),
      message: Array.from(textEncoder.encode('ok')),
    };
  },
);
jest.mock('../services/crypto/native-provider', () => ({
  // Method (not a field) so the lookup of mockDoubleRatchetDecrypt is deferred
  // to call-time. The encryptionService singleton is constructed at import,
  // before the test's mock fn is assigned, so eager field capture would bind
  // undefined.
  NativeCryptoProvider: class {
    doubleRatchetDecrypt(arg: { ratchet_state: string; envelope: string }) {
      return mockDoubleRatchetDecrypt(arg);
    }
  },
}));

import { encryptionService } from '../services/crypto/encryption-service';

function seed(conversationId: string, inboxId: string) {
  store.set(key(conversationId, inboxId), { state: '0', inboxId, conversationId });
}

beforeEach(() => {
  store.clear();
  gauge.inFlight = 0;
  gauge.max = 0;
  mockDoubleRatchetDecrypt.mockClear();
  mockGetEncryptionState.mockClear();
  mockSaveEncryptionState.mockClear();
});

test('concurrent decrypts on the SAME conversation are serialized (no forked ratchet)', async () => {
  const conv = 'alice/alice';
  const inbox = 'inbox-1';
  seed(conv, inbox);

  // Fire both without awaiting the first — they race for the same ratchet.
  await Promise.all([
    encryptionService.decryptMessage(conv, inbox, 'env-a'),
    encryptionService.decryptMessage(conv, inbox, 'env-b'),
  ]);

  // Serialized: 0 -> 1 -> 2. Forked: both read 0, final state stuck at 1.
  expect(store.get(key(conv, inbox))?.state).toBe('2');

  // The second op must have READ the state the first one SAVED (value '1'),
  // never the stale '0' twice.
  const seenInputs = mockDoubleRatchetDecrypt.mock.calls
    .map((c) => c[0].ratchet_state)
    .sort();
  expect(seenInputs).toEqual(['0', '1']);

  // Never more than one ratchet op in flight for this conversation.
  expect(gauge.max).toBe(1);
});

test('decrypts on DIFFERENT conversations still run concurrently', async () => {
  const inbox = 'inbox-1';
  seed('alice/alice', inbox);
  seed('bob/bob', inbox);

  await Promise.all([
    encryptionService.decryptMessage('alice/alice', inbox, 'env-a'),
    encryptionService.decryptMessage('bob/bob', inbox, 'env-b'),
  ]);

  // Each conversation advances independently 0 -> 1.
  expect(store.get(key('alice/alice', inbox))?.state).toBe('1');
  expect(store.get(key('bob/bob', inbox))?.state).toBe('1');

  // Different keys don't block each other: both ops overlap in flight.
  expect(gauge.max).toBe(2);
});
