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
import { Text, Image, StyleSheet } from 'react-native';
import { UNSIGNED_ICON_URI, UNSIGNED_ICON_ASPECT } from './unsignedIconAsset';

interface UnsignedIndicatorProps {
  /** Tint colour — pass the amber warning theme token. */
  color: string;
  /** Fired on tap — surface the "unsigned message" explanation. */
  onPress: () => void;
  /** Rendered height in dp. Width is derived from the asset aspect. Default 11. */
  size?: number;
}

function UnsignedIndicatorBase({ color, onPress, size = 11 }: UnsignedIndicatorProps) {
  return (
    <Text
      onPress={onPress}
      suppressHighlighting
      accessibilityRole="button"
      accessibilityLabel="Unsigned message"
    >
      {' '}
      <Image
        source={{ uri: UNSIGNED_ICON_URI }}
        style={[styles.icon, { width: size * UNSIGNED_ICON_ASPECT, height: size, tintColor: color }]}
      />
    </Text>
  );
}

const styles = StyleSheet.create({
  icon: {
    // Inline <Image> in <Text> rides high (top-aligned) on Android; push it down
    // so its bottom sits on the text baseline. Tune on device.
    transform: [{ translateY: 4 }],
  },
});

export const UnsignedIndicator = React.memo(UnsignedIndicatorBase);

export default UnsignedIndicator;
