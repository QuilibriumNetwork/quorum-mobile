/**
 * Geometry scaling — the broad-customization layer.
 *
 * Components call `radius(n)` / `space(n)` / `border(n)` instead of writing raw
 * `borderRadius: 8` / `padding: 16` / `borderWidth: 1`. By default these are the
 * identity (so the migration changes nothing visually), but the active skin can
 * scale them globally — making the whole app square, rounder, tighter, roomier,
 * or heavier-bordered with a single number.
 *
 * The current geometry is held in a module singleton updated by ThemeProvider
 * (and at boot, before first paint). This lets BOTH per-render themed styles AND
 * static `StyleSheet.create` objects pick up a skin's scale — static styles
 * capture the boot-time skin (they re-evaluate on next launch, matching how
 * static styles already don't react to live light/dark changes).
 */

import { INTER_FACES } from '../fonts';
import { skinFontFamily } from './mergeSkin';
import type { SkinOverride } from './types';

export interface Geometry {
  radiusScale: number;
  radiusSet?: number;
  spacingScale: number;
  borderScale: number;
  fontScale: number;
  /**
   * The skin's single embedded face, or null when the app's own bundled faces
   * should be used. Held here so static skinnable stylesheets can resolve a
   * font family, the same way they already resolve sizes through `font()`.
   */
  fontFamily: string | null;
}

const IDENTITY: Geometry = { radiusScale: 1, spacingScale: 1, borderScale: 1, fontScale: 1, fontFamily: null };

let current: Geometry = IDENTITY;

/** Pure: derive the geometry from a skin. Shared by `createTheme` (for named
 *  tokens) and `setSkinGeometry` so the two never diverge. */
export function deriveGeometry(skin?: SkinOverride | null): Geometry {
  if (!skin) return IDENTITY;
  const r = skin.radii;
  // `frame.corner` is a high-level shortcut, applied ONLY when the skin hasn't
  // set radii explicitly (scale/set or any named token) — those win.
  const hasExplicitRadii = !!r && (
    r.scale !== undefined || r.set !== undefined ||
    r.sm !== undefined || r.md !== undefined || r.lg !== undefined || r.pill !== undefined
  );
  let radiusScale = r?.scale ?? 1;
  let radiusSet = r?.set;
  if (!hasExplicitRadii && skin.frame?.corner) {
    // 'square' is a fixed 0 (correct for all sizes). 'pill' is a *scale*, not a
    // fixed value — a fixed large radius makes big containers/modals look like
    // giant arcs; scaling keeps corners proportional to the element.
    if (skin.frame.corner === 'square') radiusSet = 0;
    else if (skin.frame.corner === 'pill') radiusScale = 2.2;
    // 'rounded' keeps the default scale
  }
  return {
    radiusScale,
    radiusSet,
    spacingScale: skin.spacing?.scale ?? 1,
    borderScale: skin.borders?.scale ?? 1,
    fontScale: skin.fontScale ?? 1,
    fontFamily: skinFontFamily(skin),
  };
}

/**
 * Resolve the family for a weight under the active skin.
 *
 * The counterpart to `font()` for static `createSkinnable` stylesheets, where
 * `theme.fonts` is not in scope. Without this those blocks can only set a
 * `fontWeight`, which leaves them rendering in the DEVICE font while themed
 * components render in the bundled one — two typefaces in one screen.
 *
 * A skin ships a single face, so under a skin every weight returns that one
 * family and the platform synthesizes the weight, matching `makeFonts`.
 */
export function fontFamily(face: keyof typeof INTER_FACES = 'regular'): string {
  return current.fontFamily ?? INTER_FACES[face];
}

/** Update the active geometry. Call before applying a skin / before first paint. */
export function setSkinGeometry(skin?: SkinOverride | null): void {
  current = deriveGeometry(skin);
}

/** Scale a corner radius by the active skin. */
export function radius(n: number): number {
  if (current.radiusSet !== undefined) return n === 0 ? 0 : current.radiusSet;
  return Math.round(n * current.radiusScale);
}

/** Has the active skin squared every corner? `set: 0` and `scale: 0` both mean
 *  "square"; any other set/scale is some degree of rounded. */
function skinIsSquare(): boolean {
  if (current.radiusSet !== undefined) return current.radiusSet === 0;
  return current.radiusScale === 0;
}

/**
 * Always a circle — skins get no vote at all.
 *
 * Reserved for PURE-SHAPE indicators: status dots, unread dots, radio dots,
 * toggle knobs. Their shape is their entire meaning, so squaring them doesn't
 * restyle them, it breaks them — a square 9px status dot reads as a rendering
 * glitch, and a square radio dot reads as a checkbox.
 *
 * Anything that CONTAINS something (an image, a glyph, a label) is not this.
 * Use `circleOrSquare` for round containers, or `radius` for rounded rectangles.
 */
export function circle(n: number): number {
  return n;
}

/**
 * A perfect circle, or a perfect square on a skin that squares its corners.
 * Never anything in between.
 *
 * For round CONTAINERS: avatars, round icon buttons, FABs, call buttons. A
 * squared avatar is a legitimate look (it's a photo tile, and that IS the
 * brutalist aesthetic), so unlike `circle` these do follow the skin — but only
 * to the two endpoints. `radius()` is wrong here: under a `radii: { set: 4 }`
 * skin it would return 4, giving a slightly-rounded avatar, and a squircle is
 * exactly the third state this is meant to prevent.
 *
 * Callers pass half the element's size, so the call site reads as
 * `borderRadius: circleOrSquare(24)` next to `width: 48, height: 48`.
 */
export function circleOrSquare(n: number): number {
  return skinIsSquare() ? 0 : n;
}

/** Scale a padding/margin/gap by the active skin. */
export function space(n: number): number {
  return Math.round(n * current.spacingScale);
}

/** Scale a border width by the active skin (kept fractional for hairlines). */
export function border(n: number): number {
  return n * current.borderScale;
}

/**
 * Scale a font size / line height by the active skin's fontScale.
 *
 * Deliberately does NOT carry the user's text-size choice. This is the chrome
 * path — ~1180 call sites covering labels, timestamps, descriptions, buttons,
 * section headers — and much of it is already at 11-13, where a proportional
 * shrink takes it below legibility. Message content uses `theme.msgFont()` or
 * the `messageBody`/`messageAuthor` tokens instead; see theme/fonts.ts for the
 * measurement that settled it.
 */
export function font(n: number): number {
  return Math.round(n * current.fontScale);
}

/**
 * Canonical drop shadow for floating buttons (FABs, the search pill, floating
 * chips). These sit over the feed/content, not over a backdrop, so they want a
 * crisp lift, not a heavy diffuse drop. On light theme a wide blur radius reads
 * as a muddy halo, so we keep the radius tight (offset 2 / radius 4 / elevation
 * 4) and the opacity low. Surfaces that legitimately need a big soft shadow
 * (modals, sheets, toasts, drag previews) keep their own values.
 */
export function floatingShadow() {
  return {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  } as const;
}

/**
 * Canonical horizontal padding for list-content rows that hold a stream of
 * messages/casts (chat message rows, chat cast cards, Farcaster feed cards).
 * Centralised so these surfaces share one width instead of each hardcoding its
 * own (the feed used to be 12 while chat messages were 16, making the feed look
 * wider). Skin-scaled like every other spacing value.
 */
export function contentRowPaddingH(): number {
  return space(16);
}
