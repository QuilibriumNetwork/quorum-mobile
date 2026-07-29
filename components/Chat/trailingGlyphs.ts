/**
 * Shared geometry for the small glyphs that trail the end of a message
 * (delivery/read receipt, unsigned-message warning).
 *
 * WHY THIS EXISTS: these glyphs used to carry their own render height and their
 * own baseline nudge — the receipt at 9dp/translateY(1), the warning at
 * 13dp/translateY(4). Two glyphs of different box heights with independently
 * tuned nudges cannot be made to line up, and every size change re-broke them.
 *
 * The fix is to make the box uniform and let the ARTWORK carry the size
 * difference: every trailing asset is a 64px-tall canvas with its ink centered
 * and padded with transparency, so rendering them all at one height with one
 * nudge keeps their optical sizes while guaranteeing they share a center line.
 * Alignment is therefore structural — changing one glyph's artwork can't drag it
 * off the others. It is also what makes the block form below correct: `alignItems:
 * 'center'` on a row of these images aligns the ink, not just the boxes.
 *
 * If the whole group ever needs to move relative to the text, change the nudge
 * here rather than per-glyph; that is the knob that keeps them together.
 *
 * SEPARATE ISSUE, DO NOT CONFLATE: on emoji-only messages the group is laid out
 * as a flex child of a row, and an inline <Image> inside a <Text> that is itself
 * a flex child draws OUTSIDE the box the <Text> measured. No amount of shared
 * geometry fixes that, because the glyph isn't in the box being positioned. Those
 * call sites use the block form (bare <Image>s in a View row) instead — see
 * `receiptBlock` in MessageRenderer/MentionableText.
 */

/** Render height in dp for every trailing glyph. Widths come from each asset's aspect. */
export const TRAILING_GLYPH_SIZE = 13;

/**
 * Post-layout baseline nudge in dp, applied identically to every trailing glyph.
 * An inline <Image> in a <Text> does not sit on the text baseline on its own;
 * this pushes it down onto it. Tuned on device for a 13dp box.
 */
export const TRAILING_GLYPH_NUDGE = 4;

/**
 * The gap that precedes each trailing glyph.
 *
 * It has to be a real character: margins on an inline <Image> inside a <Text>
 * are ignored on Android, so a space is the only reliable gap. It is a no-break
 * space (U+00A0) rather than a plain one because a plain space is a line-break
 * opportunity, and the group should never be split across two lines with the
 * receipt ending one and the warning starting the next. Same width, nothing for
 * the line breaker to act on.
 *
 * Defensive: this was NOT the cause of the emoji-only misplacement (see the file
 * header). It is here so the group can't break in the inline path either.
 */
export const TRAILING_GLYPH_GAP = '\u00A0';
