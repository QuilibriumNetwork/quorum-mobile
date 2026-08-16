/**
 * Electing and un-electing, including what the user is told about it.
 *
 * The original defect was a handler that saved the field and showed
 * "@name is now your primary username" without ever publishing. Every word of
 * that alert was true and the whole thing was misleading: nothing had left the
 * device, so nobody else would ever see the name. No type and no lint rule
 * catches a message that is true and wrong.
 *
 * So two things are asserted here that are usually left to review: that the
 * publish is actually invoked, and that the message matches the outcome. The
 * first is the regression guard the pure-function tests could not give —
 * deleting the publish from this module turns these red.
 */

const mockRepublish = jest.fn();

// jest hoists this factory above the imports, so it may only close over
// variables whose names start with `mock`.
jest.mock('@/services/profile/republishSelfProfile', () => ({
  republishSelfProfile: (...args: unknown[]) => mockRepublish(...args),
}));

import { changePrimaryName, describeReleasedPrimary } from '../services/profile/primaryNameChange';
import { NO_PRIMARY_NAME } from '../utils/primaryName';

const ADDR = 'QmTestSelf00000000000000000000000000000000';
const self = { address: ADDR, displayName: 'GattoPardo Mobile', isProfilePublic: true };

let updated: { primaryUsername: string }[] = [];
const updateProfile = (u: { primaryUsername: string }) => {
  updated.push(u);
};

beforeEach(() => {
  updated = [];
  mockRepublish.mockReset().mockResolvedValue({ status: 'published' });
});

describe('changePrimaryName', () => {
  it('saves the name AND publishes it — the publish is the whole fix', async () => {
    await changePrimaryName({ name: 'gatto', next: 'gatto', self, updateProfile });

    expect(updated).toEqual([{ primaryUsername: 'gatto' }]);
    expect(mockRepublish).toHaveBeenCalledTimes(1);
  });

  it('publishes the NEW name, not the stale one still on the user object', async () => {
    // `updateProfile` is a React state update, so `self` here still carries the
    // previous name. Reading it back instead of overriding would publish the
    // old value and look like the publish silently did nothing.
    await changePrimaryName({
      name: 'gatto',
      next: 'gatto',
      self: { ...self, primaryUsername: 'oldname' },
      updateProfile,
    });

    expect(mockRepublish.mock.calls[0][0].primaryUsername).toBe('gatto');
  });

  it('un-elects by publishing the cleared sentinel, not undefined', async () => {
    await changePrimaryName({
      name: 'gatto',
      next: NO_PRIMARY_NAME,
      self: { ...self, primaryUsername: 'gatto' },
      updateProfile,
    });

    expect(updated).toEqual([{ primaryUsername: NO_PRIMARY_NAME }]);
    // Exactly `''`. A coercion back to `undefined` here would still be falsy
    // downstream today, and would silently reintroduce the distinction that
    // makes un-elect revert at the next login.
    expect(mockRepublish.mock.calls[0][0].primaryUsername).toBe(NO_PRIMARY_NAME);
  });

  it('tells an unpublished user their spaces and DMs still see the name', async () => {
    // This assertion was inverted until 2026-08-16, when it demanded the word
    // "private" and that the copy deny anyone could see the name. That encoded
    // a belief that stopped being true when the `.q` was decoupled from the
    // public-profile toggle: the space/DM broadcast carries an elected name to
    // spacemates and DM partners regardless of the toggle, and since the server
    // refuses every publish carrying the field, that broadcast is the only
    // route a `.q` actually has. The old copy denied the route that works and
    // pointed the user at the one that does not.
    mockRepublish.mockResolvedValue({ status: 'not-public' });

    const { body } = await changePrimaryName({ name: 'gatto', next: 'gatto', self, updateProfile });

    expect(body).toContain('spaces and DMs');
    expect(body).toContain('gatto.q');
    // The toggle is still worth offering, for the audience a broadcast cannot
    // reach: people with no shared space or DM.
    expect(body).toMatch(/Public Profile/);
    // Still must not overclaim. The unqualified promise belongs to the
    // published branch, where it is true for strangers too.
    expect(body).not.toMatch(/Other people will see you/);
    // And must not revive the claim that a private profile hides the name.
    expect(body).not.toMatch(/only you can see/i);
  });

  it('says the name is published only when it actually was', async () => {
    const { body } = await changePrimaryName({ name: 'gatto', next: 'gatto', self, updateProfile });
    expect(body).toContain('Other people will see you as gatto.q');
  });

  it('distinguishes a failed publish from a failed election', async () => {
    mockRepublish.mockResolvedValue({ status: 'failed', error: new Error('offline') });

    const { title, body } = await changePrimaryName({
      name: 'gatto',
      next: 'gatto',
      self,
      updateProfile,
    });

    // The local write already happened; the user needs to know what did NOT.
    expect(title).toContain('not published');
    expect(body).toContain('saved as your primary username on this device');
  });
});

describe('describeReleasedPrimary', () => {
  it('says nothing when the released name was not the primary one', () => {
    expect(describeReleasedPrimary('gatto', null)).toBe('');
  });

  it('warns about the impersonation window when the clear did not publish', () => {
    const s = describeReleasedPrimary('gatto', { status: 'failed', error: null });
    expect(s).toMatch(/still see you as gatto\.q/);
  });

  it('confirms the fallback when the clear published', () => {
    expect(describeReleasedPrimary('gatto', { status: 'published' })).toMatch(/display name/);
  });
});

describe('user-facing copy', () => {
  // Project convention: no em dashes in user-facing text. Enforced here rather
  // than left to review, because these strings are only reachable at runtime
  // through an Alert and nothing else checks them.
  it('never uses an em dash', async () => {
    const statuses = [
      { status: 'published' },
      { status: 'not-public' },
      { status: 'failed', error: null },
    ];
    const strings: string[] = [];

    for (const outcome of statuses) {
      for (const next of ['gatto', NO_PRIMARY_NAME]) {
        mockRepublish.mockResolvedValue(outcome);
        const r = await changePrimaryName({ name: 'gatto', next, self, updateProfile });
        strings.push(r.title, r.body);
      }
      strings.push(describeReleasedPrimary('gatto', outcome as never));
    }

    const offenders = strings.filter((s) => s.includes('—'));
    expect(offenders).toEqual([]);
  });
});
