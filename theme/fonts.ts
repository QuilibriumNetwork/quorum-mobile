/**
 * Typography system.
 *
 * `fonts` carries weight/family pairs for use with React Native's `fontFamily`
 * and `fontWeight` style props.
 *
 * `fontSizes` are the raw size tokens — useful for one-off sizes.
 *
 * `textStyles` is a semantic type scale matching iOS Human Interface
 * Guidelines (and their Material equivalents). Prefer these over raw sizes —
 * they encode proper line-heights and weights in one place so body text is
 * always the same body text.
 */

/**
 * The default font family. `'System'` is React Native's sentinel for the
 * platform's native UI font: San Francisco on iOS, and Roboto / the user's
 * chosen system font on Android (RN falls back to the device default for an
 * unrecognized family). No bundled font is used unless a skin overrides this.
 */
export const DEFAULT_FONT_FAMILY = 'System';

/**
 * Build the weight→{family,weight} map for a given font family. A skin swaps
 * the family here (a single place) and every `theme.fonts.*.fontFamily`
 * consumer picks it up. Embedded skin fonts are single-face, so all weights
 * share one family and rely on synthetic bolding (see fontLoader).
 */
export function makeFonts(fontFamily: string = DEFAULT_FONT_FAMILY) {
  return {
    regular: { fontFamily, fontWeight: '400' as const },
    medium: { fontFamily, fontWeight: '500' as const },
    bold: { fontFamily, fontWeight: '700' as const },
    heavy: { fontFamily, fontWeight: '900' as const },
  };
}

export const fonts = makeFonts(DEFAULT_FONT_FAMILY);

export const fontSizes = {
  xs: 10,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 18,
  '2xl': 20,
  '3xl': 24,
  '4xl': 32,
  '5xl': 48,
} as const;

/**
 * Semantic type scale. Sized and weighted to feel native on both platforms.
 *
 * Use these shapes directly in style objects:
 *   <Text style={textStyles.headline}>Hello</Text>
 *
 * Or spread them with color:
 *   <Text style={[textStyles.body, { color: theme.colors.textMain }]}>
 */
type TextStyleEntry = {
  fontFamily: string;
  fontWeight: '400' | '500' | '700' | '900';
  fontSize: number;
  lineHeight: number;
};

/**
 * Build the semantic type scale for a given font family + size multiplier, so
 * a skin's font and `fontScale` flow through `theme.textStyles` (see
 * createTheme). The base sizes/weights match iOS HIG.
 */
export function makeTextStyles(family: string = DEFAULT_FONT_FAMILY, scale = 1) {
  const px = (n: number) => Math.round(n * scale);
  const W = { regular: '400', medium: '500', bold: '700' } as const;
  const e = (fontWeight: '400' | '500' | '700', fontSize: number, lineHeight: number): TextStyleEntry => ({
    fontFamily: family,
    fontWeight,
    fontSize: px(fontSize),
    lineHeight: px(lineHeight),
  });
  return {
    /** 34/41 bold — large titles on list/root screens */
    largeTitle: e(W.bold, 34, 41),
    /** 28/34 bold — screen titles, main section headers */
    title1: e(W.bold, 28, 34),
    /** 22/28 bold — secondary titles, modal headers */
    title2: e(W.bold, 22, 28),
    /** 20/25 bold — tertiary titles, card headers */
    title3: e(W.bold, 20, 25),
    /** 17/22 semibold — prominent body text, list item titles */
    headline: e(W.medium, 17, 22),
    /** 17/22 regular — default body copy */
    body: e(W.regular, 17, 22),
    /** 16/21 regular — secondary body text */
    callout: e(W.regular, 16, 21),
    /** 15/20 regular — subheadlines, preview text */
    subheadline: e(W.regular, 15, 20),
    /** 13/18 regular — footnotes, tertiary info */
    footnote: e(W.regular, 13, 18),
    /** 12/16 regular — captions, metadata (timestamps, counts) */
    caption1: e(W.regular, 12, 16),
    /** 11/13 medium — overline / section labels (often uppercased) */
    caption2: e(W.medium, 11, 13),
  };
}

/** Default (unskinned) type scale. Prefer `theme.textStyles` in components so
 *  a skin's font + fontScale apply. */
export const textStyles = makeTextStyles();

export type TextStyleName = keyof ReturnType<typeof makeTextStyles>;
