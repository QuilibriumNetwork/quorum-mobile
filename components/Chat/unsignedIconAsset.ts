/**
 * Unsigned-message warning glyph, embedded as a base64 data-URI.
 *
 * Same rationale as receiptCheckAssets: a data-URI lives in the JS bundle, so it
 * never passes through expo-updates asset-embedding and can't be blanked by a
 * stale manifest in local release builds (see the apex lesson).
 *
 * Flat black (#000) template on a transparent bg. Color is applied at render
 * time via the <Image> `tintColor` style, so it follows whatever colour the
 * caller passes. Source: unsigned-indicator-filled.png.
 *
 * The triangle is centered in a 64px-tall box (ink 60 x 52) so this renders at
 * the same box height as every other trailing glyph — see trailingGlyphs.ts for
 * why that uniformity matters. Any replacement art must keep the ink centered in
 * a 64-tall canvas, or it will no longer line up with the receipt ticks.
 *
 * NOTE: currently the FILLED variant. An OUTLINE variant also exists (swap the
 * base64 to test); re-canvas it the same way and update UNSIGNED_ICON_ASPECT.
 */

export const UNSIGNED_ICON_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADwAAABACAYAAABGHBTIAAAB/klEQVR42u2a/W3CMBDFH1EHgA28QTNCNigbwAZkA7oBI0AnoBu4nYBucN3A7QT0H0eqUBrixD77XJ90EogP++Hjl3d2gBIlSpQokW4smMdTAJ4ArOxzAvAO4DO3H1YB0ACuf+TZvieL2AAwA2K7NADWOazs1SENgFqyYHIUfAVwkSp2N0Fsl63EUqYZgg2ApSTBpxliuzxKEVt7ENtlkyuoxAJs61Fs8gBTnlc3eYC5gIocf5yjVEdFNyByqYpGIqj6bGMz8rNaGqjMwHcYKQBzKUnyUCHRAeYKKh/X7oOU1o88mpVGgqPyKVhLcFTk2Y62qTsq34LZADa19aMADcchNVCFFhwcYJSgYJ1q60cBe+g2xdYvpODRAKtGCn5O/GRgCWCfAqi4Vng0wMassIac2M8VvBV2yNXMAZjvPSry0A8HdWCnABtydUBGzHJgISbRrbJi2Ol0dmChJvHbHV0Yxoi2mR4r21ib6bHyLsBOGYm9CzCVodhBgHGVcufLa/sf4xhTxwJVH0S4RG+4V9cwOa3Bs+bKlheHX/6a+Bo83pmgKsbmQA1YS645PFbM3dC5x1qytp8PAD4iHL69WUOgmA/Hvhd2QJJ2X9REhqwq++AF+cfrbamZjJ0W9bGqyVjweuhaRZmtbD22J9ZCy9zYue/+AYhLlChRIrP4AQuHVgeg7ObiAAAAAElFTkSuQmCC';

/** width / height of the source asset — multiply by render height for width. */
export const UNSIGNED_ICON_ASPECT = 60 / 64;
