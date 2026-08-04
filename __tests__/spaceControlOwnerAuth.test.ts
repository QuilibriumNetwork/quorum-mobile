/**
 * Outer-envelope authentication for privileged space control messages.
 *
 * kick / rekey / verify-kicked are gated on the space OWNER's ed448 signature
 * over the outer sync envelope; leave is gated on the departing member's own
 * inbox-key proof; join is gated on the joining participant's own inbox-key
 * proof over the participant blob (which cannot bind the claimed address to
 * that key — see verifyJoinParticipant). None is implied by successful
 * decryption — the config
 * key, the hub keypair and every member's inbox address are held by anyone who
 * has ever been in the space, including members who were later kicked. These
 * tests are the only lane that can exercise the forgery itself.
 *
 * They also lock the send/receive parity that makes the check work at all: the
 * signed bytes must be base64(utf8(envelope)), byte-for-byte what
 * sealSyncEnvelope (mobile) and SealSyncEnvelope (SDK/desktop) sign. If that
 * construction ever drifts, every real kick starts failing instead of every
 * forged one.
 */
import { deriveInboxAddress, type SpaceMember } from '@quilibrium/quorum-shared';

// --- mocks (must be prefixed `mock*` to be usable inside jest.mock factories) ---
const mockVerifyEd448 = jest.fn<Promise<boolean>, string[]>();
jest.mock('../services/crypto/native-signing-provider', () => ({
  NativeSigningProvider: jest.fn(() => ({ verifyEd448: mockVerifyEd448 })),
}));
const mockGetSpaceRegistration = jest.fn();
jest.mock('../services/api/quorumClient', () => ({
  getQuorumClient: () => ({ getSpaceRegistration: mockGetSpaceRegistration }),
}));
jest.mock('../services/storage/mmkvAdapter', () => ({
  getMMKVAdapter: () => ({
    getSpaceMembers: jest.fn(async () => []),
    getSpaceMemberDevices: jest.fn(async () => []),
  }),
}));

import {
  resolveVerifiedLeaver,
  verifyJoinParticipant,
  verifyOwnerSealedEnvelope,
} from '../services/space/spaceMessageAuth';

// The registration lookup is cached per space id, so every test gets its own
// id rather than a shared constant — otherwise one test's cached owner keys
// would silently satisfy the next test's lookup.
let SPACE = '';
let spaceSeq = 0;

const OWNER_KEY = 'ab'.repeat(57); // ed448 public key, valid even-length hex
const OTHER_KEY = 'cd'.repeat(57); // a key the registration does not list
const OWNER_SIG = 'ff'.repeat(57);
const HUB_PUB = '01'.repeat(57);
const ENVELOPE = '{"ciphertext":"Y2lwaGVy","initialization_vector":"aXY="}';

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');
const hexToB64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

const sealed = (over: Record<string, string | undefined> = {}) => ({
  owner_public_key: OWNER_KEY,
  owner_signature: OWNER_SIG,
  envelope: ENVELOPE,
  ...over,
});

function member(address: string, inbox: string, isKicked = false): SpaceMember {
  return {
    address,
    user_address: address,
    inbox_address: inbox,
    isKicked,
  } as unknown as SpaceMember;
}

beforeEach(() => {
  SPACE = `spaceTest${++spaceSeq}`;
  mockVerifyEd448.mockReset();
  mockGetSpaceRegistration.mockReset();
  mockGetSpaceRegistration.mockResolvedValue({ owner_public_keys: [OWNER_KEY] });
});

afterEach(() => {
  jest.restoreAllMocks(); // undoes any Date.now stub
});

/** Pin wall-clock time so the cache TTL and refetch floor are testable. */
function freezeClock(at: number) {
  jest.spyOn(Date, 'now').mockReturnValue(at);
}

