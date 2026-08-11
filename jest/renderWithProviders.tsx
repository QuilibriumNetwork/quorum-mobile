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
