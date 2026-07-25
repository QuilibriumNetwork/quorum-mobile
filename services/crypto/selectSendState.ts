/**
 * Choosing which stored session to SEND with, when several share a device tag.
 *
 * Multiple rows legitimately share one tag: a session we created by sending
 * first (initially unconfirmed) can coexist with one created by RECEIVING the
 * peer's init envelope (born send-ready with their full return-inbox keys).
 *
 * The rule is: prefer a send-ready row, and among send-ready rows prefer the
 * NEWEST.
 *
 * Recency is the part that matters and was missing. When the peer resets their
 * session they mint a new receiving inbox and tell us about it in a fresh init
 * envelope — but they cannot delete our old row. So we end up holding BOTH a
 * stale confirmed row (pointing at an inbox the peer has abandoned) and the new
 * one. Both look send-ready, so selecting by array order silently kept using the
 * dead inbox: the peer's reset never propagated, our messages vanished into a
 * black hole while theirs kept arriving. A reset is meant to be one-sided — one
 * user resets, their next message carries the new session, and both converge.
 * That only works if the newest session wins here.
 */

export type SendCandidate = {
  timestamp?: number;
  sendingInbox?: { inbox_public_key?: string };
};

/** Newest first; rows without a timestamp sort last. */
function newestFirst<T extends SendCandidate>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

/**
 * Pick the session to send with from the rows matching a device tag.
 * Returns undefined when there are none (caller establishes a new session).
 */
export function selectSendState<T extends SendCandidate>(tagMatches: T[]): T | undefined {
  if (tagMatches.length === 0) return undefined;
  const ordered = newestFirst(tagMatches);
  // A send-ready row (peer's return inbox known) skips init-envelope wrapping.
  return ordered.find((s) => s.sendingInbox?.inbox_public_key) ?? ordered[0];
}
