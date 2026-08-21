/**
 * Pure rules for home-feed thread units (`components/SocialFeed/threadUnit.ts`).
 *
 * Pins the bounty invariants:
 *  - a single feed unit never shows more than MAX_VISIBLE_THREAD_POSTS casts
 *    of one thread, whatever the conversation depth;
 *  - collapsed context is one elision row — `root … parent reply` when the
 *    root is known, `… tail` when it is not;
 *  - self-chain collapsing (moved here from SocialFeedModal) keeps its
 *    existing behavior: same-author chains merge root-first at the tip's
 *    feed position, cross-author replies untouched.
 */
import type { FeedPost } from '@/components/SocialFeed/types';
import {
  MAX_VISIBLE_THREAD_POSTS,
  buildThreadUnit,
  collapseSelfChains,
  visibleCastCount,
  type FeedPostWithChain,
} from '@/components/SocialFeed/threadUnit';

let seq = 0;
function post(over: Partial<FeedPost> = {}): FeedPost {
  seq += 1;
  return {
    id: `id-${seq}`,
    hash: `0xhash${seq}`,
    username: `user${seq}`,
    authorFid: 100 + seq,
    authorName: `User ${seq}`,
    authorHandle: `@user${seq}`,
    time: '1h',
    content: `cast ${seq}`,
    stats: { likes: '0', replies: '0', shares: '0' },
    tags: [],
    mediaUrls: [],
    videos: [],
    urlPreviews: [],
    quoteCasts: [],
    frameEmbeds: [],
    filter: 'all',
    ...over,
  };
}

/** Root-first chain of `n` casts, each replying to the one before. */
function chainOf(n: number, authorFid?: number): FeedPost[] {
  const chain: FeedPost[] = [];
  for (let i = 0; i < n; i++) {
    const parent = chain[i - 1];
    chain.push(
      post({
        authorFid: authorFid ?? 200 + i,
        parentHash: parent?.hash,
        parentAuthorFid: parent?.authorFid,
      }),
    );
  }
  return chain;
}

describe('buildThreadUnit', () => {
  it('never shows more than MAX_VISIBLE_THREAD_POSTS casts, at any depth', () => {
    for (let len = 1; len <= 8; len++) {
      for (const rootKnown of [true, false]) {
        const unit = buildThreadUnit(chainOf(len), rootKnown);
        expect(visibleCastCount(unit)).toBeLessThanOrEqual(MAX_VISIBLE_THREAD_POSTS);
        // At most one elision row per unit.
        expect(unit.filter((i) => i.kind === 'elision').length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('renders the bounty example: A→B→C→D collapses to [A, …, C, D]', () => {
    const [a, b, c, d] = chainOf(4);
    const unit = buildThreadUnit([a, b, c, d], true);
    expect(unit).toEqual([
      { kind: 'cast', post: a },
      { kind: 'elision' },
      { kind: 'cast', post: c },
      { kind: 'cast', post: d },
    ]);
  });

  it('keeps short conversations whole — parent→reply pair has no elision', () => {
    const [parent, reply] = chainOf(2);
    expect(buildThreadUnit([parent, reply], true)).toEqual([
      { kind: 'cast', post: parent },
      { kind: 'cast', post: reply },
    ]);
  });

  it('shows all three casts of a depth-3 conversation with no elision', () => {
    const chain = chainOf(3);
    const unit = buildThreadUnit(chain, true);
    expect(unit.every((i) => i.kind === 'cast')).toBe(true);
    expect(visibleCastCount(unit)).toBe(3);
  });

  it('marks an unreachable root with a leading elision row', () => {
    const chain = chainOf(3);
    const unit = buildThreadUnit(chain, false);
    expect(unit[0]).toEqual({ kind: 'elision' });
    expect(visibleCastCount(unit)).toBe(3);
  });

  it('keeps the freshest slice when deep and rootless: […, tail of 3]', () => {
    const chain = chainOf(6);
    const unit = buildThreadUnit(chain, false);
    expect(unit[0]).toEqual({ kind: 'elision' });
    expect(unit.slice(1).map((i) => i.kind === 'cast' && i.post.hash)).toEqual(
      chain.slice(3).map((p) => p.hash),
    );
  });

  it('anchors long self-chains on their root: [root, …, last two]', () => {
    const chain = chainOf(6, 999);
    const unit = buildThreadUnit(chain, true);
    expect(unit[0]).toEqual({ kind: 'cast', post: chain[0] });
    expect(unit[1]).toEqual({ kind: 'elision' });
    expect(unit[2]).toEqual({ kind: 'cast', post: chain[4] });
    expect(unit[3]).toEqual({ kind: 'cast', post: chain[5] });
  });

  it('always ends on the tip — the cast that earned the feed slot', () => {
    for (let len = 2; len <= 8; len++) {
      for (const rootKnown of [true, false]) {
        const chain = chainOf(len);
        const unit = buildThreadUnit(chain, rootKnown);
        const last = unit[unit.length - 1];
        expect(last.kind).toBe('cast');
        expect(last.kind === 'cast' && last.post.hash).toBe(chain[len - 1].hash);
      }
    }
  });

  it('passes a lone cast through untouched', () => {
    const p = post();
    expect(buildThreadUnit([p], true)).toEqual([{ kind: 'cast', post: p }]);
    // A lone cast gets no elision even when more exists above — its own
    // ParentContextLine (with PFP) carries that context instead.
    expect(buildThreadUnit([p], false)).toEqual([{ kind: 'cast', post: p }]);
  });

  it('does not touch quote-cast embeds — a quoted reply stays a plain quote', () => {
    // Quote casts ride on the post as embeds; unit composition must pass
    // them through untouched and never promote them into thread cards.
    const quoted = {
      cast: {
        hash: '0xquoted',
        author: { fid: 7, username: 'q', displayName: 'Q' },
        text: 'i am a reply being quoted',
        timestamp: 1,
      },
      username: 'q',
      hashPrefix: '0xquoted00',
    };
    const p = post({ quoteCasts: [quoted as FeedPost['quoteCasts'][number]] });
    const unit = buildThreadUnit([p], true);
    expect(visibleCastCount(unit)).toBe(1);
    expect(unit[0].kind === 'cast' && unit[0].post.quoteCasts).toEqual([quoted]);
  });
});

describe('collapseSelfChains', () => {
  it('collapses a same-author reply chain into one root-first row', () => {
    const chain = chainOf(3, 42);
    // Ranked feeds don't keep chains adjacent — shuffle in another cast.
    const other = post({ authorFid: 7 });
    const feed = [chain[2], other, chain[1], chain[0]];
    const result = collapseSelfChains(feed);
    expect(result).toHaveLength(2);
    const row = result[0] as FeedPostWithChain;
    expect(row.hash).toBe(chain[0].hash); // adopts the root's identity
    expect(row.__chain?.map((p) => p.hash)).toEqual(chain.map((p) => p.hash));
    expect(result[1].hash).toBe(other.hash);
  });

  it('leaves cross-author replies untouched', () => {
    const [parent, reply] = chainOf(2); // distinct authors
    const result = collapseSelfChains([reply, parent]);
    expect(result).toHaveLength(2);
    expect((result[0] as FeedPostWithChain).__chain).toBeUndefined();
  });
});
