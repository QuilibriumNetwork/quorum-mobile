import { StyleSheet } from 'react-native';
import { Theme } from '@react-navigation/native';
import { accentThemes, colors } from './colors';
import { fonts as defaultFonts, fontSizes, makeFonts, makeTextStyles } from './fonts';
import { skinFontFamily, withAlpha } from './skins/mergeSkin';
import { deriveGeometry } from './skins/geometry';
import type { FrameOptions, SkinBorders, SkinColorTokens, SkinOverride, SkinRadii, SkinSpacing } from './skins/types';

type AccentColor = keyof typeof accentThemes;

const BASE_RADII: SkinRadii = { sm: 6, md: 8, lg: 12, pill: 999 };
const BASE_SPACING: SkinSpacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

/** Scale every font-size token by a skin's `fontScale`, preserving the shape. */
function scaleFontSizes(scale: number): typeof fontSizes {
  if (scale === 1) return fontSizes;
  const out: Record<string, number> = {};
  for (const k of Object.keys(fontSizes)) {
    out[k] = Math.round((fontSizes as Record<string, number>)[k] * scale);
  }
  return out as typeof fontSizes;
}

const createTheme = (
  isDark: boolean,
  accentColor: AccentColor = 'blue',
  skin?: SkinOverride | null,
): Theme & {
  colors: Theme['colors'] & {
    accent: string;
    accentLight: string;
    accentDark: string;
    accentSoft: string;
    accentSubtle: string;
    surface0: string;
    surface1: string;
    surface2: string;
    surface3: string;
    surface4: string;
    surface5: string;
    surface6: string;
    surface7: string;
    surface8: string;
    surface9: string;
    surface10: string;
    textStrong: string;
    textMain: string;
    textSubtle: string;
    textMuted: string;
    danger: string;
    warning: string;
    success: string;
    info: string;
    // Semantic tokens — named by element role, mirroring desktop's --color-* convention.
    // Use these in components instead of raw surfaceN so a background change only
    // requires updating the token, not hunting every call site.
    bgModal: string;
    bgModalSidebar: string;
    fieldBg: string;
    fieldBgFocus: string;
    fieldBorder: string;
    fieldBorderFocus: string;
    borderSubtle: string;
    borderDefault: string;
    borderStrong: string;
    bgButtonSubtle: string;
    // Chat composer + floating tab bar — semantic, per-scheme so the dark and
    // light treatments are tuned independently instead of one value eyeballed
    // on dark and wrong on light.
    composerPillBg: string;
    composerPillBorder: string;
    tabBarIconInactive: string;
  };
  fonts: ReturnType<typeof makeFonts>;
  fontSizes: typeof fontSizes;
  textStyles: ReturnType<typeof makeTextStyles>;
  radii: SkinRadii;
  borders: SkinBorders;
  spacing: SkinSpacing;
  frame: FrameOptions;
} => {
  const accent = accentThemes[accentColor];
  const surface = isDark ? colors.darkSurface : colors.surface;
  const textColors = isDark ? colors.text.dark : colors.text.light;
  const utilities = isDark ? {
    danger: colors.utilities.dangerDark,
    warning: colors.utilities.warningDark,
    success: colors.utilities.successDark,
    info: colors.utilities.infoDark,
  } : {
    danger: colors.utilities.danger,
    warning: colors.utilities.warning,
    success: colors.utilities.success,
    info: colors.utilities.info,
  };

  // Skin color overrides for the active light/dark variant (already validated).
  const ov: Partial<SkinColorTokens> = (isDark ? skin?.colors?.dark : skin?.colors?.light) ?? {};
  const pick = (key: keyof SkinColorTokens, fallback: string): string => ov[key] ?? fallback;

  // When a wallpaper sets surfaceAlpha, surface tokens become translucent so
  // the wallpaper shows through. Text/borders stay opaque for legibility.
  const sa = skin?.wallpaper?.surfaceAlpha;
  const sheer = (val: string): string => (sa !== undefined && sa < 1 ? withAlpha(val, sa) : val);
  const surf = (key: keyof SkinColorTokens, base: string): string => sheer(pick(key, base));

  const skinFamily = skinFontFamily(skin);
  const fonts = skinFamily ? makeFonts(skinFamily) : defaultFonts;

  // Named tokens flow through the same geometry scale as the app-wide
  // radius()/space()/border() helpers, so semantic tokens and raw literals
  // stay consistent under a skin. Explicit named overrides still win.
  const geo = deriveGeometry(skin);
  const rad = (n: number) =>
    geo.radiusSet !== undefined ? (n === 0 ? 0 : geo.radiusSet) : Math.round(n * geo.radiusScale);
  const radii: SkinRadii = {
    sm: skin?.radii?.sm ?? rad(BASE_RADII.sm),
    md: skin?.radii?.md ?? rad(BASE_RADII.md),
    lg: skin?.radii?.lg ?? rad(BASE_RADII.lg),
    pill: skin?.radii?.pill ?? BASE_RADII.pill,
  };
  const spacing: SkinSpacing = {
    xs: skin?.spacing?.xs ?? Math.round(BASE_SPACING.xs * geo.spacingScale),
    sm: skin?.spacing?.sm ?? Math.round(BASE_SPACING.sm * geo.spacingScale),
    md: skin?.spacing?.md ?? Math.round(BASE_SPACING.md * geo.spacingScale),
    lg: skin?.spacing?.lg ?? Math.round(BASE_SPACING.lg * geo.spacingScale),
    xl: skin?.spacing?.xl ?? Math.round(BASE_SPACING.xl * geo.spacingScale),
  };
  const borders: SkinBorders = {
    hairline: skin?.borders?.hairline ?? StyleSheet.hairlineWidth,
    thin: skin?.borders?.thin ?? 1 * geo.borderScale,
    thick: skin?.borders?.thick ?? 2 * geo.borderScale,
    color: skin?.borders?.color ?? pick('surface6', surface['6']),
  };

  return {
    dark: isDark,
    colors: {
      primary: pick('accent', accent[500]),
      background: sheer(surface['00']),
      card: surf('surface2', surface['2']),
      text: pick('textMain', textColors.main),
      border: pick('surface6', surface['6']),
      notification: pick('accent', accent[500]),

      // Extended colors
      accent: pick('accent', accent[500]),
      accentLight: pick('accentLight', accent[200]),
      accentDark: pick('accentDark', accent[700]),
      // Accent at low alpha — for tinted highlight/selected backgrounds. Follow
      // the (possibly skinned) accent so those surfaces re-skin too.
      accentSoft: withAlpha(pick('accent', accent[500]), 0.12),
      accentSubtle: withAlpha(pick('accent', accent[500]), 0.06),
      surface0: surf('surface0', surface['0']),
      surface1: surf('surface1', surface['1']),
      surface2: surf('surface2', surface['2']),
      surface3: surf('surface3', surface['3']),
      surface4: surf('surface4', surface['4']),
      surface5: surf('surface5', surface['5']),
      surface6: surf('surface6', surface['6']),
      surface7: surf('surface7', surface['7']),
      surface8: surf('surface8', surface['8']),
      surface9: surf('surface9', surface['9']),
      surface10: surf('surface10', surface['10']),
      textStrong: pick('textStrong', textColors.strong),
      textMain: pick('textMain', textColors.main),
      textSubtle: pick('textSubtle', textColors.subtle),
      textMuted: pick('textMuted', textColors.muted),
      danger: pick('danger', utilities.danger),
      warning: pick('warning', utilities.warning),
      success: pick('success', utilities.success),
      info: pick('info', utilities.info),

      // Semantic tokens (mirrors desktop --color-* convention, see _colors.scss)
      bgModal: surf('surface2', surface['2']),
      bgModalSidebar: surf('surface1', surface['1']),
      fieldBg: surf('surface0', surface['0']),
      fieldBgFocus: surf('surface1', surface['1']),
      // surface4 gives visible delineation without feeling heavy on mobile.
      // Desktop uses surface5 but mobile fields read better with a lighter touch.
      fieldBorder: surf('surface4', surface['4']),
      fieldBorderFocus: pick('accent', accent[500]),
      borderSubtle: surf('surface4', surface['4']),
      borderDefault: surf('surface5', surface['5']),
      borderStrong: surf('surface6', surface['6']),
      bgButtonSubtle: surf('surface4', surface['4']),
      // Composer pill: a touch lighter than the chat background so it reads as a
      // distinct, raised surface in BOTH schemes (dark uses a raised surface4;
      // light uses pure white lifted off the off-white chat bg).
      composerPillBg: isDark ? surf('surface4', surface['4']) : surf('surface0', surface['0']),
      // Pill rim: a faint white top-light on dark; a subtle grey hairline on
      // light (white-on-white is invisible, so light needs a darker edge).
      composerPillBorder: isDark ? 'rgba(255,255,255,0.10)' : surf('surface4', surface['4']),
      // Inactive tab-bar icon: textMuted is too faint on a white bar, so light
      // uses a stronger subtle tone; dark keeps the muted tone (reads fine on black).
      tabBarIconInactive: isDark ? pick('textMuted', textColors.muted) : pick('textSubtle', textColors.subtle),
    },
    fonts,
    fontSizes: scaleFontSizes(skin?.fontScale ?? 1),
    textStyles: makeTextStyles(skinFamily ?? undefined, skin?.fontScale ?? 1),
    radii,
    borders,
    spacing,
    frame: skin?.frame ?? {},
  };
};

