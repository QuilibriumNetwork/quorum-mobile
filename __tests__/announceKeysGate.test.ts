/**
 * announce-keys goes out once per key, not once per connect.
 *
 * ## The regression this pins
 *
 * WebSocketContext built and sent this device's master-signed `announce-keys`
 * statement for EVERY space on EVERY transition to connected: each launch,
 * each foreground reconnect, each network blip. Every one is a `log-append`,
 * so it is written into the space's hub log for good and downloaded by every
 * member, while the receiver keeps only the newest statement per device. A
 * phone that reconnected forty times a day put forty identical entries a day
 * into every space it belongs to.
 *
 * ## What is asserted
 *
 * - The decision: announce when never announced, when the announced key (or
 *   device, or account) changed, and otherwise only after seven days.
 * - The persisted gate: once marked sent, the same key is not due again until
 *   the interval passes; a new signing key is due immediately.
 * - The wiring, read from the provider source (a ~7000-line provider with no
 *   harness, the approach receiptWiring.test.ts takes): the connect loop asks
 *   the gate before building the frame and records the send only after the
 *   frame is enqueued.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockGetSpaceSigningKey = jest.fn();
jest.mock('../services/config/spaceStorage', () => ({
  getSpaceSigningKey: (...a: unknown[]) => mockGetSpaceSigningKey(...a),
}));

import {
  ANNOUNCE_KEYS_INTERVAL_MS,
  announceKeysDue,
  announceKeysFingerprint,
  markKeysAnnounced,
  parseAnnounceKeysRecord,
  shouldAnnounceKeys,
} from '../services/space/announceKeysGate';

const T0 = 1_750_000_000_000;
const USER_PUB = 'ab'.repeat(57);
const DEVICE_INBOX = 'QmDeviceInbox';
const KEY_A = 'cd'.repeat(57);
const KEY_B = 'ef'.repeat(57);

const fp = (spaceKeyPublicKey = KEY_A, deviceInboxAddress = DEVICE_INBOX) =>
  announceKeysFingerprint({ userPublicKey: USER_PUB, deviceInboxAddress, spaceKeyPublicKey });

describe('shouldAnnounceKeys', () => {
  it('announces to a space it has never announced to', () => {
    expect(shouldAnnounceKeys(null, fp(), T0)).toBe(true);
  });

  it('does not repeat an unchanged key within the interval', () => {
    const record = { fp: fp(), at: T0 };
    expect(shouldAnnounceKeys(record, fp(), T0 + 1)).toBe(false);
    expect(shouldAnnounceKeys(record, fp(), T0 + ANNOUNCE_KEYS_INTERVAL_MS - 1)).toBe(false);
  });

  it('repeats an unchanged key once the interval has passed', () => {
    const record = { fp: fp(), at: T0 };
    expect(shouldAnnounceKeys(record, fp(), T0 + ANNOUNCE_KEYS_INTERVAL_MS)).toBe(true);
  });

  it('announces a changed signing key at once', () => {
    const record = { fp: fp(KEY_A), at: T0 };
    expect(shouldAnnounceKeys(record, fp(KEY_B), T0 + 1)).toBe(true);
  });

  it('announces a changed device inbox at once', () => {
    const record = { fp: fp(KEY_A, 'QmOld'), at: T0 };
    expect(shouldAnnounceKeys(record, fp(KEY_A, 'QmNew'), T0 + 1)).toBe(true);
  });

  it('reads an unreadable stored value as never announced', () => {
    expect(parseAnnounceKeysRecord('not json')).toBeNull();
    expect(parseAnnounceKeysRecord(JSON.stringify({ fp: 'x' }))).toBeNull();
    expect(parseAnnounceKeysRecord(undefined)).toBeNull();
  });
});

describe('announceKeysDue / markKeysAnnounced', () => {
  beforeEach(() => {
    mockGetSpaceSigningKey.mockReset();
  });

  it('is due once, then not again after it is marked sent', () => {
    mockGetSpaceSigningKey.mockReturnValue({ publicKey: KEY_A });
    const due = announceKeysDue('space-1', USER_PUB, DEVICE_INBOX, T0);
    expect(due).toBe(fp(KEY_A));

    markKeysAnnounced('space-1', due!, T0);
    // The next connect, an hour later.
    expect(announceKeysDue('space-1', USER_PUB, DEVICE_INBOX, T0 + 3_600_000)).toBeNull();
    // A week later it is due again, as a self-heal.
    expect(announceKeysDue('space-1', USER_PUB, DEVICE_INBOX, T0 + ANNOUNCE_KEYS_INTERVAL_MS)).toBe(
      fp(KEY_A),
    );
  });

  it('is due straight away when the space signing key changes', () => {
    mockGetSpaceSigningKey.mockReturnValue({ publicKey: KEY_A });
    markKeysAnnounced('space-2', announceKeysDue('space-2', USER_PUB, DEVICE_INBOX, T0)!, T0);

    mockGetSpaceSigningKey.mockReturnValue({ publicKey: KEY_B });
    expect(announceKeysDue('space-2', USER_PUB, DEVICE_INBOX, T0 + 1)).toBe(fp(KEY_B));
  });

  it('gates each space separately', () => {
    mockGetSpaceSigningKey.mockReturnValue({ publicKey: KEY_A });
    markKeysAnnounced('space-3', fp(KEY_A), T0);
    expect(announceKeysDue('space-4', USER_PUB, DEVICE_INBOX, T0 + 1)).toBe(fp(KEY_A));
  });

  it('has nothing to announce for a space without a signing key', () => {
    mockGetSpaceSigningKey.mockReturnValue(null);
    expect(announceKeysDue('space-5', USER_PUB, DEVICE_INBOX, T0)).toBeNull();
  });
});

describe('WebSocketContext wiring', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'context', 'WebSocketContext.tsx'),
    'utf8',
  );
  const start = source.indexOf('const setupTimeout = setTimeout(async () => {');
  const end = source.indexOf('}, 1500);', start);
  const setupBody = source.slice(start, end);

  it('asks the gate before building the announce frame', () => {
    expect(start).toBeGreaterThan(-1);
    expect(setupBody).toContain('announceKeysDue(');
    expect(setupBody.indexOf('announceKeysDue(')).toBeLessThan(
      setupBody.indexOf('buildAnnounceKeysFrame('),
    );
  });

  it('records the send only after the frame is enqueued', () => {
    const enqueueAt = setupBody.indexOf('enqueueOutbound(async () => [frame])');
    const markAt = setupBody.indexOf('markKeysAnnounced(');
    expect(enqueueAt).toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(enqueueAt);
  });
});
