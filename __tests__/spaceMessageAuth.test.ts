/**
 * Wiring tests for the mobile verified-signer auth module (spaceMessageAuth.ts).
 *
 * The shared VERDICT logic (authorizeControlMessage / resolveVerifiedSender) is
 * unit-tested in quorum-shared. These tests prove MOBILE's wiring: that its
 * receive-side auth actually resolves the signer from the signature (not the
 * spoofable payload senderId), fails closed, and routes each decision through
 * the shared verdict. Only the two native touchpoints are mocked — the ed448
 * verifier and the member store; all shared/crypto logic runs for real.
 */
import {
  buildMessageFingerprint,
  computeMessageIdHex,
  deriveInboxAddress,
  type Message,
  type SpaceMember,
} from '@quilibrium/quorum-shared';

// --- mocks (must be prefixed `mock*` to be usable inside jest.mock factories) ---
const mockVerifyEd448 = jest.fn<Promise<boolean>, unknown[]>();
jest.mock('../services/crypto/native-signing-provider', () => ({
  NativeSigningProvider: jest.fn(() => ({ verifyEd448: mockVerifyEd448 })),
}));
const mockGetSpaceMembers = jest.fn();
const mockGetSpaceMemberDevices = jest.fn(async () => []);
jest.mock('../services/storage/mmkvAdapter', () => ({
  getMMKVAdapter: () => ({
    getSpaceMembers: mockGetSpaceMembers,
    getSpaceMemberDevices: mockGetSpaceMemberDevices,
  }),
}));

import {
  verifySpaceMessageSignature,
  resolveVerifiedSpaceSender,
  authorizeSpaceControlMessage,
  isUpdateProfileAuthorized,
  shouldStripEveryoneMention,
  isReadOnlyPostAuthorized,
} from '../services/space/spaceMessageAuth';

// A key whose bytes are irrelevant (deriveInboxAddress just hashes it).
const PUB = 'ab'.repeat(57); // ed448 pubkey length, valid even-length hex
const SIG = 'ff'.repeat(57);
const INBOX = deriveInboxAddress(PUB);
const SPACE = 'space1';
const CHAN = 'chan1';

function member(address: string, inbox = INBOX, isKicked = false): SpaceMember {
  return { address, user_address: address, inbox_address: inbox, isKicked } as unknown as SpaceMember;
}

/** Build a wire message whose messageId is the correct hash of its fingerprint. */
function makeMessage(
  content: Record<string, unknown>,
  opts: { signed?: boolean; mentions?: Record<string, unknown> } = {}
): Message {
  const nonce = 'nonce1';
  const fingerprint = buildMessageFingerprint({
    nonce,
    content: content as Parameters<typeof buildMessageFingerprint>[0]['content'],
    senderId: content.senderId as string,
    spaceId: SPACE,
    channelId: CHAN,
  });
  const messageId = computeMessageIdHex(fingerprint);
  return {
    messageId,
    nonce,
    spaceId: SPACE,
    channelId: CHAN,
    content,
    publicKey: PUB,
    ...(opts.signed === false ? {} : { signature: SIG }),
    ...(opts.mentions ? { mentions: opts.mentions } : {}),
  } as unknown as Message;
}

const post = (senderId: string) => ({ type: 'post', senderId, text: 'hi' });

beforeEach(() => {
  mockVerifyEd448.mockReset();
  mockGetSpaceMembers.mockReset();
  mockGetSpaceMembers.mockResolvedValue([member('userA')]);
});

describe('verifySpaceMessageSignature', () => {
  it('returns the public key when signature + messageId are valid', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    const msg = makeMessage({ type: 'remove-message', senderId: 'userA', removeMessageId: 't1' });
    expect(await verifySpaceMessageSignature(msg, SPACE)).toBe(PUB);
  });

  it('returns null for an unsigned message (no signature field)', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    const msg = makeMessage({ type: 'remove-message', senderId: 'userA', removeMessageId: 't1' }, { signed: false });
    expect(await verifySpaceMessageSignature(msg, SPACE)).toBeNull();
  });

  it('returns null when the wire messageId does not match the recomputed fingerprint (tamper)', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    const msg = makeMessage({ type: 'remove-message', senderId: 'userA', removeMessageId: 't1' });
    (msg as { messageId: string }).messageId = 'deadbeef';
    expect(await verifySpaceMessageSignature(msg, SPACE)).toBeNull();
    expect(mockVerifyEd448).not.toHaveBeenCalled(); // fails before the crypto call
  });

  it('returns null when ed448 verification fails', async () => {
    mockVerifyEd448.mockResolvedValue(false);
    const msg = makeMessage({ type: 'remove-message', senderId: 'userA', removeMessageId: 't1' });
    expect(await verifySpaceMessageSignature(msg, SPACE)).toBeNull();
  });
});

