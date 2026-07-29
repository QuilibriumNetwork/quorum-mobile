/**
 * JSONL line formatting + adb command building for the dev-only DM test
 * burst tool (T2). Pure functions only — createBurstRecorder's actual file
 * I/O (expo-file-system) needs a device/native module and isn't exercised
 * here.
 */
import {
  formatBurstLine,
  buildAdbPullCommand,
  DM_BURST_BASE_APPLICATION_ID,
} from '../services/dev/dmBurstRecorder';

describe('formatBurstLine', () => {
  it('serializes a message record as one JSON line with a trailing newline', () => {
    const line = formatBurstLine({
      type: 'message',
      seq: 1,
      text: 'V 1',
      messageId: 'abc123',
      nonce: 'nonce-1',
      tsQueuedIso: '2026-07-29T12:00:00.000Z',
      tsAfterSendMs: 42,
    });

    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1); // exactly one newline, at the end
    expect(JSON.parse(line.trimEnd())).toEqual({
      type: 'message',
      seq: 1,
      text: 'V 1',
      messageId: 'abc123',
      nonce: 'nonce-1',
      tsQueuedIso: '2026-07-29T12:00:00.000Z',
      tsAfterSendMs: 42,
    });
  });

  it('serializes a failed-send record with an error field and no messageId/nonce', () => {
    const line = formatBurstLine({
      type: 'message',
      seq: 3,
      text: 'V 3',
      tsQueuedIso: '2026-07-29T12:00:05.000Z',
      tsAfterSendMs: 8,
      error: 'No target devices found',
    });

    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.error).toBe('No target devices found');
    expect(parsed.messageId).toBeUndefined();
  });

  it('serializes a summary record', () => {
    const line = formatBurstLine({
      type: 'summary',
      prefix: 'V',
      requested: 20,
      sent: 17,
      intervalMs: 2000,
      startedAtIso: '2026-07-29T12:00:00.000Z',
      wallTimeMs: 34000,
      cancelled: false,
    });

    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.type).toBe('summary');
    expect(parsed.sent).toBe(17);
    expect(parsed.cancelled).toBe(false);
  });
});

describe('buildAdbPullCommand', () => {
  it('defaults to the unsuffixed base applicationId', () => {
    const cmd = buildAdbPullCommand('run-123.jsonl');
    expect(cmd).toBe(
      `adb exec-out run-as ${DM_BURST_BASE_APPLICATION_ID} cat files/dm-burst/run-123.jsonl > run-123.jsonl`
    );
  });

  it('accepts an explicit applicationId (e.g. a .debug side-by-side build)', () => {
    const cmd = buildAdbPullCommand('run-123.jsonl', 'com.quilibrium.quorummobile.debug');
    expect(cmd).toContain('run-as com.quilibrium.quorummobile.debug cat files/dm-burst/run-123.jsonl');
  });
});
