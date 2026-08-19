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
 * Faces of the bundled UI font, registered with expo-font in the root layout
 * before first paint.
 *
 * Each weight is its own file and its own family name because React Native
 * cannot drive a variable font's weight axis — Expo's docs state plainly that
 * "variable fonts ... do not have support across all platforms" and to "use
 * static fonts" instead. This is the one place mobile must diverge from
 * desktop, which ships a single variable Inter and sets `font-weight`
 * numerically.
 *
 * Each face is paired with its TRUE weight, not a neutral one. Synthetic
 * ("faux") bolding is only applied when the requested weight is heavier than
 * the face can provide — asking Inter_700Bold for 700 is a no-op, so there is
 * no double-bolding to avoid. React Navigation's `Theme['fonts']` also requires
 * a concrete `fontWeight`, so omitting it is not an option regardless.
 */
export const INTER_FACES = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semiBold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  heavy: 'Inter_900Black',
} as const;

/**
 * The family used when no skin overrides it. Previously `'System'` (San
 * Francisco on iOS, whatever the OEM ships on Android) — which meant the app
 * rendered differently on every Android handset and never matched desktop.
 */
export const DEFAULT_FONT_FAMILY = INTER_FACES.regular;

/**
 * Build the weight→{family,weight} map for a given font family. A skin swaps
 * the family here (a single place) and every `theme.fonts.*.fontFamily`
 * consumer picks it up. Embedded skin fonts are single-face, so all weights
 * share one family and rely on synthetic bolding (see fontLoader).
 */
type FontWeight = '400' | '500' | '600' | '700' | '900';

type FontFace = { fontFamily: string; fontWeight: FontWeight };

type FontMap = {
  regular: FontFace;
  medium: FontFace;
  /** 600 is the app's most-used weight by a wide margin, so it is first-class. */
  semiBold: FontFace;
  bold: FontFace;
  heavy: FontFace;
  /**
   * Optional face a skin may add. Not produced by the default map, so consumers
   * must access it defensively (e.g. `theme.fonts.mono?.fontFamily || fallback`).
   */
  mono?: FontFace;
};

/**
 * Build the weight→face map.
 *
 * Pass nothing for the app's own font: each weight resolves to its own bundled
 * Inter family, with no `fontWeight` (see INTER_FACES).
 *
 * Pass a family for a skin: skin fonts are single-face, so every weight shares
 * that one family and relies on the platform synthesizing the weight.
 */
export function makeFonts(skinFamily?: string | null): FontMap {
  if (!skinFamily) {
    return {
      regular: { fontFamily: INTER_FACES.regular, fontWeight: '400' },
      medium: { fontFamily: INTER_FACES.medium, fontWeight: '500' },
      semiBold: { fontFamily: INTER_FACES.semiBold, fontWeight: '600' },
      bold: { fontFamily: INTER_FACES.bold, fontWeight: '700' },
      heavy: { fontFamily: INTER_FACES.heavy, fontWeight: '900' },
    };
  }
  const fontFamily = skinFamily;
  return {
    regular: { fontFamily, fontWeight: '400' },
    medium: { fontFamily, fontWeight: '500' },
    semiBold: { fontFamily, fontWeight: '600' },
    bold: { fontFamily, fontWeight: '700' },
    heavy: { fontFamily, fontWeight: '900' },
  };
}

export const fonts = makeFonts();

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
 *
 * THIS IS THE ONE PLACE THE READING SURFACES ARE SIZED. The long-form text a
 * user actually reads — chat messages, Farcaster casts — is `body`, and the
 * name heading each one is `headline`. Both were raw numbers scattered across
 * call sites until 2026-08-19, which is why retuning the message size meant
 * editing seven files and still missing some, leaving an author name smaller
 * than the cast beneath it. Change the number here, not at the call site.
 *
 * A name must never end up smaller than the text it heads: `headline` and
 * `body` share a size deliberately, so move them together.
 */
type TextStyleEntry = FontFace & {
  fontSize: number;
  lineHeight: number;
};

/**
 * Build the semantic type scale for a given font family + size multiplier, so
 * a skin's font and `fontScale` flow through `theme.textStyles` (see
 * createTheme). The base sizes/weights match iOS HIG.
 */
export function makeTextStyles(skinFamily?: string | null, scale = 1) {
  const px = (n: number) => Math.round(n * scale);
  // Resolve through makeFonts so each entry picks up the right bundled face
  // (or the skin's single face plus a synthesized weight) — the type scale must
  // not hardcode a family, or bold styles render as faux-bold regular.
  const W = makeFonts(skinFamily);
  const e = (face: FontFace, fontSize: number, lineHeight: number): TextStyleEntry => ({
    ...face,
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
    /** 16/22 semibold — prominent body text, list item titles, names */
    headline: e(W.semiBold, 16, 22),
    /**
     * 16/22 regular — default body copy, and every long-form reading surface.
     *
     * 16 rather than the 17 iOS HIG nominates for Body: 17 was tried and read
     * too large on a device, because a name at the same size sits beside it and
     * most users are on a system font scale above 1.0, which multiplies both.
     * 16 also matches the composer input and desktop, so what you type, what
     * you read, and what you see on the web client are one size.
     */
    body: e(W.regular, 16, 22),
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
