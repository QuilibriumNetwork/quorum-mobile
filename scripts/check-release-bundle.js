#!/usr/bin/env node
/**
 * Answers "is the config-sync failure instrument actually PRESENT in the build
 * users install", which no jest test can see.
 *
 * Usage:
 *   yarn check:release-bundle             export a production bundle, then check it
 *   node scripts/check-release-bundle.js --bundle <path.hbc>    check one you already have
 *   node scripts/check-release-bundle.js --keep   leave the export in place afterwards
 *
 * ## What this catches that the suite cannot
 *
 * Jest runs the source through babel in development mode. The shipped artifact
 * is something else entirely: Metro inlines `__DEV__` as `false`, drops the
 * branches that become unreachable, minifies what is left, and compiles it to
 * Hermes bytecode. Code can be present in the repo, exercised by a green test,
 * and absent from the file on the phone. That gap is invisible from inside the
 * suite by construction.
 *
 * It matters here specifically because the whole point of the publish record is
 * to be the surviving signal in a release build. An instrument that gets
 * stripped from exactly the build it was written for would be worse than none,
 * because the tests would keep saying it works.
 *
 * ## What it does NOT prove
 *
 * That the code RUNS, or that the status line renders. Presence is necessary,
 * not sufficient. This kills one specific failure class — the instrument being
 * compiled away — and leaves the runtime question to a device.
 *
 * ## Why grepping bytecode is legitimate
 *
 * Hermes keeps string literals in a plain string table; the minifier renames
 * identifiers but has no reason to touch literal contents. So a literal that
 * survives into the bundle is findable as raw bytes, and its absence means the
 * code that held it was dropped. The NEGATIVE CONTROL below is what keeps that
 * argument honest: a string nobody wrote must come back absent, or the search
 * is matching everything and every PRESENT result is meaningless.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exportBundle, findBundles } = require('./lib/metro-export');

/**
 * Literals that must survive. Each is the storage key or the user-facing copy
 * of one piece of the instrument, chosen because it is unique enough that a
 * match cannot be coincidence.
 *
 * Keep these in step with their sources. A renamed string failing here is the
 * check doing its job on the wrong question — fix the list, not the code.
 */
const MUST_BE_PRESENT = [
  // services/config/lastPublish.ts — the record's storage key and its store id.
  { needle: 'quorum:sync:lastPublish', source: 'services/config/lastPublish.ts (record key)' },
  { needle: 'quorum-config', source: 'services/config/lastPublish.ts (store id)' },
  // components/SyncStatusLine.tsx — one string per fault the user can be shown.
  {
    needle: 'Sync is failing: your settings could not be published',
    source: 'components/SyncStatusLine.tsx (rejected)',
  },
  {
    needle: 'Sync is failing: the request timed out',
    source: 'components/SyncStatusLine.tsx (timeout)',
  },
  {
    needle: 'Waiting for Spaces to finish syncing',
    source: 'components/SyncStatusLine.tsx (held)',
  },
  {
    needle: 'no key is available on this device',
    source: 'components/SyncStatusLine.tsx (no-keys)',
  },
];

/**
 * Absent, always. Without it a search that matched everything would report the
 * whole list green and mean nothing at all.
 */
const NEGATIVE_CONTROL = 'QuorumReleaseBundleCheckNegativeControlString';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function main() {
  let bundlePath = value('--bundle');
  let outDir;

  if (!bundlePath) {
    outDir = path.join(os.tmpdir(), 'quorum-release-bundle-check');
    fs.rmSync(outDir, { recursive: true, force: true });
    console.log('[release-bundle] exporting a production bundle');
    console.log('[release-bundle] this takes a few minutes.\n');
    exportBundle({ outDir, platform: 'android' });
    // Android is the only platform exported, so there is exactly one bundle.
    bundlePath = findBundles(outDir)[0]?.file;
    if (!bundlePath) {
      console.error(`[release-bundle] FAIL: the export produced no bundle under ${outDir}`);
      process.exit(1);
    }
  }

  if (!fs.existsSync(bundlePath)) {
    console.error(`[release-bundle] FAIL: no bundle at ${bundlePath}`);
    process.exit(1);
  }

  const bytes = fs.readFileSync(bundlePath);
  // latin1 maps every byte to one character, so a byte-for-byte search of a
  // binary file is exact. utf8 would silently mangle the non-text regions.
  const haystack = bytes.toString('latin1');
  const contains = (needle) => haystack.includes(needle);

  console.log(`\n[release-bundle] bundle: ${path.basename(bundlePath)}`);
  console.log(`[release-bundle] size:   ${(bytes.length / 1e6).toFixed(1)} MB\n`);

  let failed = 0;

  // The control runs FIRST. If it fails, nothing below is evidence of anything,
  // and reporting the rest as passes would be actively misleading.
  if (contains(NEGATIVE_CONTROL)) {
    console.error('[release-bundle] FAIL (negative control): a string nobody wrote was found.');
    console.error('[release-bundle] the search is matching everything; ignore every result below.');
    process.exit(1);
  }
  console.log('  ok  negative control absent — the search can return a negative');

  for (const { needle, source } of MUST_BE_PRESENT) {
    if (contains(needle)) {
      console.log(`  ok  ${source}`);
    } else {
      failed += 1;
      console.error(`  FAIL ${source}`);
      console.error(`       missing from the production bundle: ${JSON.stringify(needle)}`);
    }
  }

  if (outDir && !flag('--keep')) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  console.log('');
  if (failed) {
    console.error(
      `[release-bundle] ${failed} of ${MUST_BE_PRESENT.length} missing. The instrument is ` +
        'not fully present in the build users install.'
    );
    process.exit(1);
  }
  console.log(
    `[release-bundle] all ${MUST_BE_PRESENT.length} present. The record and every failure ` +
      'string survive minification into the shipped bundle.'
  );
}

main();
