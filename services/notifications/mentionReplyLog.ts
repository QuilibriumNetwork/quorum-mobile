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
import { useCallback, useEffect, useState } from 'react';
import type { MessagePreview } from '@/utils/messagePreview';
import { coerceMessagePreview } from '@/utils/messagePreview';

const storage: MMKV = createMMKV({ id: 'quorum-mention-reply-log' });

const KEY_ENTRIES = 'mrlog.entries';
// Per-channel read marks (Level 2): channelKey -> ms epoch the channel was last
// opened. A mention/reply is unread iff its createdAt > this.
const KEY_CHANNEL_READ = 'mrlog.channelReadAt';
// Tab-seen mark (Level 1): single ms epoch the Notifications tab was last opened.
// Decoupled from Level 2 so opening the tab clears the tab badge WITHOUT marking
// per-channel mentions read (the two-level model — see the notifications doc).
const KEY_TAB_SEEN = 'mrlog.tabSeenAt';
// Bound the log so a runaway producer can't fill MMKV. 200 mirrors the OS
// notification log; a mentions inbox rarely needs deeper history.
const MAX_ENTRIES = 200;

const channelKey = (spaceId: string, channelId: string) => `${spaceId}:${channelId}`;

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

// ── Read-state (two-level model) ────────────────────────────────────────────

function loadChannelReadMap(): Record<string, number> {
  const raw = storage.getString(KEY_CHANNEL_READ);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/**
 * Level 2 — mark a channel read (called when the user opens that channel).
 * Clears the channel's per-space bubble; does NOT touch the tab badge.
 */
export function markChannelMentionsRead(
  spaceId: string,
  channelId: string,
  /** Read watermark; defaults to now. Pass an entry's createdAt to cover a
   *  just-logged mention whose timestamp may lead the wall clock. */
  at: number = Date.now()
): void {
  const map = loadChannelReadMap();
  const key = channelKey(spaceId, channelId);
  // Never move the watermark backwards.
  map[key] = Math.max(map[key] ?? 0, at);
  storage.set(KEY_CHANNEL_READ, JSON.stringify(map));
  emit();
}

/** Count of unread (createdAt > channel lastReadAt) mention/reply entries in a channel. */
export function getUnreadCountForChannel(spaceId: string, channelId: string): number {
  const key = channelKey(spaceId, channelId);
  const readAt = loadChannelReadMap()[key] ?? 0;
  return getMentionReplyLog().reduce(
    (n, e) => (channelKey(e.spaceId, e.channelId) === key && e.createdAt > readAt ? n + 1 : n),
    0
  );
}

/**
 * Level 1 — mark the Notifications tab seen (called on tab open). Clears the tab
 * badge's Quorum contribution without marking any channel read.
 */
export function markQuorumTabSeen(): void {
  storage.set(KEY_TAB_SEEN, String(Date.now()));
  emit();
}

function getQuorumTabSeenAt(): number {
  const v = storage.getString(KEY_TAB_SEEN);
  return v ? parseInt(v, 10) : 0;
}

/** Level 1 — number of Quorum entries newer than the last tab-seen mark. */
export function getQuorumTabUnreadCount(): number {
  const seenAt = getQuorumTabSeenAt();
  return getMentionReplyLog().reduce((n, e) => (e.createdAt > seenAt ? n + 1 : n), 0);
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

/**
 * Subscription for the per-channel unread bubble (Level 2). Exposes a stable
 * getter that recomputes whenever the log OR a channel read-mark changes.
 * Replaces the old integer-counter trackers as the single source of truth.
 */
export function useChannelMentionUnread(): {
  getUnreadCount: (spaceId: string, channelId: string) => number;
} {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const getUnreadCount = useCallback(
    (spaceId: string, channelId: string) => getUnreadCountForChannel(spaceId, channelId),
    // version drives recomputation on every mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );
  return { getUnreadCount };
}
