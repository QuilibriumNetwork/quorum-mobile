/**
 * Custom client skins — shared types.
 *
 * A skin is a *declarative* token document plus embedded `data:` assets. It is
 * never evaluated as code: the engine reads an allow-listed set of keys and
 * maps them onto theme tokens. See `validate.ts` for the (security-critical)
 * validation that enforces the allow-list, the no-remote-URL rule, and image
 * content sniffing.
 */

/** Overridable color tokens (mirror the extended colors in `createTheme`). */
export interface SkinColorTokens {
  accent: string;
  accentLight: string;
  accentDark: string;
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
}

/** The exhaustive set of color token names a skin may override. */
export const SKIN_COLOR_KEYS: readonly (keyof SkinColorTokens)[] = [
  'accent', 'accentLight', 'accentDark',
  'surface0', 'surface1', 'surface2', 'surface3', 'surface4', 'surface5',
  'surface6', 'surface7', 'surface8', 'surface9', 'surface10',
  'textStrong', 'textMain', 'textSubtle', 'textMuted',
  'danger', 'warning', 'success', 'info',
] as const;

export interface SkinRadii {
  sm: number;
  md: number;
  lg: number;
  pill: number;
}

/** Spacing scale (padding/margins/gaps). Components read `theme.spacing.*`. */
export interface SkinSpacing {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
}

/** A single icon substitution: a validated `data:image/png|jpeg` glyph.
 *  `tint` (default true) renders it as a template tinted by the requested
 *  color; set false for full-color icons that should render as-is. */
export interface SkinIcon {
  image: string;
  tint?: boolean;
}

/** Map of IconSymbol name → substitute image. */
export type SkinIcons = Record<string, SkinIcon>;

export interface SkinBorders {
  hairline: number;
  thin: number;
  thick: number;
  color: string;
}

/**
 * Geometry overrides combine optional named-token overrides with a global
 * `scale` (and, for radii, an absolute `set`). The scale is what makes the app
 * *broadly* customizable: it's applied to every `radius()`/`space()`/`border()`
 * call across the app (identity = 1), so a skin can make everything square
 * (`radii.scale: 0`), rounder, tighter, or heavier-bordered with one number.
 */
export interface SkinRadiiOverride extends Partial<SkinRadii> {
  /** Multiplies every radius (0 = square corners everywhere). */
  scale?: number;
  /** Forces every radius to this absolute px (overrides scale). */
  set?: number;
}
export interface SkinSpacingOverride extends Partial<SkinSpacing> {
  /** Multiplies every padding/margin/gap. */
  scale?: number;
}
export interface SkinBordersOverride extends Partial<SkinBorders> {
  /** Multiplies every border width. */
  scale?: number;
}

/** Embedded font face. v1 is single-face (`static-single`); the same family is
 *  used for every weight (synthetic bold). `source.dataUri` is a validated
 *  `data:font/ttf|otf;base64,...` URI. */
export interface SkinFont {
  family: string;
  source: { dataUri: string };
  weights: 'static-single';
}

export type WallpaperFit = 'cover' | 'tile' | 'contain';

export interface SkinWallpaper {
  /** Validated `data:image/png|jpeg;base64,...`. */
  source: { dataUri: string };
  fit: WallpaperFit;
  /** Scrim opacity over the wallpaper, 0..1 (keeps text legible). */
  scrimOpacity: number;
  /** Global alpha applied to surface tokens so the wallpaper shows through, 0..1. */
  surfaceAlpha: number;
}

export type FrameCorner = 'square' | 'rounded' | 'pill';

/** Decorative "chrome" — allow-listed enums/tokens only, applied at a few
 *  container boundaries (never arbitrary per-component style). */
export interface FrameOptions {
  corner?: FrameCorner;
  accentBorder?: { width: 'thin' | 'thick'; color?: string; radius?: 'sm' | 'md' | 'lg' };
  headerBar?: { background?: string; height?: number; tint?: string };
  panelGlow?: boolean;
}

/**
 * Named UI regions a skin can give their own background / style. Allow-listed
 * (security + bounded). Components opt in via `useSurface(slot)` /
 * `<SurfaceBackground slot=…>`; unwired slots are simply ignored until a
 * component adopts them.
 */
export type SlotName =
  | 'feed'
  | 'cast'
  | 'wallet'
  | 'messages'
  | 'spaces'
  | 'profile'
  | 'button'
  | 'card'
  | 'input'
  | 'header'
  | 'tabBar'
  | 'chatBubble';

export const SLOT_NAMES: readonly SlotName[] = [
  'feed', 'cast', 'wallet', 'messages', 'spaces', 'profile',
  'button', 'card', 'input', 'header', 'tabBar', 'chatBubble',
];

/** Per-slot style. `background` is either a color (hex/rgba) or a
 *  `data:image/png|jpeg` URI; `fit`/`opacity` apply when it's an image. */
export interface SurfaceStyle {
  background?: string;
  fit?: WallpaperFit;
  opacity?: number;
  /** Optional text-color override for content rendered on this surface. */
  text?: string;
}

export interface SkinMeta {
  name: string;
  description?: string;
  authorAddress?: string;
  authorName?: string;
  createdAt?: number;
}

export interface SkinOverride {
  schemaVersion: 1;
  /** Server-assigned content hash; empty for a locally-authored draft. */
  id: string;
  meta: SkinMeta;
  /** Built-in theme to layer onto. */
  base: 'light' | 'dark';
  colors?: {
    light?: Partial<SkinColorTokens>;
    dark?: Partial<SkinColorTokens>;
  };
  radii?: SkinRadiiOverride;
  borders?: SkinBordersOverride;
  spacing?: SkinSpacingOverride;
  /** Global multiplier applied to every `theme.fontSizes` token (0.7–1.6). */
  fontScale?: number;
  font?: SkinFont;
  /** Per-icon image substitutions, keyed by IconSymbol name. */
  icons?: SkinIcons;
  wallpaper?: SkinWallpaper;
  frame?: FrameOptions;
  /**
   * Per-region backgrounds/knobs. Keys are slot names, optionally with a
   * dotted variant (`button`, `button.primary`). Resolution cascades
   * most-specific → generic → theme default, so generic slots are inherited
   * unless a more specific one overrides. See theme/skins/surfaces.ts.
   */
  surfaces?: Record<string, SurfaceStyle>;
}
