import {
  buildThreadPreview,
  collapseSelfReplyChains,
  selectFeedThreadTarget,
} from '@/components/SocialFeed/threadPreview';
import type { FeedPost } from '@/components/SocialFeed/types';

function post(hash: string, parentHash?: string, authorFid = 1): FeedPost {
  return {
    id: hash,
    hash,
    parentHash,
    username: `user${authorFid}`,
    authorFid,
    authorName: `User ${authorFid}`,
    authorHandle: `@user${authorFid}`,
    time: 'now',
    content: hash,
    stats: { likes: '0', replies: '0', shares: '0' },
    tags: [],
    mediaUrls: [],
    videos: [],
    urlPreviews: [],
    quoteCasts: [],
    frameEmbeds: [],
    filter: 'all',
  };
}

describe('buildThreadPreview', () => {
  it('keeps one-, two-, and three-cast paths intact', () => {
    const chain = [post('a'), post('b', 'a'), post('c', 'b')];
    expect(buildThreadPreview(chain).map((entry) => entry.type)).toEqual([
      'cast',
      'cast',
      'cast',
    ]);
  });

  it('caps a deep path at three casts and reports omitted context', () => {
    const chain = [
      post('a'),
      post('b', 'a'),
      post('c', 'b'),
      post('d', 'c'),
      post('e', 'd'),
    ];
    const preview = buildThreadPreview(chain);
    expect(preview.map((entry) => entry.type)).toEqual(['cast', 'gap', 'cast', 'cast']);
    expect(preview.filter((entry) => entry.type === 'cast').map((entry) => entry.cast.hash))
      .toEqual(['a', 'd', 'e']);
    expect(preview[1]).toEqual({ type: 'gap', omittedCount: 2 });
  });

  it('marks unknown earlier context without inventing an omitted count', () => {
    const chain = [post('c', 'b'), post('d', 'c'), post('e', 'd')];
    expect(buildThreadPreview(chain, { hasEarlierContext: true })[0]).toEqual({ type: 'gap' });
  });

  it('preserves both unknown earlier context and a known internal omission', () => {
    const chain = [
      post('c', 'b'),
      post('d', 'c'),
      post('e', 'd'),
      post('f', 'e'),
      post('g', 'f'),
    ];
    const preview = buildThreadPreview(chain, { hasEarlierContext: true });

    expect(preview.map((entry) => entry.type)).toEqual([
      'gap',
      'cast',
      'gap',
      'cast',
      'cast',
    ]);
    expect(preview[0]).toEqual({ type: 'gap' });
    expect(preview[2]).toEqual({ type: 'gap', omittedCount: 2 });
    expect(preview.filter((entry) => entry.type === 'cast').map((entry) => entry.cast.hash))
      .toEqual(['c', 'f', 'g']);
  });

  it('never exceeds three casts at any supported depth', () => {
    for (let depth = 1; depth <= 64; depth += 1) {
      const chain = Array.from({ length: depth }, (_, index) =>
        post(`cast-${index}`, index > 0 ? `cast-${index - 1}` : undefined),
      );
      const preview = buildThreadPreview(chain);
      const visible = preview.filter((entry) => entry.type === 'cast');
      expect(visible.length).toBeLessThanOrEqual(3);
      expect(visible.at(-1)?.cast.hash).toBe(`cast-${depth - 1}`);
    }
  });
});

describe('selectFeedThreadTarget', () => {
  it('preserves the existing parent-thread destination for a reply', () => {
    expect(selectFeedThreadTarget(post('reply', 'parent'), false)).toEqual({
      hash: 'parent',
      username: '',
      opensParent: true,
    });
  });

  it('opens a promoted context card on its own thread', () => {
    expect(selectFeedThreadTarget(post('parent', 'root'), true)).toEqual({
      hash: 'parent',
      username: 'user1',
      opensParent: false,
    });
  });
});

describe('collapseSelfReplyChains', () => {
  it('keeps reply-bumping order while attaching the full path to its tip', () => {
    const result = collapseSelfReplyChains([
      post('a'),
      post('unrelated', undefined, 2),
      post('b', 'a'),
      post('c', 'b'),
    ]);
    expect(result.map((item) => item.hash)).toEqual(['unrelated', 'c']);
    expect(result[1].__chain?.map((item) => item.hash)).toEqual(['a', 'b', 'c']);
  });

  it('does not merge a cross-author reply', () => {
    const result = collapseSelfReplyChains([post('a'), post('b', 'a', 2)]);
    expect(result).toHaveLength(2);
    expect(result.every((item) => item.__chain === undefined)).toBe(true);
  });

  it('keeps branches as separate feed units', () => {
    const result = collapseSelfReplyChains([
      post('a'),
      post('b', 'a'),
      post('c', 'a'),
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((item) => item.hash)).toEqual(['b', 'c']);
    expect(new Set(result.map((item) => item.id)).size).toBe(2);
    expect(result.map((item) => item.__chain?.map((member) => member.hash))).toEqual([
      ['a', 'b'],
      ['a', 'c'],
    ]);
  });

  it('terminates a malformed cycle', () => {
    const result = collapseSelfReplyChains([post('a', 'b'), post('b', 'a')]);
    expect(result).toHaveLength(2);
  });

  it('keeps unrelated conversations distinct and in bumped order', () => {
    const result = collapseSelfReplyChains([
      post('a1', undefined, 1),
      post('x1', undefined, 2),
      post('a2', 'a1', 1),
      post('x2', 'x1', 2),
    ]);
    expect(result.map((item) => item.hash)).toEqual(['a2', 'x2']);
    expect(result.map((item) => item.__chain?.map((member) => member.hash))).toEqual([
      ['a1', 'a2'],
      ['x1', 'x2'],
    ]);
  });
});
