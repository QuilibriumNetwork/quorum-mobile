export const colors = {
  accent: {
    50: '#eef7ff',
    100: '#daeeff',
    150: '#a6d9ff',
    200: '#6fc3ff',
    300: '#48adf5',
    400: '#3aa9f8',
    500: '#0287f2',
    600: '#025ead',
    700: '#034081',
    800: '#0a0733',
    900: '#060421',
  },
  surface: {
    '00': '#ffffff',
    '0': '#fefeff',
    '1': '#f6f6f9',
    '2': '#eeeef3',
    '3': '#e6e6eb',
    '4': '#dedee3',
    '5': '#d5d5db',
    '6': '#cdccd3',
    '7': '#c4c4cb',
    '8': '#bbbbc3',
    '9': '#a2a2aa',
    '10': '#939399',
  },
  darkSurface: {
    '00': '#100f11',
    '0': '#1d1a21',
    '1': '#241f27',
    '2': '#2c252e',
    '3': '#312935',
    '4': '#3a313f',
    '5': '#443b49',
    '6': '#584d5e',
    '7': '#716379',
    '8': '#92829b',
    '9': '#a999b3',
    '10': '#bfadca',
  },
  text: {
    light: {
      strong: '#3b3b3b',
      main: '#363636',
      subtle: '#818181',
      muted: '#b6b6b6',
    },
    dark: {
      strong: '#f8f7fa',
      main: '#f4f1f6',
      // Dark `subtle` quieted from #bfb5c8 toward the muted tone (#84788b) so
      // the secondary text re-pointed from muted→subtle (for the light-theme
      // contrast fix) doesn't read louder than it did on dark, where it already
      // looked right. Still clearly above muted for legibility. Light is
      // unchanged (#818181 is already the correct secondary tone there).
      subtle: '#9b8fa6',
      muted: '#84788b',
    },
  },
  utilities: {
    danger: '#e74a4a',
    dangerHover: '#ec3333',
    warning: '#e7b04a',
    success: '#46c236',
    info: '#3095bd',
    dangerDark: '#c73737',
    dangerHoverDark: '#b83030',
    warningDark: '#d09a3d',
    successDark: '#379e2b',
    infoDark: '#267b9e',
  },
} as const;

export const accentThemes = {
  blue: {
    50: '#eef7ff',
    100: '#daeeff',
    150: '#a6d9ff',
    200: '#6fc3ff',
    300: '#48adf5',
    400: '#3aa9f8',
    500: '#0287f2',
    600: '#025ead',
    700: '#034081',
    800: '#0a0733',
    900: '#060421',
  },
  purple: {
    50: '#f5f2ff',
    100: '#e9e3ff',
    150: '#d3c6ff',
    200: '#bda8ff',
    300: '#a78bff',
    400: '#916eff',
    500: '#7c52ff',
    600: '#6233e8',
    700: '#4b27b3',
    800: '#281566',
    900: '#140b33',
  },
  fuchsia: {
    50: '#fdf4ff',
    100: '#fae8ff',
    200: '#f5d0fe',
    300: '#f0abfc',
    400: '#e879f9',
    500: '#d946ef',
    600: '#c026d3',
    700: '#a21caf',
    800: '#86198f',
    900: '#701a75',
  },
  orange: {
    50: '#fff7ed',
    100: '#ffedd5',
    200: '#fed7aa',
    300: '#fdba74',
    400: '#fb923c',
    500: '#f97316',
    600: '#ea580c',
    700: '#c2410c',
    800: '#9a3412',
    900: '#7c2d12',
  },
  green: {
    50: '#f0f9eb',
    100: '#e1f3d6',
    150: '#c3e7ad',
    200: '#a5d984',
    300: '#87cc5b',
    400: '#69be32',
    500: '#4fa81a',
    600: '#3b7e14',
    700: '#27540e',
    800: '#142b07',
    900: '#0a1504',
  },
  yellow: {
    50: '#fefce8',
    100: '#fef9c3',
    200: '#fef08a',
    300: '#fde047',
    400: '#facc15',
    500: '#eab308',
    600: '#ca8a04',
    700: '#a16207',
    800: '#854d0e',
    900: '#713f12',
  },
} as const;

/**
 * Brand marks that are NOT ours, and therefore NOT themeable.
 *
 * The accent palette above re-skins with the user's chosen accent, which is
 * right for anything that means "this app". These do the opposite job: the
 * whole point of Farcaster purple is to say "Farcaster" at a glance, so it has
 * to stay the same colour whatever accent the user picked. Do not route these
 * through `theme.colors.*`.
 *
 * `farcaster` is Farcaster's own #855DCD. Several older call sites use #8B5CF6
 * (Tailwind violet-500) labelled "Farcaster purple" — that is a near-miss, not
 * the brand colour; prefer this token in new code.
 *
 * Quorum's own mark is `colors.accent[500]` and is the one exception that DOES
 * follow the accent: it is our logo, so tinting it to the user's accent reads
 * as the app agreeing with itself rather than as a wrong brand colour.
 */
export const brandColors = {
  farcaster: '#855DCD',
  quorum: colors.accent[500],
  /**
   * Farcaster purple corrected for LEGIBILITY, as a light/dark pair.
   *
   * The brand value above is a graphic colour. Used as small text it fails WCAG
   * AA (4.5:1 — a 12px bold label is nowhere near the 18.7px "large text"
   * threshold): measured 4.38:1 on `surface1` light and 3.42:1 on dark. The
   * dark figure is the worse problem, because the neutral it replaced sat at
   * 5.29:1, so painting a label brand-purple on dark makes it harder to read
   * than it was.
   *
   * These two are the closest values to the brand hue that clear 4.5:1 on their
   * respective surfaces — measured 5.20:1 (light) and 4.79:1 (dark). Still
   * unmistakably Farcaster purple; just readable.
   *
   * Use `farcaster` for a mark on its own, and this pair anywhere the colour
   * carries a word.
   */
  farcasterOn: {
    light: '#7A4FC4',
    dark: '#9B7BD9',
  },
} as const;