/**
 * A cast stub that has been sent must leave the feed even when no feed ever
 * carries the real cast.
 *
 * Hypersnap's following feed leaves out the viewer's own casts unless they
 * follow themselves, so for those users the hash reconcile never fires, and
 * the "Posted" stub sat at the top of the feed for good, coming back on every
 * launch within its 24 h TTL.
 */

import * as store from '@/services/feed/optimisticFeedStore';
import type { PendingCast } from '@/services/feed/optimisticFeedStore';

const HASH = '0x' + 'a'.repeat(40);

function stub(localId: string, overrides: Partial<PendingCast> = {}): PendingCast {
  return {
    localId,
    kind: 'top',
    text: `hello from ${localId}`,
    embedUrls: [],
    author: { fid: 42, displayName: 'Me', username: 'me' },
    timestamp: Date.now(),
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

const ids = () => store.pendingTopLevel().map((p) => p.localId);

beforeEach(() => {
  jest.useFakeTimers();
  store.__resetOptimisticFeed();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('a sent stub', () => {
  it('leaves the feed once its refetch window passes, though no feed showed the cast', () => {
    store.addPending(stub('a'));
    store.updatePending('a', { status: 'sent', realHash: HASH, attempts: 1 });

    jest.advanceTimersByTime(store.SENT_STUB_TTL_MS - 1);
    expect(ids()).toEqual(['a']);

    jest.advanceTimersByTime(1);
    expect(ids()).toEqual([]);
  });

  it('goes as soon as the feed shows the real cast, and its timer then touches nothing', () => {
    store.addPending(stub('a'));
    store.updatePending('a', { status: 'sent', realHash: HASH, attempts: 1 });
    store.reconcilePendingByHash([HASH]);
    expect(ids()).toEqual([]);

    store.addPending(stub('b'));
    jest.advanceTimersByTime(store.SENT_STUB_TTL_MS);
    expect(ids()).toEqual(['b']);
  });

  it('does not expire a cast that is still sending, unconfirmed or failed', () => {
    store.addPending(stub('sending'));
    store.addPending(stub('confirming'));
    store.addPending(stub('failed'));
    store.updatePending('sending', { attempts: 1 });
    store.updatePending('confirming', { status: 'confirming', realHash: HASH, acceptedAt: Date.now() });
    store.updatePending('failed', { status: 'failed', attempts: 3, error: 'nope' });

    jest.advanceTimersByTime(store.SENT_STUB_TTL_MS * 10);
    expect(ids()).toEqual(['sending', 'confirming', 'failed']);
  });
});

describe('stubs saved by an earlier run', () => {
  it('bring back unsent, unconfirmed and failed casts but not sent ones', () => {
    const saved = [
      stub('sent', { status: 'sent', realHash: HASH }),
      stub('sending'),
      stub('confirming', { status: 'confirming', realHash: HASH, acceptedAt: Date.now() }),
      stub('failed', { status: 'failed', attempts: 3 }),
    ];
    const mmkv = new Map<string, string>([['feed-optimistic-pending:v1', JSON.stringify(saved)]]);

    let restored: string[] = [];
    jest.isolateModules(() => {
      jest.doMock('react-native-mmkv', () => ({
        createMMKV: () => ({
          getString: (k: string) => mmkv.get(k),
          set: (k: string, v: string) => void mmkv.set(k, v),
        }),
      }));
      const fresh = jest.requireActual<typeof store>('@/services/feed/optimisticFeedStore');
      restored = fresh.getPending().map((p) => p.localId);
    });

    expect(restored).toEqual(['sending', 'confirming', 'failed']);
  });
});
