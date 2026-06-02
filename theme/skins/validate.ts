/**
 * Skin validation — the security boundary.
 *
 * Enforced identically before publishing a skin and before applying/importing
 * one (a malicious gallery entry must never be able to crash or escape the
 * client). The Go server runs an equivalent validator on publish.
 *
 * Guarantees:
 *  - Strict allow-list: unknown keys are rejected, not merged.
 *  - No remote calls: the ONLY URIs permitted anywhere are `data:` URIs of an
 *    explicitly-allowed asset class. Any `http(s)://`/other scheme is rejected.
 *  - Image slots are PNG/JPEG only, and are *content-validated*: the declared
 *    MIME and `data:` label are never trusted — we decode and sniff magic bytes
 *    and require the bytes to actually be the declared type. Every other image
 *    type (webp/gif/svg/heic/bmp/...) is rejected.
 *  - Bounded sizes/dimensions to prevent DoS.
 */

import {
  SKIN_COLOR_KEYS,
  SLOT_NAMES,
  type SkinColorTokens,
  type SkinOverride,
  type SlotName,
} from './types';

// Caps.
export const MAX_SKIN_BYTES = 2 * 1024 * 1024; // 2MB total decoded asset budget
const MAX_IMAGE_DIMENSION = 4096;
const MAX_ICON_DIMENSION = 512;
const MAX_ICONS = 400;
const SPACING_MIN = 0;
const SPACING_MAX = 128;
const FONT_SCALE_MIN = 0.7;
const FONT_SCALE_MAX = 1.6;
const SCALE_MAX = 8; // upper bound for radii/spacing/border scale multipliers
const RADIUS_MIN = 0;
const RADIUS_MAX = 64;
const BORDER_MIN = 0;
const BORDER_MAX = 16;
// How many leading bytes of an image we decode for sniffing + dimensions. The
// JPEG SOF marker can sit after a large EXIF/APP segment, so we scan a window.
const IMAGE_SNIFF_BYTES = 16 * 1024;

export type ValidationResult =
  | { ok: true; skin: SkinOverride }
  | { ok: false; error: string };

const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg']);
const ALLOWED_FONT_MIMES = new Set(['font/ttf', 'font/otf', 'application/font-sfnt']);

// ---------------------------------------------------------------------------
// base64 / data-URI helpers
// ---------------------------------------------------------------------------

const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B64_ALPHABET.length; i++) m[B64_ALPHABET[i]] = i;
  return m;
})();

/** Decode only the leading `byteCount` bytes of a base64 string — avoids
 *  materializing a multi-MB buffer just to read a header. */
function decodeBase64Prefix(b64: string, byteCount: number): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < b64.length && out.length < byteCount; i++) {
    const ch = b64[i];
    if (ch === '=') break;
    const v = B64_LOOKUP[ch];
    if (v === undefined) continue; // skip whitespace/newlines
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Approximate decoded byte length of a base64 payload (ignoring whitespace). */
function base64ByteLength(b64: string): number {
  let chars = 0;
  let pad = 0;
  for (let i = 0; i < b64.length; i++) {
    const ch = b64[i];
    if (ch === '=') { pad++; continue; }
    if (B64_LOOKUP[ch] !== undefined) chars++;
  }
  return Math.floor((chars * 3) / 4) - (pad > 0 ? pad : 0);
}

interface ParsedDataUri {
  mime: string;
  base64: string;
}

/** Parse a strict base64 `data:` URI. Returns null for anything else (incl.
 *  non-base64 data URIs and any non-`data:` scheme). */
function parseDataUri(value: unknown): ParsedDataUri | null {
  if (typeof value !== 'string') return null;
  const m = /^data:([a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    value,
  );
  if (!m) return null;
  return { mime: m[1].toLowerCase(), base64: m[2] };
}

// ---------------------------------------------------------------------------
// image content sniffing
// ---------------------------------------------------------------------------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

/** Sniff the actual image type from decoded bytes — 'png' | 'jpeg' | null. */
function sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | null {
  if (startsWith(bytes, PNG_SIG)) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  return null;
}

function pngDimensions(bytes: Uint8Array): { w: number; h: number } | null {
  // IHDR width/height are big-endian uint32 at byte offsets 16 and 20.
  if (bytes.length < 24) return null;
  const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
  const h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  return { w: w >>> 0, h: h >>> 0 };
}

function jpegDimensions(bytes: Uint8Array): { w: number; h: number } | null {
  let i = 2; // skip SOI (FFD8)
  const len = bytes.length;
  while (i + 9 < len) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    // Standalone markers (no length): RSTn, SOI, EOI, TEM, fill.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
    // SOF markers carry dimensions (exclude DHT/JPG/DAC C4/C8/CC).
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      const h = (bytes[i + 5] << 8) | bytes[i + 6];
      const w = (bytes[i + 7] << 8) | bytes[i + 8];
      return { w, h };
    }
    if (segLen < 2) return null; // malformed
    i += 2 + segLen;
  }
  return null; // SOF not within sniff window — can't verify dims (allowed)
}

