/**
 * confirmSenderSession — mobile port of the SDK's
 * ConfirmDoubleRatchetSenderSession. The crypto calls are existing primitives
 * (mocked here); what these tests pin is the NEW logic: the guards, the SDK
 * field validation, and the confirmed-state bookkeeping.
 */

const mockStore = new Map<string, Record<string, unknown>>();
const mockKey = (c: string, i: string) => `${c}::${i}`;

const mockSaveEncryptionState = jest.fn(
  (s: { conversationId: string; inboxId: string }) => {
    mockStore.set(mockKey(s.conversationId, s.inboxId), s);
  },
);
const mockSaveInboxMapping = jest.fn();

jest.mock('../services/crypto/encryption-state-storage', () => ({
  encryptionStateStorage: {
    getEncryptionState: (c: string, i: string) => mockStore.get(mockKey(c, i)) ?? null,
    saveEncryptionState: (s: { conversationId: string; inboxId: string }) => mockSaveEncryptionState(s),
    saveInboxMapping: (inbox: string, conv: string) => mockSaveInboxMapping(inbox, conv),
  },
}));

jest.mock('../services/onboarding/keyService', () => ({
  deriveAddress: jest.fn(() => 'addr'),
}));

let mockDecryptImpl: (arg: { ratchet_state: string; envelope: string }) => Promise<{
  ratchet_state: string;
  message: number[];
  decryptionError?: string;
}>;
jest.mock('../services/crypto/native-provider', () => ({
  NativeCryptoProvider: class {
    doubleRatchetDecrypt(arg: { ratchet_state: string; envelope: string }) {
      return mockDecryptImpl(arg);
    }
  },
}));

import { encryptionService } from '../services/crypto/encryption-service';

const CONV = 'QmPeer/QmPeer';
const INBOX = 'QmOurConversationInbox';

const textEncoder = new TextEncoder();
const okDecrypt = async () => ({
  ratchet_state: 'advanced-state',
  message: Array.from(textEncoder.encode('{"messageId":"m1"}')),
});

function seedUnconfirmed() {
  mockStore.set(mockKey(CONV, INBOX), {
    state: 'ratchet-0',
    timestamp: 1,
    conversationId: CONV,
    inboxId: INBOX,
    sentAccept: false,
    sendingInbox: {
      inbox_address: 'QmPeerDeviceInbox',
      inbox_encryption_key: 'enckey',
      inbox_public_key: '', // UNCONFIRMED
      inbox_private_key: '',
    },
    tag: INBOX,
  });
}

const fullEnvelope = {
  user_address: 'QmPeer',
  display_name: 'Peer',
  return_inbox_address: 'QmPeerReturnInbox',
  return_inbox_encryption_key: 'peer-enc-key',
  return_inbox_public_key: 'peer-signing-pub',
  return_inbox_private_key: 'peer-signing-priv',
  identity_public_key: 'idpub',
  tag: 'QmPeerReturnInbox',
  message: 'inner-dr-envelope',
  type: 'direct',
} as never;

beforeEach(() => {
  mockStore.clear();
  mockSaveEncryptionState.mockClear();
  mockSaveInboxMapping.mockClear();
  mockDecryptImpl = okDecrypt;
});

describe('confirmSenderSession', () => {
  it('returns null when no state exists for the inbox', async () => {
    const res = await encryptionService.confirmSenderSession(CONV, INBOX, fullEnvelope);
    expect(res).toBeNull();
    expect(mockSaveEncryptionState).not.toHaveBeenCalled();
  });

  it('returns null when the session is already confirmed', async () => {
    seedUnconfirmed();
    const st = mockStore.get(mockKey(CONV, INBOX))!;
    (st.sendingInbox as Record<string, string>).inbox_public_key = 'already-set';
    const res = await encryptionService.confirmSenderSession(CONV, INBOX, fullEnvelope);
    expect(res).toBeNull();
    expect(mockSaveEncryptionState).not.toHaveBeenCalled();
  });

  it('returns null (state untouched) when the envelope is missing a required field', async () => {
    seedUnconfirmed();
    const partial = { ...(fullEnvelope as object), return_inbox_private_key: '' } as never;
    const res = await encryptionService.confirmSenderSession(CONV, INBOX, partial);
    expect(res).toBeNull();
    expect(mockSaveEncryptionState).not.toHaveBeenCalled();
    expect((mockStore.get(mockKey(CONV, INBOX))!.sendingInbox as Record<string, string>).inbox_public_key).toBe('');
  });

  it('returns null and keeps the session on decrypt failure (Signal rule)', async () => {
    seedUnconfirmed();
    mockDecryptImpl = async () => ({ ratchet_state: 'x', message: [], decryptionError: 'aead' });
    const res = await encryptionService.confirmSenderSession(CONV, INBOX, fullEnvelope);
    expect(res).toBeNull();
    expect(mockSaveEncryptionState).not.toHaveBeenCalled();
    expect(mockStore.get(mockKey(CONV, INBOX))!.state).toBe('ratchet-0');
  });

  it('confirms on success: full sendingInbox, sentAccept true, tag + mapping saved', async () => {
    seedUnconfirmed();
    const res = await encryptionService.confirmSenderSession(CONV, INBOX, fullEnvelope);
    expect(res).not.toBeNull();
    expect(res!.message).toBe('{"messageId":"m1"}');

    expect(mockSaveEncryptionState).toHaveBeenCalledTimes(1);
    const saved = mockSaveEncryptionState.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.sentAccept).toBe(true);
    expect(saved.state).toBe('advanced-state');
    expect(saved.inboxId).toBe(INBOX); // keyed under OUR receiving inbox
    expect(saved.tag).toBe('QmPeerReturnInbox');
    expect(saved.sendingInbox).toEqual({
      inbox_address: 'QmPeerReturnInbox',
      inbox_encryption_key: 'peer-enc-key',
      inbox_public_key: 'peer-signing-pub',
      inbox_private_key: 'peer-signing-priv',
    });
    expect(mockSaveInboxMapping).toHaveBeenCalledWith('QmPeerReturnInbox', CONV);
  });
});
