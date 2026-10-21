/**
 * The perf probe measures JS-thread stalls, labels them, and stays off unless
 * turned on.
 *
 * ## Why it exists
 *
 * The performance work needs numbers on a release build: how often the JS
 * thread is blocked, for how long, and by what. The probe samples event-loop
 * lag, records stalls over 100 ms with the `perfMark` labels set during them,
 * and logs a summary every 30 s.
 *
 * ## What is asserted
 *
 * - A stall is recorded as a long task with the labels marked during it;
 *   ordinary ticks are not.
 * - Marks are ignored while the probe is off, and it is off by default.
 * - Turning it on persists, and it reports through the logger.
 */
import { logger } from '@quilibrium/quorum-shared';
import {
  getPerfProbeSnapshot,
  isPerfProbeEnabled,
  perfMark,
  setPerfProbeEnabled,
  startPerfProbe,
  stopPerfProbe,
} from '@/services/observability/perfProbe';

jest.mock('@quilibrium/quorum-shared', () => ({ logger: { warn: jest.fn(), log: jest.fn() } }));

beforeEach(() => {
  jest.useFakeTimers();
  (logger.warn as jest.Mock).mockClear();
});
afterEach(() => {
  stopPerfProbe();
  jest.useRealTimers();
});

/** Block the "thread" for `ms`: the clock moves on but no timer runs. */
function stall(ms: number) {
  jest.setSystemTime(Date.now() + ms);
}

it('is off by default', () => {
  expect(isPerfProbeEnabled()).toBe(false);
});

it('records a stall as a long task, with the labels marked during it', () => {
  startPerfProbe();
  jest.advanceTimersByTime(500);
  expect(getPerfProbeSnapshot().longTasks).toEqual([]);

  perfMark('ws-drain');
  stall(400);
  jest.advanceTimersByTime(100);

  const { longTasks, lagMax } = getPerfProbeSnapshot();
  expect(longTasks).toHaveLength(1);
  expect(longTasks[0].labels).toEqual(['ws-drain']);
  expect(longTasks[0].ms).toBeGreaterThanOrEqual(390);
  expect(lagMax).toBeGreaterThanOrEqual(390);
});

it('ignores marks while off', () => {
  perfMark('ignored');
  startPerfProbe();
  stall(300);
  jest.advanceTimersByTime(100);
  expect(getPerfProbeSnapshot().longTasks[0].labels).toEqual([]);
});

it('persists being turned on, and reports every 30 s', () => {
  setPerfProbeEnabled(true);
  expect(isPerfProbeEnabled()).toBe(true);

  jest.advanceTimersByTime(30_000);
  const lines = (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0]));
  expect(lines.some((l) => l.startsWith('[perf] 30s:'))).toBe(true);

  setPerfProbeEnabled(false);
  expect(isPerfProbeEnabled()).toBe(false);
});
