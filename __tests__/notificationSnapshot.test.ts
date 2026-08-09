/**
 * Dev notification snapshot — the copy-aside that makes the destructive clear
 * paths testable more than once.
 *
 * Worth real tests despite being dev-only: it is the thing standing between a
 * clear and permanently losing a notification history that takes weeks of real
 * activity to rebuild. If it silently fails, the loss is discovered only when
 * Restore does nothing.
 */

jest.mock('react-native-mmkv', () => ({
  createMMKV: ({ id }: { id: string }) => {
    const stores = ((globalThis as Record<string, unknown>).__mmkv ??= new Map()) as Map<
      string,
      Map<string, string>
    >;
    if (!stores.has(id)) stores.set(id, new Map());
    const store = stores.get(id)!;
    return {
      getString: (k: string) => store.get(k),
      set: (k: string, v: string) => store.set(k, v),
      remove: (k: string) => store.delete(k),
      delete: (k: string) => store.delete(k),
      getAllKeys: () => Array.from(store.keys()),
      clearAll: () => store.clear(),
      contains: (k: string) => store.has(k),
    };
  },
}));

import { createMMKV } from 'react-native-mmkv';
import {
  captureNotificationSnapshot,
  clearNotificationSnapshot,
  getNotificationSnapshotInfo,
  restoreNotificationSnapshot,
} from '../services/dev/notificationSnapshot';
import {
  appendMentionReplyLog,
  clearMentionReplyLog,
  getMentionReplyLog,
  type MentionReplyEntry,
} from '../services/notifications/mentionReplyLog';
import {
  appendNotificationLog,
  clearNotificationLog,
  getNotificationLog,
} from '../services/notifications/notificationLog';
import {
  clearFarcasterNotifications,
  dismissFarcasterNotification,
  getFarcasterClearedBefore,
  getFarcasterDismissedKeys,
  resetFarcasterDismissal,
  setFarcasterDismissedKeys,
} from '../services/notifications/farcasterDismissal';

function mention(id: string): MentionReplyEntry {
  return {
    id,
    kind: 'mention-you',
    spaceId: 'space',
    channelId: 'chan',
    senderId: 'sender',
    preview: { kind: 'text', text: 'ping' },
    createdAt: 1_000,
  } as MentionReplyEntry;
}

/**
 * Rewrite the stored snapshot as one taken BEFORE the per-row trash existed,
 * i.e. with no `dismissedKeys` field at all.
 *
 * Reaches into the mocked MMKV store rather than constructing the JSON by hand,
 * so the fixture stays a real captured snapshot minus one field — hand-writing
 * the whole object would stop resembling what `captureNotificationSnapshot`
 * actually produces the first time its shape changes.
 */
function stripDismissedKeysFromStoredSnapshot(): void {
  const store = createMMKV({ id: 'quorum-dev-notification-snapshot' });
  const raw = store.getString('dev.notificationSnapshot');
  if (!raw) throw new Error('no snapshot stored — capture one first');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  delete parsed.dismissedKeys;
  store.set('dev.notificationSnapshot', JSON.stringify(parsed));
}

beforeEach(() => {
  clearMentionReplyLog();
  clearNotificationLog();
  resetFarcasterDismissal();
  clearNotificationSnapshot();
});