describe('verifyOwnerSealedEnvelope — the kick / rekey / verify-kicked gate', () => {
  it('accepts an envelope signed by a registered owner key', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    expect(await verifyOwnerSealedEnvelope(sealed(), SPACE)).toBe('valid');
  });

  it('verifies over base64(utf8(envelope)) — the exact bytes the sender signed', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    await verifyOwnerSealedEnvelope(sealed(), SPACE);
    expect(mockVerifyEd448).toHaveBeenCalledWith(
      hexToB64(OWNER_KEY), // public key: hex on the wire, base64 to the verifier
      b64(ENVELOPE), // message: base64 of the envelope's UTF-8 bytes
      hexToB64(OWNER_SIG) // signature: hex on the wire, base64 to the verifier
    );
  });

  it('REJECTS a forgery signed by a key that is not in the space registration', async () => {
    // The attack: any past member holds the hub key and the config key, so they
    // can produce a decryptable envelope — but not one the owner signed.
    mockVerifyEd448.mockResolvedValue(true); // their signature is internally valid
    expect(
      await verifyOwnerSealedEnvelope(sealed({ owner_public_key: OTHER_KEY }), SPACE)
    ).toBe('invalid');
    expect(mockVerifyEd448).not.toHaveBeenCalled(); // rejected before the crypto call
  });

  it('REJECTS when the signature does not verify (tampered envelope)', async () => {
    mockVerifyEd448.mockResolvedValue(false);
    expect(await verifyOwnerSealedEnvelope(sealed(), SPACE)).toBe('invalid');
  });

  it('REJECTS an unsigned envelope without touching the network', async () => {
    expect(
      await verifyOwnerSealedEnvelope(sealed({ owner_signature: undefined }), SPACE)
    ).toBe('invalid');
    expect(mockGetSpaceRegistration).not.toHaveBeenCalled();
    expect(mockVerifyEd448).not.toHaveBeenCalled();
  });

  it('REJECTS an envelope with no owner key and one with no envelope body', async () => {
    expect(
      await verifyOwnerSealedEnvelope(sealed({ owner_public_key: undefined }), SPACE)
    ).toBe('invalid');
    expect(await verifyOwnerSealedEnvelope(sealed({ envelope: undefined }), SPACE)).toBe(
      'invalid'
    );
  });

  it('REJECTS a null/undefined frame (fail closed)', async () => {
    expect(await verifyOwnerSealedEnvelope(null, SPACE)).toBe('invalid');
    expect(await verifyOwnerSealedEnvelope(undefined, SPACE)).toBe('invalid');
  });

  it('REJECTS when the registration lists no owner keys at all', async () => {
    mockGetSpaceRegistration.mockResolvedValue({ owner_public_keys: [] });
    mockVerifyEd448.mockResolvedValue(true);
    expect(await verifyOwnerSealedEnvelope(sealed(), SPACE)).toBe('invalid');
  });

  it('REJECTS when the native verifier throws on malformed input', async () => {
    mockVerifyEd448.mockRejectedValue(new Error('invalid signature length'));
    expect(await verifyOwnerSealedEnvelope(sealed(), SPACE)).toBe('invalid');
  });

  it('returns INDETERMINATE (not invalid) when the registration cannot be fetched', async () => {
    // A network blip must not be read as forgery: the caller keeps the message
    // in the inbox for retry instead of acking a rekey it never applied.
    mockGetSpaceRegistration.mockRejectedValue(new Error('network down'));
    expect(await verifyOwnerSealedEnvelope(sealed(), SPACE)).toBe('indeterminate');
    expect(mockVerifyEd448).not.toHaveBeenCalled();
  });

  it('accepts any of several registered owner keys (key rotation)', async () => {
    mockGetSpaceRegistration.mockResolvedValue({
      owner_public_keys: [OTHER_KEY, OWNER_KEY],
    });
    mockVerifyEd448.mockResolvedValue(true);
    expect(await verifyOwnerSealedEnvelope(sealed(), SPACE)).toBe('valid');
  });

  it('DROPS (not retries) when the server says the space does not exist', async () => {
    // A deleted space can never verify, so `indeterminate` here would leave the
    // message in the inbox to be reprocessed on every reconnect, forever.
    for (const status of [404, 410]) {
      SPACE = `spaceGone${status}`;
      mockGetSpaceRegistration.mockRejectedValue(
        Object.assign(new Error('not found'), { status })
      );
      expect(await verifyOwnerSealedEnvelope(sealed(), SPACE)).toBe('invalid');
    }
  });

  it('still retries on a server error, which may be transient', async () => {
    mockGetSpaceRegistration.mockRejectedValue(
      Object.assign(new Error('bad gateway'), { status: 502 })
    );
    expect(await verifyOwnerSealedEnvelope(sealed(), SPACE)).toBe('indeterminate');
  });
});

