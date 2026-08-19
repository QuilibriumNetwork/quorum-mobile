/**
 * The user's text-size choice must move message text and NOTHING else.
 *
 * The first implementation multiplied every size in the app by the user's
 * factor. On a device that is plainly wrong: 20% off a 16pt message leaves 13,
 * which reads fine, while 20% off an 11pt section label leaves 9, which does
 * not. Legibility is not proportional at the small end. So the scope is
 * deliberately narrow, and these tests exist to keep it narrow — the failure
 * mode is someone later "fixing" an inconsistency by widening it again.
 *
 * Two properties matter more than the arithmetic:
 *   1. At the default step, every size in the app is byte-identical to what
 *      shipped before this feature existed. No user who never opens the setting
 *      can be affected by it.
 *   2. At every other step, the chrome does not move.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { Text } from 'react-native';
import { TextSizeModal } from '@/components/TextSizeModal';
import { CustomThemeProvider, useTheme } from '@/theme/ThemeProvider';
import { createTheme } from '@/theme/themes';
import { makeTextStyles } from '@/theme/fonts';
import * as Skin from '@/theme/skins/geometry';
import { TEXT_SIZE_STEPS, textSizeScale, type TextSizePref } from '@/theme/textSize';

// Reached by the always-mounted BaseModal; the house pattern for render tests.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// AuthContext transitively loads the native crypto module, and the preview's
// name goes through the identity resolver. Both are stubbed because this suite
// is about SIZING — that the preview resolves its name rather than reading it
// raw is enforced separately, by __tests__/rawNameFieldAudit.test.ts.
jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { address: 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz' } }),
}));
jest.mock('@/identity', () => ({ useResolvedName: () => 'Sample' }));

// MMKV is a native module; the pref store only needs to not throw here.
jest.mock('@/services/theme/skinPrefs', () => ({
  getActiveSkin: () => null,
  getAppearancePref: () => 'system',
  getTextSizePref: () => 'md',
  setTextSizePref: jest.fn(),
  setAppearancePref: jest.fn(),
  saveSkin: jest.fn(),
  setActiveSkinId: jest.fn(),
}));

const NON_DEFAULT = TEXT_SIZE_STEPS.filter((s) => s.scale !== 1).map((s) => s.key);

/** Tokens the setting is allowed to touch. */
const READING = ['messageBody', 'messageAuthor'] as const;

afterEach(() => {
  Skin.setSkinGeometry(null);
});

describe('text size steps', () => {
  it('are ordered smallest to largest and centred on 1', () => {
    const scales = TEXT_SIZE_STEPS.map((s) => s.scale);
    expect(scales).toEqual([...scales].sort((a, b) => a - b));
    expect(TEXT_SIZE_STEPS.find((s) => s.key === 'md')?.scale).toBe(1);
  });
});

describe('the default step changes nothing', () => {
  it('produces a type scale identical to the one with no user scale at all', () => {
    expect(makeTextStyles(undefined, 1, textSizeScale('md'))).toEqual(makeTextStyles(undefined, 1));
  });

  it('leaves every size token and Skin.font() untouched', () => {
    const theme = createTheme(false, 'blue', null, textSizeScale('md'));
    expect(theme.fontSizes).toEqual(createTheme(false, 'blue', null).fontSizes);
    expect(theme.msgFont(16)).toBe(16);
    expect(Skin.font(11)).toBe(11);
  });
});

describe('only message text moves', () => {
  it.each(NON_DEFAULT)('at step %s, the chrome tokens are unchanged', (key) => {
    const scaled = createTheme(false, 'blue', null, textSizeScale(key)).textStyles;
    const base = createTheme(false, 'blue', null).textStyles;

    for (const name of Object.keys(base) as (keyof typeof base)[]) {
      if ((READING as readonly string[]).includes(name)) continue;
      expect({ [name]: scaled[name] }).toEqual({ [name]: base[name] });
    }
  });

  it.each(NON_DEFAULT)('at step %s, message text DOES move', (key) => {
    const scale = textSizeScale(key);
    const { messageBody } = createTheme(false, 'blue', null, scale).textStyles;
    expect(messageBody.fontSize).toBe(Math.round(16 * scale));
    expect(messageBody.fontSize).not.toBe(16);
  });

  it.each(NON_DEFAULT)('at step %s, Skin.font() (the chrome path) is unaffected', (key) => {
    // Skin.font is a module singleton with no knowledge of the user's choice —
    // that is the point. If someone wires the user scale into it, this fails.
    createTheme(false, 'blue', null, textSizeScale(key));
    expect(Skin.font(12)).toBe(12);
    expect(Skin.font(16)).toBe(16);
  });
});

