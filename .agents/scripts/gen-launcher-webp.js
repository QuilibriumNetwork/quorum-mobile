// Regenerates the committed Android launcher bitmaps from the redesigned icons:
//   - mipmap-*/ic_launcher_foreground.webp  <- icon-android-adaptive.png (gradient+glyph, full-bleed, 108dp)
//   - mipmap-*/ic_launcher.webp             <- icon.png (full icon) with rounded-square mask (legacy launchers)
//   - mipmap-*/ic_launcher_round.webp       <- icon.png with circle mask (round launchers)
//
// Writes intermediate PNGs to a temp dir, then shells ffmpeg to encode lossless webp
// (ffmpeg is the only image tool available; no npm webp encoder installed).
//
// Run: node .agents/scripts/gen-launcher-webp.js
//
// Sizes (mdpi..xxxhdpi): foreground 108/162/216/324/432 ; launcher 48/72/96/144/192

const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RES = path.join(ROOT, 'android/app/src/main/res');
// ffmpeg binary. Override with QM_FFMPEG when yours lives elsewhere or is on PATH.
const FFMPEG = process.env.QM_FFMPEG || 'C:/Program Files/ffmpeg/bin/ffmpeg.exe';
const TMP = path.join(ROOT, '.agents/scripts/.tmp-icons');

const DENS = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
const FG_SIZE = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
const IC_SIZE = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

const fg = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'assets/images/icon-android-adaptive.png')));
// Legacy/round launchers (pre-API-26 fallback, rarely used) reuse the SAME
// adaptive foreground (glyph-on-gradient, padded) so they match the modern
// adaptive icon instead of the old squircle-baked icon.png.
const full = fg;

// Bilinear resize of an opaque PNG to NxN.
function resize(src, N) {
  const out = new PNG({ width: N, height: N });
  const W = src.width,
    H = src.height;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const fx = (x / (N - 1)) * (W - 1);
      const fy = (y / (N - 1)) * (H - 1);
      const x0 = Math.floor(fx),
        y0 = Math.floor(fy);
      const x1 = Math.min(W - 1, x0 + 1),
        y1 = Math.min(H - 1, y0 + 1);
      const dx = fx - x0,
        dy = fy - y0;
      const i = (N * y + x) * 4;
      for (let k = 0; k < 4; k++) {
        const p = (xx, yy) => src.data[(W * yy + xx) * 4 + k];
        const top = p(x0, y0) * (1 - dx) + p(x1, y0) * dx;
        const bot = p(x0, y1) * (1 - dx) + p(x1, y1) * dx;
        out.data[i + k] = Math.round(top * (1 - dy) + bot * dy);
      }
    }
  return out;
}

// Apply a mask: 'square' (no-op opaque), 'rounded' (radius frac), 'circle'.
function mask(img, kind) {
  const N = img.width;
  const r = N * 0.18; // rounded-square corner radius (~Android legacy look)
  const cx = (N - 1) / 2,
    cy = (N - 1) / 2,
    rad = N / 2;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = (N * y + x) * 4;
      let a = 1;
      if (kind === 'circle') {
        const d = Math.hypot(x - cx, y - cy);
        a = d <= rad - 1 ? 1 : d >= rad ? 0 : rad - d;
      } else if (kind === 'rounded') {
        // distance into nearest corner
        const dx = Math.max(r - x, 0, x - (N - 1 - r));
        const dy = Math.max(r - y, 0, y - (N - 1 - r));
        if (dx > 0 && dy > 0) {
          const d = Math.hypot(dx, dy);
          a = d <= r - 1 ? 1 : d >= r ? 0 : r - d;
        }
      }
      img.data[i + 3] = Math.round(img.data[i + 3] * a);
    }
  return img;
}

function toWebp(png, outPath) {
  const tmpPng = path.join(TMP, 'tmp.png');
  fs.writeFileSync(tmpPng, PNG.sync.write(png));
  execFileSync(FFMPEG, ['-y', '-i', tmpPng, '-lossless', '1', '-q:v', '100', outPath], {
    stdio: 'ignore',
  });
}

for (const d of DENS) {
  // foreground: full-bleed gradient+glyph, no mask (adaptive system masks it)
  toWebp(resize(fg, FG_SIZE[d]), path.join(RES, `mipmap-${d}`, 'ic_launcher_foreground.webp'));
  // legacy launcher: full icon, rounded-square
  toWebp(mask(resize(full, IC_SIZE[d]), 'rounded'), path.join(RES, `mipmap-${d}`, 'ic_launcher.webp'));
  // round launcher: full icon, circle
  toWebp(mask(resize(full, IC_SIZE[d]), 'circle'), path.join(RES, `mipmap-${d}`, 'ic_launcher_round.webp'));
  console.log('wrote mipmap-' + d + ' {foreground, launcher, round}');
}

// cleanup tmp
fs.rmSync(TMP, { recursive: true, force: true });
console.log('done');
