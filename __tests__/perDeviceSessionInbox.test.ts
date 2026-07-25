/**
 * One conversation inbox PER SESSION (per peer device), never one per conversation.
 *
 * State rows are keyed `(conversationId, inboxId)`, so the inbox a session
 * advertises IS its row key. Sharing one conversation-wide inbox made every
 * device of a peer re-initialize into the SAME row: last writer won and the
 * other devices' sessions were silently destroyed, losing every message to
 * them. A phone plus a laptop is enough to trigger it.
 *
 * These tests drive the real resolver against the real storage class (MMKV
 * replaced with a map). What they stand in for is `establishSession`'s row
 * write, which needs native crypto: the harness below writes the row with the
 * same `inboxId` production uses — the resolved return inbox address.
 */

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

jest.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

// Saving a keypair schedules a debounced push re-registration; keep it inert.
jest.mock('../services/notifications/pushRegistration', () => ({
  registerPushTokenWithQuorum: jest.fn(async () => {}),
}));

// Address = base58 multihash of the Ed448 key in production; here just a
// readable function of the key so rows are easy to assert on.
jest.mock('@/services/onboarding/keyService', () => ({
  deriveAddress: (key: Uint8Array) => `Qm-inbox-${key[0]}`,
}));

import { encryptionStateStorage, type EncryptionState } from '../services/crypto/encryption-state-storage';
import {
  mintSessionReturnInbox,
  resolveSessionReturnInbox,
  sessionReturnInbox,
  type InboxKeyGenerator,
} from '../services/crypto/sessionReturnInbox';

const CONV = 'QmPeer/QmPeer';
const DEVICE_A = 'QmPeerDeviceA';
const DEVICE_B = 'QmPeerDeviceB';

/** Deterministic stand-in for NativeCryptoProvider's keygen. */
function keyGenerator(): InboxKeyGenerator {
  let n = 0;
  return {
    generateX448: async () => ({ public_key: [++n, 0], private_key: [n, 1] }),
    generateEd448: async () => ({ public_key: [++n, 2], private_key: [n, 3] }),
  };
}
let generator: InboxKeyGenerator;

/** An unconfirmed session row for `device` — the state that forces a re-init. */
const unconfirmedRow = (inboxId: string, device: string): EncryptionState => ({
  state: `ratchet-${device}`,
  timestamp: Date.now(),
  conversationId: CONV,
  inboxId,
  sentAccept: false,
  tag: device,
  sendingInbox: {
    inbox_address: `${device}-inbox`,
    inbox_encryption_key: 'aabb',
    inbox_public_key: '', // unconfirmed
    inbox_private_key: '',
  },
});

/**
 * What a re-init does: resolve the session's return inbox, then write the row
 * keyed by it (production does the write inside establishSession).
 */
async function reinit(device: string, existing?: EncryptionState) {
  const { inbox, minted } = await resolveSessionReturnInbox(CONV, existing, generator);
  encryptionStateStorage.saveEncryptionState(unconfirmedRow(inbox.inboxAddress, device), false, true);
  return { inbox, minted };
}

const rowsByTag = () => {
  const out = new Map<string, EncryptionState>();
  for (const s of encryptionStateStorage.getEncryptionStates(CONV)) out.set(s.tag!, s);
  return out;
};

