// Regenerates the app icons for iOS and Android from the existing icon.png,
// removing the baked-in rounded "squircle card" so the white Q+arrow glyph sits
// directly on a full-bleed blue gradient. Each OS then applies its own corner
// mask (iOS squircle, Android launcher shape).
//
// WHY (see also gen-android-adaptive-icon.js notes):
//  - The original assets/images/icon.png has rounded corners + an inner squircle
//    card baked into the artwork. Apple's HIG says NOT to round corners (the
//    system masks them); Android adaptive icons mask them too and reserve the
//    outer ~1/3 as a safe-zone margin. Baked corners are therefore wrong on both
//    platforms and cause the "no padding / shape-inside-shape" look.
//  - Fix: extract just the glyph (per-pixel alpha so the 3D bevel + AA edges are
//    preserved) and recomposite on a clean vertical blue gradient, full-square.
//    iOS gets the glyph larger (it likes more fill); Android gets it at the
//    safe-zone scale.
//
// Run: node .agents/scripts/gen-app-icons.js
// Outputs:
//   assets/images/icon.png                  (iOS + general, glyph ~0.82)
//   assets/images/icon-android-adaptive.png (Android foreground, glyph ~0.66)
//
// NOTE: this overwrites icon.png. A backup is written to
// assets/images/icon-original.png on first run if it doesn't already exist.

const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'assets/images/icon.png'); // output target (iOS icon)
const BACKUP = path.join(ROOT, 'assets/images/icon-original.png');
// Glyph is ALWAYS extracted from the immutable backup, never from SRC (which this
// script overwrites — re-running while reading SRC compounds artifacts).
const GLYPH_SRC = BACKUP;

// Gradient field (vertical, sampled from the original icon's flat-field corners).
const TOP = [0, 135, 250]; // #0087FA
const BOT = [0, 91, 229]; // #005BE5

// Glyph bbox measured in the source (white mark, excludes the squircle rim).
const GLYPH = { minX: 203, minY: 204, maxX: 818, maxY: 819 };

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Load source and build a glyph layer with per-pixel alpha.
// alpha = how "light" a pixel is vs the dark blue field. The glyph is near-white
// (high luma, low saturation toward blue); the field is saturated blue with R~0.
// Using R as the driver works because the field has R~0 everywhere and the glyph
// (white + pale-blue bevel) has high R. We map R through a soft ramp so the AA
// edges and bevel shading fade smoothly instead of hard-clipping.
function buildGlyphLayer(src) {
  const { width: W, height: H } = src;
  const layer = { width: W, height: H, data: new Float32Array(W * H * 4) };
  const LO = 30; // R below this => fully field (alpha 0)
  const HI = 150; // R above this => fully glyph (alpha 1)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (W * y + x) * 4;
      const r = src.data[i],
        g = src.data[i + 1],
        b = src.data[i + 2];
      // restrict to glyph bbox (+ small margin) so stray rim highlights outside
      // the mark don't leak in
      const inBox =
        x >= GLYPH.minX - 8 && x <= GLYPH.maxX + 8 && y >= GLYPH.minY - 8 && y <= GLYPH.maxY + 8;
      let a = 0;
      if (inBox) {
        a = Math.max(0, Math.min(1, (r - LO) / (HI - LO)));
      }
      // store the source colour; where alpha>0 we'll keep the glyph's own shading
      layer.data[i] = r;
      layer.data[i + 1] = g;
      layer.data[i + 2] = b;
      layer.data[i + 3] = a;
    }
  }
  return layer;
}

// Sample the glyph layer (premultiplied-safe bilinear) at fractional source coords.
function sampleLayer(layer, fx, fy) {
  const W = layer.width,
    H = layer.height;
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(fy)));
  const x1 = Math.min(W - 1, x0 + 1),
    y1 = Math.min(H - 1, y0 + 1);
  const dx = fx - x0,
    dy = fy - y0;
  const at = (x, y) => {
    const i = (W * y + x) * 4;
    return [
      layer.data[i],
      layer.data[i + 1],
      layer.data[i + 2],
      layer.data[i + 3],
    ];
  };
  const c00 = at(x0, y0),
    c10 = at(x1, y0),
    c01 = at(x0, y1),
    c11 = at(x1, y1);
  // bilinear on premultiplied colour to avoid dark fringing at edges
  const out = [0, 0, 0, 0];
  const corners = [
    [c00, (1 - dx) * (1 - dy)],
    [c10, dx * (1 - dy)],
    [c01, (1 - dx) * dy],
    [c11, dx * dy],
  ];
  for (const [c, w] of corners) {
    const a = c[3];
    out[0] += c[0] * a * w;
    out[1] += c[1] * a * w;
    out[2] += c[2] * a * w;
    out[3] += a * w;
  }
  if (out[3] > 0) {
    out[0] /= out[3];
    out[1] /= out[3];
    out[2] /= out[3];
  }
  return out; // [r,g,b,alpha], colour un-premultiplied
}

