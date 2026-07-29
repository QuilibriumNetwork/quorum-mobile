/**
 * UnsignedIndicator — the "unsigned message" warning glyph, inline.
 *
 * Like ReceiptTicks, this is an inline <Image> wrapped in a <Text> so it flows
 * on the same line as the end of the message and wraps with it. Unlike the
 * receipt, it is tappable: the <Text> carries an onPress that surfaces the
 * "unsigned message" explanation (the mobile equivalent of desktop's tooltip).
 *
 * The <Text> wrapper (with a leading space) is valid both inside a parent <Text>
 * (inline flow) and inside a <View> (the fallback row), so one component fits
 * both call sites. Color is applied via `tintColor` (the source is a flat #000
 * template), so callers pass the amber `theme.colors.warning`.
 */

import React from 'react';
import { Text, Image, Pressable, StyleSheet } from 'react-native';
import { UNSIGNED_ICON_URI, UNSIGNED_ICON_ASPECT } from './unsignedIconAsset';
import {
  TRAILING_GLYPH_SIZE,
  TRAILING_GLYPH_NUDGE,
  TRAILING_GLYPH_GAP,
  DEBUG_TRAILING_LAYOUT,
  DEBUG_UNSIGNED_BG,
} from './trailingGlyphs';

interface UnsignedIndicatorProps {
  /** Tint colour — pass the amber warning theme token. */
  color: string;
  /** Fired on tap — surface the "unsigned message" explanation. */
  onPress: () => void;
  /**
   * Rendered height of the glyph BOX in dp — the triangle is padded into that
   * box so every trailing glyph shares one box (see trailingGlyphs.ts). Width is
   * derived from the asset aspect. Leave unset outside deliberate one-offs.
   */
  size?: number;
  /**
   * Inline (a text run inside the message <Text>) vs block (a bare tappable
   * <Image> for a View-based row).
   *
   * Block exists because an inline <Image> inside a <Text> that is itself a flex
   * child does not lay out reliably — the image draws outside the box the <Text>
   * measured. Any caller placing this in a View row must use block.
   */
  inline?: boolean;
}

function UnsignedIndicatorBase({
  color,
  onPress,
  size = TRAILING_GLYPH_SIZE,
  inline = true,
}: UnsignedIndicatorProps) {
  if (!inline) {
    return (
      <Pressable
        onPress={onPress}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        accessibilityRole="button"
        accessibilityLabel="Unsigned message"
      >
        <Image
          source={{ uri: UNSIGNED_ICON_URI }}
          style={{ width: size * UNSIGNED_ICON_ASPECT, height: size, tintColor: color }}
        />
      </Pressable>
    );
  }
  return (
    <Text
      onPress={onPress}
      suppressHighlighting
      accessibilityRole="button"
      accessibilityLabel="Unsigned message"
      style={DEBUG_TRAILING_LAYOUT ? { backgroundColor: DEBUG_UNSIGNED_BG } : undefined}
    >
      {TRAILING_GLYPH_GAP}
      <Image
        source={{ uri: UNSIGNED_ICON_URI }}
        style={[styles.icon, { width: size * UNSIGNED_ICON_ASPECT, height: size, tintColor: color }]}
      />
    </Text>
  );
}

const styles = StyleSheet.create({
  icon: {
    // Shared with every other trailing glyph so they can't drift apart — see
    // trailingGlyphs.ts. Do not tune this one on its own.
    transform: [{ translateY: TRAILING_GLYPH_NUDGE }],
  },
});

export const UnsignedIndicator = React.memo(UnsignedIndicatorBase);

export default UnsignedIndicator;
