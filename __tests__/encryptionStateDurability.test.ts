/**
 * EncryptionStateStorage write-batching invariants.
 *
 * Ratchet state is the one piece of DM state that must never regress or
 * resurrect: a frame encrypted at position N is already on the wire, so a
 * stored state that goes back to N-1 (or a deleted session that comes back)
 * desynchronizes the pairing permanently — every later frame fails AEAD and
 * only a manual "reset encryption session" recovers it.
 *
 * The storage layer batches writes (100ms / 10 updates) to keep MMKV off the
 * hot path. These tests pin the invariants that batching must preserve.
 */

// Real MMKV replaced with an in-memory map; everything else is the real class.
const mockBacking = new Map<string, string>();
jest.mock('@/services/storage/mirroredMMKV', () => ({
  createMirroredMMKV: () => ({
    getString: (k: string) => mockBacking.get(k),
    set: (k: string, v: string) => void mockBacking.set(k, v),
    remove: (k: string) => void mockBacking.delete(k),
    getAllKeys: () => [...mockBacking.keys()],
    clearAll: () => mockBacking.clear(),
  }),
}));

// Capture the storage module's AppState subscription so tests can drive it.
// The listener array lives INSIDE the factory: the storage singleton is built
// during import, which runs this factory before any module-scope const in this
// file is initialized.
jest.mock('react-native', () => {
  const listeners: ((s: string) => void)[] = [];
  return {
    AppState: {
      addEventListener: (_event: string, cb: (s: string) => void) => {
        listeners.push(cb);
        return { remove: () => {} };
      },
      __listeners: listeners,
    },
  };
});

import { encryptionStateStorage, type EncryptionState } from '../services/crypto/encryption-state-storage';

/** Simulate the app going to the background. */
const backgroundApp = () => {
  const { AppState } = jest.requireMock('react-native') as {
    AppState: { __listeners: ((s: string) => void)[] };
  };
  expect(AppState.__listeners.length).toBeGreaterThan(0); // storage must subscribe
  AppState.__listeners.forEach((cb) => cb('background'));
};

const CONV = 'QmPeer/QmPeer';
const INBOX = 'QmOurConversationInbox';
const stateKey = `enc_state:${CONV}:${INBOX}`;

const row = (ratchet: string): EncryptionState =>
  ({ state: ratchet, timestamp: Date.now(), conversationId: CONV, inboxId: INBOX, sentAccept: true }) as EncryptionState;

/** What is actually durable on disk right now (ignores the in-process queue). */
const onDisk = () => {
  const raw = mockBacking.get(stateKey);
  return raw ? (JSON.parse(raw) as EncryptionState).state : null;
};

beforeEach(() => {
  mockBacking.clear();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe('EncryptionStateStorage batching invariants', () => {
  it('does not resurrect a deleted session when a queued write flushes afterwards', () => {
    encryptionStateStorage.saveEncryptionState(row('ratchet-1'), false);

    // Reset the session while that write is still queued.
    encryptionStateStorage.deleteAllEncryptionStates(CONV);
    expect(encryptionStateStorage.getEncryptionState(CONV, INBOX)).toBeNull();

    // The batch timer fires.
    jest.advanceTimersByTime(200);

    expect(onDisk()).toBeNull();
    expect(encryptionStateStorage.getEncryptionState(CONV, INBOX)).toBeNull();
  });

  it('does not let a stale queued write overwrite a newer immediate write', () => {
    encryptionStateStorage.saveEncryptionState(row('ratchet-1'), false); // queued
    encryptionStateStorage.saveEncryptionState(row('ratchet-2'), false, true); // immediate

    expect(onDisk()).toBe('ratchet-2');
    jest.advanceTimersByTime(200);
    expect(onDisk()).toBe('ratchet-2');
  });

  it('makes a queued ratchet advance durable when the app leaves the foreground', () => {
    // Batching is deliberate, but the frame encrypted at this position is
    // ALREADY on the wire. Backgrounding freezes JS timers on Android, so the
    // queued flush may never run before the process is reaped.
    encryptionStateStorage.saveEncryptionState(row('ratchet-1'), false);
    expect(onDisk()).toBeNull(); // batched, not yet durable

    backgroundApp();
    expect(onDisk()).toBe('ratchet-1');
  });
});
