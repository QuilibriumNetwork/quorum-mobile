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

import type { SkinOverride } from './types';

export interface Geometry {
  radiusScale: number;
  radiusSet?: number;
  spacingScale: number;
  borderScale: number;
  fontScale: number;
}

const IDENTITY: Geometry = { radiusScale: 1, spacingScale: 1, borderScale: 1, fontScale: 1 };

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
  };
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

/** Scale a padding/margin/gap by the active skin. */
export function space(n: number): number {
  return Math.round(n * current.spacingScale);
}

/** Scale a border width by the active skin (kept fractional for hairlines). */
export function border(n: number): number {
  return n * current.borderScale;
}

/** Scale a font size / line height by the active skin's fontScale. */
export function font(n: number): number {
  return Math.round(n * current.fontScale);
}
