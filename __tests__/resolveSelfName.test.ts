/**
 * Your own name on the profile screen.
 *
 * This is one function because the profile header renders in three layouts
 * (split-mode Quorum card, merged Quorum+Farcaster, Quorum-only) and all three
 * previously computed the name inline as `displayName || primaryUsername`.
 * That inverts the app's own rule — `resolveDisplayName` ranks
 * `primary_username` ABOVE `display_name` — so a user who had elected a primary
 * `.q` saw their global name as the big name and their `.q` demoted to a small
 * line beneath it. Their own profile was the one screen disagreeing with every
 * other surface about who they are.
 *
 * Tested rather than eyeballed because the failure is silent: both names are
 * real, so the wrong one looks like a design choice rather than a bug. It took
 * a screenshot to notice.
 */

import { resolveSelfName } from '../utils/resolveSelfName';

describe('resolveSelfName', () => {
  it('shows the .q as the name when one is primary', () => {
    expect(resolveSelfName({ primaryUsername: 'gatto', displayName: 'GattoPardo Mobile' }))
      .toMatchObject({ label: 'gatto.q', initialsSource: 'gatto' });
  });

  it('outranks the global name — this is the regression', () => {
    // The old expression was `displayName || primaryUsername`, which returns
    // the global name here. If this assertion ever reads 'GattoPardo Mobile'
    // again, the inversion is back.
    expect(
      resolveSelfName({ primaryUsername: 'gatto', displayName: 'GattoPardo Mobile' }).label,
    ).not.toBe('GattoPardo Mobile');
  });

  it('falls back to the global name when no .q is primary', () => {
    expect(resolveSelfName({ displayName: 'GattoPardo Mobile' }))
      .toMatchObject({ label: 'GattoPardo Mobile', initialsSource: 'GattoPardo Mobile' });
  });

  it('treats whitespace as unset at both tiers', () => {
    // Empty string means "not set at this tier" everywhere else in the identity
    // code; a `.q` of "   " must not win and blank out the name.
    expect(resolveSelfName({ primaryUsername: '   ', displayName: 'Real Name' }).label)
      .toBe('Real Name');
    expect(resolveSelfName({ primaryUsername: '', displayName: '  ' }).label)
      .toBe('Unnamed');
  });

  it('gives the avatar the bare name, so gatto.q initials as G not GQ', () => {
    // getInitials splits on non-letters, so handing it "gatto.q" would produce
    // two initials from one name.
    expect(resolveSelfName({ primaryUsername: 'gatto' }).initialsSource).toBe('gatto');
  });

  it('never returns an empty label', () => {
    expect(resolveSelfName({}).label).toBe('Unnamed');
  });
});
