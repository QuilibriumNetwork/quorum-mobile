/**
 * Deregister-before-wipe (Reset App Data).
 *
 * The two cleanups fail independently and are reported independently. Both bugs
 * found in the desktop version of this lived in the composition, not in either
 * piece: the flush barrier's answer was computed and then discarded, and a slow
 * revoke leg overwrote a hub write that had already succeeded. Testing the
 * pieces in isolation caught neither, so these tests exercise the whole
 * function with only its boundaries mocked.
 */
const mockGetPrivateKey = jest.fn<Promise<string | null>, []>();
const mockGetPublicKey = jest.fn<Promise<string | null>, []>();
const mockGetInboxAddress = jest.fn<Promise<string | null>, []>();
jest.mock('../services/onboarding/secureStorage', () => ({
  getPrivateKey: () => mockGetPrivateKey(),
  getPublicKey: () => mockGetPublicKey(),
  getInboxAddress: () => mockGetInboxAddress(),
}));

const mockRemoveDevice = jest.fn();
jest.mock('../services/onboarding/keyService', () => ({
  removeDeviceFromRegistration: (...a: unknown[]) => mockRemoveDevice(...a),
}));

const mockGetSpaceIds = jest.fn<string[], []>();
jest.mock('../services/config/spaceStorage', () => ({
  getSpaceIds: () => mockGetSpaceIds(),
}));

const mockBuildRevokeFrames = jest.fn();
jest.mock('../services/space/deviceKeyStatements', () => ({
  buildRevokeDeviceFrames: (...a: unknown[]) => mockBuildRevokeFrames(...a),
}));

import { deregisterThisDevice } from '../services/onboarding/deregisterDevice';

const ADDRESS = 'QmUserAddress';
const INBOX = 'this-device-inbox';

describe('deregisterThisDevice', () => {
  let enqueueOutbound: jest.Mock;
  let flushOutbound: jest.Mock;

  const run = () =>
    deregisterThisDevice({ userAddress: ADDRESS, enqueueOutbound, flushOutbound });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPrivateKey.mockResolvedValue('aa'.repeat(57));
    mockGetPublicKey.mockResolvedValue('bb'.repeat(57));
    mockGetInboxAddress.mockResolvedValue(INBOX);
    mockRemoveDevice.mockResolvedValue('removed');
    mockGetSpaceIds.mockReturnValue(['space-1', 'space-2']);
    mockBuildRevokeFrames.mockResolvedValue(['frame-1', 'frame-2']);
    enqueueOutbound = jest.fn();
    flushOutbound = jest.fn().mockResolvedValue(true);
  });

  it('removes the device from the hub and confirms the revoke frames on the wire', async () => {
    const outcome = await run();

    expect(outcome).toEqual({ hub: 'ok', spaces: 'ok' });
    expect(mockRemoveDevice).toHaveBeenCalledWith(
      ADDRESS,
      'bb'.repeat(57),
      'aa'.repeat(57),
      INBOX
    );
    // One tombstone per space, for this device only.
    expect(mockBuildRevokeFrames).toHaveBeenCalledWith(
      ['space-1', 'space-2'],
      [INBOX],
      expect.objectContaining({ privateKeyHex: 'aa'.repeat(57) })
    );
    expect(enqueueOutbound).toHaveBeenCalledTimes(2);
    expect(flushOutbound).toHaveBeenCalled();
  });

  it('reports the spaces leg failed when the flush is not confirmed', async () => {
    // The bug this guards: flushOutbound's answer was awaited and discarded, so
    // frames discarded by the sign-out disconnect were reported as a clean
    // goodbye.
    flushOutbound.mockResolvedValue(false);

    const outcome = await run();

    expect(outcome.spaces).toBe('failed');
  });

  it('does not let a failing spaces leg mask a successful hub write', async () => {
    // The bug this guards: one shared budget meant a slow revoke resolved the
    // whole thing to failed, so the user was told the device might still be
    // listed when it had already been removed.
    flushOutbound.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(false), 50))
    );

    const outcome = await run();

    expect(outcome).toEqual({ hub: 'ok', spaces: 'failed' });
  });

  it('does not let a failing hub leg mask a successful revoke', async () => {
    mockRemoveDevice.mockResolvedValue('failed');

    const outcome = await run();

    expect(outcome).toEqual({ hub: 'failed', spaces: 'ok' });
  });

  it('treats refusing to remove the only device as a failure, not a clean goodbye', async () => {
    // Mobile deliberately refuses to leave the account with no devices, so the
    // entry is still listed. Reporting 'ok' here is what makes a known leftover
    // look like success.
    mockRemoveDevice.mockResolvedValue('last-device');

    const outcome = await run();

    expect(outcome.hub).toBe('failed');
  });

  it('treats a device already absent from the list as done', async () => {
    mockRemoveDevice.mockResolvedValue('not-listed');

    const outcome = await run();

    expect(outcome.hub).toBe('ok');
  });

  it('still revokes in spaces when the hub leg fails', async () => {
    // Signing admissions are anchored to the master key, not the device list,
    // so the two can be out of step and each is worth cleaning on its own.
    mockRemoveDevice.mockRejectedValue(new Error('hub unreachable'));

    const outcome = await run();

    expect(outcome.hub).toBe('failed');
    expect(outcome.spaces).toBe('ok');
    expect(enqueueOutbound).toHaveBeenCalledTimes(2);
  });

  it('skips everything, touching no network, when the keys are already gone', async () => {
    mockGetPrivateKey.mockResolvedValue(null);

    const outcome = await run();

    expect(outcome).toEqual({ hub: 'skipped', spaces: 'skipped' });
    expect(mockRemoveDevice).not.toHaveBeenCalled();
    expect(enqueueOutbound).not.toHaveBeenCalled();
  });

  it('skips the revoke when the user is in no spaces, without failing the reset', async () => {
    mockGetSpaceIds.mockReturnValue([]);

    const outcome = await run();

    expect(outcome).toEqual({ hub: 'ok', spaces: 'skipped' });
    expect(mockBuildRevokeFrames).not.toHaveBeenCalled();
    expect(flushOutbound).not.toHaveBeenCalled();
  });

  it('never throws, so a broken goodbye cannot block the wipe', async () => {
    mockGetSpaceIds.mockImplementation(() => {
      throw new Error('storage exploded');
    });
    mockRemoveDevice.mockRejectedValue(new Error('hub exploded'));

    await expect(run()).resolves.toEqual({ hub: 'failed', spaces: 'failed' });
  });
});
