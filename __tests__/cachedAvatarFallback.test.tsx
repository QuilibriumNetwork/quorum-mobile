/**
 * A photoless avatar shows the person, never a shared brand mark.
 *
 * `CachedAvatar`'s fallback used to default to a static Quorum symbol, so any
 * call site that omitted `fallbackName` rendered every user without a profile
 * picture as the same blue square — four different people in one thread, four
 * identical avatars. Twenty-one call sites omitted it, mostly by being
 * extracted out of `SocialFeedModal` into their own files without the prop
 * following them, which is not a mistake a reviewer catches by eye.
 *
 * ## What is worth testing here, and what is not
 *
 * "Give it a name and a missing photo, get initials" passes against the BROKEN
 * version too — that path was always correct. A test like that proves nothing
 * and manufactures confidence, so it is deliberately absent.
 *
 * The defect only ever appeared when the name was OMITTED. So both tests below
 * attack omission, from the two directions it can happen:
 *
 *   1. at runtime, if the default is ever reintroduced
 *   2. at the call sites, which is where it actually happened
 *
 * Both fail against the pre-fix tree. That is the bar.
 */
import React from 'react';
import { render, act } from '@testing-library/react-native';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { Image } from 'expo-image';
import { CachedAvatar } from '@/components/ui/CachedAvatar';

const SCAN_ROOTS = ['components', 'app'];

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
};

describe('CachedAvatar has no brand-mark fallback', () => {
  // `fallbackName` is required, so omitting it is a compile error — which is
  // the real guard. This casts past the type to assert the RUNTIME behaviour
  // too, so reintroducing a default image is caught even for a caller that
  // reaches this component through `any` (a plain-JS consumer, a spread props
  // object, a test helper).
  const withNoName = () =>
    render(
      React.createElement(CachedAvatar as unknown as React.ComponentType<Record<string, unknown>>, {
        source: null,
        style: { width: 44, height: 44 },
      }),
    );

  it('renders no image when it has neither a photo nor a name', () => {
    // Pre-fix this rendered an <Image> carrying quorum-symbol-bg-blue.png.
    const { UNSAFE_queryAllByType } = withNoName();
    expect(UNSAFE_queryAllByType(Image)).toHaveLength(0);
  });

  it('renders the neutral glyph when it has neither a photo nor a name', () => {
    // Honest about knowing nobody, rather than asserting a brand.
    expect(withNoName().getByText('?')).toBeTruthy();
  });

  it('degrades to initials when a photo that looked valid fails to load', () => {
    // `onError` used to be wired only when a fallbackName was supplied, so at
    // the 21 nameless sites a 404 left a blank or broken image on screen. It is
    // now unconditional, which is a real behaviour change this diff ships and
    // which nothing else in the suite exercises.
    const { UNSAFE_getByType, UNSAFE_queryAllByType, getByText } = render(
      <CachedAvatar
        source={{ uri: 'https://example.test/gone.png' }}
        fallbackName="Ada Rivera"
        style={{ width: 44, height: 44 }}
      />,
    );
    act(() => {
      UNSAFE_getByType(Image).props.onError();
    });
    expect(UNSAFE_queryAllByType(Image)).toHaveLength(0);
    expect(getByText('AR')).toBeTruthy();
  });

  it('retries when the photo changes after a failure', () => {
    // Load-bearing in a recycled list: FlashList reuses one instance across
    // rows, so without a reset a single 404 latches the failure and everyone
    // who later lands in that slot renders as initials despite having a photo.
    const { UNSAFE_getByType, UNSAFE_queryAllByType, rerender } = render(
      <CachedAvatar
        source={{ uri: 'https://example.test/gone.png' }}
        fallbackName="Ada Rivera"
        style={{ width: 44, height: 44 }}
      />,
    );
    act(() => {
      UNSAFE_getByType(Image).props.onError();
    });
    expect(UNSAFE_queryAllByType(Image)).toHaveLength(0);

    // The row rebinds to a different person, who does have a working photo.
    rerender(
      <CachedAvatar
        source={{ uri: 'https://example.test/bo.png' }}
        fallbackName="Bo Chen"
        style={{ width: 44, height: 44 }}
      />,
    );
    expect(UNSAFE_queryAllByType(Image)).toHaveLength(1);
  });
});

