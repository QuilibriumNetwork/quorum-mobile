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
  type SpaceMemberDevice,
} from '@quilibrium/quorum-shared';

// --- mocks (must be prefixed `mock*` to be usable inside jest.mock factories) ---
const mockVerifyEd448 = jest.fn<Promise<boolean>, unknown[]>();
jest.mock('../services/crypto/native-signing-provider', () => ({
  NativeSigningProvider: jest.fn(() => ({ verifyEd448: mockVerifyEd448 })),
}));
// spaceMessageAuth reaches the API client for owner-envelope checks; importing
// it for real drags in react-native-mmkv (native module, absent under jest).
// The owner-envelope path itself is covered in spaceControlOwnerAuth.test.ts.
jest.mock('../services/api/quorumClient', () => ({
  getQuorumClient: () => ({ getSpaceRegistration: jest.fn() }),
}));
const mockGetSpaceMembers = jest.fn();
const mockGetSpaceMemberDevices = jest.fn<Promise<SpaceMemberDevice[]>, unknown[]>();
// The single-row accessor, kept separate from `getSpaceMembers` on purpose:
// `isUpdateProfileAuthorized` uses THIS call to decide whether the claimed
// senderId already has a row, because it is the same call both receive handlers
// make to decide create-vs-merge. Mocking it independently is what lets a test
// express "the key is unbound AND the row exists" without contorting the member
// list.
const mockGetSpaceMember = jest.fn<Promise<SpaceMember | undefined>, unknown[]>();
jest.mock('../services/storage/mmkvAdapter', () => ({
  getMMKVAdapter: () => ({
    getSpaceMembers: mockGetSpaceMembers,
    getSpaceMemberDevices: mockGetSpaceMemberDevices,
    getSpaceMember: mockGetSpaceMember,
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
/** A second key, so a row can be anchored to something OTHER than the signer. */
const OTHER_PUB = 'cd'.repeat(57);
const OTHER_INBOX = deriveInboxAddress(OTHER_PUB);
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
  mockGetSpaceMemberDevices.mockReset();
  mockGetSpaceMemberDevices.mockResolvedValue([]);
  mockGetSpaceMember.mockReset();
  // Default: the claimed address has no row yet. Tests that need the opposite
  // say so explicitly, because "a row already exists" is the whole condition
  // the bootstrap exemption is bounded by.
  mockGetSpaceMember.mockResolvedValue(undefined);
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

  it('ACCEPTS an unbound key INTRODUCING a member with no row (bootstrap)', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    // The roster-population path, and the reason the exemption cannot simply be
    // deleted: mobile's space manifest carries no member list, so an existing
    // member's connect-time re-broadcast landing in the handler's upsert is the
    // only way a new joiner learns who was already there.
    mockGetSpaceMember.mockResolvedValue(undefined);
    expect(await isUpdateProfileAuthorized(makeMessage(up('newuser')), SPACE, [])).toBe(true);
  });

  it('DROPS an unbound key REWRITING a member that already has a row', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    // The signing key is bound to nobody — the only row is anchored to a
    // DIFFERENT key — which is the entire qualification the bootstrap
    // exemption asks for. But a row for the claimed senderId exists, so this is
    // an overwrite of a real identity rather than the introduction of a new
    // one, and the exemption does not stretch that far.
    const victim = member('userB', OTHER_INBOX);
    mockGetSpaceMember.mockResolvedValue(victim);
    expect(await isUpdateProfileAuthorized(makeMessage(up('userB')), SPACE, [victim])).toBe(false);
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

  it("ACCEPTS an announced per-device key updating ITS OWNER's profile", async () => {
    mockVerifyEd448.mockResolvedValue(true);
    // A second device signs with its own per-space key, which is never written
    // to the member row's anchor. Without the announce-keys admission being
    // consulted it would look exactly like the unbound attacker above, and the
    // rule under test would break every multi-device profile update.
    const owner = member('userA', OTHER_INBOX);
    mockGetSpaceMember.mockResolvedValue(owner);
    mockGetSpaceMemberDevices.mockResolvedValue([
      {
        spaceId: SPACE,
        userAddress: 'userA',
        deviceInboxAddress: INBOX,
        inboxAddress: INBOX,
        spaceKeyPublicKey: PUB,
        timestamp: 1,
        revoked: false,
      },
    ]);
    expect(await isUpdateProfileAuthorized(makeMessage(up('userA')), SPACE, [owner])).toBe(true);
  });

  it('DROPS an announced per-device key claiming a DIFFERENT member', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    const owner = member('userA', OTHER_INBOX);
    const victim = member('userB', deriveInboxAddress('ef'.repeat(57)));
    mockGetSpaceMember.mockResolvedValue(victim);
    mockGetSpaceMemberDevices.mockResolvedValue([
      {
        spaceId: SPACE,
        userAddress: 'userA',
        deviceInboxAddress: INBOX,
        inboxAddress: INBOX,
        spaceKeyPublicKey: PUB,
        timestamp: 1,
        revoked: false,
      },
    ]);
    expect(
      await isUpdateProfileAuthorized(makeMessage(up('userB')), SPACE, [owner, victim])
    ).toBe(false);
  });

  it("DROPS a KICKED member's own key from rewriting their row", async () => {
    mockVerifyEd448.mockResolvedValue(true);
    // `resolveVerifiedSender` skips kicked members, so their key resolves to
    // nobody — and an unbound key may not rewrite an existing row. A deliberate
    // tightening that rides along with the bound: previously the anchor-only
    // lookup matched kicked rows too and let them keep editing themselves.
    const kicked = member('userA', INBOX, true);
    mockGetSpaceMember.mockResolvedValue(kicked);
    expect(await isUpdateProfileAuthorized(makeMessage(up('userA')), SPACE, [kicked])).toBe(false);
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
