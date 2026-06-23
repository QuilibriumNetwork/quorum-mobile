/**
 * Active-channel singleton — tracks which channel the user is currently
 * viewing so the mentions/replies inbox can keep just-arrived items READ while
 * that channel is open (see services/notifications/logMentionOrReply).
 *
 * This module used to also hold per-channel reply/mention COUNTERS; those were
 * retired when the mentions/replies inbox log became the single source of truth
 * for the channel bubble (two-level read-state model). Only the active-channel
 * marker remains.
 */

/**
 * In-memory tracker of the channel the user is currently viewing. Ephemeral by
 * design — resets on app restart, which is correct: after restart the user
 * isn't on any channel until they navigate to one.
 */
let activeChannelKey: string | null = null;

export function setActiveChannel(spaceId: string, channelId: string): void {
  activeChannelKey = `${spaceId}:${channelId}`;
}

export function clearActiveChannel(spaceId: string, channelId: string): void {
  // Only clear if we're still the active channel — guards against a stale
  // unmount of a previous channel clobbering the next one's active state.
  if (activeChannelKey === `${spaceId}:${channelId}`) {
    activeChannelKey = null;
  }
}

/** Read the currently-viewed channel key (`${spaceId}:${channelId}`) or null. */
export function getActiveChannelKey(): string | null {
  return activeChannelKey;
}