describe('resolveVerifiedSpaceSender — reverse key→member lookup, fail-closed', () => {
  it('resolves the member whose inbox_address derives from the signing key', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    const msg = makeMessage({ type: 'remove-message', senderId: 'userA', removeMessageId: 't1' });
    expect(await resolveVerifiedSpaceSender(msg, SPACE, [member('userA')])).toBe('userA');
  });

  it('returns null when the signing key matches no member (fail closed)', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    const msg = makeMessage({ type: 'remove-message', senderId: 'userA', removeMessageId: 't1' });
    expect(await resolveVerifiedSpaceSender(msg, SPACE, [])).toBeNull();
  });

  it('returns null for a kicked member (fail closed)', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    const msg = makeMessage({ type: 'remove-message', senderId: 'userA', removeMessageId: 't1' });
    expect(await resolveVerifiedSpaceSender(msg, SPACE, [member('userA', INBOX, true)])).toBeNull();
  });
});

describe('authorizeSpaceControlMessage — remove-message (anti-spoof)', () => {
  const target = { content: { type: 'post', senderId: 'userA', text: 'x' } } as unknown as Message;

  it('ALLOWS a verified own-message delete', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    const msg = makeMessage({ type: 'remove-message', senderId: 'userA', removeMessageId: 't1' });
    const v = await authorizeSpaceControlMessage({ message: msg, spaceId: SPACE, space: undefined, channel: undefined, targetMessage: target, members: [member('userA')] });
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('ok-own-message');
  });

  it('DENIES a forged senderId (signed with own key, claiming another member)', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    // Attacker signs with their own key (resolves to userA) but claims userB.
    const msg = makeMessage({ type: 'remove-message', senderId: 'userB', removeMessageId: 't1' });
    const v = await authorizeSpaceControlMessage({ message: msg, spaceId: SPACE, space: undefined, channel: undefined, targetMessage: target, members: [member('userA')] });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('senderid-mismatch');
  });

  it('DENIES an unsigned control message', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    const msg = makeMessage({ type: 'remove-message', senderId: 'userA', removeMessageId: 't1' }, { signed: false });
    const v = await authorizeSpaceControlMessage({ message: msg, spaceId: SPACE, space: undefined, channel: undefined, targetMessage: target, members: [member('userA')] });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('unsigned-control-rejected');
  });

  it('DENIES when the signing key matches no member (fail closed)', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    const msg = makeMessage({ type: 'remove-message', senderId: 'userA', removeMessageId: 't1' });
    const v = await authorizeSpaceControlMessage({ message: msg, spaceId: SPACE, space: undefined, channel: undefined, targetMessage: target, members: [] });
    expect(v.allowed).toBe(false);
  });
});

describe('isUpdateProfileAuthorized — known-key binding', () => {
  const up = (senderId: string) => ({ type: 'update-profile', senderId, displayName: 'X', userIcon: '' });

  it('DROPS an unsigned update-profile', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    expect(await isUpdateProfileAuthorized(makeMessage(up('userA'), { signed: false }), SPACE, [])).toBe(false);
  });

  it('ACCEPTS an unknown key (rotation/bootstrap announcement)', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    expect(await isUpdateProfileAuthorized(makeMessage(up('newuser')), SPACE, [])).toBe(true);
  });

  it('DROPS a KNOWN key claiming another member as senderId (impersonation)', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    // key belongs to userB (registered), but claims userA
    expect(await isUpdateProfileAuthorized(makeMessage(up('userA')), SPACE, [member('userB')])).toBe(false);
  });

  it('ACCEPTS a member updating their own profile', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    expect(await isUpdateProfileAuthorized(makeMessage(up('userA')), SPACE, [member('userA')])).toBe(true);
  });
});

describe('shouldStripEveryoneMention', () => {
  it('keeps (no strip) a message without an everyone flag', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    const msg = makeMessage(post('userA'), { mentions: { everyone: false } });
    expect(await shouldStripEveryoneMention(msg, SPACE, [member('userA')])).toBe(false);
  });

  it('keeps @everyone when the verified signer matches the claimed sender', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    const msg = makeMessage(post('userA'), { mentions: { everyone: true } });
    expect(await shouldStripEveryoneMention(msg, SPACE, [member('userA')])).toBe(false);
  });

  it('STRIPS @everyone when the message is unverifiable', async () => {
    mockVerifyEd448.mockResolvedValue(false);
    const msg = makeMessage(post('userA'), { mentions: { everyone: true } });
    expect(await shouldStripEveryoneMention(msg, SPACE, [member('userA')])).toBe(true);
  });

  it('STRIPS @everyone when the signing key belongs to someone other than the claimed sender', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    const msg = makeMessage(post('userB'), { mentions: { everyone: true } });
    expect(await shouldStripEveryoneMention(msg, SPACE, [member('userA')])).toBe(true);
  });
});

describe('isReadOnlyPostAuthorized — verified manager required', () => {
  it('DROPS an unverifiable post (unsigned/invalid signature)', async () => {
    mockVerifyEd448.mockResolvedValue(false);
    const msg = makeMessage(post('userA'));
    expect(await isReadOnlyPostAuthorized(msg, SPACE, undefined, undefined, [member('userA')])).toBe(false);
  });
});
