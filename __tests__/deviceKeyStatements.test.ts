/**
 * Wiring tests for per-device signing-key statements (deviceKeyStatements.ts).
 *
 * The shared statement crypto (buildDeviceKeyStatementBytes /
 * verifyDeviceKeyStatement) is unit-tested in quorum-shared. These prove
 * MOBILE's wiring: the announce/revoke frames carry the right statement, the
 * signed payload is the canonical cross-platform bytes (or signatures split
 * with desktop), and the receive path stores admissions/tombstones. Only the
 * native crypto + storage are mocked; all shared logic runs for real.
 */
import {
  buildDeviceKeyStatementBytes,
  deriveInboxAddress,
  type DeviceKeyStatement,
} from '@quilibrium/quorum-shared';

// --- mocks (must be prefixed `mock*` for jest.mock factories) ---
const mockSignEd448 = jest.fn(async () => btoa('mock-signature'));
const mockSealHubEnvelope = jest.fn(async (_addr: string, _kp: unknown, payload: string) => ({
  sealed: 'envelope',
  payload,
}));
jest.mock('../services/crypto/native-provider', () => ({
  NativeCryptoProvider: jest.fn(() => ({
    signEd448: mockSignEd448,
    sealHubEnvelope: mockSealHubEnvelope,
  })),
}));

const mockVerifyEd448 = jest.fn<Promise<boolean>, unknown[]>();
jest.mock('../services/crypto/native-signing-provider', () => ({
  NativeSigningProvider: jest.fn(() => ({ verifyEd448: mockVerifyEd448 })),
}));

const mockGetSpaceKey = jest.fn();
const mockGetSpaceSigningKey = jest.fn();
jest.mock('../services/config/spaceStorage', () => ({
  getSpaceKey: (...a: unknown[]) => mockGetSpaceKey(...a),
  getSpaceSigningKey: (...a: unknown[]) => mockGetSpaceSigningKey(...a),
}));

const mockGetSpaceMemberDevice = jest.fn();
const mockSaveSpaceMemberDevice = jest.fn();
jest.mock('../services/storage/mmkvAdapter', () => ({
  getMMKVAdapter: () => ({
    getSpaceMemberDevice: mockGetSpaceMemberDevice,
    saveSpaceMemberDevice: mockSaveSpaceMemberDevice,
  }),
}));

import {
  buildAnnounceKeysFrame,
  buildRevokeDeviceFrames,
  processDeviceKeyStatement,
} from '../services/space/deviceKeyStatements';

const SPACE = 'space-pdk';
const USER_PUB = 'ab'.repeat(57);
const USER_ADDRESS = deriveInboxAddress(USER_PUB);
const SIGNING_PUB = 'cd'.repeat(57); // key the device signs with (signing ?? inbox)
const DEVICE_KEY_PUB = 'ef'.repeat(57);
const DEVICE_INBOX = 'dev-inbox-1';
const master = { privateKeyHex: '99'.repeat(57), publicKeyHex: USER_PUB };

/** base64 of the UTF-8 bytes of a string (matches the sign path). */
function b64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSpaceSigningKey.mockReturnValue({ publicKey: SIGNING_PUB });
  mockGetSpaceKey.mockImplementation((_spaceId: string, keyId: string) =>
    keyId === 'hub'
      ? { address: 'hub-addr', publicKey: '1122', privateKey: '3344' }
      : keyId === 'config'
        ? { publicKey: '5566', privateKey: '7788' }
        : null
  );
});

