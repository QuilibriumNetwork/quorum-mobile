/**
 * What actually goes on the wire when you elect or un-elect a primary `.q`.
 *
 * `publishPublicProfile` picks between two signing payloads by whether a
 * primary username is present, and the server picks the same one by the same
 * condition. Get that switch wrong in either direction and the server rejects
 * the signature — so this is the load-bearing detail behind both electing and
 * un-electing, and it is not visible from any UI.
 *
 * The un-elect case is the reason this file exists. There is no "clear the
 * primary name" route on the server; un-electing works by publishing a profile
 * that is byte-identical to one from a user who never elected a name. That only
 * holds if a falsy name omits the field AND drops back to the v1 payload. If it
 * omitted the field but kept signing v2, the POST would be rejected and the old
 * name would keep resolving, with the app showing a success alert.
 *
 * NOTE what this does not prove: that the server stores the record wholesale,
 * so that an absent `primary_username` replaces a previously stored one rather
 * than leaving it. That is a server behaviour and has to be measured against
 * the real endpoint.
 */

const mockPost = jest.fn();
const mockSign = jest.fn();

// jest hoists these factories above the imports, so they may only close over
// variables whose names start with `mock`.
jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({
    postPublicProfile: (...args: unknown[]) => mockPost(...args),
  }),
}));
jest.mock('@/services/onboarding/keyService', () => ({
  // Any well-formed hex key: the signature itself is stubbed, only the payload
  // handed to the signer matters here.
  ensurePrivateKey: async () => 'ab'.repeat(57),
}));
jest.mock('@/services/crypto/native-provider', () => ({
  NativeCryptoProvider: class {
    signEd448(...args: unknown[]) {
      return mockSign(...args);
    }
  },
}));

import { publishPublicProfile } from '../services/profile/publicProfile';

const ADDR = 'QmTestSelf00000000000000000000000000000000';

/** The exact bytes handed to the signer, as text. */
function signedPayload(): string {
  const messageBase64 = mockSign.mock.calls[0][1] as string;
  const binary = atob(messageBase64);
  let out = '';
  for (let i = 0; i < binary.length; i++) out += binary[i];
  return out;
}

beforeEach(() => {
  mockPost.mockReset().mockResolvedValue(undefined);
  // A base64 signature; the value is irrelevant, only that signing succeeded.
  mockSign.mockReset().mockResolvedValue('AAAA');
});

describe('publishPublicProfile and the primary QNS name', () => {
  const base = {
    address: ADDR,
    displayName: 'GattoPardo Mobile',
    profileImage: '',
    bio: 'hello',
  };

  it('sends the name and signs the v2 payload when one is elected', async () => {
    await publishPublicProfile({ ...base, primaryUsername: 'gatto' });

    expect(mockPost.mock.calls[0][1]).toMatchObject({ primary_username: 'gatto' });
    expect(signedPayload()).toContain('public-profile-v2:');
    // The claim itself must be inside the signed bytes, or it could be stripped
    // or swapped in transit while the signature still verified.
    expect(signedPayload()).toContain(':gatto:');
  });

  it('omits the field and drops back to v1 when the name is cleared', async () => {
    // This is un-elect. Same shape as a user who never elected anything.
    await publishPublicProfile({ ...base, primaryUsername: '' });

    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('primary_username');
    expect(signedPayload()).toContain('public-profile:');
    expect(signedPayload()).not.toContain('public-profile-v2:');
  });

  it('is identical whether the name is cleared or was never set', async () => {
    await publishPublicProfile({ ...base, primaryUsername: '' });
    const cleared = signedPayload();
    const clearedBody = mockPost.mock.calls[0][1];

    mockSign.mockClear();
    mockPost.mockClear();
    await publishPublicProfile(base);

    // Timestamps differ; everything before them must not.
    const strip = (s: string) => s.slice(0, s.lastIndexOf(':') + 1);
    expect(strip(signedPayload())).toBe(strip(cleared));
    expect(Object.keys(mockPost.mock.calls[0][1]).sort()).toEqual(
      Object.keys(clearedBody).sort(),
    );
  });
});
