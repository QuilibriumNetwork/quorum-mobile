#!/usr/bin/env node
/**
 * Answers one question: does the app still bundle for production?
 *
 * Usage:
 *   yarn check:bundle                    android only (the fast default)
 *   yarn check:bundle --platform ios     iOS instead
 *   yarn check:bundle --platform all     every platform, including web
 *   yarn check:bundle --keep             leave the export on disk afterwards
 *
 * ## Why this is not covered by tsc or jest
 *
 * `tsc --noEmit` type-checks; it never resolves a module the way Metro does, so
 * an import pointing at a path that does not exist can pass typecheck through a
 * stale or hand-written .d.ts and still fail to bundle. Jest runs the source
 * through babel in development mode with its own moduleNameMapper, which is a
 * different resolver again. Conversely Metro strips types and discards them, so
 * a red tsc and a green bundle are both routinely true at the same time. The
 * three tools genuinely disagree, and only this one speaks for the release
 * artifact.
 *
 * ## What it does NOT prove
 *
 * That the app RUNS. A bundle that builds can still crash on the first frame.
 * This rules out one class of failure — the build breaking — and leaves the
 * runtime question to a device.
 *
 * It also says nothing about the native layer. `ios/` and `android/` are
 * compiled by Xcode and Gradle, which this never invokes. If you changed a
 * native dependency or native config, a green result here is not the signal you
 * want.
 *
 * ## Platform default
 *
 * android, because the dev loop here is Android-only and doubling the wall
 * clock on every run would stop it being used. That leaves a real gap: an
 * import that only resolves on one platform is invisible until you export the
 * other. Pass `--platform ios` when touching anything platform-conditional.
 * Web is excluded from the default for a different reason — this app is not
 * shipped as a web build, so a web failure would be noise, not a regression.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exportBundle, findBundles } = require('./lib/metro-export');

const VALID_PLATFORMS = ['android', 'ios', 'web', 'all'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function main() {
  const platform = value('--platform') ?? value('-p') ?? 'android';
  if (!VALID_PLATFORMS.includes(platform)) {
    console.error(
      `[check-bundle] "${platform}" is not a platform. Expected one of: ${VALID_PLATFORMS.join(', ')}`
    );
    process.exit(1);
  }

  const outDir = path.join(os.tmpdir(), 'quorum-bundle-check');
  fs.rmSync(outDir, { recursive: true, force: true });

  // The absolute temp path runs through the user profile directory, which
  // identifies the machine and its operator. Console output from this script
  // ends up pasted into issues and PR threads, so keep it out of the log and
  // print it only behind --keep, where the caller explicitly needs to find it.
  console.log(`[check-bundle] exporting a production bundle for: ${platform}`);
  console.log('[check-bundle] this takes a few minutes.\n');

  const started = Date.now();
  try {
    exportBundle({ outDir, platform });
  } catch (err) {
    // execFileSync already streamed Metro's own diagnostics to stderr, and they
    // are far more useful than anything reconstructable from the exit status.
    // Adding a stack trace here would only bury them.
    console.error('\n[check-bundle] FAIL: the production export did not complete.');
    console.error('[check-bundle] the bundler error is above; the app does not build for release.');
    process.exit(err.status ?? 1);
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);

  const bundles = findBundles(outDir);
  if (bundles.length === 0) {
    // A zero-exit export that emitted nothing means the CLI changed its output
    // layout, not that the app is fine. Failing here keeps a silent green from
    // being worse than no check at all.
    console.error(`\n[check-bundle] FAIL: the export reported success but produced no bundle.`);
    console.error('[check-bundle] findBundles() may need updating for a new Expo output layout.');
    process.exit(1);
  }

  console.log(`\n[check-bundle] built in ${elapsed}s:`);
  for (const { platform: p, file, bytes } of bundles) {
    console.log(`  ok  ${p.padEnd(8)} ${path.basename(file)}  (${(bytes / 1e6).toFixed(1)} MB)`);
  }

  if (flag('--keep')) {
    console.log(`\n[check-bundle] kept at: ${outDir}`);
  } else {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  console.log('\n[check-bundle] the app bundles for production. This does not mean it runs.');
}

main();
