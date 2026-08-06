/**
 * The publish that makes electing a QNS name mean anything.
 *
 * A `.q` reaches other people ONLY inside the published public profile. Before
 * this helper existed, "Set as Primary" wrote a local field and showed an
 * alert — so the elected name changed what the electing user saw and nothing
 * about what anyone else saw, indefinitely, until some unrelated profile edit
 * happened to carry it along. That failure is invisible from inside the app:
 * your own header shows the `.q` immediately, because it reads the local field
 * rather than the published profile.
 *
 * The cases below are the ones that would have caught it, plus the un-elect
 * direction, which has the same shape in reverse.
 */

const mockPublish = jest.fn();
const mockGenerateFarcasterLink = jest.fn();

// jest hoists these factories above the imports, so they may only close over
// variables whose names start with `mock`.
jest.mock('@/services/profile/publicProfile', () => ({
  publishPublicProfile: (...args: unknown[]) => mockPublish(...args),
}));
jest.mock('@/services/calling/farcaster-link', () => ({
  generateFarcasterLink: (...args: unknown[]) => mockGenerateFarcasterLink(...args),
}));

import { republishSelfProfile } from '../services/profile/republishSelfProfile';
import { NO_PRIMARY_NAME } from '../utils/primaryName';

const ADDR = 'QmTestSelf00000000000000000000000000000000';

const self = (over: Record<string, unknown> = {}) => ({
  address: ADDR,
  displayName: 'GattoPardo Mobile',
  profileImage: 'data:image/png;base64,AAA',
  bio: 'hello',
  isProfilePublic: true,
  ...over,
});

beforeEach(() => {
  mockPublish.mockReset().mockResolvedValue(undefined);
  mockGenerateFarcasterLink.mockReset().mockResolvedValue(null);
});

describe('republishSelfProfile', () => {
  it('publishes the elected name so other people can see it', async () => {
    const outcome = await republishSelfProfile(self({ primaryUsername: 'gatto' }));

    expect(outcome).toEqual({ status: 'published' });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0][0]).toMatchObject({
      address: ADDR,
      primaryUsername: 'gatto',
    });
  });

  it('publishes the un-election too, as a falsy name', async () => {
    // Falsy is what makes `publishPublicProfile` omit `primary_username` and
    // sign the v1 payload — byte-identical to a user who never elected one.
    // That is why un-electing needs no separate "clear" route.
    await republishSelfProfile(self({ primaryUsername: NO_PRIMARY_NAME }));

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0][0].primaryUsername).toBeFalsy();
  });

  it('does not publish when the profile is private', async () => {
    // Not an error: there is no published record to update. The caller uses
    // this to tell the user their `.q` is visible only to them.
    const outcome = await republishSelfProfile(
      self({ isProfilePublic: false, primaryUsername: 'gatto' }),
    );

    expect(outcome).toEqual({ status: 'not-public' });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('reports failure instead of throwing, because the election is already saved', async () => {
    // The local write happened before this ran. Throwing here would surface as
    // "electing failed" when what actually failed was telling everyone else.
    mockPublish.mockRejectedValue(new Error('offline'));

    const outcome = await republishSelfProfile(self({ primaryUsername: 'gatto' }));

    expect(outcome.status).toBe('failed');
  });

  it('refreshes the Farcaster link on every publish', async () => {
    // The POST replaces the record wholesale, so publishing without the link
    // would silently unlink the two identities.
    mockGenerateFarcasterLink.mockResolvedValue({
      fid: 1234,
      custodyAddress: '0xabc',
      farcasterSignature: 'fsig',
      quorumSignature: 'qsig',
    });

    await republishSelfProfile(
      self({
        primaryUsername: 'gatto',
        farcaster: { fid: 1234, custodyAddress: '0xabc' },
      }),
    );

    expect(mockGenerateFarcasterLink).toHaveBeenCalledWith(1234, '0xabc', ADDR);
    expect(mockPublish.mock.calls[0][0].farcasterLink).toMatchObject({ fid: 1234 });
  });

  it('still publishes the name when the Farcaster link cannot be derived', async () => {
    // Losing a name change to a failed link refresh would be the wrong trade.
    mockGenerateFarcasterLink.mockRejectedValue(new Error('no custody key'));

    const outcome = await republishSelfProfile(
      self({
        primaryUsername: 'gatto',
        farcaster: { fid: 1234, custodyAddress: '0xabc' },
      }),
    );

    expect(outcome).toEqual({ status: 'published' });
    expect(mockPublish.mock.calls[0][0]).toMatchObject({ primaryUsername: 'gatto' });
  });
});
