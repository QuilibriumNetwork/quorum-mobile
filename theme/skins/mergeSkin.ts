/**
 * Pure helpers for layering a validated skin onto the base theme. Kept
 * dependency-free (no native modules) so `themes.ts` can import it at module
 * load without pulling in expo-font/expo-file-system.
 */

import type { SkinOverride } from './types';

/**
 * The actual font family the theme uses (and the loader registers) when a skin
 * ships an embedded font. Namespaced by skin id so it never collides with the
 * bundled `AtAero` or a system font; the author's `font.family` is just a
 * display label. Returns null when the skin has no embedded font, in which case
 * the theme uses the platform's native system font (see DEFAULT_FONT_FAMILY).
 */
export function skinFontFamily(skin?: SkinOverride | null): string | null {
  return skin?.font ? `skin-${skin.id || 'local'}` : null;
}

/**
 * Convert a `#rgb`/`#rrggbb` hex color to an `rgba(...)` string with the given
 * alpha — used to make surface tokens translucent so a wallpaper shows through.
 * Non-hex inputs (already `rgba()`, or unknown) are returned unchanged.
 */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  let hex = color.trim();
  if (hex[0] !== '#') return color;
  hex = hex.slice(1);
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  if (hex.length !== 6) return color; // 4/8-digit or invalid — leave as-is
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return color;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
