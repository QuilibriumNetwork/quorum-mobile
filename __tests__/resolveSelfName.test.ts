/**
 * Your own name on the profile screen, and the per-space name placeholder.
 *
 * ## Why this file changed shape
 *
 * `resolveSelfName`/`selfNamePlaceholder` used to compose `${primaryUsername}.q`
 * directly off the raw auth profile — the same class of forgery the rest of
 * the identity migration exists to close everywhere else, just not yet
 * closed here: `primaryUsername` is a CLAIM the user broadcasts, not proof
 * they own it, and nothing checked it resolved back to their own address
 * before rendering the `.q`. In practice this could only ever mislead a user
 * about their OWN name (the one production call site is a text-input
 * placeholder for editing your own per-space profile), but the function's
 * generic name and generic `SelfNameInput` type invited a future caller to
 * hand it someone else's identity with nothing to catch it.
 *
 * The fix: `resolveSelfName` no longer reads `primaryUsername` AT ALL, so it
 * is structurally incapable of composing a `.q` — not "guarded", incapable.
 * `selfNamePlaceholder` takes a `resolvedSelf: ResolvedMemberName | null` as
 * its first argument, already resolved through `identity/`'s verified
 * ladder (`useResolvedMemberName(selfAddress, { global: true })` at the call
 * site), and renders a `.q` ONLY when that value's `isQnsVerified` is `true`
 * — a flag `identity/` sets exclusively after `claimedNameBelongsTo` checks
 * the claim resolves back to the claiming address. The tests below prove
 * both halves: `resolveSelfName` ignores a `primaryUsername`-shaped field
 * even when a caller hands it one, and `selfNamePlaceholder` never infers a
 * `.q` from a name string alone — only from the verified flag.
 */

import { resolveSelfName, selfNamePlaceholder, type SelfNameInput } from '../utils/resolveSelfName';

describe('resolveSelfName', () => {
  it('shows the global display name', () => {
    expect(resolveSelfName({ displayName: 'GattoPardo Mobile' }))
      .toMatchObject({ label: 'GattoPardo Mobile', initialsSource: 'GattoPardo Mobile', isQnsVerified: false });
  });

  it('treats whitespace as unset', () => {
    // Empty string means "not set at this tier" everywhere else in the
    // identity code; a whitespace-only name must not blank the header.
    expect(resolveSelfName({ displayName: '  ' }).label).toBe('Unnamed');
  });

  it('never returns an empty label', () => {
    expect(resolveSelfName({}).label).toBe('Unnamed');
  });

  it('ignores a primaryUsername field entirely — it cannot compose a .q', () => {
    // The regression this whole file exists to pin. `SelfNameInput` no
    // longer declares `primaryUsername`, so a plain object literal could
    // never carry one past the type checker — this simulates a caller who
    // gets one in anyway (a wider-typed variable, a cast, a future
    // "helpful" field re-addition) to prove the FUNCTION, not just the
    // type, is what makes this safe.
    const legacyShapedInput = {
      primaryUsername: 'gatto',
      displayName: 'GattoPardo Mobile',
    } as SelfNameInput & { primaryUsername: string };

    const result = resolveSelfName(legacyShapedInput);

    expect(result.label).toBe('GattoPardo Mobile');
    expect(result.label).not.toBe('gatto.q');
    expect(result.isQnsVerified).toBe(false);
  });
});

/**
 * The placeholder in a per-space name field.
 *
 * It is a PROMISE — "leave this empty and you will be shown as this" — so it
 * has to agree with what the app actually renders. The screen whose job is to
 * explain the follow-global default was the screen contradicting it.
 */
describe('selfNamePlaceholder', () => {
  it('promises the .q only when identity/ has verified it', () => {
    expect(
      selfNamePlaceholder({ name: 'alice', isQnsVerified: true }, { displayName: 'Alice' }, 'fallback'),
    ).toBe('alice.q');
  });

  it('never appends .q when the resolved value is unverified, even if the name looks QNS-like', () => {
    // The impersonation-shaped case: a resolved value whose NAME could pass
    // for a QNS username, but whose `isQnsVerified` flag says it was not
    // actually confirmed. This function must trust only the flag, never
    // infer a claim from the string's shape.
    expect(
      selfNamePlaceholder({ name: 'mallory', isQnsVerified: false }, { displayName: 'Alice' }, 'fallback'),
    ).toBe('Alice');
    expect(
      selfNamePlaceholder({ name: 'mallory', isQnsVerified: false }, { displayName: 'Alice' }, 'fallback'),
    ).not.toBe('mallory.q');
  });

  it('promises the global name when resolvedSelf is null (no address yet)', () => {
    expect(selfNamePlaceholder(null, { displayName: 'Alice' }, 'fallback')).toBe('Alice');
  });

  it('still honours the deprecated username field when nothing else is set', () => {
    // `username` is the old alias of primaryUsername. Nothing writes it any
    // more, but a profile that still carries it should not lose its placeholder.
    expect(selfNamePlaceholder(null, { username: 'legacy' }, 'fallback')).toBe('legacy');
  });

  it('ranks the deprecated field below both live ones', () => {
    expect(
      selfNamePlaceholder(
        { name: 'alice', isQnsVerified: true },
        { displayName: 'Alice', username: 'legacy' },
        'fallback',
      ),
    ).toBe('alice.q');
    expect(
      selfNamePlaceholder(null, { displayName: 'Alice', username: 'legacy' }, 'fallback'),
    ).toBe('Alice');
  });

  it("uses the caller's copy when there is no name at all", () => {
    // Deliberately NOT resolveSelfName's "Unnamed", which is a rendered name
    // and would read as though it were already your name.
    expect(selfNamePlaceholder(null, undefined, 'Your name in this space')).toBe(
      'Your name in this space',
    );
    expect(selfNamePlaceholder(null, {}, 'Your name in this space')).toBe(
      'Your name in this space',
    );
    expect(
      selfNamePlaceholder(null, { displayName: '  ' }, 'Your name in this space'),
    ).toBe('Your name in this space');
  });
});
