/**
 * ReceiptTicks — the DM delivery/read receipt glyph.
 *
 * Renders a single inline <Image> (one check = delivered, double check = read)
 * that is meant to sit INSIDE a <Text> so it flows on the same line as the end
 * of the message and wraps with it — the only way to get Telegram-style inline
 * receipts in React Native (Yoga has no `display:inline`/float; an element joins
 * a text line only as a child of the same <Text>, and <Image> is one of the two
 * elements that legally do so).
 *
 * Colour is applied via `tintColor` (the source assets are flat #000 templates),
 * so it follows the theme. Both states use the same muted colour — delivered and
 * read differ only by one vs two checks, matching desktop.
 */

import React from 'react';
import { Text, Image, StyleSheet } from 'react-native';
import {
  RECEIPT_CHECK_SINGLE_URI,
  RECEIPT_CHECK_DOUBLE_URI,
  RECEIPT_CHECK_SINGLE_ASPECT,
  RECEIPT_CHECK_DOUBLE_ASPECT,
} from './receiptCheckAssets';

interface ReceiptTicksProps {
  /** true → double check (read); false → single check (delivered). */
  read: boolean;
  /** Tint colour — pass the muted theme token. */
  color: string;
  /** Rendered height in dp. Width is derived from the asset aspect. Default 9. */
  size?: number;
}

// Wrapped in a <Text> with a leading space for two reasons:
//  1. margins on an inline <Image> inside <Text> are ignored on Android, so a
//     real space character is the reliable way to gap the tick from the last
//     word. It scales with the text font, which looks natural.
//  2. a <Text> wrapper is valid both inside a parent <Text> (inline flow) and
//     inside a <View> (the fallback row) — so one component fits both call sites.
function ReceiptTicksBase({ read, color, size = 9 }: ReceiptTicksProps) {
  const aspect = read ? RECEIPT_CHECK_DOUBLE_ASPECT : RECEIPT_CHECK_SINGLE_ASPECT;
  return (
    <Text>
      {' '}
      <Image
        source={{ uri: read ? RECEIPT_CHECK_DOUBLE_URI : RECEIPT_CHECK_SINGLE_URI }}
        // width from aspect so the check glyph is never stretched; both states
        // share the same glyph size, so delivered→read doesn't appear to resize.
        style={[styles.tick, { width: size * aspect, height: size, tintColor: color }]}
        accessibilityLabel={read ? 'Read' : 'Delivered'}
      />
    </Text>
  );
}

const styles = StyleSheet.create({
  tick: {
    // Baseline nudge so the glyph sits level with the text rather than on the
    // descender line (inline <Image> in <Text> rides slightly low). Tune on device.
    transform: [{ translateY: 1 }],
  },
});

export const ReceiptTicks = React.memo(ReceiptTicksBase);

export default ReceiptTicks;