// 4x4 Bayer ordered-dither matrix, normalised to [-0.5, 0.5). Added before the
// final integer round so the gradient's tiny per-channel deltas (e.g. blue only
// moves ~21 levels over 1024px) don't collapse into visible horizontal bands.
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
function dither(x, y) {
  return BAYER[y & 3][x & 3] / 16 - 0.5;
}

function render(glyphLayer, outSize, scale) {
  const out = new PNG({ width: outSize, height: outSize });
  // glyph source region is the bbox; we place that region scaled into the canvas
  const gW = GLYPH.maxX - GLYPH.minX;
  const gH = GLYPH.maxY - GLYPH.minY;
  const gMax = Math.max(gW, gH);
  const target = outSize * scale; // glyph longest side in output px
  const placedW = (gW / gMax) * target;
  const placedH = (gH / gMax) * target;
  const offX = (outSize - placedW) / 2;
  const offY = (outSize - placedH) / 2;

  for (let y = 0; y < outSize; y++) {
    const t = y / (outSize - 1);
    const gr = lerp(TOP[0], BOT[0], t);
    const gg = lerp(TOP[1], BOT[1], t);
    const gb = lerp(TOP[2], BOT[2], t);
    for (let x = 0; x < outSize; x++) {
      const i = (outSize * y + x) * 4;
      let r = gr,
        g = gg,
        b = gb;
      if (x >= offX && x < offX + placedW && y >= offY && y < offY + placedH) {
        const fx = GLYPH.minX + ((x - offX) / placedW) * gW;
        const fy = GLYPH.minY + ((y - offY) / placedH) * gH;
        const [sr, sg, sb, sa] = sampleLayer(glyphLayer, fx, fy);
        r = sr * sa + gr * (1 - sa);
        g = sg * sa + gg * (1 - sa);
        b = sb * sa + gb * (1 - sa);
      }
      const d = dither(x, y);
      out.data[i] = Math.max(0, Math.min(255, Math.round(r + d)));
      out.data[i + 1] = Math.max(0, Math.min(255, Math.round(g + d)));
      out.data[i + 2] = Math.max(0, Math.min(255, Math.round(b + d)));
      out.data[i + 3] = 255;
    }
  }
  return out;
}

// Establish the immutable backup from the true original on first run only.
if (!fs.existsSync(BACKUP)) {
  fs.writeFileSync(BACKUP, fs.readFileSync(SRC));
  console.log('Backed up original ->', path.relative(ROOT, BACKUP));
}

// Always extract the glyph from the backup, never from the (mutated) SRC.
const src = PNG.sync.read(fs.readFileSync(GLYPH_SRC));
const glyph = buildGlyphLayer(src);

// iOS / general icon: glyph fills ~70% of the square (iOS masks corners itself).
// Fuller than Android (per iOS convention) but with comfortable breathing room.
const ios = render(glyph, 1024, 0.7);
fs.writeFileSync(SRC, PNG.sync.write(ios));
console.log('Wrote', path.relative(ROOT, SRC), '(iOS, glyph 70%)');

// Android adaptive foreground: glyph at 0.60 of the 108dp PNG. Android's spec
// says logo content must stay within the 66/108 (~0.61) safe zone; 0.60 sits
// right at that max for the comfortable padding requested while filling the
// masked viewport (~72dp) nicely. See gen-app-icons notes + Android adaptive
// icon docs (108dp layer, 66dp safe zone).
const android = render(glyph, 1024, 0.56);
const OUT_A = path.join(ROOT, 'assets/images/icon-android-adaptive.png');
fs.writeFileSync(OUT_A, PNG.sync.write(android));
console.log('Wrote', path.relative(ROOT, OUT_A), '(Android, glyph 56%)');
