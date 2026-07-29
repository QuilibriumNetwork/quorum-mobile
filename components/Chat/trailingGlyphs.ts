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

/**
 * TEMPORARY layout diagnostic — set to false (or delete this block and its three
 * call sites) once the emoji-only alignment question is settled.
 *
 * Tints each box in the trailing group so a single screenshot shows what static
 * reading of the code cannot: how many boxes exist, how wide they are, and
 * whether the glyphs are wrapping inside one box or being laid out by different
 * paths. Red = the group wrapper, green = the receipt, blue = the warning.
 */
export const DEBUG_TRAILING_LAYOUT = true;
export const DEBUG_GROUP_BG = 'rgba(255,0,0,0.35)';
export const DEBUG_RECEIPT_BG = 'rgba(0,255,0,0.45)';
export const DEBUG_UNSIGNED_BG = 'rgba(0,140,255,0.5)';

/**
 * The gap that precedes each trailing glyph.
 *
 * It has to be a real character: margins on an inline <Image> inside a <Text>
 * are ignored on Android, so a space is the only reliable gap. But a normal
 * space is also a LINE-BREAK OPPORTUNITY, which let the group split across two
 * lines — the receipt ending one line and the warning wrapping onto the next.
 * A no-break space (U+00A0) is the same width and gives the line breaker nothing
 * to break on, so the glyphs stay together as one unbreakable run.
 */
export const TRAILING_GLYPH_GAP = '\u00A0';
