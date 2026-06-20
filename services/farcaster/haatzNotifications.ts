/**
 * haatzNotifications — a second, auth-free source of Farcaster notifications.
 *
 * The primary in-app notifications feed comes from farcaster.xyz's web API
 * (`notifications-for-tab`), which needs a custody-derived bearer token and
 * is therefore unavailable when the user hasn't linked Farcaster or the
 * token has lapsed. Hypersnap (hosted at haatz.quilibrium.com) exposes the
 * same activity by `fid` with no auth, so we blend it in for resilience and
 * dedupe against the official source in useUnifiedNotifications.
 *
 * Shape returned by GET /v2/farcaster/notifications?fid=<fid>&limit=N:
 *   { "notifications": [
 *       { "object": "notification",
 *         "type": "likes" | "reply" | "follows" | "mention",
 *         "cast": { "hash", "text", "author": { "username" } } | null,
 *         "user": { "fid", "username", ... },
 *         "timestamp": "2026-06-11T03:21:45.000Z" | "<farcaster-epoch secs>" }
 *   ] }
 *
 * Field names differ from the official API: `user` (not `actor`), plural
 * `likes`/`follows` types, no stable id / unread flag / pfp. We normalize
 * into the shared FarcasterNotification shape so the rest of the pipeline
 * (titles, routing, dedup) treats both sources uniformly.
 */

import type {
  FarcasterNotification,
  FarcasterNotificationType,
} from '@/services/farcasterClient';

/** Hypersnap base (the public "haatz" deployment). */
const HAATZ_BASE_URL = 'https://haatz.quilibrium.com';

/** Farcaster epoch (2021-01-01T00:00:00Z) in unix seconds. */
const FARCASTER_EPOCH_SECONDS = 1609459200;

interface HaatzCast {
  hash?: string;
  text?: string;
  author?: { username?: string };
}

interface HaatzNotification {
  type?: string;
  timestamp?: string | number;
  cast?: HaatzCast | null;
  user?: { fid?: number; username?: string };
}

/**
 * Parse haatz's timestamp into ms epoch. Accepts ISO-8601 strings, or a
 * numeric/string value that may be Farcaster-epoch seconds, unix seconds,
 * or unix ms — disambiguated by magnitude (mirrors the Go reference in
 * quorum-api's farcaster_push.go).
 */
function parseHaatzTimestamp(ts: string | number | undefined): number {
  if (ts == null) return 0;
  if (typeof ts === 'string') {
    // ISO-8601 first (the common case).
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) return parsed;
    const n = Number(ts);
    if (Number.isNaN(n)) return 0;
    return magnitudeToMs(n);
  }
  return magnitudeToMs(ts);
}

function magnitudeToMs(v: number): number {
  if (v < 1e9) return (v + FARCASTER_EPOCH_SECONDS) * 1000; // farcaster-epoch seconds
  if (v < 1e11) return v * 1000; // unix seconds
  return v; // already ms
}

/** Map haatz's type vocabulary into the shared FarcasterNotificationType. */
function mapType(type: string | undefined): FarcasterNotificationType {
  switch ((type ?? '').toLowerCase()) {
    case 'likes':
    case 'like':
      return 'cast-like';
    case 'recasts':
    case 'recast':
      return 'cast-recast';
    case 'reply':
    case 'replies':
      return 'cast-reply';
    case 'mention':
    case 'mentions':
      return 'cast-mention';
    case 'follows':
    case 'follow':
      return 'follow';
    default:
      return type ?? 'unknown';
  }
}

function normalize(n: HaatzNotification): FarcasterNotification | null {
  const type = mapType(n.type);
  const timestamp = parseHaatzTimestamp(n.timestamp);
  const actorFid = n.user?.fid;
  const actorUsername = n.user?.username;
  const castHash = n.cast?.hash;

  // A notification with neither an actor nor a cast carries no usable
  // information — drop it rather than render an empty row.
  if (actorFid == null && !actorUsername && !castHash) return null;

  const content = castHash
    ? {
        cast: {
          hash: castHash,
          text: n.cast?.text,
          author: n.cast?.author?.username
            ? { fid: actorFid ?? 0, username: n.cast.author.username }
            : undefined,
        },
      }
    : undefined;

  // Synthesize a stable-enough id for the in-source seen-set. Cross-source
  // dedup uses a separate heuristic key (see useUnifiedNotifications).
  const idParts = [type, String(actorFid ?? actorUsername ?? '?'), castHash ?? '', String(timestamp)];
  const id = `haatz:${idParts.join(':')}`;

  return {
    id,
    type,
    timestamp,
    reactionType: type === 'cast-like' ? 'like' : undefined,
    actor:
      actorFid != null || actorUsername
        ? { fid: actorFid ?? 0, username: actorUsername, displayName: actorUsername }
        : undefined,
    content,
    raw: { source: 'haatz', original: n as unknown as Record<string, unknown> },
  };
}

/**
 * Fetch + normalize notifications from haatz for the given fid. Resolves to
 * an empty array on any failure — this is a best-effort supplementary
 * source and must never surface an error to the user.
 */
export async function fetchHaatzNotifications(
  fid: number,
  limit = 25,
): Promise<FarcasterNotification[]> {
  try {
    const url = `${HAATZ_BASE_URL}/v2/farcaster/notifications?fid=${encodeURIComponent(
      String(fid),
    )}&limit=${limit}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const json = (await res.json()) as { notifications?: HaatzNotification[] } | null;
    const list = json?.notifications;
    if (!Array.isArray(list)) return [];
    const out: FarcasterNotification[] = [];
    for (const n of list) {
      const normalized = normalize(n);
      if (normalized) out.push(normalized);
    }
    return out;
  } catch {
    return [];
  }
}
