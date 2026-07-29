/**
 * Shared geometry for the small glyphs that trail the end of a message
 * (delivery/read receipt, unsigned-message warning).
 *
 * WHY THIS EXISTS: these glyphs used to carry their own render height and their
 * own baseline nudge — the receipt at 9dp/translateY(1), the warning at
 * 13dp/translateY(4). Inside a parent <Text> that only looked slightly off, but
 * MentionableText's emoji-only branch lays the trailing node out as a flex child
 * of a `flexDirection: 'row'` / `alignItems: 'flex-end'` View. Two glyphs meant
 * two boxes of unequal height, bottom-aligned by box and then shifted apart by
 * the difference of their nudges — the visibly broken layout on emoji-only rows.
 *
 * The fix is to make the box uniform and let the ARTWORK carry the size
 * difference: every trailing asset is a 64px-tall canvas with its ink centered
 * and padded with transparency, so rendering them all at one height with one
 * nudge keeps their optical sizes while guaranteeing they share a center line.
 * Alignment is therefore structural — changing one glyph's artwork can't drag it
 * off the others.
 *
 * If the whole group ever needs to move relative to the text, change the nudge
 * here rather than per-glyph; that is the knob that keeps them together.
 */

/** Render height in dp for every trailing glyph. Widths come from each asset's aspect. */
export const TRAILING_GLYPH_SIZE = 13;

/**
 * Post-layout baseline nudge in dp, applied identically to every trailing glyph.
 * An inline <Image> in a <Text> does not sit on the text baseline on its own;
 * this pushes it down onto it. Tuned on device for a 13dp box.
 */
export const TRAILING_GLYPH_NUDGE = 4;
