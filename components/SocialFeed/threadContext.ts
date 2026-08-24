import type { FeedPost } from '@/components/SocialFeed/types';

/** Maximum number of actual casts rendered in one compact feed thread unit. */
export const MAX_FEED_THREAD_CARDS = 3;

export type CompactThreadItem =
  | { kind: 'cast'; cast: FeedPost }
  | { kind: 'collapsed-context'; count: number };

/**
 * Keep a feed thread unit short while preserving both ends of the visible
 * relationship: the oldest available context and the newest replies.
 */
export function buildCompactThread(casts: FeedPost[]): CompactThreadItem[] {
  if (casts.length <= MAX_FEED_THREAD_CARDS) {
    return casts.map((cast) => ({ kind: 'cast' as const, cast }));
  }

  const collapsedCount = casts.length - MAX_FEED_THREAD_CARDS;
  return [
    { kind: 'cast', cast: casts[0] },
    { kind: 'collapsed-context', count: collapsedCount },
    ...casts
      .slice(casts.length - (MAX_FEED_THREAD_CARDS - 1))
      .map((cast) => ({ kind: 'cast' as const, cast })),
  ];
}
