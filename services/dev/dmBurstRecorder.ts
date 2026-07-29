/**
 * dmBurstRecorder — the send-side instrument for the dev-only DM test burst
 * tool (T2 of the transport-debugging tool suite, see the desktop repo's
 * .agents/tasks/2026-07-29-transport-debug-workflow-and-tooling.md §2).
 *
 * Writes one JSONL line per burst message INCREMENTALLY (the app may be
 * killed mid-run) to a file under the app's document directory, plus a final
 * summary line. Pulled off-device with adb (see buildAdbPullCommand) and
 * joined against the receiver-side record by timestamp + content.
 */

import { Directory, File, Paths } from 'expo-file-system';

const BURST_DIR_NAME = 'dm-burst';

/**
 * Base Android applicationId (app.json). A debug build compiled with
 * `-PsideBySide=true` (android/app/build.gradle) gets a `.debug` suffix so it
 * can install alongside a release build — pass the suffixed id explicitly to
 * buildAdbPullCommand when pulling from that kind of build.
 */
export const DM_BURST_BASE_APPLICATION_ID = 'com.quilibrium.quorummobile';

export interface BurstMessageRecord {
  seq: number;
  text: string;
  /** Absent when the send threw before a message/nonce was minted. */
  messageId?: string;
  nonce?: string;
  tsQueuedIso: string;
  /** Wall time (ms) from issuing the send to the send mutation settling. */
  tsAfterSendMs: number;
  /** Present only when this message's send threw. */
  error?: string;
}

export interface BurstSummaryRecord {
  prefix: string;
  requested: number;
  sent: number;
  intervalMs: number;
  startedAtIso: string;
  wallTimeMs: number;
  cancelled: boolean;
}

/** Pure: serializes one JSONL line (includes the trailing newline). */
export function formatBurstLine(
  record: (BurstMessageRecord & { type: 'message' }) | (BurstSummaryRecord & { type: 'summary' })
): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Pure: the adb command that pulls a run's JSONL file off a debug build.
 * `applicationId` defaults to the unsuffixed base id — pass the `.debug`
 * variant explicitly for a side-by-side dev build (see the constant above).
 */
export function buildAdbPullCommand(
  fileName: string,
  applicationId: string = DM_BURST_BASE_APPLICATION_ID
): string {
  return `adb exec-out run-as ${applicationId} cat files/${BURST_DIR_NAME}/${fileName} > ${fileName}`;
}

function getBurstDirectory(): Directory {
  const dir = new Directory(Paths.document, BURST_DIR_NAME);
  if (!dir.exists) {
    dir.create({ intermediates: true, idempotent: true });
  }
  return dir;
}

export interface BurstRecorder {
  fileName: string;
  /** file:// URI of the JSONL file on-device. */
  filePath: string;
  appendMessage(record: BurstMessageRecord): void;
  appendSummary(record: BurstSummaryRecord): void;
  adbPullCommand(): string;
}

/**
 * Opens (creating if needed) `<documentDirectory>/dm-burst/<fileName>` and
 * returns append-only writers for it. Each append opens a fresh FileHandle at
 * end-of-file and closes it immediately — no buffered content is held across
 * calls, so a killed app loses at most the in-flight line.
 */
export function createBurstRecorder(fileName: string): BurstRecorder {
  const dir = getBurstDirectory();
  const file = new File(dir, fileName);
  if (!file.exists) {
    file.create();
  }

  const appendLine = (line: string) => {
    const bytes = new TextEncoder().encode(line);
    const handle = file.open();
    try {
      handle.offset = handle.size ?? 0;
      handle.writeBytes(bytes);
    } finally {
      handle.close();
    }
  };

  return {
    fileName,
    filePath: file.uri,
    appendMessage: (record) => appendLine(formatBurstLine({ ...record, type: 'message' })),
    appendSummary: (record) => appendLine(formatBurstLine({ ...record, type: 'summary' })),
    adbPullCommand: () => buildAdbPullCommand(fileName),
  };
}