export const LightTheme = createTheme(false);
export const DarkTheme = createTheme(true);

export const createThemedStyles = (theme: ReturnType<typeof createTheme>) => {
  const { colors, fonts, fontSizes, radii, spacing } = theme;

  return {
    text: {
      default: {
        fontFamily: fonts.regular.fontFamily,
        fontSize: fontSizes.md,
        color: colors.textMain,
      },
      strong: {
        fontFamily: fonts.bold.fontFamily,
        fontSize: fontSizes.md,
        color: colors.textStrong,
      },
      subtle: {
        fontFamily: fonts.regular.fontFamily,
        fontSize: fontSizes.md,
        color: colors.textSubtle,
      },
      muted: {
        fontFamily: fonts.regular.fontFamily,
        fontSize: fontSizes.sm,
        color: colors.textMuted,
      },
      heading: {
        fontFamily: fonts.bold.fontFamily,
        fontSize: fontSizes['2xl'],
        color: colors.textStrong,
      },
      subheading: {
        fontFamily: fonts.medium.fontFamily,
        fontSize: fontSizes.lg,
        color: colors.textMain,
      },
    },
    container: {
      default: {
        backgroundColor: colors.background,
      },
      card: {
        backgroundColor: colors.card,
        borderRadius: radii.md,
        padding: spacing.lg,
      },
      modal: {
        backgroundColor: colors.surface5,
        borderRadius: radii.lg,
      },
    },
    button: {
      primary: {
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
      },
      secondary: {
        backgroundColor: colors.surface3,
        borderRadius: radii.lg,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
      },
      danger: {
        backgroundColor: colors.danger,
        borderRadius: radii.lg,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
      },
    },
    input: {
      default: {
        backgroundColor: colors.surface3,
        borderRadius: radii.md,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        fontSize: fontSizes.md,
        fontFamily: fonts.regular.fontFamily,
        color: colors.textMain,
      },
    },
  };
};

export type AppTheme = ReturnType<typeof createTheme>;

export { createTheme, type AccentColor };
