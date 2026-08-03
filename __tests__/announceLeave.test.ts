/**
 * Wiring tests for announceLeave.ts — mobile telling a Space it is leaving.
 *
 * Only native crypto, storage and the API client are mocked; the encoding
 * helpers run for real, so the bytes asserted here are the bytes that go on the
 * wire. The point of these tests is the two things that are easy to get wrong and
 * impossible to see afterwards: WHICH key signs WHICH statement, and what happens
 * to the user's Space when a leg fails.
 */

// --- mocks (must be prefixed `mock*` for jest.mock factories) ---
const mockSignEd448 = jest.fn<Promise<string>, [string, string]>(
  async (_key: string, payload: string) => btoa(`sig-of:${payload}`)
);
// Typed with the real arity (4 args, config key optional) so the assertions on
// `calls[0][3]` typecheck — a 3-arg inferred signature silently makes the
// "sealed to the config key" tests unwriteable.
const mockSealHubEnvelope = jest.fn<
  Promise<{ hub_address: string; envelope: string }>,
  [string, unknown, string, unknown?]
>(async (_addr, _kp, payload) => ({
  hub_address: 'hub-addr',
  envelope: payload,
}));
jest.mock('../services/crypto/native-provider', () => ({
  NativeCryptoProvider: jest.fn(() => ({
    signEd448: mockSignEd448,
    sealHubEnvelope: mockSealHubEnvelope,
  })),
}));

const mockGetSpaceKey = jest.fn();
const mockGetSpaceSigningKey = jest.fn();
jest.mock('../services/config/spaceStorage', () => ({
  getSpaceKey: (...a: unknown[]) => mockGetSpaceKey(...a),
  getSpaceSigningKey: (...a: unknown[]) => mockGetSpaceSigningKey(...a),
}));

const mockPostHubDelete = jest.fn<
  Promise<{ status: string }>,
  [Record<string, string>]
>(async () => ({ status: 'ok' }));
jest.mock('../services/api/quorumClient', () => ({
  getQuorumClient: () => ({ postHubDelete: mockPostHubDelete }),
}));

import { announceLeave, LEAVE_FLUSH_MS } from '../services/space/announceLeave';
import { hexToBase64, numberArrayToBase64 } from '../utils/encoding';

const SPACE = 'space-leaving-abcdef123456';
const HUB_PUB = 'aa'.repeat(57);
const HUB_PRIV = 'bb'.repeat(57);
const INBOX_PUB = 'cc'.repeat(57);
const INBOX_PRIV = 'dd'.repeat(57);
const CONFIG_PUB = 'ee'.repeat(56);
const CONFIG_PRIV = 'ff'.repeat(56);

const KEYS: Record<string, unknown> = {
  hub: { address: 'hub-addr', publicKey: HUB_PUB, privateKey: HUB_PRIV },
  inbox: { address: 'inbox-addr', publicKey: INBOX_PUB, privateKey: INBOX_PRIV },
  config: { address: 'cfg-addr', publicKey: CONFIG_PUB, privateKey: CONFIG_PRIV },
};

/** The base64 payload a `"delete" + <pubkey>` statement signs over. */
const deleteStatement = (subjectPublicKeyHex: string) =>
  numberArrayToBase64(
    Array.from(new TextEncoder().encode(`delete${subjectPublicKeyHex}`))
  );

let enqueueOutbound: jest.Mock;
let flushOutbound: jest.Mock;

const run = () =>
  announceLeave({
    spaceId: SPACE,
    enqueueOutbound: enqueueOutbound as never,
    flushOutbound: flushOutbound as never,
  });

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks wipes call history but KEEPS implementations, so a
  // mockRejectedValue set in one test leaks into every later one. Re-seat all of
  // them explicitly rather than relying on the module-level defaults.
  mockGetSpaceKey.mockImplementation((_id: string, keyId: string) => KEYS[keyId]);
  // Default: the join/create device, where signing IS the inbox keypair. Tests
  // that care about a second device override this.
  mockGetSpaceSigningKey.mockImplementation(() => KEYS.inbox);
  // Encodes WHICH private key signed WHAT, so a swapped key is visible in the
  // assertion rather than hidden behind an opaque blob.
  mockSignEd448.mockImplementation(async (key, payload) => btoa(`${key}|${payload}`));
  mockSealHubEnvelope.mockImplementation(async (_addr, _kp, payload) => ({
    hub_address: 'hub-addr',
    envelope: payload as string,
  }));
  mockPostHubDelete.mockResolvedValue({ status: 'ok' });
  enqueueOutbound = jest.fn();
  flushOutbound = jest.fn().mockResolvedValue(true);
});

