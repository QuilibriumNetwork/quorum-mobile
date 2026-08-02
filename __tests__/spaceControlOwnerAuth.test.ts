/**
 * Outer-envelope authentication for privileged space control messages.
 *
 * kick / rekey / verify-kicked are gated on the space OWNER's ed448 signature
 * over the outer sync envelope; leave is gated on the departing member's own
 * inbox-key proof. Neither is implied by successful decryption — the config
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
  verifyOwnerSealedEnvelope,
} from '../services/space/spaceMessageAuth';

const SPACE = 'spaceAbc123456789';
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
  mockVerifyEd448.mockReset();
  mockGetSpaceRegistration.mockReset();
  mockGetSpaceRegistration.mockResolvedValue({ owner_public_keys: [OWNER_KEY] });
});

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
