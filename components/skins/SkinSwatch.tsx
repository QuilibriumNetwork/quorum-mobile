/**
 * SkinSwatch — a tiny palette+geometry preview chip for a skin row.
 *
 * A rounded square split diagonally: the top-left triangle is the skin's
 * accent, the rest is the skin's background. The swatch's OWN corner radius
 * reflects the skin's geometry (square for a square-corner skin, rounder for a
 * roomy one), so a color-less skin still previews its shape. Purely
 * presentational and synchronous — no font loading, no global theme mutation.
 */

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '@/theme';

export function SkinSwatch({
  accent,
  background,
  cornerRadius,
  size = 40,
  theme,
}: {
  accent: string;
  background: string;
  cornerRadius: number;
  size?: number;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: cornerRadius,
        overflow: 'hidden',
        backgroundColor: background,
        borderWidth: 1,
        borderColor: theme.colors.surface5,
      }}
    >
      {/* Oversized square rotated 45° so its straight edge becomes the
          diagonal; positioned to cover the top-left triangle with the accent. */}
      <View
        style={{
          position: 'absolute',
          width: size * 1.5,
          height: size * 1.5,
          left: -size * 0.75,
          top: -size * 0.75,
          backgroundColor: accent,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </View>
  );
}
