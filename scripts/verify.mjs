#!/usr/bin/env node
/**
 * Delegate to the shared orchestrator in quorum-desktop.
 *
 * If that checkout is absent this does NOT fail. Someone who cloned one repo
 * still gets a useful answer from their own fast tier — they simply cannot get
 * a bare PASS, because a single-repo run cannot clear a change that crosses the
 * wire or rides on shared. Same rule as a missing sibling in the orchestrator.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// The override exists so the fallback path below can be tested by pointing at a
// path that does not exist. Renaming a real checkout to prove an error message
// leaves a repo renamed if the run dies halfway.
const ORCHESTRATOR =
  process.env.VERIFY_ORCHESTRATOR ??
  resolve(REPO, '../quorum-desktop/scripts/verify/index.mjs');
const passthrough = process.argv.slice(2);

if (existsSync(ORCHESTRATOR)) {
  spawn('node', [ORCHESTRATOR, ...passthrough], {
    cwd: resolve(REPO, '../quorum-desktop'),
    shell: true,
    stdio: 'inherit',
  }).on('exit', (code) => process.exit(code ?? 1));
} else {
  console.log('[verify] quorum-desktop not found — running this repo\'s fast tier only.');
  // mobile has no test:run script — it runs Jest directly, in CI mode.
  const child = spawn('yarn', ['test', '--ci'], { cwd: REPO, shell: true, stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log('');
    // Must check the exit code before printing anything that reads as good
    // news: a failed fast tier run through this same path, unconditionally,
    // would report PASS while the child died non-zero.
    //
    // --strict must also be honored here, not just forwarded to the
    // orchestrator branch above: its whole job is "a reduced run stops being
    // an answer and becomes a failure", and a single-repo fallback IS a
    // reduced run — dropping the flag here would let a caller who explicitly
    // asked for strict gating get ordinary lenient behavior with no signal
    // that the flag did nothing.
    const strict = passthrough.includes('--strict');
    if (code !== 0) {
      console.log(`  VERDICT  FAIL — single-repo fast tier failed (exit ${code ?? 1})`);
      process.exit(code ?? 1);
    } else if (strict) {
      console.log('  VERDICT  FAIL (--strict) — tests passed, but a single-repo fallback is a reduced run');
      console.log('           --strict rejects reduced runs; the orchestrator was not found to run the full net.');
      process.exit(1);
    } else {
      console.log('  VERDICT  PASS (PARTIAL) — orchestrator not found, single-repo fast tier only');
      console.log('           ⚠ This does NOT clear a change that touches shared or the wire.');
      process.exit(0);
    }
  });
}
