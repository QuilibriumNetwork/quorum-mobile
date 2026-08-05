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
  getFarcasterClearedBefore,
  resetFarcasterDismissal,
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
});
