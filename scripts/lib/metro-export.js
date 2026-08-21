/**
 * Shared Metro/Expo production-export plumbing for the `check:*` scripts.
 *
 * Not runnable on its own. It exists so the Windows spawn workaround below has
 * exactly one home: it is subtle, it fails in a way that looks nothing like its
 * cause, and a second copy would drift out of step with the first.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Run `expo export` for one platform, writing the bundle under `outDir`.
 *
 * @param {object} opts
 * @param {string} opts.outDir     destination directory, created by the CLI
 * @param {string} opts.platform   android | ios | web | all
 */
function exportBundle({ outDir, platform }) {
  // Run the CLI's JS entry point under this node, rather than going through
  // `npx`. On Windows `npx` is a .cmd, and since the CVE-2024-27980 fix Node
  // refuses to spawn a .cmd without a shell — `execFileSync('npx.cmd', …)`
  // fails with EINVAL before Metro is ever reached. Going through a shell
  // instead would work but reintroduces quoting bugs on any path containing a
  // space, which a temp directory under a user profile very often does.
  //
  // Deliberately NOT --clear: the Metro cache is what makes a re-run bearable,
  // and a stale cache would have to survive a source change to mislead us,
  // which Metro's own invalidation already rules out.
  execFileSync(
    process.execPath,
    [
      require.resolve('@expo/cli/build/bin/cli'),
      'export',
      '--platform',
      platform,
      '--output-dir',
      outDir,
    ],
    { stdio: 'inherit' }
  );
}

/**
 * Locate every bundle an export produced.
 *
 * @param {string} dir  an --output-dir previously passed to exportBundle
 * @returns {Array<{ platform: string, file: string, bytes: number }>}
 */
function findBundles(dir) {
  const jsRoot = path.join(dir, '_expo', 'static', 'js');
  if (!fs.existsSync(jsRoot)) return [];

  const found = [];
  for (const platform of fs.readdirSync(jsRoot)) {
    const platformDir = path.join(jsRoot, platform);
    if (!fs.statSync(platformDir).isDirectory()) continue;
    for (const file of fs.readdirSync(platformDir)) {
      // .hbc is Hermes bytecode, .js the plain bundle. Either is the shipped
      // artifact depending on the engine; both carry the string table.
      if (file.endsWith('.hbc') || file.endsWith('.js')) {
        const full = path.join(platformDir, file);
        found.push({ platform, file: full, bytes: fs.statSync(full).size });
      }
    }
  }
  return found;
}

module.exports = { exportBundle, findBundles };