/**
 * Validate an image data-URI for a UI image slot (wallpaper, thumbnail):
 * PNG/JPEG only, content must match the declared MIME, dimensions bounded.
 */
function validateImageDataUri(value: unknown, label: string, maxDim = MAX_IMAGE_DIMENSION): string | null {
  const parsed = parseDataUri(value);
  if (!parsed) return `${label}: must be a base64 data: URI`;
  if (!ALLOWED_IMAGE_MIMES.has(parsed.mime)) {
    return `${label}: only image/png and image/jpeg are allowed (got ${parsed.mime})`;
  }
  const bytes = decodeBase64Prefix(parsed.base64, IMAGE_SNIFF_BYTES);
  const actual = sniffImage(bytes);
  if (!actual) return `${label}: content is not a valid PNG or JPEG`;
  const declared = parsed.mime === 'image/png' ? 'png' : 'jpeg';
  if (actual !== declared) {
    return `${label}: content (${actual}) does not match declared type (${parsed.mime})`;
  }
  const dims = actual === 'png' ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (dims && (dims.w > maxDim || dims.h > maxDim)) {
    return `${label}: image exceeds ${maxDim}px (${dims.w}x${dims.h})`;
  }
  return null;
}

function validateFontDataUri(value: unknown, label: string): string | null {
  const parsed = parseDataUri(value);
  if (!parsed) return `${label}: must be a base64 data: URI`;
  if (!ALLOWED_FONT_MIMES.has(parsed.mime)) {
    return `${label}: only font/ttf, font/otf are allowed (got ${parsed.mime})`;
  }
  const b = decodeBase64Prefix(parsed.base64, 8);
  // sfnt magic: 0x00010000 (TTF), 'OTTO' (CFF/OTF), 'true'/'ttcf'.
  const tag = String.fromCharCode(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0);
  const isTrueType = b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00;
  if (!isTrueType && tag !== 'OTTO' && tag !== 'true' && tag !== 'ttcf') {
    return `${label}: not a valid sfnt font`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// scalar validators
// ---------------------------------------------------------------------------

const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGBA_RE = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i;

function isColor(value: unknown): value is string {
  return typeof value === 'string' && (HEX_RE.test(value) || RGBA_RE.test(value));
}

function clampedNumber(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isOpacity(value: unknown): value is number {
  return clampedNumber(value, 0, 1);
}

// ---------------------------------------------------------------------------
// top-level
// ---------------------------------------------------------------------------

function validateColorMap(map: unknown, label: string): string | null {
  if (map === undefined) return null;
  if (typeof map !== 'object' || map === null) return `${label}: must be an object`;
  for (const [k, v] of Object.entries(map)) {
    if (!SKIN_COLOR_KEYS.includes(k as keyof SkinColorTokens)) {
      return `${label}: unknown color token "${k}"`;
    }
    if (!isColor(v)) return `${label}.${k}: not a valid color`;
  }
  return null;
}

/**
 * Validate an untrusted skin manifest. On success returns the value typed as
 * SkinOverride; on failure returns a human-readable error. Does NOT mutate.
 */
export function validateSkin(input: unknown): ValidationResult {
  const fail = (error: string): ValidationResult => ({ ok: false, error });
  if (typeof input !== 'object' || input === null) return fail('skin must be an object');
  const s = input as Record<string, unknown>;

  const ALLOWED_TOP = new Set([
    'schemaVersion', 'id', 'meta', 'base', 'colors', 'radii', 'borders', 'spacing',
    'fontScale', 'font', 'icons', 'wallpaper', 'frame', 'surfaces',
  ]);
  for (const k of Object.keys(s)) {
    if (!ALLOWED_TOP.has(k)) return fail(`unknown top-level key "${k}"`);
  }

  if (s.schemaVersion !== 1) return fail('unsupported schemaVersion');
  if (s.base !== 'light' && s.base !== 'dark') return fail('base must be "light" or "dark"');
  if (typeof s.id !== 'string') return fail('id must be a string');

  // meta
  if (typeof s.meta !== 'object' || s.meta === null) return fail('meta is required');
  const meta = s.meta as Record<string, unknown>;
  if (typeof meta.name !== 'string' || meta.name.trim().length === 0) {
    return fail('meta.name is required');
  }
  if (meta.name.length > 80) return fail('meta.name too long');
  if (meta.description !== undefined && (typeof meta.description !== 'string' || meta.description.length > 500)) {
    return fail('meta.description invalid');
  }

  // colors
  if (s.colors !== undefined) {
    if (typeof s.colors !== 'object' || s.colors === null) return fail('colors must be an object');
    const c = s.colors as Record<string, unknown>;
    for (const k of Object.keys(c)) {
      if (k !== 'light' && k !== 'dark') return fail(`colors: unknown key "${k}"`);
    }
    const e = validateColorMap(c.light, 'colors.light') ?? validateColorMap(c.dark, 'colors.dark');
    if (e) return fail(e);
  }

  // radii (named tokens 0..64; `pill`/`set` up to 9999; `scale` 0..8)
  if (s.radii !== undefined) {
    if (typeof s.radii !== 'object' || s.radii === null) return fail('radii must be an object');
    for (const [k, v] of Object.entries(s.radii)) {
      if (k === 'scale') {
        if (!clampedNumber(v, 0, SCALE_MAX)) return fail('radii.scale: out of range');
      } else if (k === 'set' || k === 'pill') {
        if (!clampedNumber(v, 0, 9999)) return fail(`radii.${k}: out of range`);
      } else if (['sm', 'md', 'lg'].includes(k)) {
        if (!clampedNumber(v, RADIUS_MIN, RADIUS_MAX)) return fail(`radii.${k}: out of range`);
      } else {
        return fail(`radii: unknown key "${k}"`);
      }
    }
  }

  // borders
  if (s.borders !== undefined) {
    if (typeof s.borders !== 'object' || s.borders === null) return fail('borders must be an object');
    for (const [k, v] of Object.entries(s.borders)) {
      if (k === 'color') {
        if (!isColor(v)) return fail('borders.color: not a valid color');
      } else if (k === 'scale') {
        if (!clampedNumber(v, 0, SCALE_MAX)) return fail('borders.scale: out of range');
      } else if (['hairline', 'thin', 'thick'].includes(k)) {
        if (!clampedNumber(v, BORDER_MIN, BORDER_MAX)) return fail(`borders.${k}: out of range`);
      } else {
        return fail(`borders: unknown key "${k}"`);
      }
    }
  }

  // spacing (named tokens + a global `scale`)
  if (s.spacing !== undefined) {
    if (typeof s.spacing !== 'object' || s.spacing === null) return fail('spacing must be an object');
    for (const [k, v] of Object.entries(s.spacing)) {
      if (k === 'scale') {
        if (!clampedNumber(v, 0, SCALE_MAX)) return fail('spacing.scale: out of range');
      } else if (['xs', 'sm', 'md', 'lg', 'xl'].includes(k)) {
        if (!clampedNumber(v, SPACING_MIN, SPACING_MAX)) return fail(`spacing.${k}: out of range`);
      } else {
        return fail(`spacing: unknown key "${k}"`);
      }
    }
  }

  // fontScale
  if (s.fontScale !== undefined && !clampedNumber(s.fontScale, FONT_SCALE_MIN, FONT_SCALE_MAX)) {
    return fail(`fontScale must be between ${FONT_SCALE_MIN} and ${FONT_SCALE_MAX}`);
  }

  // icons — each entry is a content-validated PNG/JPEG glyph.
  if (s.icons !== undefined) {
    if (typeof s.icons !== 'object' || s.icons === null) return fail('icons must be an object');
    const entries = Object.entries(s.icons);
    if (entries.length > MAX_ICONS) return fail(`too many icons (max ${MAX_ICONS})`);
    for (const [name, def] of entries) {
      if (!/^[\w.]{1,48}$/.test(name)) return fail(`icons: invalid name "${name}"`);
      if (typeof def !== 'object' || def === null) return fail(`icons.${name}: must be an object`);
      const d = def as Record<string, unknown>;
      for (const k of Object.keys(d)) {
        if (!['image', 'tint'].includes(k)) return fail(`icons.${name}: unknown key "${k}"`);
      }
      if (d.tint !== undefined && typeof d.tint !== 'boolean') return fail(`icons.${name}.tint invalid`);
      const e = validateImageDataUri(d.image, `icons.${name}.image`, MAX_ICON_DIMENSION);
      if (e) return fail(e);
    }
  }

  // font
  if (s.font !== undefined) {
    if (typeof s.font !== 'object' || s.font === null) return fail('font must be an object');
    const f = s.font as Record<string, unknown>;
    for (const k of Object.keys(f)) {
      if (!['family', 'source', 'weights'].includes(k)) return fail(`font: unknown key "${k}"`);
    }
    if (typeof f.family !== 'string' || !/^[\w .-]{1,48}$/.test(f.family)) {
      return fail('font.family invalid');
    }
    if (f.weights !== 'static-single') return fail('font.weights must be "static-single"');
    if (typeof f.source !== 'object' || f.source === null) return fail('font.source required');
    const e = validateFontDataUri((f.source as Record<string, unknown>).dataUri, 'font.source.dataUri');
    if (e) return fail(e);
  }

  // wallpaper
  if (s.wallpaper !== undefined) {
    if (typeof s.wallpaper !== 'object' || s.wallpaper === null) return fail('wallpaper must be an object');
    const w = s.wallpaper as Record<string, unknown>;
    for (const k of Object.keys(w)) {
      if (!['source', 'fit', 'scrimOpacity', 'surfaceAlpha'].includes(k)) {
        return fail(`wallpaper: unknown key "${k}"`);
      }
    }
    if (typeof w.source !== 'object' || w.source === null) return fail('wallpaper.source required');
    const e = validateImageDataUri((w.source as Record<string, unknown>).dataUri, 'wallpaper.source.dataUri');
    if (e) return fail(e);
    if (w.fit !== undefined && !['cover', 'tile', 'contain'].includes(w.fit as string)) {
      return fail('wallpaper.fit invalid');
    }
    if (w.scrimOpacity !== undefined && !isOpacity(w.scrimOpacity)) return fail('wallpaper.scrimOpacity invalid');
    if (w.surfaceAlpha !== undefined && !isOpacity(w.surfaceAlpha)) return fail('wallpaper.surfaceAlpha invalid');
  }

  // frame
  if (s.frame !== undefined) {
    const e = validateFrame(s.frame);
    if (e) return fail(e);
  }

  // surfaces — per-slot backgrounds/knobs (cascading by dotted key)
  if (s.surfaces !== undefined) {
    if (typeof s.surfaces !== 'object' || s.surfaces === null) return fail('surfaces must be an object');
    const entries = Object.entries(s.surfaces);
    if (entries.length > 64) return fail('too many surfaces');
    for (const [key, sv] of entries) {
      if (!/^[a-z]+(\.[a-z0-9]+)*$/i.test(key)) return fail(`surfaces: invalid key "${key}"`);
      if (!SLOT_NAMES.includes(key.split('.')[0] as SlotName)) {
        return fail(`surfaces: unknown slot "${key.split('.')[0]}"`);
      }
      if (typeof sv !== 'object' || sv === null) return fail(`surfaces.${key}: must be an object`);
      const o = sv as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (!['background', 'fit', 'opacity', 'text'].includes(k)) {
          return fail(`surfaces.${key}: unknown key "${k}"`);
        }
      }
      if (o.background !== undefined) {
        const bg = o.background;
        if (typeof bg !== 'string') return fail(`surfaces.${key}.background invalid`);
        if (/^data:/i.test(bg)) {
          const e = validateImageDataUri(bg, `surfaces.${key}.background`);
          if (e) return fail(e);
        } else if (!isColor(bg)) {
          return fail(`surfaces.${key}.background must be a color or PNG/JPEG data URI`);
        }
      }
      if (o.fit !== undefined && !['cover', 'tile', 'contain'].includes(o.fit as string)) {
        return fail(`surfaces.${key}.fit invalid`);
      }
      if (o.opacity !== undefined && !isOpacity(o.opacity)) return fail(`surfaces.${key}.opacity invalid`);
      if (o.text !== undefined && !isColor(o.text)) return fail(`surfaces.${key}.text invalid`);
    }
  }

  // total asset budget (decoded) — wallpaper + font + every icon image.
  let totalBytes = 0;
  const assetUris: (string | undefined)[] = [
    (s.wallpaper as { source?: { dataUri?: string } })?.source?.dataUri,
    (s.font as { source?: { dataUri?: string } })?.source?.dataUri,
  ];
  if (s.icons && typeof s.icons === 'object') {
    for (const def of Object.values(s.icons as Record<string, { image?: string }>)) {
      assetUris.push(def?.image);
    }
  }
  if (s.surfaces && typeof s.surfaces === 'object') {
    for (const sv of Object.values(s.surfaces as Record<string, { background?: string }>)) {
      if (sv?.background && /^data:/i.test(sv.background)) assetUris.push(sv.background);
    }
  }
  for (const uri of assetUris) {
    const p = parseDataUri(uri);
    if (p) totalBytes += base64ByteLength(p.base64);
  }
  if (totalBytes > MAX_SKIN_BYTES) {
    return fail(`skin assets exceed ${Math.round(MAX_SKIN_BYTES / 1024)}KB`);
  }

  return { ok: true, skin: input as SkinOverride };
}

function validateFrame(frame: unknown): string | null {
  if (typeof frame !== 'object' || frame === null) return 'frame must be an object';
  const f = frame as Record<string, unknown>;
  for (const k of Object.keys(f)) {
    if (!['corner', 'accentBorder', 'headerBar', 'panelGlow'].includes(k)) {
      return `frame: unknown key "${k}"`;
    }
  }
  if (f.corner !== undefined && !['square', 'rounded', 'pill'].includes(f.corner as string)) {
    return 'frame.corner invalid';
  }
  if (f.panelGlow !== undefined && typeof f.panelGlow !== 'boolean') return 'frame.panelGlow invalid';
  if (f.accentBorder !== undefined) {
    const ab = f.accentBorder as Record<string, unknown>;
    if (typeof ab !== 'object' || ab === null) return 'frame.accentBorder invalid';
    if (ab.width !== 'thin' && ab.width !== 'thick') return 'frame.accentBorder.width invalid';
    if (ab.color !== undefined && !isColor(ab.color)) return 'frame.accentBorder.color invalid';
    if (ab.radius !== undefined && !['sm', 'md', 'lg'].includes(ab.radius as string)) {
      return 'frame.accentBorder.radius invalid';
    }
  }
  if (f.headerBar !== undefined) {
    const hb = f.headerBar as Record<string, unknown>;
    if (typeof hb !== 'object' || hb === null) return 'frame.headerBar invalid';
    if (hb.background !== undefined && !isColor(hb.background)) return 'frame.headerBar.background invalid';
    if (hb.tint !== undefined && !isColor(hb.tint)) return 'frame.headerBar.tint invalid';
    if (hb.height !== undefined && !clampedNumber(hb.height, 0, 200)) return 'frame.headerBar.height invalid';
  }
  return null;
}