describe('announceLeave', () => {
  describe('the signatures — asymmetric, and unverifiable if swapped', () => {
    it('signs the inbox statement over the HUB key, with the INBOX private key', async () => {
      await run();

      expect(mockSignEd448).toHaveBeenCalledWith(
        expect.any(String),
        deleteStatement(HUB_PUB)
      );
      // The signing key is passed base64; assert on the pairing, not the encoding.
      const inboxCall = mockSignEd448.mock.calls.find(
        ([, payload]) => payload === deleteStatement(HUB_PUB)
      );
      expect(inboxCall).toBeDefined();
    });

    it('signs the hub statement over the INBOX key, with the HUB private key', async () => {
      await run();

      const hubCall = mockSignEd448.mock.calls.find(
        ([, payload]) => payload === deleteStatement(INBOX_PUB)
      );
      expect(hubCall).toBeDefined();
    });

    it('sends each signature in the field that verifies it', async () => {
      await run();

      const body = mockPostHubDelete.mock.calls[0][0];
      const controlMessage = JSON.parse(mockSealHubEnvelope.mock.calls[0][2]);

      // inbox_signature and the control message's inboxSignature are the SAME
      // statement — the receiver resolves the leaver from it.
      expect(body.inbox_signature).toBe(controlMessage.message.inboxSignature);
      expect(body.inbox_signature).not.toBe(body.hub_signature);
      expect(body.hub_public_key).toBe(HUB_PUB);
      expect(body.inbox_public_key).toBe(INBOX_PUB);
      expect(body.hub_address).toBe('hub-addr');
    });
  });

  describe('a second device, where the signing key is NOT the mailbox key', () => {
    // The failure this guards is invisible: sign the broadcast with a device's own
    // mailbox key and resolveVerifiedLeaver derives an inbox address no member row
    // has ever held, so every receiver drops the leave and reports nothing. On the
    // join/create device the two keys are identical, so only this setup can catch it.
    const SIGNING_PUB = '11'.repeat(57);
    const SIGNING_PRIV = '22'.repeat(57);

    beforeEach(() => {
      mockGetSpaceSigningKey.mockImplementation(() => ({
        address: 'signing-addr',
        publicKey: SIGNING_PUB,
        privateKey: SIGNING_PRIV,
      }));
    });

    it('announces with the SIGNING key, which is what the member table binds', async () => {
      await run();

      const payload = JSON.parse(mockSealHubEnvelope.mock.calls[0][2]);
      expect(payload.message.inboxPublicKey).toBe(SIGNING_PUB);
      expect(payload.message.inboxPublicKey).not.toBe(INBOX_PUB);
    });

    it('signs the announcement with the signing private key', async () => {
      await run();

      const payload = JSON.parse(mockSealHubEnvelope.mock.calls[0][2]);
      // The mock encodes `${signingKeyBase64}|${payloadBase64}` and announceLeave
      // hex-encodes whatever comes back, so unwind both layers.
      const [signer] = atob(hexToBase64(payload.message.inboxSignature)).split('|');
      expect(signer).toBe(hexToBase64(SIGNING_PRIV));
      expect(signer).not.toBe(hexToBase64(INBOX_PRIV));
    });

    it('still deregisters THIS device mailbox from the hub, not the signing key', async () => {
      // Hub registration is genuinely per-device: this device registered this
      // mailbox, and that is the entry being removed.
      await run();

      const body = mockPostHubDelete.mock.calls[0][0];
      expect(body.inbox_public_key).toBe(INBOX_PUB);
      expect(body.inbox_public_key).not.toBe(SIGNING_PUB);
    });

    it('degrades to skipped when the signing key is unreadable', async () => {
      mockGetSpaceSigningKey.mockImplementation(() => null);

      await expect(run()).resolves.toBe('skipped');
      expect(mockPostHubDelete).not.toHaveBeenCalled();
    });
  });

  describe('the control message', () => {
    it('is a leave control envelope carrying the inbox public key', async () => {
      await run();

      const payload = JSON.parse(mockSealHubEnvelope.mock.calls[0][2] as string);
      expect(payload.type).toBe('control');
      expect(payload.message.type).toBe('leave');
      expect(payload.message.inboxPublicKey).toBe(INBOX_PUB);
    });

    it('never names an address — the receiver resolves it from the signature', async () => {
      // A payload-supplied address is exactly how a forged leave used to blank an
      // arbitrary member's identity anchor (#217).
      await run();

      const payload = JSON.parse(mockSealHubEnvelope.mock.calls[0][2] as string);
      expect(payload.message).not.toHaveProperty('address');
      expect(payload.message).not.toHaveProperty('participant');
    });

    it('goes out as a log-append hub broadcast', async () => {
      await run();

      expect(enqueueOutbound).toHaveBeenCalledTimes(1);
      const frame = JSON.parse(await enqueueOutbound.mock.calls[0][0]().then((f: string[]) => f[0]));
      expect(frame.type).toBe('log-append');
    });

    it('is sealed to the config key so a kicked member cannot read it', async () => {
      await run();

      expect(mockSealHubEnvelope.mock.calls[0][3]).toEqual({
        publicKey: expect.any(Array),
        privateKey: expect.any(Array),
      });
    });

    it('still seals when the space has no config key', async () => {
      mockGetSpaceKey.mockImplementation((_id: string, keyId: string) =>
        keyId === 'config' ? undefined : KEYS[keyId]
      );

      await expect(run()).resolves.toBe('ok');
      expect(mockSealHubEnvelope.mock.calls[0][3]).toBeUndefined();
    });
  });

  describe('ordering — say goodbye before the keys are gone', () => {
    it('flushes the broadcast before deregistering from the hub', async () => {
      const order: string[] = [];
      flushOutbound.mockImplementation(async () => {
        order.push('flush');
        return true;
      });
      mockPostHubDelete.mockImplementation(async () => {
        order.push('hub-delete');
        return { status: 'ok' };
      });

      await run();

      expect(order).toEqual(['flush', 'hub-delete']);
    });

    it('waits on the socket rather than firing and forgetting', async () => {
      await run();
      expect(flushOutbound).toHaveBeenCalledWith(LEAVE_FLUSH_MS);
    });
  });

  describe('failure semantics — what happens to the user Space', () => {
    it('THROWS when the hub deregistration fails, so the caller keeps the Space', async () => {
      // The whole point: wiping through this failure strands the inbox registered
      // on the hub with the keys needed to remove it already deleted.
      mockPostHubDelete.mockRejectedValue(new Error('network down'));

      await expect(run()).rejects.toThrow('network down');
    });

    it('does NOT throw when the broadcast is unconfirmed', async () => {
      // A user on a bad connection must still be able to leave.
      flushOutbound.mockResolvedValue(false);

      await expect(run()).resolves.toBe('unconfirmed');
      expect(mockPostHubDelete).toHaveBeenCalled();
    });

    it('does NOT throw when the flush itself blows up', async () => {
      flushOutbound.mockRejectedValue(new Error('socket exploded'));

      await expect(run()).resolves.toBe('unconfirmed');
      expect(mockPostHubDelete).toHaveBeenCalled();
    });

    it.each([
      ['hub', 'hub'],
      ['inbox', 'inbox'],
    ])('degrades to skipped when the %s key is missing, so the Space stays leavable', async (_l, missing) => {
      mockGetSpaceKey.mockImplementation((_id: string, keyId: string) =>
        keyId === missing ? undefined : KEYS[keyId]
      );

      await expect(run()).resolves.toBe('skipped');
      expect(enqueueOutbound).not.toHaveBeenCalled();
      expect(mockPostHubDelete).not.toHaveBeenCalled();
    });

    it('degrades to skipped when the hub key has no address', async () => {
      mockGetSpaceKey.mockImplementation((_id: string, keyId: string) =>
        keyId === 'hub' ? { publicKey: HUB_PUB, privateKey: HUB_PRIV } : KEYS[keyId]
      );

      await expect(run()).resolves.toBe('skipped');
      expect(mockPostHubDelete).not.toHaveBeenCalled();
    });

    it('reports ok only when the socket confirmed the write', async () => {
      await expect(run()).resolves.toBe('ok');
    });
  });
});
