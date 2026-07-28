// expo-file-system replacement for Node, backed by node:fs.
//
// Only the handful of calls mobile's storage and media paths reach are mapped.
// Anything unmapped throws by name rather than returning undefined, so a
// scenario that wanders into unshimmed territory fails with a message that says
// what to add — instead of a confusing `undefined is not a function` three
// layers down.
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/** Harness scratch space, mirroring expo's documentTirectory-style contract. */
export const documentDirectory = resolve(tmpdir(), 'quorum-harness-fs') + '/';
export const cacheDirectory = resolve(tmpdir(), 'quorum-harness-cache') + '/';

const stripScheme = (uri: string) => uri.replace(/^file:\/\//, '');

export async function readAsStringAsync(
  uri: string,
  opts?: { encoding?: string }
): Promise<string> {
  const encoding = opts?.encoding === 'base64' ? 'base64' : 'utf8';
  return fs.readFile(stripScheme(uri), encoding as BufferEncoding);
}

export async function writeAsStringAsync(
  uri: string,
  contents: string,
  opts?: { encoding?: string }
): Promise<void> {
  const encoding = opts?.encoding === 'base64' ? 'base64' : 'utf8';
  await fs.writeFile(stripScheme(uri), contents, encoding as BufferEncoding);
}

export async function deleteAsync(
  uri: string,
  opts?: { idempotent?: boolean }
): Promise<void> {
  await fs.rm(stripScheme(uri), { force: opts?.idempotent ?? true, recursive: true });
}

export async function getInfoAsync(
  uri: string
): Promise<{ exists: boolean; uri: string; size?: number }> {
  try {
    const st = await fs.stat(stripScheme(uri));
    return { exists: true, uri, size: st.size };
  } catch {
    return { exists: false, uri };
  }
}

export async function makeDirectoryAsync(
  uri: string,
  opts?: { intermediates?: boolean }
): Promise<void> {
  await fs.mkdir(stripScheme(uri), { recursive: opts?.intermediates ?? true });
}

/**
 * Network download is deliberately NOT implemented. A scenario reaching it is
 * almost certainly pulling remote media, which is outside what this harness
 * covers — fail loudly rather than silently produce an empty file.
 */
export async function downloadAsync(): Promise<never> {
  throw new Error(
    '[harness] expo-file-system downloadAsync is not shimmed — remote media is ' +
      'outside the harness scope. Add it to dev/harness/filesystem-shim.ts if a ' +
      'scenario genuinely needs it.'
  );
}

export default {
  documentDirectory,
  cacheDirectory,
  readAsStringAsync,
  writeAsStringAsync,
  deleteAsync,
  getInfoAsync,
  makeDirectoryAsync,
  downloadAsync,
};
