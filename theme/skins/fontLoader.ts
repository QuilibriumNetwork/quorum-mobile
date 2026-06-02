/**
 * Runtime loader for a skin's embedded font.
 *
 * A skin's font arrives as a validated `data:font/...;base64,...` URI. expo-font
 * can't load a data-URI directly, so we write the bytes to a stable cache file
 * (persisted across launches, keyed by skin id) and register it with
 * `Font.loadAsync` under the namespaced family from `skinFontFamily` — the same
 * family `createTheme` stamps into `theme.fonts`. Idempotent via `Font.isLoaded`.
 *
 * Callers must `await` this BEFORE applying the skin so text doesn't render in
 * the fallback font for a frame and reflow.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as Font from 'expo-font';
import { logger } from '@quilibrium/quorum-shared';
import { skinFontFamily } from './mergeSkin';
import type { SkinOverride } from './types';

function parseFontDataUri(dataUri: string): { ext: 'ttf' | 'otf'; base64: string } | null {
  const m = /^data:(font\/ttf|font\/otf|application\/font-sfnt);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUri);
  if (!m) return null;
  const ext = m[1].toLowerCase() === 'font/otf' ? 'otf' : 'ttf';
  return { ext, base64: m[2] };
}

/**
 * Ensure the skin's embedded font is registered. Resolves (no-op) when the
 * skin has no font, the font is already loaded, or on any failure — a missing
 * font must never block applying the rest of the skin.
 */
export async function ensureSkinFontLoaded(skin: SkinOverride | null | undefined): Promise<void> {
  if (!skin?.font) return;
  const family = skinFontFamily(skin);
  if (!family || Font.isLoaded(family)) return;

  const parsed = parseFontDataUri(skin.font.source.dataUri);
  if (!parsed) return;

  try {
    const dir = `${FileSystem.documentDirectory}skins/${skin.id || 'local'}/`;
    const path = `${dir}font.${parsed.ext}`;
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      await FileSystem.writeAsStringAsync(path, parsed.base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
    }
    await Font.loadAsync(family, { uri: path });
  } catch (e) {
    logger.warn('[skins] font load failed:', e instanceof Error ? e.message : e);
  }
}
