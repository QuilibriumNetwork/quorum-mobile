/**
 * `planFarcasterPings` — what a background Farcaster check decides to notify
 * about: which conversations get a ping, where the last-seen watermark lands,
 * and when the run collapses into a single digest.
 *
 * The surrounding `checkFarcasterDirectCasts` is network + MMKV, so none of
 * this is observable through it. The planner is the pure half.
 */

import {
  planFarcasterPings,
  rewoundWatermark,
  MAX_FC_CONVERSATION_PINGS,
  type FarcasterPingPlan,
} from '../services/notifications/farcasterPingPlan';
import type { DirectCastConversation } from '../services/farcasterClient';

const SEEN = 1_000;

function conversation(
  id: string,
  serverTimestamp: number,
  over: Partial<DirectCastConversation> = {},
): DirectCastConversation {
  return {
    conversationId: id,
    participants: [],
    isGroup: false,
    unreadCount: 1,
    muted: false,
    lastMessage: { messageId: `${id}-msg`, serverTimestamp, message: 'hi' },
    viewerContext: { category: 'default', lastReadAt: 0, unreadCount: 1 },
    ...over,
  } as unknown as DirectCastConversation;
}

const ids = (plan: FarcasterPingPlan) => plan.conversations.map((c) => c.conversationId);

describe('planFarcasterPings', () => {
  it('pings only conversations whose last message is newer than the watermark', () => {
    const plan = planFarcasterPings(
      [conversation('stale', SEEN - 1), conversation('fresh', SEEN + 1)],
      SEEN,
    );
    expect(ids(plan)).toEqual(['fresh']);
    expect(plan.digestCount).toBe(0);
  });

  it('treats a message exactly at the watermark as already seen', () => {
    // Off-by-one here re-notifies the same message forever.
    const plan = planFarcasterPings([conversation('edge', SEEN)], SEEN);
    expect(ids(plan)).toEqual([]);
    expect(plan.latestTimestamp).toBe(SEEN);
  });

  it('leaves the watermark alone when nothing is new', () => {
    // The control arm: a quiet run must change no state at all.
    const plan = planFarcasterPings([conversation('quiet', SEEN - 50)], SEEN);
    expect(plan).toEqual({ conversations: [], latestTimestamp: SEEN, digestCount: 0 });
  });

  it('ignores a conversation with no last message', () => {
    const plan = planFarcasterPings([conversation('empty', 0, { lastMessage: undefined })], SEEN);
    expect(ids(plan)).toEqual([]);
  });

  it('skips conversations muted on Farcaster', () => {
    const plan = planFarcasterPings(
      [conversation('muted', SEEN + 5, { muted: true }), conversation('loud', SEEN + 5)],
      SEEN,
    );
    expect(ids(plan)).toEqual(['loud']);
  });

  it('still advances the watermark past a muted conversation', () => {
    // Otherwise the muted conversation pins the watermark below its own
    // traffic and every OTHER conversation in the batch re-notifies each run.
    const plan = planFarcasterPings(
      [conversation('muted', SEEN + 900, { muted: true }), conversation('loud', SEEN + 5)],
      SEEN,
    );
    expect(plan.latestTimestamp).toBe(SEEN + 900);
    expect(ids(plan)).toEqual(['loud']);
  });

  it('advances the watermark to the newest message seen', () => {
    const plan = planFarcasterPings(
      [conversation('a', SEEN + 10), conversation('b', SEEN + 40), conversation('c', SEEN + 20)],
      SEEN,
    );
    expect(plan.latestTimestamp).toBe(SEEN + 40);
  });

  it('pings per conversation right up to the cap', () => {
    const n = MAX_FC_CONVERSATION_PINGS;
    const many = Array.from({ length: n }, (_, i) => conversation(`c${i}`, SEEN + 1 + i));
    const plan = planFarcasterPings(many, SEEN);
    expect(plan.conversations).toHaveLength(n);
    expect(plan.digestCount).toBe(0);
  });

  it('collapses into a single digest once past the cap', () => {
    const n = MAX_FC_CONVERSATION_PINGS + 1;
    const many = Array.from({ length: n }, (_, i) => conversation(`c${i}`, SEEN + 1 + i));
    const plan = planFarcasterPings(many, SEEN);
    expect(plan.conversations).toEqual([]);
    expect(plan.digestCount).toBe(n);
    // The digest still has to carry the watermark forward, or the same
    // conversations arrive again on the next run.
    expect(plan.latestTimestamp).toBe(SEEN + n);
  });

  it('counts only unmuted conversations toward the cap', () => {
    const n = MAX_FC_CONVERSATION_PINGS;
    const many = [
      ...Array.from({ length: n }, (_, i) => conversation(`c${i}`, SEEN + 1 + i)),
      conversation('muted', SEEN + 99, { muted: true }),
    ];
    const plan = planFarcasterPings(many, SEEN);
    expect(plan.digestCount).toBe(0);
    expect(plan.conversations).toHaveLength(n);
  });
});

describe('rewoundWatermark (the dev rewind)', () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = 100 * HOUR;

  it('accumulates — repeated rewinds keep walking backwards', () => {
    // The bug this exists for: anchoring on `now` instead of the current
    // watermark makes every tap land on the same instant, so tapping "go back
    // further" six times is identical to tapping it once. The button looks
    // dead, and the tester concludes the FEATURE is broken.
    const once = rewoundWatermark(NOW, HOUR, NOW);
    const twice = rewoundWatermark(once, HOUR, NOW);
    const thrice = rewoundWatermark(twice, HOUR, NOW);
    expect(once).toBe(NOW - HOUR);
    expect(twice).toBe(NOW - 2 * HOUR);
    expect(thrice).toBe(NOW - 3 * HOUR);
  });

  it('anchors on now only when there is no watermark yet', () => {
    expect(rewoundWatermark(0, HOUR, NOW)).toBe(NOW - HOUR);
  });

  it('never goes below zero', () => {
    expect(rewoundWatermark(HOUR, 10 * HOUR, NOW)).toBe(0);
  });
});
