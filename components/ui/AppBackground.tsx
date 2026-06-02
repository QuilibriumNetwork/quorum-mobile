/**
 * AppBackground — the app-wide root surface, skin-wallpaper aware.
 *
 * Layers (back to front):
 *   1. base color (`surface1`) — paints immediately, no flash
 *   2. wallpaper image (when the active skin has one) via expo-image
 *   3. scrim — a semi-opaque overlay that guarantees a contrast floor so text
 *      stays legible over busy wallpapers
 *   4. children (the app)
 *
 * The wallpaper itself is a validated `data:image/png|jpeg` URI; surfaces above
 * it become translucent via the skin's `surfaceAlpha` (applied at the token
 * level in `createTheme`), so panels read as glass over the wallpaper.
 */

import React from 'react';
import { Image as RNImage, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useTheme } from '@/theme';
import { frameAccentBorder } from '@/theme/skins/frame';

// cover/contain go through expo-image (better caching). `tile` needs CSS-style
// repeat, which expo-image lacks — RN's core Image supports resizeMode="repeat".
const EXPO_FIT = {
  cover: 'cover',
  contain: 'contain',
} as const;

export function AppBackground({ children }: { children: React.ReactNode }) {
  const { theme, activeSkin } = useTheme();
  const wallpaper = activeSkin?.wallpaper;
  // Dark skins want a dark scrim, light skins a light one, so the contrast
  // floor matches the palette rather than always darkening.
  const scrimBase = theme.dark ? '0,0,0' : '255,255,255';
  const scrimOpacity = wallpaper?.scrimOpacity ?? 0.6;

  const fit = wallpaper?.fit ?? 'cover';

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.surface1 }, frameAccentBorder(theme)]}>
      {wallpaper ? (
        <>
          {fit === 'tile' ? (
            <RNImage
              source={{ uri: wallpaper.source.dataUri }}
              style={StyleSheet.absoluteFill}
              resizeMode="repeat"
            />
          ) : (
            <ExpoImage
              source={{ uri: wallpaper.source.dataUri }}
              style={StyleSheet.absoluteFill}
              contentFit={EXPO_FIT[fit]}
              // Cache by skin id so a large base64 isn't re-decoded each render.
              recyclingKey={activeSkin?.id || 'local-skin'}
              cachePolicy="memory-disk"
              transition={150}
            />
          )}
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: `rgba(${scrimBase},${scrimOpacity})` },
            ]}
            pointerEvents="none"
          />
        </>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