describe('verifyOwnerSealedEnvelope — registration caching', () => {
  it('asks the server once for a burst of messages in the same space', async () => {
    // A reconnect catch-up can carry many control messages for one space.
    mockVerifyEd448.mockResolvedValue(true);
    freezeClock(1_000_000);
    for (let i = 0; i < 5; i++) {
      expect(await verifyOwnerSealedEnvelope(sealed(), SPACE)).toBe('valid');
    }
    expect(mockGetSpaceRegistration).toHaveBeenCalledTimes(1);
  });

  it('does not let one space\'s cached keys answer for another', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    freezeClock(1_000_000);
    await verifyOwnerSealedEnvelope(sealed(), SPACE);
    await verifyOwnerSealedEnvelope(sealed(), `${SPACE}-other`);
    expect(mockGetSpaceRegistration).toHaveBeenCalledTimes(2);
  });

  it('re-asks the server once the cache has aged out', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    freezeClock(1_000_000);
    await verifyOwnerSealedEnvelope(sealed(), SPACE);
    freezeClock(1_000_000 + 31_000); // past the 30s TTL
    await verifyOwnerSealedEnvelope(sealed(), SPACE);
    expect(mockGetSpaceRegistration).toHaveBeenCalledTimes(2);
  });

  it('KEEPS a message whose owner key the cached copy does not know, rather than rejecting it', async () => {
    // Rejecting here would ack and delete the message. If the cache were merely
    // stale (owner key rotated), that would discard a genuine rekey and lock
    // this member out permanently. Undecided beats wrongly-decided.
    mockVerifyEd448.mockResolvedValue(true);
    freezeClock(1_000_000);
    await verifyOwnerSealedEnvelope(sealed(), SPACE); // caches [OWNER_KEY]
    expect(mockGetSpaceRegistration).toHaveBeenCalledTimes(1);

    const unknownKey = await verifyOwnerSealedEnvelope(
      sealed({ owner_public_key: OTHER_KEY }),
      SPACE
    );
    expect(unknownKey).toBe('indeterminate');
    expect(mockGetSpaceRegistration).toHaveBeenCalledTimes(1); // refetch floor held
  });

  it('picks up a genuinely rotated owner key once the refetch floor passes', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    freezeClock(1_000_000);
    await verifyOwnerSealedEnvelope(sealed(), SPACE); // caches [OWNER_KEY]

    mockGetSpaceRegistration.mockResolvedValue({
      owner_public_keys: [OWNER_KEY, OTHER_KEY],
    });
    freezeClock(1_000_000 + 6_000); // past the 5s floor, inside the 30s TTL

    expect(
      await verifyOwnerSealedEnvelope(sealed({ owner_public_key: OTHER_KEY }), SPACE)
    ).toBe('valid');
    expect(mockGetSpaceRegistration).toHaveBeenCalledTimes(2);
  });

  it('REJECTS an unknown owner key once fresh data confirms it is not registered', async () => {
    // The forgery case: nothing cached, server asked, key genuinely absent.
    mockVerifyEd448.mockResolvedValue(true);
    freezeClock(1_000_000);
    expect(
      await verifyOwnerSealedEnvelope(sealed({ owner_public_key: OTHER_KEY }), SPACE)
    ).toBe('invalid');
    expect(mockGetSpaceRegistration).toHaveBeenCalledTimes(1);
    expect(mockVerifyEd448).not.toHaveBeenCalled();
  });

  it('a flood of forged messages costs at most one request per floor window', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    freezeClock(1_000_000);
    for (let i = 0; i < 20; i++) {
      await verifyOwnerSealedEnvelope(sealed({ owner_public_key: OTHER_KEY }), SPACE);
    }
    expect(mockGetSpaceRegistration).toHaveBeenCalledTimes(1);
  });
});

