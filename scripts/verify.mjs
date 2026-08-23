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

// Must match the orchestrator's own fast tier for this repo (quorum-desktop's
// scripts/verify/steps.mjs, tier === 'fast', repoName === 'mobile'). The
// fallback exists so a lone contributor gets a useful answer, and a fallback
// that silently ran a subset while claiming to run "the fast tier" would be
// worse than no fallback at all — see the PASS (PARTIAL) message below, which
// names exactly these steps so it can never claim more than it did.
// mobile has no test:run script — it runs Jest directly, in CI mode.
const FAST_TIER = [
  { label: 'lint', args: ['lint'] },
  { label: 'unit', args: ['test', '--ci'] },
];

function runOne(args) {
  return new Promise((resolveRun) => {
    const child = spawn('yarn', args, { cwd: REPO, shell: true, stdio: 'inherit' });
    // Mirrors runner.mjs's once(): a spawn-level failure (ENOENT, EACCES)
    // emits 'error' instead of ever reaching 'exit', and without this
    // listener that surfaces as an uncaught exception rather than a FAIL.
    child.on('error', (err) => {
      console.error(`[verify] failed to launch yarn ${args.join(' ')}: ${err.message}`);
      resolveRun(1);
    });
    child.on('exit', (code) => resolveRun(code ?? 1));
  });
}

async function runFastTier() {
  for (const step of FAST_TIER) {
    console.log(`\n[verify] ── ${step.label} ──`);
    const code = await runOne(step.args);
    // Must check the exit code before printing anything that reads as good
    // news: a failed step, unconditionally continued past, would report PASS
    // while a step in the middle of the tier died non-zero.
    if (code !== 0) {
      console.log('');
      console.log(`  VERDICT  FAIL — single-repo fast tier failed at '${step.label}' (exit ${code})`);
      process.exit(code);
    }
  }
  console.log('');
  // --strict must also be honored here, not just forwarded to the
  // orchestrator branch above: its whole job is "a reduced run stops being
  // an answer and becomes a failure", and a single-repo fallback IS a
  // reduced run — dropping the flag here would let a caller who explicitly
  // asked for strict gating get ordinary lenient behavior with no signal
  // that the flag did nothing.
  const strict = passthrough.includes('--strict');
  if (strict) {
    console.log('  VERDICT  FAIL (--strict) — tests passed, but a single-repo fallback is a reduced run');
    console.log('           --strict rejects reduced runs; the orchestrator was not found to run the full net.');
    process.exit(1);
  } else {
    console.log(
      `  VERDICT  PASS (PARTIAL) — orchestrator not found, single-repo fast tier only (${FAST_TIER.map((s) => s.label).join(', ')})`
    );
    console.log('           ⚠ This does NOT clear a change that touches shared or the wire.');
    process.exit(0);
  }
}

if (existsSync(ORCHESTRATOR)) {
  const child = spawn('node', [ORCHESTRATOR, ...passthrough], {
    cwd: resolve(REPO, '../quorum-desktop'),
    shell: true,
    stdio: 'inherit',
  });
  // Without this, a spawn-level failure (the orchestrator path existing but
  // being unlaunchable — permissions, a broken node install) crashes with an
  // uncaught exception instead of a readable FAIL.
  child.on('error', (err) => {
    console.error(`[verify] failed to launch the orchestrator: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  console.log(
    `[verify] quorum-desktop not found — running this repo's fast tier only (${FAST_TIER.map((s) => s.label).join(', ')}).`
  );
  runFastTier();
}
