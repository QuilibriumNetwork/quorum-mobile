/**
 * Perf probe: how long the JS thread is blocked, by what, and how big the heap
 * is. Off by default; nothing runs unless it's turned on.
 *
 * - A timer that should fire every `SAMPLE_MS` measures how late it fires.
 *   Lateness is time the thread was busy; over `LONG_TASK_MS` it's logged as a
 *   long task, labelled with the `perfMark` calls made during it.
 * - Every `REPORT_MS` it logs a line: long tasks (count, worst, labels), lag
 *   percentiles, and the Hermes heap size.
 *
 * Release-safe and meant for release builds: debug builds evaluate and render
 * differently enough that their numbers mislead. Turn it on with
 * `EXPO_PUBLIC_PERF_PROBE=1` at build time, or from the developer panel (dev
 * builds), which persists across launches. Output goes through the logger with
 * a `[perf]` prefix (logcat / Console.app).
 *
 * Mark heavy work with `perfMark('label')` where it starts; it costs a Set
 * insert when the probe is on and a flag check when it's off.
 */
import { createMMKV } from 'react-native-mmkv';
import { logger } from '@quilibrium/quorum-shared';

const SAMPLE_MS = 100;
const LONG_TASK_MS = 100;
const REPORT_MS = 30_000;

const flagStore = createMMKV({ id: 'quorum-perf-probe' });
const FLAG_KEY = 'enabled';

interface LongTask {
  ms: number;
  labels: string[];
}

let running = false;
let sampleTimer: ReturnType<typeof setTimeout> | undefined;
let reportTimer: ReturnType<typeof setInterval> | undefined;
let lastTick = 0;
let labelsSinceTick = new Set<string>();
let longTasks: LongTask[] = [];
let lags: number[] = [];

export function isPerfProbeEnabled(): boolean {
  return process.env.EXPO_PUBLIC_PERF_PROBE === '1' || flagStore.getBoolean(FLAG_KEY) === true;
}

/** Turn the probe on or off, now and for later launches. */
export function setPerfProbeEnabled(enabled: boolean): void {
  flagStore.set(FLAG_KEY, enabled);
  if (enabled) startPerfProbe();
  else stopPerfProbe();
}

/** Note that labelled work is running; a long task during it carries the label. */
export function perfMark(label: string): void {
  if (running) labelsSinceTick.add(label);
}

function sample(): void {
  const now = Date.now();
  const lag = Math.max(0, now - lastTick - SAMPLE_MS);
  lags.push(lag);
  if (lag > LONG_TASK_MS) longTasks.push({ ms: lag, labels: Array.from(labelsSinceTick) });
  labelsSinceTick = new Set();
  lastTick = now;
  sampleTimer = setTimeout(sample, SAMPLE_MS);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function heapMegabytes(): number | undefined {
  const stats = (
    globalThis as { HermesInternal?: { getInstrumentedStats?: () => Record<string, number> } }
  ).HermesInternal?.getInstrumentedStats?.();
  const bytes = stats?.js_heapSize ?? stats?.js_allocatedBytes;
  return typeof bytes === 'number' ? Math.round((bytes / (1024 * 1024)) * 10) / 10 : undefined;
}

/** What has been measured since the last report. */
export function getPerfProbeSnapshot(): {
  longTasks: LongTask[];
  lagP50: number;
  lagP95: number;
  lagMax: number;
  heapMb?: number;
} {
  const sorted = [...lags].sort((a, b) => a - b);
  return {
    longTasks: [...longTasks],
    lagP50: percentile(sorted, 50),
    lagP95: percentile(sorted, 95),
    lagMax: sorted[sorted.length - 1] ?? 0,
    heapMb: heapMegabytes(),
  };
}

function report(): void {
  const snap = getPerfProbeSnapshot();
  const labelCounts = new Map<string, number>();
  for (const task of snap.longTasks) {
    for (const label of task.labels.length ? task.labels : ['(unlabelled)']) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
  }
  const worst = snap.longTasks.reduce((max, t) => Math.max(max, t.ms), 0);
  const labels = Array.from(labelCounts, ([label, n]) => `${label}×${n}`).join(', ');
  logger.warn(
    `[perf] ${REPORT_MS / 1000}s: ${snap.longTasks.length} long tasks` +
      (snap.longTasks.length ? ` (worst ${worst}ms; ${labels})` : '') +
      `; lag p50 ${snap.lagP50}ms p95 ${snap.lagP95}ms max ${snap.lagMax}ms` +
      (snap.heapMb !== undefined ? `; heap ${snap.heapMb}MB` : ''),
  );
  longTasks = [];
  lags = [];
}

export function startPerfProbe(): void {
  if (running) return;
  running = true;
  lastTick = Date.now();
  sampleTimer = setTimeout(sample, SAMPLE_MS);
  reportTimer = setInterval(report, REPORT_MS);
  logger.warn('[perf] probe on');
}

export function stopPerfProbe(): void {
  if (!running) return;
  running = false;
  if (sampleTimer !== undefined) clearTimeout(sampleTimer);
  if (reportTimer !== undefined) clearInterval(reportTimer);
  sampleTimer = reportTimer = undefined;
  labelsSinceTick = new Set();
  longTasks = [];
  lags = [];
}