describe('resolveVerifiedLeaver — the leave gate', () => {
  const LEAVER_KEY = '02'.repeat(57);
  const LEAVER_SIG = '03'.repeat(57);
  const LEAVER_INBOX = deriveInboxAddress(LEAVER_KEY);
  const proof = { inboxPublicKey: LEAVER_KEY, inboxSignature: LEAVER_SIG };
  const members = [member('userA', LEAVER_INBOX), member('userB', 'someOtherInbox')];

  it('resolves the member whose inbox_address derives from the signing key', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    const leaver = await resolveVerifiedLeaver(proof, HUB_PUB, members);
    expect(leaver?.address).toBe('userA');
  });

  it('verifies the signature over "delete" + hubPublicKey', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    await resolveVerifiedLeaver(proof, HUB_PUB, members);
    expect(mockVerifyEd448).toHaveBeenCalledWith(
      hexToB64(LEAVER_KEY),
      b64(`delete${HUB_PUB}`),
      hexToB64(LEAVER_SIG)
    );
  });

  it('IGNORES an address named in the payload — the key alone names the leaver', async () => {
    // The forgery this closes: `{ type:'leave', address: victim }` over the hub,
    // which any past member can send. With no valid proof, nobody is resolved.
    mockVerifyEd448.mockResolvedValue(false);
    const forged = { ...proof, address: 'userB', participant: { address: 'userB' } };
    expect(await resolveVerifiedLeaver(forged, HUB_PUB, members)).toBeNull();
  });

  it('resolves the SIGNER, not a different member named in the payload', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    const misnamed = { ...proof, address: 'userB' };
    const leaver = await resolveVerifiedLeaver(misnamed, HUB_PUB, members);
    expect(leaver?.address).toBe('userA');
  });

  it('returns null when the signature does not verify', async () => {
    mockVerifyEd448.mockResolvedValue(false);
    expect(await resolveVerifiedLeaver(proof, HUB_PUB, members)).toBeNull();
  });

  it('returns null when the proof is absent, without touching the verifier', async () => {
    expect(
      await resolveVerifiedLeaver({ inboxPublicKey: LEAVER_KEY }, HUB_PUB, members)
    ).toBeNull();
    expect(await resolveVerifiedLeaver({}, HUB_PUB, members)).toBeNull();
    expect(await resolveVerifiedLeaver(null, HUB_PUB, members)).toBeNull();
    expect(mockVerifyEd448).not.toHaveBeenCalled();
  });

  it('returns null when the hub public key is missing (nothing to bind the proof to)', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    expect(await resolveVerifiedLeaver(proof, '', members)).toBeNull();
    expect(mockVerifyEd448).not.toHaveBeenCalled();
  });

  it('returns null when a valid signature matches no member (fail closed)', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    expect(await resolveVerifiedLeaver(proof, HUB_PUB, [])).toBeNull();
    expect(
      await resolveVerifiedLeaver(proof, HUB_PUB, [member('userB', 'someOtherInbox')])
    ).toBeNull();
  });

  it('never matches a member whose inbox_address is already blank', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    expect(await resolveVerifiedLeaver(proof, HUB_PUB, [member('userC', '')])).toBeNull();
  });

  it('returns null when the native verifier throws', async () => {
    mockVerifyEd448.mockRejectedValue(new Error('bad key'));
    expect(await resolveVerifiedLeaver(proof, HUB_PUB, members)).toBeNull();
  });
});