/**
 * Every call site names its subject.
 *
 * The type system already enforces this, and this test is deliberately NOT
 * redundant with it: `tsc --noEmit` is a separate command that a contributor
 * can skip, and a `{...props}` spread or an `any`-typed wrapper satisfies the
 * compiler while still shipping a nameless avatar. This asserts the property at
 * the level the bug actually lived — the JSX — where it is also readable as a
 * rule rather than inferable from a type error.
 *
 * Grep-shaped on purpose, in the same spirit as `rawNameFieldAudit`: it exists
 * to keep the CLASS loud, not to replace review.
 */
describe('every CachedAvatar call site supplies a name', () => {
  /** The rule, as a pure function, so it can be aimed at a fixture too. */
  const namelessAvatarsIn = (src: string): number[] => {
    const hits: number[] = [];
    let from = 0;
    for (;;) {
      const open = src.indexOf('<CachedAvatar', from);
      if (open === -1) break;
      // Every usage in this codebase is self-closing. Bound the element at the
      // first `/>` so a `fallbackName` belonging to a LATER element cannot
      // vouch for this one — the exact way a hand-rolled window check gives a
      // false pass.
      const close = src.indexOf('/>', open);
      const element = close === -1 ? src.slice(open) : src.slice(open, close);
      if (!element.includes('fallbackName')) hits.push(src.slice(0, open).split('\n').length);
      from = open + 1;
    }
    return hits;
  };

  // Without this, a one-line regression in `namelessAvatarsIn` (a bad bound, a
  // typo'd tag name) makes the audit permanently green and nobody notices. The
  // same failure mode `rawNameFieldAudit`'s own not-vacuous test exists to
  // prevent. Proves the rule fires in BOTH directions against known strings.
  it('is not vacuous — the rule fires on a synthetic offender', () => {
    expect(namelessAvatarsIn('<CachedAvatar source={x} style={y} />')).toHaveLength(1);
    expect(namelessAvatarsIn('<CachedAvatar source={x} fallbackName={n} />')).toHaveLength(0);
    // A name on a LATER element must not vouch for an earlier bare one.
    expect(
      namelessAvatarsIn('<CachedAvatar source={a} />\n<CachedAvatar source={b} fallbackName={n} />'),
    ).toHaveLength(1);
  });

  it('finds no <CachedAvatar> without a fallbackName', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walk(root)) {
        for (const line of namelessAvatarsIn(readFileSync(file, 'utf8'))) {
          offenders.push(`${file.replace(/\\/g, '/')}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The hole the two guards above could not see.
 *
 * Requiring `fallbackName` only governs code that goes THROUGH `CachedAvatar`.
 * Two avatars bypassed it entirely and hardcoded the brand mark into a bare
 * `<Image>` — including the main feed's post row — so they kept shipping the
 * exact bug while a green suite said the class was closed. Type safety on one
 * component cannot police a component nobody used.
 *
 * The asset itself is legitimate; wearing it as somebody's FACE is not. So the
 * rule is on the asset's use, with the one genuine brand placement allowlisted.
 */
describe('the Quorum mark is never used as an avatar', () => {
  const BRAND_ASSET = 'quorum-symbol-bg-blue';

  /** Genuine brand placements — not a stand-in for a person. */
  const ALLOWED: Record<string, string> = {
    'app/(onboarding)/account-setup.tsx':
      'The product logo on the account-creation screen. It is the brand there, not a substitute for a face.',
  };

  it('finds no unallowlisted reference to the brand asset', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walk(root)) {
        const rel = file.replace(/\\/g, '/');
        if (ALLOWED[rel]) continue;
        if (readFileSync(file, 'utf8').includes(BRAND_ASSET)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    // An allowlist nobody prunes becomes a place bugs hide.
    for (const rel of Object.keys(ALLOWED)) {
      expect(readFileSync(rel, 'utf8')).toContain(BRAND_ASSET);
    }
  });
});
