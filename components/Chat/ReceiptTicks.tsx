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
import { TRAILING_GLYPH_SIZE, TRAILING_GLYPH_NUDGE, TRAILING_GLYPH_GAP } from './trailingGlyphs';

interface ReceiptTicksProps {
  /** true → double check (read); false → single check (delivered). */
  read: boolean;
  /** Tint colour — muted theme token inline; white on a media overlay. */
  color: string;
  /**
   * Rendered height of the glyph BOX in dp — not of the check marks themselves,
   * which are padded into a taller canvas so every trailing glyph shares one box
   * (see trailingGlyphs.ts). Width is derived from the asset aspect. Leave unset
   * unless you need a deliberately larger or smaller receipt.
   */
  size?: number;
  /**
   * Inline (in message text) vs standalone (media corner overlay).
   * - inline (default): wrapped in a <Text> with a leading no-break space so it
   *   gaps from the last word and flows/wraps with the text; margins on an
   *   inline <Image> in <Text> are ignored on Android, so a real character is
   *   the reliable gap, and it must be non-breaking or the group can split
   *   across lines (see TRAILING_GLYPH_GAP). The <Text> wrapper is valid both
   *   inside a parent <Text> and inside a <View>.
   * - standalone: a bare <Image>, tightly packed for an overlay pill (no leading
   *   space, no baseline nudge).
   */
  inline?: boolean;
}

function ReceiptTicksBase({ read, color, size = TRAILING_GLYPH_SIZE, inline = true }: ReceiptTicksProps) {
  const aspect = read ? RECEIPT_CHECK_DOUBLE_ASPECT : RECEIPT_CHECK_SINGLE_ASPECT;
  // width from aspect so the check glyph is never stretched; both states share
  // the same glyph size, so delivered→read doesn't appear to resize.
  const img = (
    <Image
      source={{ uri: read ? RECEIPT_CHECK_DOUBLE_URI : RECEIPT_CHECK_SINGLE_URI }}
      style={[inline && styles.tickInline, { width: size * aspect, height: size, tintColor: color }]}
      accessibilityLabel={read ? 'Read' : 'Delivered'}
    />
  );
  if (!inline) return img;
  return (
    <Text>
      {TRAILING_GLYPH_GAP}
      {img}
    </Text>
  );
}

const styles = StyleSheet.create({
  tickInline: {
    // Shared with every other trailing glyph so they can't drift apart — see
    // trailingGlyphs.ts. Do not tune this one on its own.
    transform: [{ translateY: TRAILING_GLYPH_NUDGE }],
  },
});

export const ReceiptTicks = React.memo(ReceiptTicksBase);

export default ReceiptTicks;
