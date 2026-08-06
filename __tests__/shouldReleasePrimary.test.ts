/**
 * When an action on a QNS name should also drop it as your primary one.
 *
 * The rule is "a name stops being your primary the moment it stops pointing at
 * you", but the call sites express it as a negation inside react-query
 * `onSuccess` callbacks, which nothing in CI executes. Flipping that one `!`
 * gives you "making a name resolvable un-elects it" and "making it private
 * leaves it elected" — both silent, both wrong, and neither caught by a type.
 *
 * The transfer case is the one with teeth: keeping a transferred name elected
 * means you and its new owner both publish the same `.q`.
 */

import { shouldReleasePrimary } from '../services/profile/primaryNameChange';

describe('shouldReleasePrimary', () => {
  it('releases when a primary name is made private', () => {
    expect(shouldReleasePrimary({ isPrimary: true, stillResolvesToYou: false })).toBe(true);
  });

  it('releases when a primary name is transferred away', () => {
    // Same shape as make-private: the name no longer points at you. This is the
    // impersonation case, so it must not depend on which action got here.
    expect(shouldReleasePrimary({ isPrimary: true, stillResolvesToYou: false })).toBe(true);
  });

  it('does NOT release when a name is made resolvable', () => {
    // The opposite direction. Making a name resolvable is how you make it
    // usable; un-electing it there would undo the user's intent silently.
    expect(shouldReleasePrimary({ isPrimary: true, stillResolvesToYou: true })).toBe(false);
  });

  it('does nothing for a name that was never the primary one', () => {
    // Making some OTHER owned name private must not disturb your elected name.
    expect(shouldReleasePrimary({ isPrimary: false, stillResolvesToYou: false })).toBe(false);
    expect(shouldReleasePrimary({ isPrimary: false, stillResolvesToYou: true })).toBe(false);
  });
});
