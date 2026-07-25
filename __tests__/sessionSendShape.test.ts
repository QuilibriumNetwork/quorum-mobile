/**
 * The frame shape a session must send, and the bookkeeping behind it.
 *
 * The receiver demands a shape based on ITS session, not ours: while its
 * `sending_inbox.inbox_public_key` is empty it takes
 * ConfirmDoubleRatchetSenderSession, which throws on a plain frame. So until
 * the peer has our return inbox, every plain frame we send is discarded — the
 * "permanently one-way after a reset" failure.
 *
 * Mobile used to answer "do I know THEIR inbox?"; the SDK answers "have I told
 * them MINE?" (`sent_accept`). These tests pin that question and the two ways
 * mobile answers it — one on receive, one on send — landing on one meaning.
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
jest.mock('../services/notifications/pushRegistration', () => ({
  registerPushTokenWithQuorum: jest.fn(async () => {}),
}));
jest.mock('@/services/onboarding/keyService', () => ({ deriveAddress: () => 'Qm-addr' }));
jest.mock('../services/crypto/native-provider', () => ({ NativeCryptoProvider: class {} }));

import { sessionSendShape } from '../services/crypto/sessionSendShape';
import { encryptionService } from '../services/crypto/encryption-service';
import { encryptionStateStorage, type EncryptionState } from '../services/crypto/encryption-state-storage';

const CONV = 'QmPeer/QmPeer';
const INBOX = 'QmOurSessionInbox';

/** A session WE opened: we hold their device inbox, not their return inbox. */
const unconfirmedSender = (over: Partial<EncryptionState> = {}): EncryptionState => ({
  state: 'ratchet-0',
  timestamp: 1,
  conversationId: CONV,
  inboxId: INBOX,
  sentAccept: false,
  sendingInbox: {
    inbox_address: 'QmTheirDeviceInbox',
    inbox_encryption_key: 'aabb',
    inbox_public_key: '', // they have not replied yet
    inbox_private_key: '',
  },
  ...over,
});

/** A session THEY opened: their init envelope gave us their full keyset. */
const recipientSession = (over: Partial<EncryptionState> = {}): EncryptionState => ({
  ...unconfirmedSender(),
  sendingInbox: {
    inbox_address: 'QmTheirConversationInbox',
    inbox_encryption_key: 'aabb',
    inbox_public_key: 'ccdd',
    inbox_private_key: 'eeff',
  },
  ...over,
});

beforeEach(() => {
  mockBacking.clear();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('which shape a session sends', () => {
  it('keeps announcing while the peer has not replied', () => {
    expect(sessionSendShape(unconfirmedSender())).toBe('init');
  });

  it('still announces even if sentAccept was somehow set', () => {
    // Their inbox is unknown, so there is nowhere a plain frame could land.
    expect(sessionSendShape(unconfirmedSender({ sentAccept: true }))).toBe('init');
  });

  it('sends the accept on a session the peer opened', () => {
    // The regression this whole task is about: mobile used to call this 'plain'
    // because their inbox key was known, and the peer dropped every frame.
    expect(sessionSendShape(recipientSession())).toBe('accept');
  });

  it('sends plain once our return inbox is known to be out there', () => {
    expect(sessionSendShape(recipientSession({ sentAccept: true }))).toBe('plain');
  });

  it('reports unsendable with nothing to seal to', () => {
    expect(sessionSendShape(undefined)).toBe('unsendable');
    expect(sessionSendShape({})).toBe('unsendable');
    expect(sessionSendShape({ sendingInbox: { inbox_encryption_key: '' } })).toBe('unsendable');
  });
});

describe('a recipient session announces once, then goes plain', () => {
  it('first reply is the accept, second is plain', async () => {
    encryptionStateStorage.saveEncryptionState(recipientSession(), false, true);

    const first = encryptionStateStorage.getEncryptionState(CONV, INBOX)!;
    expect(sessionSendShape(first)).toBe('accept');

    await encryptionService.markAcceptSent(CONV, INBOX);

    const second = encryptionStateStorage.getEncryptionState(CONV, INBOX)!;
    expect(sessionSendShape(second)).toBe('plain');
  });

  it('never regresses the ratchet when flipping the flag', async () => {
    // The flag write re-reads inside the lock; a send may have advanced the
    // state in between, and writing back a stale snapshot would desync a
    // ratchet whose frame is already on the wire (see #178).
    encryptionStateStorage.saveEncryptionState(recipientSession(), false, true);
    encryptionStateStorage.saveEncryptionState(
      recipientSession({ state: 'ratchet-7', timestamp: 2 }),
      false,
      true,
    );

    await encryptionService.markAcceptSent(CONV, INBOX);

    const row = encryptionStateStorage.getEncryptionState(CONV, INBOX)!;
    expect(row.state).toBe('ratchet-7');
    expect(row.sentAccept).toBe(true);
  });

  it('is idempotent, and leaves the rest of the row alone', async () => {
    encryptionStateStorage.saveEncryptionState(recipientSession(), false, true);

    await encryptionService.markAcceptSent(CONV, INBOX);
    await encryptionService.markAcceptSent(CONV, INBOX);

    const row = encryptionStateStorage.getEncryptionState(CONV, INBOX)!;
    expect(row.sentAccept).toBe(true);
    expect(row.sendingInbox).toEqual(recipientSession().sendingInbox);
    expect(row.state).toBe('ratchet-0');
  });

  it('does nothing for a session that no longer exists', async () => {
    await expect(encryptionService.markAcceptSent(CONV, 'QmGone')).resolves.toBeUndefined();
    expect(encryptionStateStorage.getEncryptionState(CONV, 'QmGone')).toBeNull();
  });
});

describe('the two ways sentAccept gets set converge', () => {
  it('a session confirmed on RECEIVE sends plain, same as one accepted on SEND', async () => {
    // Mobile sets the flag in two unrelated places and they must mean one
    // thing: "the peer has our return inbox".
    //
    // 1. confirmSenderSession — the peer replied to the inbox we advertised,
    //    which is proof they had it. It writes sentAccept: true and fills
    //    sendingInbox from their envelope.
    const confirmedOnReceive: EncryptionState = {
      ...unconfirmedSender(),
      sentAccept: true,
      sendingInbox: {
        inbox_address: 'QmTheirConversationInbox',
        inbox_encryption_key: 'aabb',
        inbox_public_key: 'ccdd',
        inbox_private_key: 'eeff',
      },
    };

    // 2. markAcceptSent — we just put our return inbox on the wire.
    encryptionStateStorage.saveEncryptionState(recipientSession(), false, true);
    await encryptionService.markAcceptSent(CONV, INBOX);
    const acceptedOnSend = encryptionStateStorage.getEncryptionState(CONV, INBOX)!;

    expect(sessionSendShape(confirmedOnReceive)).toBe('plain');
    expect(sessionSendShape(acceptedOnSend)).toBe('plain');
  });

  it('a fresh session from either direction starts unaccepted', () => {
    // encryptMessageForNewDevice and initializeRecipientSession both write
    // sentAccept: false, so neither can skip its announcement.
    expect(sessionSendShape(unconfirmedSender({ sentAccept: undefined }))).toBe('init');
    expect(sessionSendShape(recipientSession({ sentAccept: undefined }))).toBe('accept');
  });
});
