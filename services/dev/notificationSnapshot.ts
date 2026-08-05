/**
 * notificationSnapshot — dev-build-only copy-aside for the notification state,
 * so the destructive clear paths can be tested more than once.
 *
 * WHY. Every "Clear" scope destroys something that cannot be recovered:
 *
 *   Clear Farcaster → hides feed rows (undoable via the watermark), AND
 *                     DELETES the Farcaster direct-cast pings
 *   Clear Quorum    → DELETES the mention log and the Quorum pings
 *   Clear all       → both of the above
 *
 * The dismissal watermark is reversible because feed rows are a remote feed
 * that cannot be deleted. Everything else is a local log, and a local log that
 * is cleared is simply gone. On a one-test-account setup those logs take weeks
 * of real activity to accumulate, so without this each clear path is testable
 * exactly once, ever.
 *
 * This captures all three pieces of state before a clear and can put them back:
 * the mention log, the background-ping log, and the watermark value.
 *
 * Only ever called behind a `__DEV__` gate at the call site.
 */

import { createMMKV, type MMKV } from 'react-native-mmkv';
import { useEffect, useState } from 'react';
import {
  getMentionReplyLog,
  replaceMentionReplyLog,
  type MentionReplyEntry,
} from '@/services/notifications/mentionReplyLog';
import {
  getNotificationLog,
  replaceNotificationLog,
  type NotificationLogEntry,
} from '@/services/notifications/notificationLog';
import {
  getFarcasterClearedBefore,
  setFarcasterClearedBefore,
} from '@/services/notifications/farcasterDismissal';

const storage: MMKV = createMMKV({ id: 'quorum-dev-notification-snapshot' });

const KEY_SNAPSHOT = 'dev.notificationSnapshot';

interface NotificationSnapshot {
  takenAt: number;
  mentions: MentionReplyEntry[];
  pings: NotificationLogEntry[];
  clearedBefore: number;
}

export interface NotificationSnapshotInfo {
  takenAt: number;
  mentionCount: number;
  pingCount: number;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) {
    try { l(); } catch { /* swallow per-listener errors */ }
  }
}

function read(): NotificationSnapshot | null {
  const raw = storage.getString(KEY_SNAPSHOT);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as NotificationSnapshot;
    if (!parsed || !Array.isArray(parsed.mentions) || !Array.isArray(parsed.pings)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Copy the current notification state aside, replacing any previous snapshot.
 *
 * Deliberately overwrites rather than keeping a stack: the useful snapshot is
 * always "what it looked like before the clear I am about to do", and a stack
 * would just raise the question of which entry to restore.
 *
 * No-ops when there is nothing to save, so an accidental double-capture after
 * a clear cannot overwrite a good snapshot with an empty one — that would
 * quietly destroy the very thing this exists to protect.
 */
export function captureNotificationSnapshot(): void {
  const mentions = getMentionReplyLog();
  const pings = getNotificationLog();
  if (mentions.length === 0 && pings.length === 0) return;
  const snapshot: NotificationSnapshot = {
    takenAt: Date.now(),
    mentions,
    pings,
    clearedBefore: getFarcasterClearedBefore(),
  };
  storage.set(KEY_SNAPSHOT, JSON.stringify(snapshot));
  emit();
}

/** Put the captured state back. Returns false when there is no snapshot. */
export function restoreNotificationSnapshot(): boolean {
  const snapshot = read();
  if (!snapshot) return false;
  replaceMentionReplyLog(snapshot.mentions);
  replaceNotificationLog(snapshot.pings);
  setFarcasterClearedBefore(snapshot.clearedBefore);
  return true;
}

export function getNotificationSnapshotInfo(): NotificationSnapshotInfo | null {
  const snapshot = read();
  if (!snapshot) return null;
  return {
    takenAt: snapshot.takenAt,
    mentionCount: snapshot.mentions.length,
    pingCount: snapshot.pings.length,
  };
}

export function clearNotificationSnapshot(): void {
  storage.remove(KEY_SNAPSHOT);
  emit();
}

/** React subscription helper — re-renders the dev panel as snapshots change. */
export function useNotificationSnapshot(): NotificationSnapshotInfo | null {
  const [info, setInfo] = useState<NotificationSnapshotInfo | null>(() =>
    getNotificationSnapshotInfo(),
  );
  useEffect(() => {
    const listener = () => setInfo(getNotificationSnapshotInfo());
    listeners.add(listener);
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return info;
}
