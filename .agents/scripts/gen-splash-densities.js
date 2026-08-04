// Builds the Android-12 splash logo PNGs from the brand white-glyph master.
// Source: assets/images/quorum-symbol-white.png (copied from the brand kit) -
// pure-white glyph on transparent. We trim to the glyph bbox, then centre it on
// a 1024x1024 transparent canvas at SPLASH_SCALE so it stays inside the Android
// 12 system circle clip. Background colour comes from windowSplashScreenBackground
// (set to brand blue in colors.xml), so the PNG itself stays transparent.
//
// Run: node .agents/scripts/gen-splash-densities.js
// Overwrites: android/.../drawable-{,night-}{m,h,xh,xxh,xxxh}dpi/splashscreen_logo.png
// Also writes assets/images/splash-glyph.png (master) + a preview.

const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MASTER = path.join(ROOT, 'assets/images/quorum-symbol-white.png');
const RES = path.join(ROOT, 'android/app/src/main/res');

// Glyph occupies this fraction of the 1024 canvas longest side. The Android 12
// splash circle shows roughly the inner 2/3; 0.5 keeps a safe margin.
const SPLASH_SCALE = 0.5;
const CANVAS = 1024;
const DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];

function trimToAlpha(src) {
  const { width: W, height: H } = src;
  let minX = W,
    minY = H,
    maxX = 0,
    maxY = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (src.data[(W * y + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  return { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// Nearest-neighbour-on-premultiplied bilinear downscale of the trimmed glyph
// into a CANVAS x CANVAS transparent buffer.
function renderCanvas(src, box, scale) {
  const out = new PNG({ width: CANVAS, height: CANVAS });
  const gMax = Math.max(box.w, box.h);
  const target = CANVAS * scale;
  const pw = (box.w / gMax) * target;
  const ph = (box.h / gMax) * target;
  const ox = (CANVAS - pw) / 2;
  const oy = (CANVAS - ph) / 2;
  const W = src.width;
  for (let y = 0; y < CANVAS; y++) {
    for (let x = 0; x < CANVAS; x++) {
      const i = (CANVAS * y + x) * 4;
      out.data[i] = 255;
      out.data[i + 1] = 255;
      out.data[i + 2] = 255;
      out.data[i + 3] = 0;
      if (x >= ox && x < ox + pw && y >= oy && y < oy + ph) {
        // bilinear sample of source alpha (colour is pure white everywhere)
        const fx = box.minX + ((x - ox) / pw) * (box.w - 1);
        const fy = box.minY + ((y - oy) / ph) * (box.h - 1);
        const x0 = Math.floor(fx),
          y0 = Math.floor(fy);
        const x1 = Math.min(src.width - 1, x0 + 1),
          y1 = Math.min(src.height - 1, y0 + 1);
        const dx = fx - x0,
          dy = fy - y0;
        const a = (xx, yy) => src.data[(W * yy + xx) * 4 + 3];
        const top = a(x0, y0) * (1 - dx) + a(x1, y0) * dx;
        const bot = a(x0, y1) * (1 - dx) + a(x1, y1) * dx;
        out.data[i + 3] = Math.round(top * (1 - dy) + bot * dy);
      }
    }
  }
  return out;
}

const src = PNG.sync.read(fs.readFileSync(MASTER));
const box = trimToAlpha(src);
console.log('glyph bbox', box);
const canvas = renderCanvas(src, box, SPLASH_SCALE);

// master copy for reference
fs.writeFileSync(path.join(ROOT, 'assets/images/splash-glyph.png'), PNG.sync.write(canvas));

const buf = PNG.sync.write(canvas);
for (const d of DENSITIES) {
  for (const variant of ['drawable-' + d, 'drawable-night-' + d]) {
    const dir = path.join(RES, variant);
    if (fs.existsSync(dir)) {
      fs.writeFileSync(path.join(dir, 'splashscreen_logo.png'), buf);
      console.log('wrote', variant + '/splashscreen_logo.png');
    }
  }
}

// preview: composite on brand blue + draw the ~2/3 system circle to confirm fit
const BG = [0, 110, 240];
const prev = new PNG({ width: CANVAS, height: CANVAS });
const cx = CANVAS / 2,
  cy = CANVAS / 2,
  rCircle = CANVAS * 0.34; // approx Android12 branded circle radius
for (let y = 0; y < CANVAS; y++)
  for (let x = 0; x < CANVAS; x++) {
    const i = (CANVAS * y + x) * 4;
    const sa = canvas.data[i + 3] / 255;
    let r = BG[0] * (1 - sa) + 255 * sa;
    let g = BG[1] * (1 - sa) + 255 * sa;
    let b = BG[2] * (1 - sa) + 255 * sa;
    // faint circle guide
    const dist = Math.hypot(x - cx, y - cy);
    if (Math.abs(dist - rCircle) < 2) {
      r = 255;
      g = 255;
      b = 255;
    }
    prev.data[i] = r;
    prev.data[i + 1] = g;
    prev.data[i + 2] = b;
    prev.data[i + 3] = 255;
  }
fs.writeFileSync(path.join(ROOT, 'assets/images/_preview-splash.png'), PNG.sync.write(prev));
console.log('wrote preview with system-circle guide');
