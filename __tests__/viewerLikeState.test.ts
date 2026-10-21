/**
 * A cast the viewer has liked or recast shows as such, and optimistic
 * overrides give way once the server has caught up.
 *
 * ## The regression this pins
 *
 * Hypersnap's `/v2` reads return no viewer context, so every cast showed as
 * not liked, the viewer's own likes included, and like overrides were never
 * reconciled: the home feed didn't try, and the thread view compared against a
 * `viewerContext` that is always empty. The hub API's `/v1/reactionsByFid`
 * lists the viewer's reactions; the store now holds them and cards read them.
 *
 * ## What is asserted
 *
 * - The fetch asks the hub for the viewer's newest reactions of a type, and
 *   keeps cast-target ADDs only, as lowercase `0x` hashes.
 * - The per-cast hooks report the sets and re-render only for a change to
 *   their own cast.
 * - An override is dropped only once the reaction set agrees AND the cast's
 *   server count has caught up with it.
 */
import { act, renderHook } from '@testing-library/react-native';
import * as store from '@/services/feed/optimisticFeedStore';
import { fetchViewerReactionHashes } from '@/services/farcaster/viewerReactions';

const HASH_A = '0x' + 'a'.repeat(40);
const HASH_B = '0x' + 'b'.repeat(40);

const mockFetch = jest.fn();
(globalThis as { fetch: unknown }).fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  store.__resetOptimisticFeed();
});

describe('fetching the viewer reactions', () => {
  it('asks for the newest reactions of a type and keeps cast-target adds', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          { data: { type: 'MESSAGE_TYPE_REACTION_ADD', reactionBody: { targetCastId: { hash: HASH_A.toUpperCase().replace('0X', '0x') } } } },
          { data: { type: 'MESSAGE_TYPE_REACTION_ADD', reactionBody: { targetUrl: 'https://example.invalid' } } },
          { data: { type: 'MESSAGE_TYPE_REACTION_REMOVE', reactionBody: { targetCastId: { hash: HASH_B } } } },
        ],
      }),
    });

    expect(await fetchViewerReactionHashes(42, 'Like', 500)).toEqual([HASH_A]);
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toContain('/v1/reactionsByFid?');
    expect(url).toContain('fid=42');
    expect(url).toContain('reaction_type=Like');
    expect(url).toContain('pageSize=500');
    expect(url).toContain('reverse=true');
  });

  it('throws on a failed request, so the last good set stays', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await expect(fetchViewerReactionHashes(42, 'Recast', 200)).rejects.toThrow('503');
  });
});

describe('the viewer reaction sets', () => {
  it('mark a liked or recast cast, and re-render only that cast', () => {
    let rendersB = 0;
    const a = renderHook(() => store.useViewerLiked(HASH_A));
    const b = renderHook(() => {
      rendersB++;
      return store.useViewerLiked(HASH_B);
    });
    const recastA = renderHook(() => store.useViewerRecasted(HASH_A));
    const before = rendersB;

    act(() => store.setViewerReactions([HASH_A.toUpperCase().replace('0X', '0x')], [HASH_A]));

    expect(a.result.current).toBe(true);
    expect(recastA.result.current).toBe(true);
    expect(b.result.current).toBe(false);
    expect(rendersB).toBe(before);
  });

  it('follow the viewer’s own reactions as they land', () => {
    const a = renderHook(() => store.useViewerLiked(HASH_A));
    act(() => store.setViewerReaction('like', HASH_A, true));
    expect(a.result.current).toBe(true);
    act(() => store.setViewerReaction('like', HASH_A, false));
    expect(a.result.current).toBe(false);
  });
});

describe('reconciling overrides', () => {
  it('drops a like override once the set agrees and the count has caught up', () => {
    store.setLike(HASH_A, true, 6);
    store.setViewerReactions([HASH_A], []);

    // The cast's count is still from before the like: keep the override.
    store.reconcileReactions([{ hash: HASH_A, reactions: { count: 5 } }]);
    expect(store.getLikes().has(HASH_A)).toBe(true);

    store.reconcileReactions([{ hash: HASH_A, reactions: { count: 7 } }]);
    expect(store.getLikes().has(HASH_A)).toBe(false);
  });

  it('keeps an override the reaction set disagrees with', () => {
    store.setLike(HASH_A, true, 6);
    store.setViewerReactions([], []);

    store.reconcileReactions([{ hash: HASH_A, reactions: { count: 6 } }]);
    expect(store.getLikes().has(HASH_A)).toBe(true);
  });

  it('drops an unlike override once the set and the count agree', () => {
    store.setLike(HASH_A, false, 4);
    store.setViewerReactions([], []);

    store.reconcileReactions([{ hash: HASH_A, reactions: { count: 5 } }]);
    expect(store.getLikes().has(HASH_A)).toBe(true);
    store.reconcileReactions([{ hash: HASH_A, reactions: { count: 4 } }]);
    expect(store.getLikes().has(HASH_A)).toBe(false);
  });

  it('reconciles recasts the same way', () => {
    store.setRecast(HASH_B, true, 2);
    store.setViewerReactions([], [HASH_B]);

    store.reconcileReactions([{ hash: HASH_B, recasts: { count: 1 } }]);
    expect(store.getRecasts().has(HASH_B)).toBe(true);
    store.reconcileReactions([{ hash: HASH_B, recasts: { count: 2 } }]);
    expect(store.getRecasts().has(HASH_B)).toBe(false);
  });
});