beforeEach(() => {
  mockBacking.clear();
  generator = keyGenerator();
  // Keeps the storage layer's batch timer and the debounced push
  // re-registration off the real clock (the latter outlives the run otherwise).
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('a session advertises its OWN inbox', () => {
  it('reuses the inbox the session row is keyed by', async () => {
    const minted = await mintSessionReturnInbox(CONV, generator);
    const row = unconfirmedRow(minted.inboxAddress, DEVICE_A);

    expect(sessionReturnInbox(row)?.inboxAddress).toBe(minted.inboxAddress);
  });

  it('mints instead of reusing when the row has no inboxId', () => {
    expect(sessionReturnInbox({ inboxId: undefined })).toBeNull();
    expect(sessionReturnInbox(null)).toBeNull();
  });

  it('mints instead of reusing when we no longer hold the row inbox keys', () => {
    // A row written before per-address keypairs existed (#177): its keypair
    // lived only in the last-writer-wins per-conversation slot and is gone.
    expect(sessionReturnInbox(unconfirmedRow('QmForgottenInbox', DEVICE_A))).toBeNull();
  });

  it('mints instead of reusing a keyset with no Ed448 half', async () => {
    // Without signing keys the peer cannot confirm the session, so it would
    // re-initialize forever.
    encryptionStateStorage.saveConversationInboxKeypair({
      conversationId: CONV,
      inboxAddress: 'QmEncryptionOnly',
      encryptionPublicKey: [1],
      encryptionPrivateKey: [2],
    });

    expect(sessionReturnInbox(unconfirmedRow('QmEncryptionOnly', DEVICE_A))).toBeNull();
  });
});

describe('two devices of one peer', () => {
  it('get two distinct inboxes and two distinct rows', async () => {
    const a = await reinit(DEVICE_A);
    const b = await reinit(DEVICE_B);

    expect(a.inbox.inboxAddress).not.toBe(b.inbox.inboxAddress);
    expect(rowsByTag().size).toBe(2);
    expect(rowsByTag().get(DEVICE_A)!.inboxId).toBe(a.inbox.inboxAddress);
    expect(rowsByTag().get(DEVICE_B)!.inboxId).toBe(b.inbox.inboxAddress);
  });

  it('re-initializing device A never overwrites device B row', async () => {
    const a = await reinit(DEVICE_A);
    const b = await reinit(DEVICE_B);
    const bRatchetBefore = rowsByTag().get(DEVICE_B)!.state;

    // Device A re-initializes again, reusing its own inbox.
    const again = await reinit(DEVICE_A, rowsByTag().get(DEVICE_A));

    expect(again.minted).toBe(false);
    expect(again.inbox.inboxAddress).toBe(a.inbox.inboxAddress);
    expect(rowsByTag().size).toBe(2);
    expect(rowsByTag().get(DEVICE_B)!.inboxId).toBe(b.inbox.inboxAddress);
    expect(rowsByTag().get(DEVICE_B)!.state).toBe(bRatchetBefore);
  });

  it('REGRESSION: one shared inbox collapses both devices onto one row', async () => {
    // The pre-fix behaviour, spelled out: both devices re-initializing into the
    // same conversation-wide inbox leaves ONE row. Device A survives only
    // because it was written last; B session is destroyed and its messages lost.
    const shared = await mintSessionReturnInbox(CONV, generator);
    encryptionStateStorage.saveEncryptionState(unconfirmedRow(shared.inboxAddress, DEVICE_B), false, true);
    encryptionStateStorage.saveEncryptionState(unconfirmedRow(shared.inboxAddress, DEVICE_A), false, true);

    expect(encryptionStateStorage.getEncryptionStates(CONV)).toHaveLength(1);
    expect(rowsByTag().has(DEVICE_B)).toBe(false);
  });
});

describe('resolution is idempotent and preserves routing', () => {
  it('returns the same inbox on every later send', async () => {
    const first = await reinit(DEVICE_A);
    const second = await resolveSessionReturnInbox(CONV, rowsByTag().get(DEVICE_A), generator);
    const third = await resolveSessionReturnInbox(CONV, rowsByTag().get(DEVICE_A), generator);

    expect(second.inbox.inboxAddress).toBe(first.inbox.inboxAddress);
    expect(third.inbox.inboxAddress).toBe(first.inbox.inboxAddress);
    expect(second.minted).toBe(false);
    expect(third.minted).toBe(false);
  });

  it('maps every session inbox to the conversation, and never unmaps one', async () => {
    const a = await reinit(DEVICE_A);
    const b = await reinit(DEVICE_B);

    // A stale row whose keypair is gone re-initializes onto a fresh inbox —
    // the migration path — without disturbing the older mappings, because the
    // peer may still be writing to them (desktop #252).
    const migrated = await reinit(DEVICE_A, unconfirmedRow('QmForgottenInbox', DEVICE_A));
    expect(migrated.minted).toBe(true);
    expect(migrated.inbox.inboxAddress).not.toBe(a.inbox.inboxAddress);

    for (const addr of [a.inbox.inboxAddress, b.inbox.inboxAddress, migrated.inbox.inboxAddress]) {
      expect(encryptionStateStorage.getInboxMapping(addr)?.conversationId).toBe(CONV);
    }
  });

  it('exposes every per-device inbox for subscription and push registration', async () => {
    const a = await reinit(DEVICE_A);
    const b = await reinit(DEVICE_B);

    // Both must be covered: a peer replying to the inbox we advertised is
    // unheard if we are not subscribed and unregistered for push there.
    expect(encryptionStateStorage.getAllConversationInboxAddresses()).toEqual(
      expect.arrayContaining([a.inbox.inboxAddress, b.inbox.inboxAddress]),
    );
  });
});
