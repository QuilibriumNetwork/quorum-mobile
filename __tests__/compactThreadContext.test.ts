import { buildCompactThread, MAX_FEED_THREAD_CARDS } from '@/components/SocialFeed/threadContext';
import type { FeedPost } from '@/components/SocialFeed/types';

function makeCast(hash: string): FeedPost {
  return {
    id: hash,
    hash,
    username: `user-${hash}`,
    authorFid: 1,
    authorName: 'Author',
    authorHandle: '@author',
    time: 'now',
    content: '',
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

describe('buildCompactThread', () => {
  it('renders every cast when the thread is already compact', () => {
    const casts = [makeCast('a'), makeCast('b')];

    expect(buildCompactThread(casts)).toEqual([
      { kind: 'cast', cast: casts[0] },
      { kind: 'cast', cast: casts[1] },
    ]);
  });

  it('caps visible casts and marks omitted intermediate context', () => {
    const casts = ['a', 'b', 'c', 'd', 'e'].map(makeCast);

    expect(buildCompactThread(casts)).toEqual([
      { kind: 'cast', cast: casts[0] },
      { kind: 'collapsed-context', count: 2 },
      { kind: 'cast', cast: casts[3] },
      { kind: 'cast', cast: casts[4] },
    ]);
  });

  it('never exposes more than three actual posts per feed unit', () => {
    const casts = Array.from({ length: 12 }, (_, index) => makeCast(String(index)));
    const renderedCasts = buildCompactThread(casts).filter(
      (item): item is Extract<typeof item, { kind: 'cast' }> => item.kind === 'cast',
    );

    expect(renderedCasts).toHaveLength(MAX_FEED_THREAD_CARDS);
  });
});
