/**
 * Resolve a skin's decorative `FrameOptions` into concrete RN styles, applied
 * only at a few container boundaries (app ring, cards, modals) — never as
 * arbitrary per-component chrome. Returns empty objects when no frame is set,
 * so callers can spread unconditionally.
 */

import type { ViewStyle } from 'react-native';
import type { AppTheme } from '@/theme';

/** Accent border ring — for the app edge, cards, and modals. */
export function frameAccentBorder(theme: AppTheme): ViewStyle {
  const ab = theme.frame?.accentBorder;
  if (!ab) return {};
  return {
    borderWidth: ab.width === 'thick' ? theme.borders.thick : theme.borders.thin,
    borderColor: ab.color ?? theme.colors.accent,
  };
}

/** Soft elevation/glow for panels when `frame.panelGlow` is set. */
export function framePanelGlow(theme: AppTheme): ViewStyle {
  if (!theme.frame?.panelGlow) return {};
  return {
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  };
}