describe('buildAnnounceKeysFrame', () => {
  it('builds a control envelope announcing the signed key', async () => {
    const frame = await buildAnnounceKeysFrame(SPACE, master, DEVICE_INBOX);
    expect(frame).toBeTruthy();

    const payload = JSON.parse(mockSealHubEnvelope.mock.calls[0][2]);
    expect(payload.type).toBe('control');
    expect(payload.message).toMatchObject({
      type: 'announce-keys',
      userAddress: USER_ADDRESS,
      userPublicKey: USER_PUB,
      spaceId: SPACE,
      deviceInboxAddress: DEVICE_INBOX,
      spaceKeyPublicKey: SIGNING_PUB,
    });
    expect(typeof payload.message.signature).toBe('string');
    expect(payload.message.signature.length).toBeGreaterThan(0);
  });

  it('signs the canonical shared bytes (cross-platform gate)', async () => {
    await buildAnnounceKeysFrame(SPACE, master, DEVICE_INBOX);
    const stmt = JSON.parse(mockSealHubEnvelope.mock.calls[0][2]).message;
    // The signed message MUST be exactly buildDeviceKeyStatementBytes(stmt) —
    // if mobile and desktop serialize differently, signatures fail silently.
    expect(mockSignEd448.mock.calls[0][1]).toBe(
      b64Utf8(buildDeviceKeyStatementBytes(stmt))
    );
  });

  it('returns null when the space has no signing key', async () => {
    mockGetSpaceSigningKey.mockReturnValue(null);
    const frame = await buildAnnounceKeysFrame(SPACE, master, DEVICE_INBOX);
    expect(frame).toBeNull();
    expect(mockSealHubEnvelope).not.toHaveBeenCalled();
  });
});

describe('buildRevokeDeviceFrames', () => {
  it('builds one revoke-device frame per (space, device)', async () => {
    const frames = await buildRevokeDeviceFrames(
      ['s1', 's2'],
      ['d1', 'd2'],
      master
    );
    expect(frames).toHaveLength(4);
    const payload = JSON.parse(mockSealHubEnvelope.mock.calls[0][2]);
    expect(payload.message).toMatchObject({
      type: 'revoke-device',
      userAddress: USER_ADDRESS,
      deviceInboxAddress: 'd1',
    });
  });

  it('returns nothing for an empty device list', async () => {
    const frames = await buildRevokeDeviceFrames(['s1'], [], master);
    expect(frames).toHaveLength(0);
  });
});

describe('processDeviceKeyStatement', () => {
  const announce = {
    type: 'announce-keys',
    userAddress: USER_ADDRESS,
    userPublicKey: USER_PUB,
    spaceId: SPACE,
    deviceInboxAddress: DEVICE_INBOX,
    spaceKeyPublicKey: DEVICE_KEY_PUB,
    timestamp: 1000,
    signature: 'ab'.repeat(57),
  } as DeviceKeyStatement;

  it('persists an admission for a valid announce-keys', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    mockGetSpaceMemberDevice.mockResolvedValue(undefined);

    await processDeviceKeyStatement(announce, SPACE);

    expect(mockSaveSpaceMemberDevice).toHaveBeenCalledTimes(1);
    expect(mockSaveSpaceMemberDevice.mock.calls[0][0]).toMatchObject({
      spaceId: SPACE,
      userAddress: USER_ADDRESS,
      deviceInboxAddress: DEVICE_INBOX,
      inboxAddress: deriveInboxAddress(DEVICE_KEY_PUB),
      revoked: false,
    });
  });

  it('drops a statement whose spaceId does not match the delivering space', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    await processDeviceKeyStatement({ ...announce, spaceId: 'other' }, SPACE);
    expect(mockSaveSpaceMemberDevice).not.toHaveBeenCalled();
  });

  it('writes a tombstone for a valid revoke-device', async () => {
    mockVerifyEd448.mockResolvedValue(true);
    mockGetSpaceMemberDevice.mockResolvedValue({
      spaceId: SPACE,
      userAddress: USER_ADDRESS,
      deviceInboxAddress: DEVICE_INBOX,
      inboxAddress: deriveInboxAddress(DEVICE_KEY_PUB),
      spaceKeyPublicKey: DEVICE_KEY_PUB,
      timestamp: 500,
      revoked: false,
    });

    await processDeviceKeyStatement(
      {
        type: 'revoke-device',
        userAddress: USER_ADDRESS,
        userPublicKey: USER_PUB,
        spaceId: SPACE,
        deviceInboxAddress: DEVICE_INBOX,
        timestamp: 2000,
        signature: 'ab'.repeat(57),
      } as DeviceKeyStatement,
      SPACE
    );

    expect(mockSaveSpaceMemberDevice).toHaveBeenCalledTimes(1);
    expect(mockSaveSpaceMemberDevice.mock.calls[0][0]).toMatchObject({
      deviceInboxAddress: DEVICE_INBOX,
      revoked: true,
      timestamp: 2000,
    });
  });
});
