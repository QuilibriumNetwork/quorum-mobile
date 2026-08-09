// Orchestrator for the two-bot DM measurement.
//
//   yarn harness:dm
//
// Starts the dm-two-bot scenario TWICE, as two separate OS processes (one per
// bot — see bot.ts for why they cannot share one), pairs them through a run
// directory, then reads both result files and reports loss in each direction.
//
// The loss verdict lives here rather than in the scenario because neither bot
// can compute it alone: each knows what it sent and what it received, and loss
// needs one side's sends matched against the other side's arrivals.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
// Must match rendezvous.ts. Kept as a literal because that file is TypeScript
// and this orchestrator is plain node — if you change the layout there, change
// it here too.
const RENDEZVOUS_ROOT = resolve(HERE, '.state', 'rendezvous');

const runId = `run-${Date.now()}`;

// Old run directories are pruned here, not in the scenario: the scenario cannot
// know whether a sibling directory belongs to a live peer or a dead one.
if (existsSync(RENDEZVOUS_ROOT)) {
  for (const entry of readdirSync(RENDEZVOUS_ROOT)) {
    if (entry !== runId) rmSync(resolve(RENDEZVOUS_ROOT, entry), { recursive: true, force: true });
  }
}

// Which two-bot scenario to run. Defaults to the DM loss measurement this
// runner was written for; `HARNESS_SCENARIO=qns-claim-two-bot` runs the
// identity-claim round trip instead. Both need the same thing from here — two
// processes, paired by run id — so they share the launcher rather than each
// growing a near-identical copy of it.
// Taken from argv rather than an env var so the npm script needs no cross-env
// (which this repo does not depend on, and adding a dependency to choose a
// filename would be a poor trade). `HARNESS_SCENARIO` still works for anyone
// invoking node directly.
const SCENARIO = process.argv[2] ?? process.env.HARNESS_SCENARIO ?? 'dm-two-bot';

function startRole(role) {
  const child = spawn(
    'npx',
    ['jest', '--config', 'jest.harness.config.js', SCENARIO],
    {
      cwd: REPO,
      env: { ...process.env, HARNESS_ROLE: role, HARNESS_RUN_ID: runId },
      shell: true,
    }
  );
  // Both children write to the same terminal, so every line is tagged. Without
  // this an interleaved failure is very hard to attribute to a side.
  const tag = (stream, prefix) => {
    let buffered = '';
    stream.on('data', (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) console.log(`[${prefix}] ${line}`);
    });
  };
  tag(child.stdout, role);
  tag(child.stderr, role);

  return new Promise((res) => child.on('close', (code) => res({ role, code })));
}

console.log(`[dm] run ${runId} — starting both bots`);
const outcomes = await Promise.all([startRole('a'), startRole('b')]);

for (const { role, code } of outcomes) {
  if (code !== 0) console.log(`[dm] role ${role} exited ${code}`);
}

// Only the DM scenario publishes the per-message result files the loss verdict
// below is computed from. Every other scenario states its own verdict through
// jest assertions, so for those the child exit codes ARE the result — running
// the DM arithmetic over absent files would report "nothing was sent" and fail
// a run that actually passed.
if (SCENARIO !== 'dm-two-bot') {
  const failed = outcomes.filter((o) => o.code !== 0);
  if (failed.length) {
    console.error(
      `[${SCENARIO}] FAIL — role(s) ${failed.map((f) => f.role).join(', ')} exited non-zero. ` +
        `Read that role's output above.`
    );
    process.exit(1);
  }
  console.log(`[${SCENARIO}] both roles passed.`);
  process.exit(0);
}

const readResult = (role) => {
  const p = resolve(RENDEZVOUS_ROOT, runId, `${role}.result.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

const a = readResult('a');
const b = readResult('b');

if (!a || !b) {
  console.error(
    `[dm] FAIL — missing results (a=${!!a} b=${!!b}). A bot crashed before ` +
      `publishing; read that role's output above. No loss figure is reported ` +
      `because a partial run cannot produce an honest one.`
  );
  process.exit(1);
}

// A message counts as delivered when the RECEIVER recorded its number. The
// receiver's set is deduped, so relay redelivery cannot inflate it.
function direction(from, to, label) {
  const sent = from.sent.length;
  const got = to.received.filter((n) => from.sent.includes(n)).length;
  const missing = from.sent.filter((n) => !to.received.includes(n));
  const pct = sent === 0 ? 0 : ((sent - got) / sent) * 100;
  console.log(
    `[dm] ${label}: sent=${sent} arrived=${got} loss=${pct.toFixed(1)}%` +
      (missing.length ? `  missing=[${missing.join(',')}]` : '')
  );
  return { sent, got, missing };
}

console.log('');
console.log(`[dm] run ${runId}`);
const ab = direction(a, b, 'A→B');
const ba = direction(b, a, 'B→A');

const lost = ab.missing.length + ba.missing.length;
const total = ab.sent + ba.sent;
console.log(`[dm] total: ${total - lost}/${total} delivered`);

if (total === 0) {
  console.error('[dm] FAIL — nothing was sent; this measured nothing.');
  process.exit(1);
}
if (lost > 0) {
  console.error(`[dm] LOSS DETECTED — ${lost}/${total} messages did not arrive.`);
  process.exit(1);
}
console.log('[dm] no loss.');
