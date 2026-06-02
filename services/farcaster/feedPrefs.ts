/**
 * feedPrefs — persisted social-feed display preferences.
 *
 * Two toggles, both affecting the MAIN feed only (thread views always show
 * every reply, the block placeholder aside):
 *
 *   • showRepliesInFeed (default ON) — when OFF, every reply cast is removed
 *     from the main feed, leaving only top-level casts.
 *   • showNonFollowReplies (default OFF) — when replies ARE shown, this gates
 *     whether replies from authors the viewer doesn't follow appear.
 *
 * Resolution: if showRepliesInFeed is off, no replies show at all and
 * showNonFollowReplies is moot. Otherwise showNonFollowReplies decides
 * whether non-follow replies are kept.
 *
 * Backed by a small dedicated MMKV instance. The instance is exported so
 * UI and the feed hook can subscribe reactively via `useMMKVBoolean`,
 * keeping the settings toggles and the feed in sync without a refetch.
 */

import { createMMKV } from 'react-native-mmkv';

export const feedPrefsStore = createMMKV({ id: 'quorum-feed-prefs' });

export const K_SHOW_REPLIES_IN_FEED = 'showRepliesInFeed';
export const K_SHOW_NON_FOLLOW_REPLIES = 'showNonFollowReplies';

/** True (default) shows reply casts in the main feed at all. */
export function getShowRepliesInFeed(): boolean {
  const v = feedPrefsStore.getBoolean(K_SHOW_REPLIES_IN_FEED);
  return v === undefined ? true : v;
}

export function setShowRepliesInFeed(enabled: boolean): void {
  feedPrefsStore.set(K_SHOW_REPLIES_IN_FEED, enabled);
}

/** False (default) hides replies from non-followed authors on the main feed. */
export function getShowNonFollowReplies(): boolean {
  const v = feedPrefsStore.getBoolean(K_SHOW_NON_FOLLOW_REPLIES);
  return v === undefined ? false : v;
}

export function setShowNonFollowReplies(enabled: boolean): void {
  feedPrefsStore.set(K_SHOW_NON_FOLLOW_REPLIES, enabled);
}