describe('verifyJoinParticipant — the join gate', () => {
  const JOINER_KEY = '04'.repeat(57);
  const JOINER_INBOX = deriveInboxAddress(JOINER_KEY);
  // Already base64 on the wire: signEd448 returns base64 and join ships it
  // unchanged, unlike leave's hex inboxSignature.
  const JOIN_SIG = Buffer.from('05'.repeat(114), 'hex').toString('base64');

  const participant = (over: Record<string, unknown> = {}) => ({
    address: 'userA',
    id: 3,
    inboxAddress: JOINER_INBOX,
    inboxPubKey: JOINER_KEY,
    pubKey: '06'.repeat(56),
    inboxKey: '07'.repeat(56),
    identityKey: '08'.repeat(56),
    preKey: '09'.repeat(56),
    userIcon: '',
    displayName: 'Ada',
    joinedAt: 1_700_000_000_000,
    signature: JOIN_SIG,
    ...over,
  });

  it('accepts a well-formed, correctly signed join', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    expect(await verifyJoinParticipant(participant())).toBe('valid');
  });

  it('signs over the 10-field blob desktop builds, in desktop order', async () => {
    // The parity lock. If this construction drifts, every REAL join starts
    // failing rather than every forged one, so it is asserted byte-for-byte.
    mockVerifyEd448.mockResolvedValue(true);
    await verifyJoinParticipant(participant());
    expect(mockVerifyEd448).toHaveBeenCalledWith(
      hexToB64(JOINER_KEY),
      b64(
        'userA' +
          '3' +
          JOINER_INBOX +
          '06'.repeat(56) +
          '07'.repeat(56) +
          '08'.repeat(56) +
          '09'.repeat(56) +
          '' +
          'Ada' +
          '1700000000000'
      ),
      JOIN_SIG
    );
  });

  it('passes the signature through as base64, NOT hex-decoded', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    await verifyJoinParticipant(participant());
    expect(mockVerifyEd448.mock.calls[0][2]).toBe(JOIN_SIG);
  });

  it('reproduces desktop\'s bare-concat coercion for absent fields', async () => {
    // Desktop joins the fields with `+`, so a missing displayName contributes
    // the literal "undefined" to what the sender signed. Coercing it to '' here
    // would reject genuine joins from a client that omitted the field.
    mockVerifyEd448.mockResolvedValue(true);
    await verifyJoinParticipant(participant({ displayName: undefined }));
    expect(mockVerifyEd448.mock.calls[0][1]).toBe(
      b64(
        'userA3' +
          JOINER_INBOX +
          '06'.repeat(56) +
          '07'.repeat(56) +
          '08'.repeat(56) +
          '09'.repeat(56) +
          '' +
          'undefined' +
          '1700000000000'
      )
    );
  });

  it('rejects an inboxAddress that does not derive from the announced key', async () => {
    // Without this the signer could claim an inbox address that is not theirs —
    // and inbox_address is the anchor resolveVerifiedSender matches members on.
    mockVerifyEd448.mockResolvedValue(true);
    expect(
      await verifyJoinParticipant(participant({ inboxAddress: deriveInboxAddress(OTHER_KEY) }))
    ).toBe('inbox-address-mismatch');
    expect(mockVerifyEd448).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature', async () => {
    mockVerifyEd448.mockResolvedValue(false);
    expect(await verifyJoinParticipant(participant())).toBe('signature-invalid');
  });

  it('rejects an unsigned join without touching the verifier', async () => {
    expect(await verifyJoinParticipant(participant({ signature: undefined }))).toBe('proof-missing');
    expect(await verifyJoinParticipant(participant({ inboxPubKey: undefined }))).toBe('proof-missing');
    expect(await verifyJoinParticipant(participant({ inboxAddress: undefined }))).toBe('proof-missing');
    expect(await verifyJoinParticipant(null)).toBe('proof-missing');
    expect(mockVerifyEd448).not.toHaveBeenCalled();
  });

  it('fails closed when the native verifier throws', async () => {
    mockVerifyEd448.mockRejectedValue(new Error('bad key'));
    expect(await verifyJoinParticipant(participant())).toBe('unverifiable');
  });

  it('separates "could not check" from "checked and bad" — the retry contract', async () => {
    // The handler keeps a join in the inbox for retry ONLY on `unverifiable`.
    // If a verifier throw were classified as a rejection, a device-side native
    // failure would ack away a genuine member permanently. If a genuine
    // rejection were classified as unverifiable, a forged join would be
    // reprocessed on every reconnect forever. The split has to hold both ways.
    mockVerifyEd448.mockRejectedValue(new Error('native module unavailable'));
    expect(await verifyJoinParticipant(participant())).toBe('unverifiable');

    mockVerifyEd448.mockReset();
    mockVerifyEd448.mockResolvedValue(false);
    expect(await verifyJoinParticipant(participant())).toBe('signature-invalid');

    // An unsigned join is a verdict, not an unknown: no retry can add a
    // signature that was never sent.
    expect(await verifyJoinParticipant(participant({ signature: undefined }))).toBe(
      'proof-missing'
    );
  });

  it('does NOT bind the claimed address to the key — documented, not a bug', async () => {
    // The limitation this gate cannot close: an attacker names the victim's
    // address but signs with their OWN key, announcing their own inbox address.
    // Everything is self-consistent, so it verifies. Only buildJoinedMemberRow
    // stops that from rewriting the victim; full authentication needs Layer 3.
    mockVerifyEd448.mockResolvedValue(true);
    const impersonation = participant({ address: 'victimAddress' });
    expect(await verifyJoinParticipant(impersonation)).toBe('valid');
  });
});