describe('captureNotificationSnapshot / restoreNotificationSnapshot', () => {
  it('restores both logs after a clear wipes them', () => {
    appendMentionReplyLog(mention('a'));
    appendNotificationLog({ id: 'p1', title: 'New Messages', body: 'x' });

    captureNotificationSnapshot();
    clearMentionReplyLog();
    clearNotificationLog();
    expect(getMentionReplyLog()).toHaveLength(0);
    expect(getNotificationLog()).toHaveLength(0);

    expect(restoreNotificationSnapshot()).toBe(true);
    expect(getMentionReplyLog().map((e) => e.id)).toEqual(['a']);
    expect(getNotificationLog().map((e) => e.id)).toEqual(['p1']);
  });

  it('restores the watermark to its captured value, not just to zero', () => {
    appendMentionReplyLog(mention('a'));
    captureNotificationSnapshot();          // captured while never-cleared
    clearFarcasterNotifications();          // watermark now set
    expect(getFarcasterClearedBefore()).toBeGreaterThan(0);

    restoreNotificationSnapshot();
    expect(getFarcasterClearedBefore()).toBe(0);
  });

  it('reports what it is holding', () => {
    appendMentionReplyLog(mention('a'));
    appendMentionReplyLog(mention('b'));
    appendNotificationLog({ id: 'p1', title: 't', body: 'b' });
    captureNotificationSnapshot();

    const info = getNotificationSnapshotInfo();
    expect(info?.mentionCount).toBe(2);
    expect(info?.pingCount).toBe(1);
  });

  it('does NOT overwrite a good snapshot with an empty one', () => {
    // The trap: clear, then capture again before restoring. A naive capture
    // would save the now-empty logs over the only copy of the real data, and
    // Restore would cheerfully restore nothing. The loss would surface only
    // when it was already unrecoverable.
    appendMentionReplyLog(mention('a'));
    captureNotificationSnapshot();
    clearMentionReplyLog();
    clearNotificationLog();

    captureNotificationSnapshot(); // both logs empty — must be ignored

    expect(getNotificationSnapshotInfo()?.mentionCount).toBe(1);
    restoreNotificationSnapshot();
    expect(getMentionReplyLog().map((e) => e.id)).toEqual(['a']);
  });

  it('reports failure when there is nothing captured', () => {
    expect(restoreNotificationSnapshot()).toBe(false);
    expect(getNotificationSnapshotInfo()).toBeNull();
  });

  it('a later capture replaces an earlier one', () => {
    appendMentionReplyLog(mention('a'));
    captureNotificationSnapshot();
    appendMentionReplyLog(mention('b'));
    captureNotificationSnapshot();

    expect(getNotificationSnapshotInfo()?.mentionCount).toBe(2);
  });

  it('round-trips the per-row dismissals, not just the watermark', () => {
    // Without this, `captureNotificationSnapshot` could stop recording
    // `dismissedKeys` entirely and the whole suite stayed green — the field was
    // added to the snapshot and to restore, and nothing checked either half.
    appendMentionReplyLog(mention('a'));
    dismissFarcasterNotification('like:abc:111');
    captureNotificationSnapshot();

    // A clear wipes the per-row map (the watermark subsumes it).
    clearFarcasterNotifications();
    expect(getFarcasterDismissedKeys()).toEqual({});

    restoreNotificationSnapshot();
    expect(Object.keys(getFarcasterDismissedKeys())).toEqual(['like:abc:111']);
  });

  it('restores a pre-feature snapshot to no dismissals, without touching the logs', () => {
    // A snapshot taken before the row trash existed has no `dismissedKeys`.
    // Restoring it must land on "nothing dismissed" — the state that snapshot
    // was actually taken in — and must not quietly leave a later dismissal in
    // place, nor drop the logs it did capture. Rows reappearing is the safe
    // direction; rows staying hidden with no record of why is not.
    appendMentionReplyLog(mention('a'));
    captureNotificationSnapshot();
    stripDismissedKeysFromStoredSnapshot();

    dismissFarcasterNotification('like:abc:111');
    restoreNotificationSnapshot();

    expect(getFarcasterDismissedKeys()).toEqual({});
    expect(getMentionReplyLog().map((e) => e.id)).toEqual(['a']);
  });

  it('a restored empty map really clears the store, rather than writing "{}"', () => {
    // Guards the branch in setFarcasterDismissedKeys that removes the key
    // instead of persisting an empty object — a stored "{}" parses back to the
    // same thing, so only the raw read distinguishes them.
    dismissFarcasterNotification('like:abc:111');
    setFarcasterDismissedKeys({});
    expect(getFarcasterDismissedKeys()).toEqual({});
  });
});
