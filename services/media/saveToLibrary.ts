/**
 * saveToLibrary — download a remote image or video and save it to the
 * device's Photos library. Used by the in-app image lightbox and the
 * video player so users can save what they're viewing.
 *
 * Requires the `expo-media-library` package (native module). Requires
 * the `ACCESS_MEDIA_LOCATION` / Photo Library Add Usage permission to
 * be present in app.json / Info.plist. See applyMediaLibraryPlist().
 */

import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

export type SaveResult =
  | { ok: true }
  | { ok: false; reason: 'permission_denied' | 'download_failed' | 'save_failed' | 'invalid_url'; detail?: string };

/**
 * Best-effort filename derivation from a URL. We append a unique
 * suffix to avoid clobbering whatever the cache has at the same name,
 * and force a recognized extension so MediaLibrary can detect the
 * media type. Falls back to `.jpg` for unknown extensions in image
 * contexts; the caller can override via the `extensionFallback` arg.
 */
function deriveCachePath(url: string, extensionFallback: string): string {
  let ext = extensionFallback;
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop() ?? '';
    const m = last.match(/\.(jpe?g|png|gif|webp|heic|mp4|mov|m4v|webm)$/i);
    if (m) ext = m[1].toLowerCase();
  } catch {
    /* malformed URL — use fallback */
  }
  // `.jpe` => `.jpg`
  if (ext === 'jpe' || ext === 'jpeg') ext = 'jpg';
  const safeName = `quorum-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  return `${FileSystem.cacheDirectory}${safeName}`;
}

/**
 * Decode a `data:<mime>;base64,<payload>` URI into a local cache
 * file and return its path. Returns null on malformed input.
 * Chat attachments are stored as base64 data URIs, so this is the
 * path that handles "save this image from a DM/space".
 */
async function writeDataUriToCache(
  url: string,
  fallbackExt: string,
): Promise<string | null> {
  // data:<mime>[;<param>]*;base64,<payload>
  const m = url.match(/^data:([^;,]+)(?:;[^,]*)*;base64,(.+)$/i);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const payload = m[2];
  // Pick a useful extension from the mime where we can.
  let ext = fallbackExt;
  if (mime.startsWith('image/')) {
    const sub = mime.split('/')[1] ?? '';
    if (/^(jpeg|jpg|png|gif|webp|heic)$/.test(sub)) ext = sub === 'jpeg' ? 'jpg' : sub;
  } else if (mime.startsWith('video/')) {
    const sub = mime.split('/')[1] ?? '';
    if (/^(mp4|mov|m4v|webm)$/.test(sub)) ext = sub;
  }
  const safeName = `quorum-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const dest = `${FileSystem.cacheDirectory}${safeName}`;
  try {
    await FileSystem.writeAsStringAsync(dest, payload, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return dest;
  } catch {
    return null;
  }
}

/**
 * Save a remote URL (http(s)) or a base64 data URI to the user's
 * Photos library. Returns a discriminated result so callers can
 * give specific feedback.
 */
export async function saveMediaToLibrary(
  url: string,
  kind: 'image' | 'video',
): Promise<SaveResult> {
  if (!url) {
    return { ok: false, reason: 'invalid_url' };
  }
  const isHttp = /^https?:\/\//i.test(url);
  const isData = /^data:/i.test(url);
  if (!isHttp && !isData) {
    return { ok: false, reason: 'invalid_url' };
  }

  // HLS streams (.m3u8) are a playlist of segments, not a single file —
  // downloading the manifest and handing it to the camera roll always fails.
  // We can't remux on-device, so report it honestly.
  if (kind === 'video' && /\.m3u8(\?|#|$)/i.test(url)) {
    return { ok: false, reason: 'save_failed', detail: 'streaming video (HLS) can’t be saved' };
  }

  // Permission. iOS distinguishes write-only ("add") and full access;
  // requesting `writeOnly` covers our case (we never read existing
  // photos) and prompts the least invasive system dialog.
  const writeOnly = Platform.OS === 'ios';
  const perm = await MediaLibrary.requestPermissionsAsync(writeOnly);
  if (!perm.granted) {
    return { ok: false, reason: 'permission_denied' };
  }

  // Materialize to a local file. MediaLibrary needs a file URI.
  const ext = kind === 'image' ? 'jpg' : 'mp4';
  let localUri: string;
  if (isData) {
    const written = await writeDataUriToCache(url, ext);
    if (!written) {
      return { ok: false, reason: 'download_failed', detail: 'unsupported data URI' };
    }
    localUri = written;
  } else {
    const dest = deriveCachePath(url, ext);
    try {
      const result = await FileSystem.downloadAsync(url, dest);
      if (result.status >= 400) {
        return { ok: false, reason: 'download_failed', detail: `HTTP ${result.status}` };
      }
      localUri = result.uri;
    } catch (e) {
      return {
        ok: false,
        reason: 'download_failed',
        detail: (e as Error)?.message ?? 'network error',
      };
    }
  }

  // Save to library. `saveToLibraryAsync` detects image vs video from
  // the file extension, which is why we forced a recognized one above.
  try {
    await MediaLibrary.saveToLibraryAsync(localUri);
  } catch (e) {
    return {
      ok: false,
      reason: 'save_failed',
      detail: (e as Error)?.message ?? 'unknown',
    };
  } finally {
    // Best-effort cleanup of the cache copy. MediaLibrary takes its
    // own snapshot into the system library, so we don't need the
    // local file around.
    FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
  }

  return { ok: true };
}
