// File-based pairing for two bots that live in SEPARATE PROCESSES.
//
// Two bots cannot share a process (see bot.ts — mobile's storage is module
// singletons, and lazy requires defeat jest's module isolation), so the pair is
// two jest runs coordinated through disk. That is enough: the only things the
// two sides must agree on are each other's addresses and when to start.
//
// Everything lives under a per-run directory keyed by HARNESS_RUN_ID, so a
// crashed run can never be mistaken for a live peer — the failure mode of a
// fixed path is a bot pairing with yesterday's file and reporting nonsense.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '.state', 'rendezvous');

export type Role = 'a' | 'b';

export const peerOf = (role: Role): Role => (role === 'a' ? 'b' : 'a');

function runDir(): string {
  const id = process.env.HARNESS_RUN_ID;
  if (!id) {
    throw new Error(
      '[harness] HARNESS_RUN_ID is not set. The two-bot scenario is started by ' +
        'dev/harness/run-two-bots.mjs, which sets it and pairs the two processes. ' +
        'Run `yarn harness:dm` rather than invoking the scenario directly.'
    );
  }
  return resolve(ROOT, id);
}

const filePath = (role: Role, kind: string) => resolve(runDir(), `${role}.${kind}.json`);

export function publish(role: Role, kind: string, data: unknown): void {
  mkdirSync(runDir(), { recursive: true });
  // Write-then-rename would be tidier, but a partially written file is already
  // handled: readers JSON.parse inside try/catch and simply wait for the next
  // poll, so a torn read costs one 250ms tick rather than a bad pairing.
  writeFileSync(filePath(role, kind), JSON.stringify(data, null, 2), 'utf8');
}

export function read<T>(role: Role, kind: string): T | null {
  const p = filePath(role, kind);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Poll until the peer publishes `kind`, or fail with a diagnosable message. */
export async function awaitPeer<T>(
  role: Role,
  kind: string,
  timeoutMs = 120_000
): Promise<T> {
  const peer = peerOf(role);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read<T>(peer, kind);
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `[harness] role ${role} waited ${timeoutMs}ms for peer ${peer}'s "${kind}" and it never ` +
      `appeared. The peer process most likely failed to start or crashed before ` +
      `publishing — check the other jest run's output, not this one.`
  );
}

/** Sleep until an absolute epoch ms, so both sides begin on the same instant. */
export async function waitUntil(epochMs: number): Promise<void> {
  const delay = epochMs - Date.now();
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
}

/** Drop rendezvous directories from previous runs. Called by the orchestrator. */
export function pruneOldRuns(keepId: string): void {
  if (!existsSync(ROOT)) return;
  for (const entry of readdirSync(ROOT)) {
    if (entry !== keepId) rmSync(resolve(ROOT, entry), { recursive: true, force: true });
  }
}
