/**
 * Pure core of the background Farcaster direct-cast check.
 *
 * `BackgroundMessageService` around it is all network + MMKV + the OS
 * scheduler, so none of the actual decisions in here — the mute skip, where the
 * last-seen watermark lands, the per-conversation / digest fork — are
 * observable through it. Same split as `partitionNotifications`: plain
 * functions over plain data, unit-testable without a device.
 */

import type { DirectCastConversation } from '../farcasterClient';

/**
 * How many conversations one background run will ping about individually.
 *
 * A per-conversation ping is what makes the in-app row tappable (it is the only
 * thing carrying a conversationId), but it also costs one OS banner per
 * conversation. Past a handful the user needs their inbox, not a stack of
 * banners, so the run collapses into a single digest instead.
 */
export const MAX_FC_CONVERSATION_PINGS = 5;

/**
 * Where a dev rewind of the last-seen watermark lands.
 *
 * Anchored on the CURRENT watermark, not on `now`, so repeated rewinds keep
 * walking backwards. Anchoring on `now` makes the operation idempotent — every
 * tap landing on the same instant — so "go back further" silently does nothing
 * and the tester concludes the FEATURE is broken rather than the button.
 *
 * Falls back to `now` only when there is no watermark yet, where every message
 * already counts as new and there is nothing to rewind past.
 */
export function rewoundWatermark(current: number, byMs: number, now: number): number {
  return Math.max(0, (current || now) - byMs);
}

export interface FarcasterPingPlan {
  /** Conversations to raise one ping each for. Empty when `digestCount > 0`. */
  conversations: DirectCastConversation[];
  /** New watermark to persist; equals the input when nothing is new. */
  latestTimestamp: number;
  /**
   * Number of new conversations to collapse into ONE generic ping, or 0 when
   * the run pings per conversation instead. The two are mutually exclusive.
   */
  digestCount: number;
}

export function planFarcasterPings(
  conversations: readonly DirectCastConversation[],
  lastSeenTimestamp: number,
): FarcasterPingPlan {
  const fresh: DirectCastConversation[] = [];
  let latestTimestamp = lastSeenTimestamp;

  for (const conversation of conversations) {
    const lastMessage = conversation.lastMessage;
    if (!lastMessage || lastMessage.serverTimestamp <= lastSeenTimestamp) continue;
    // Advance the watermark for EVERY new message, including ones skipped
    // below — otherwise a muted conversation with recent traffic pins the
    // watermark below its own messages and the rest of the batch re-notifies
    // on every later run.
    if (lastMessage.serverTimestamp > latestTimestamp) {
      latestTimestamp = lastMessage.serverTimestamp;
    }
    // Muted on Farcaster itself. We only learn this per-conversation, so it
    // could not be honored while the run raised one aggregate ping.
    if (conversation.muted) continue;
    fresh.push(conversation);
  }

  if (fresh.length > MAX_FC_CONVERSATION_PINGS) {
    return { conversations: [], latestTimestamp, digestCount: fresh.length };
  }
  return { conversations: fresh, latestTimestamp, digestCount: 0 };
}
