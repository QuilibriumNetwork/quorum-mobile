/**
 * Render a real screen with the providers it cannot run without.
 *
 * ## What belongs here, and what does not
 *
 * ONLY providers whose absence makes a component throw rather than misbehave —
 * today that is the theme, because `useTheme` raises if no provider is above it.
 * These are infrastructure, identical for every test, and repeating them in
 * forty files would mean forty places to update when one changes.
 *
 * **Data providers do NOT belong here.** A test's fixtures are the thing it is
 * actually about, and hiding them in a shared helper is how a test comes to pass
 * for a reason its author never chose. Mock the hook you care about in the test
 * file, where a reader can see what was supplied.
 *
 * That line matters more than usual on this codebase: the defect class these
 * tests exist to catch is a screen resolving a name from the wrong data. A
 * helper that quietly supplied identity data would be able to hide exactly that.
 *
 * ## Why not a custom `render` that re-exports everything
 *
 * The common RTL pattern is to re-export the whole library with `render`
 * swapped. Not done here: the swap is invisible at the call site, so a reader
 * cannot tell a wrapped render from a bare one, and a test that genuinely wants
 * no providers has to fight the helper. An explicitly named function costs one
 * import and states what it does.
 *
 * ## Pinned to @testing-library/react-native 13.x — do NOT upgrade to 14 blind
 *
 * 14 is the forward-looking version: it drops `react-test-renderer`, which React
 * 19 deprecated, for the `test-renderer` package. It was tried (2026-08-11) and
 * REVERTED, because under this jest-expo + babel setup its `screen` global is
 * never populated — `dist/index.js` does not re-export `screen` as a live
 * binding, so `render` mutating it never reaches the importer. Every query
 * against `screen` throws "render function has not been called", MEASURED on a
 * bare `<Text>hello</Text>` with no providers and no mocks involved.
 *
 * What makes it worth this many words: the suite went GREEN on 14. An
 * `it.failing` test passes whenever its body throws, for any reason at all, so a
 * completely broken renderer read as a correctly-reproduced bug. The upgrade
 * looked fine and was not.
 *
 * Upgrading later is fine — 13.x will need replacing eventually — but it is a
 * task with its own verification, not a version bump. Confirm a plain `it` still
 * fails for the RIGHT reason, by reading the rendered tree in the failure output
 * rather than trusting the pass/fail count.
 */

import React from 'react';
import { render, type RenderOptions } from '@testing-library/react-native';
import { CustomThemeProvider } from '@/theme';

export function renderWithProviders(
  ui: React.ReactElement,
  options?: RenderOptions,
): ReturnType<typeof render> {
  return render(
    // Pinned rather than left to default. A test asserting on text should never
    // change behaviour because the app's default appearance changed, and a
    // failure caused by that would look like a naming bug.
    <CustomThemeProvider defaultAccentColor="blue" defaultAppearance="dark">
      {ui}
    </CustomThemeProvider>,
    options,
  );
}
