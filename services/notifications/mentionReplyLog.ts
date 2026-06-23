/**
 * Persistent mentions/replies log — the data behind the Quorum section of the
 * Notifications tab.
 *
 * Mobile already detects mentions/replies on the WebSocket receive path (the
 * same shared detection desktop uses) to bump per-channel badge counters; this
 * log additionally PERSISTS each one with enough detail to render an inbox row
 * (sender, channel, preview, type). Written from `logMentionOrReply` in
 * WebSocketContext (live + catch-up paths); read by `useUnifiedNotifications`.
 *
 * Uses MMKV so it survives restarts. Bounded so a chatty space can't fill
 * storage. Deduped by a stable `id` keyed on the message id, so the same
 * message arriving via both the live and catch-up paths produces ONE row.
 *
 * Read-state is intentionally NOT stored here — it follows the two-level model
 * (Phase 3): per-channel `lastReadTimestamp` decides "read", and a single
 * `quorumLastSeenAt` decides the tab-badge (Level 1). This file is the event
 * log only.
 */

import { createMMKV, type MMKV } from 'react-native-mmkv';
import { useEffect, useState } from 'react';
import type { MessagePreview } from '@/utils/messagePreview';
import { coerceMessagePreview } from '@/utils/messagePreview';

const storage: MMKV = createMMKV({ id: 'quorum-mention-reply-log' });

const KEY_ENTRIES = 'mrlog.entries';
// Bound the log so a runaway producer can't fill MMKV. 200 mirrors the OS
// notification log; a mentions inbox rarely needs deeper history.
const MAX_ENTRIES = 200;

export type MentionReplyKind =
  | 'mention-you'
  | 'mention-everyone'
  | 'mention-roles'
  | 'reply';

export interface MentionReplyEntry {
  /** Stable + dedup key: `${spaceId}:${channelId}:${messageId}`. */
  id: string;
  kind: MentionReplyKind;
  spaceId: string;
  channelId: string;
  channelName?: string;
  /** Set when the mention/reply happened inside a thread, for the breadcrumb. */
  threadId?: string;
  senderId: string;
  senderName?: string;
  preview: MessagePreview;
  /** ms epoch — sort order + read-state comparison. */
  createdAt: number;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* swallow per-listener errors */
    }
  }
}

export function getMentionReplyLog(): MentionReplyEntry[] {
  const raw = storage.getString(KEY_ENTRIES);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: coerce any legacy/odd preview shape on read.
    return (parsed as MentionReplyEntry[]).map((e) => ({
      ...e,
      preview: coerceMessagePreview(e.preview),
    }));
  } catch {
    return [];
  }
}

export function appendMentionReplyLog(entry: MentionReplyEntry): void {
  const existing = getMentionReplyLog();
  // Dedup by id (same message via live + catch-up paths → one row), newest first.
  const next: MentionReplyEntry[] = [
    entry,
    ...existing.filter((e) => e.id !== entry.id),
  ];
  if (next.length > MAX_ENTRIES) next.length = MAX_ENTRIES;
  storage.set(KEY_ENTRIES, JSON.stringify(next));
  emit();
}

export function clearMentionReplyLog(): void {
  storage.remove(KEY_ENTRIES);
  emit();
}

export function removeMentionReplyEntry(id: string): void {
  const next = getMentionReplyLog().filter((e) => e.id !== id);
  storage.set(KEY_ENTRIES, JSON.stringify(next));
  emit();
}

/**
 * React subscription helper. Returns the current log and re-renders whenever any
 * mutator above fires.
 */
export function useMentionReplyLog(): { entries: MentionReplyEntry[] } {
  const [entries, setEntries] = useState<MentionReplyEntry[]>(() =>
    getMentionReplyLog()
  );
  useEffect(() => {
    const listener = () => setEntries(getMentionReplyLog());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return { entries };
}