describe('the author name never ends up smaller than the message', () => {
  it.each(TEXT_SIZE_STEPS.map((s) => s.key))('at step %s', (key) => {
    const { messageBody, messageAuthor } = createTheme(
      false,
      'blue',
      null,
      textSizeScale(key),
    ).textStyles;
    expect(messageAuthor.fontSize).toBe(messageBody.fontSize);
    expect(messageAuthor.lineHeight).toBe(messageBody.lineHeight);
  });
});

describe('message content that is not prose follows the same scale', () => {
  it.each(TEXT_SIZE_STEPS.map((s) => s.key))('msgFont tracks step %s', (key) => {
    const scale = textSizeScale(key);
    // Markdown headings / code inside a bubble go through msgFont, so they must
    // move with the prose they sit next to.
    expect(createTheme(false, 'blue', null, scale).msgFont(14)).toBe(Math.round(14 * scale));
  });
});

describe('a skin fontScale still applies app-wide', () => {
  it('scales the chrome, and composes with the user choice on message text', () => {
    const skin = { id: 'test', base: 'dark' as const, fontScale: 1.25 };
    Skin.setSkinGeometry(skin as never);
    const t = createTheme(true, 'blue', skin as never, 1.2);

    // Chrome: skin only.
    expect(t.textStyles.footnote.fontSize).toBe(Math.round(13 * 1.25));
    expect(Skin.font(12)).toBe(Math.round(12 * 1.25));
    // Message text: skin AND user.
    expect(t.textStyles.messageBody.fontSize).toBe(Math.round(16 * 1.25 * 1.2));
  });
});

/** Reads live sizes out of the provider, so the assertions are on what a real
 *  component would render with rather than on recomputed values. */
function SizeProbe() {
  const { theme } = useTheme();
  return (
    <>
      <Text testID="msg">{String(theme.textStyles.messageBody.fontSize)}</Text>
      <Text testID="chrome">{String(theme.textStyles.footnote.fontSize)}</Text>
    </>
  );
}

describe('the control applies live', () => {
  const renderAt = (defaultTextSize: TextSizePref) =>
    render(
      <CustomThemeProvider defaultTextSize={defaultTextSize}>
        <SizeProbe />
        <TextSizeModal visible onClose={() => {}} />
      </CustomThemeProvider>,
    );

  it('moves message text but not the chrome when a step is tapped', () => {
    renderAt('md');
    expect(screen.getByTestId('msg')).toHaveTextContent('16');
    expect(screen.getByTestId('chrome')).toHaveTextContent('13');

    fireEvent.press(screen.getByLabelText('Text size: Extra large'));

    expect(screen.getByTestId('msg')).toHaveTextContent(String(Math.round(16 * textSizeScale('xl'))));
    // The control arm: this must NOT have moved.
    expect(screen.getByTestId('chrome')).toHaveTextContent('13');
  });

  it('shrinks message text without touching the chrome', () => {
    renderAt('md');
    fireEvent.press(screen.getByLabelText('Text size: Extra small'));

    expect(screen.getByTestId('msg')).toHaveTextContent(String(Math.round(16 * textSizeScale('xs'))));
    expect(screen.getByTestId('chrome')).toHaveTextContent('13');
  });

  it('returns to the default when Reset is tapped', () => {
    renderAt('xl');
    fireEvent.press(screen.getByLabelText('Reset text size to default'));
    expect(screen.getByTestId('msg')).toHaveTextContent('16');
  });
});
