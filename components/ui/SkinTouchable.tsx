/**
 * SkinTouchable — a drop-in replacement for RN's TouchableOpacity that lets a
 * skin's `button` surface style "effectively a button" touchables app-wide.
 *
 * It is IDENTITY by default: it only changes anything when (a) a skin defines a
 * `button` surface AND (b) the touchable has an *action-colored* background
 * (primary/accent/danger/success/warning) — i.e. a filled button. Icon taps,
 * list rows, links and other transparent/surface-colored touchables are left
 * exactly as-is, so the "is this a button?" guess stays conservative.
 *
 * The button color also picks the cascade variant (`button.danger` etc., which
 * inherits `button`), so a skin can style all buttons generically or override
 * per kind. Codemod `scripts/skin-touchable-codemod.js` rewrites
 * `TouchableOpacity` imports across the app to this module.
 */

import React from 'react';
import {
  StyleSheet,
  TouchableOpacity as RNTouchableOpacity,
  type TouchableOpacityProps,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useThemeOptional } from '@/theme';
import { resolveSurface } from '@/theme/skins/surfaces';
import type { AppTheme } from '@/theme';

/** Map a resolved backgroundColor to a button cascade variant, or null when it
 *  isn't a recognized action color (i.e. not a filled button). */
function variantForColor(bg: string, theme: AppTheme): string | null {
  const c = bg.toLowerCase();
  const eq = (x: string) => x.toLowerCase() === c;
  if (eq(theme.colors.danger)) return 'danger';
  if (eq(theme.colors.success)) return 'success';
  if (eq(theme.colors.warning)) return 'warning';
  if (eq(theme.colors.primary) || eq(theme.colors.accent) || eq(theme.colors.accentDark)) return 'primary';
  return null;
}

export const TouchableOpacity = React.forwardRef<
  React.ElementRef<typeof RNTouchableOpacity>,
  TouchableOpacityProps
>(function SkinTouchable({ style, children, ...rest }, ref) {
  // Optional context: if ever rendered outside the ThemeProvider, degrade to a
  // plain touchable rather than throwing.
  const ctx = useThemeOptional();
  const theme = ctx?.theme;
  const activeSkin = ctx?.activeSkin ?? null;

  const flat = StyleSheet.flatten(style) as { backgroundColor?: string } | undefined;
  const bg = flat?.backgroundColor;
  const variant =
    theme && typeof bg === 'string' && bg !== 'transparent' ? variantForColor(bg, theme) : null;
  const surface = variant ? resolveSurface(activeSkin, `button.${variant}`) : null;

  if (!surface || surface.empty || !surface.background) {
    return (
      <RNTouchableOpacity ref={ref} style={style} {...rest}>
        {children}
      </RNTouchableOpacity>
    );
  }

  const image = surface.backgroundIsImage ? surface.background : undefined;
  return (
    <RNTouchableOpacity
      ref={ref}
      style={[
        style,
        image
          ? { backgroundColor: 'transparent', overflow: 'hidden' }
          : { backgroundColor: surface.background },
      ]}
      {...rest}
    >
      {image && (
        <ExpoImage
          source={{ uri: image }}
          style={[StyleSheet.absoluteFill, { opacity: surface.opacity }]}
          contentFit={surface.fit === 'contain' ? 'contain' : 'cover'}
          pointerEvents="none"
          cachePolicy="memory-disk"
        />
      )}
      {children}
    </RNTouchableOpacity>
  );
});
