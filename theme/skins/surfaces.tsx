/**
 * Scoped surfaces — per-region backgrounds + style knobs with a cascade.
 *
 * A skin can style a region as generically or specifically as it likes:
 *   surfaces.button            -> all buttons
 *   surfaces['button.primary'] -> just primary buttons (inherits `button`)
 *   surfaces.feed / .wallet / .cast ...
 *
 * Resolution walks dotted paths from most-specific to most-generic and merges
 * per-property (specific wins), then the consuming component falls back to the
 * theme default for anything unset. So "generic controls get inherited" while
 * you can "go as specific as you want".
 */

import React from 'react';
import { Image as RNImage, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useTheme } from '@/theme';
import type { SkinOverride, SlotName, SurfaceStyle } from './types';
import { SLOT_NAMES } from './types';

const HEX_OR_RGBA = /^(#|rgba?\()/i;
const IS_IMAGE = /^data:image\//i;
const EXPO_FIT = { cover: 'cover', contain: 'contain', tile: 'cover' } as const;

/** Base slot of a (possibly dotted) key — the part before the first dot. */
export function slotBase(key: string): string {
  const dot = key.indexOf('.');
  return dot > 0 ? key.slice(0, dot) : key;
}

/** Validity check used by the validator: base must be an allow-listed slot. */
export function isKnownSlot(key: string): boolean {
  return SLOT_NAMES.includes(slotBase(key) as SlotName);
}

/** Specific → generic chain for a dotted key: `a.b.c` -> [a.b.c, a.b, a]. */
function chain(key: string): string[] {
  const out: string[] = [];
  let s = key;
  while (s) {
    out.push(s);
    const dot = s.lastIndexOf('.');
    if (dot <= 0) break;
    s = s.slice(0, dot);
  }
  return out;
}

export interface ResolvedSurface {
  /** Resolved background — a color, a data:image URI, or undefined. */
  background?: string;
  backgroundIsImage: boolean;
  fit: 'cover' | 'contain' | 'tile';
  opacity: number;
  /** Optional content text-color override. */
  text?: string;
  /** True when the cascade produced nothing (use theme defaults). */
  empty: boolean;
}

/** Merge a slot's cascade into a single resolved surface. */
export function resolveSurface(skin: SkinOverride | null | undefined, slot: string): ResolvedSurface {
  const map = skin?.surfaces;
  let background: string | undefined;
  let fit: SurfaceStyle['fit'];
  let opacity: number | undefined;
  let text: string | undefined;
  if (map) {
    for (const key of chain(slot)) {
      const sv = map[key];
      if (!sv) continue;
      if (background === undefined && sv.background) background = sv.background;
      if (fit === undefined && sv.fit) fit = sv.fit;
      if (opacity === undefined && sv.opacity !== undefined) opacity = sv.opacity;
      if (text === undefined && sv.text) text = sv.text;
    }
  }
  return {
    background,
    backgroundIsImage: !!background && IS_IMAGE.test(background),
    fit: fit ?? 'cover',
    opacity: opacity ?? 1,
    text,
    empty: background === undefined && text === undefined,
  };
}

/** Resolve a slot against the active skin. */
export function useSurface(slot: string): ResolvedSurface {
  const { activeSkin } = useTheme();
  return resolveSurface(activeSkin, slot);
}

/** True if the value is a plain color (vs an image data-URI). */
export function isColor(v: string | undefined): boolean {
  return !!v && HEX_OR_RGBA.test(v);
}

/**
 * Wrap a container region so it picks up its slot's background (color OR
 * image+scrim). Falls back to a plain View when the slot isn't styled.
 */
export function SurfaceBackground({
  slot,
  style,
  fallbackColor,
  children,
}: {
  slot: string;
  style?: StyleProp<ViewStyle>;
  /** Background color when the slot isn't styled (keeps the region's default). */
  fallbackColor?: string;
  children: React.ReactNode;
}) {
  const surface = useSurface(slot);
  const fallback = fallbackColor ? { backgroundColor: fallbackColor } : null;
  if (surface.empty || !surface.background) {
    return <View style={[style, fallback]}>{children}</View>;
  }
  if (!surface.backgroundIsImage) {
    return <View style={[style, { backgroundColor: surface.background }]}>{children}</View>;
  }
  return (
    <View style={[style, fallback]}>
      {surface.fit === 'tile' ? (
        <RNImage
          source={{ uri: surface.background }}
          style={[StyleSheet.absoluteFill, { opacity: surface.opacity }]}
          resizeMode="repeat"
        />
      ) : (
        <ExpoImage
          source={{ uri: surface.background }}
          style={[StyleSheet.absoluteFill, { opacity: surface.opacity }]}
          contentFit={EXPO_FIT[surface.fit]}
          cachePolicy="memory-disk"
        />
      )}
      {children}
    </View>
  );
}
