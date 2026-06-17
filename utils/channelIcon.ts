import { getIconColorHex, type IconColor } from '@quilibrium/quorum-shared';

/**
 * Resolve a channel/group's stored iconColor to a render hex.
 *
 * New channels store a named token ('blue'); legacy channels stored a raw hex
 * ('#3b82f6'). Pass raw hex through unchanged; resolve named tokens via the
 * shared palette; fall back to the caller's color when unset, so legacy
 * channels never gray out.
 */
export function resolveChannelIconColor(iconColor: string | undefined, fallback: string): string {
  if (!iconColor) return fallback;
  if (iconColor.startsWith('#')) return iconColor;
  return getIconColorHex(iconColor as IconColor);
}
