/**
 * haatzNotifications — the in-app Farcaster notifications feed, from
 * Hypersnap (the public "haatz" deployment) by `fid`, with no auth.
 *
 * Shape returned by GET /v2/farcaster/notifications?fid=<fid>&limit=N[&cursor=]:
 *   { "notifications": [
 *       { "object": "notification",
 *         "type": "likes" | "recasts" | "reply" | "follows" | "mention",
 *         "cast": { "hash", "text", "author": <user> } | null,
 *         "user": <user: fid, username, display_name, pfp_url, ...>,
 *         "timestamp": "2026-06-11T03:21:45.000Z" | "<farcaster-epoch secs>" }
 *     ],
 *     "next": { "cursor": "<opaque>" | null } }
 *
 * `user` is who acted. For a like or recast, `cast` is the viewer's cast that
 * was reacted to; for a reply or mention it is the new cast. Rows carry no
 * stable id, unread flag or aggregation count, and Hypersnap does not report
 * quote casts or mini-app notifications (FARCASTER_TECH_DEBT.md). We
 * normalize into the shared FarcasterNotification shape so the rest of the
 * pipeline (titles, routing, dismissal) is source-agnostic.
 */

import { DEFAULT_HYPERSNAP_BASE_URL } from '@quilibrium/quorum-shared';
import type {
  FarcasterNotification,
  FarcasterNotificationsPage,
  FarcasterNotificationType,
} from '@/services/farcasterClient';

/** Farcaster epoch (2021-01-01T00:00:00Z) in unix seconds. */
const FARCASTER_EPOCH_SECONDS = 1609459200;

interface HaatzUser {
  fid?: number;
  username?: string;
  display_name?: string;
  pfp_url?: string;
}

interface HaatzCast {
  hash?: string;
  text?: string;
  author?: HaatzUser;
}

interface HaatzNotification {
  type?: string;
  timestamp?: string | number;
  cast?: HaatzCast | null;
  user?: HaatzUser;
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
  const rawCastHash = n.cast?.hash;
  // Hypersnap sends bare hex; everything downstream (thread routes, cast
  // lookups) uses the `0x…` form the rest of the app's casts carry.
  const castHash = rawCastHash ? `0x${rawCastHash.replace(/^0x/i, '')}` : undefined;

  // A notification with neither an actor nor a cast carries no usable
  // information — drop it rather than render an empty row.
  if (actorFid == null && !actorUsername && !castHash) return null;

  const castAuthor = n.cast?.author;
  const content = castHash
    ? {
        cast: {
          hash: castHash,
          text: n.cast?.text,
          author:
            castAuthor?.fid != null
              ? {
                  fid: castAuthor.fid,
                  username: castAuthor.username,
                  displayName: castAuthor.display_name || undefined,
                }
              : undefined,
        },
      }
    : undefined;

  // Synthesize a stable-enough id for the in-source seen-set. Built from the
  // raw hash so ids already in someone's seen-set keep matching.
  const idParts = [type, String(actorFid ?? actorUsername ?? '?'), rawCastHash ?? '', String(timestamp)];
  const id = `haatz:${idParts.join(':')}`;

  return {
    id,
    type,
    timestamp,
    reactionType: type === 'cast-like' ? 'like' : type === 'cast-recast' ? 'recast' : undefined,
    actor:
      actorFid != null || actorUsername
        ? {
            fid: actorFid ?? 0,
            username: actorUsername,
            displayName: n.user?.display_name || actorUsername,
            pfp: n.user?.pfp_url ? { url: n.user.pfp_url } : undefined,
          }
        : undefined,
    content,
    raw: { source: 'haatz', original: n as unknown as Record<string, unknown> },
  };
}

/**
 * Fetch + normalize one page of notifications from haatz for the given fid.
 * Throws on network or HTTP failure, so a query keeps its last good data
 * instead of being replaced by an empty page.
 */
export async function fetchHaatzNotifications(
  fid: number,
  cursor?: string,
  limit = 25,
): Promise<FarcasterNotificationsPage> {
  const params = new URLSearchParams({ fid: String(fid), limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  const res = await fetch(`${DEFAULT_HYPERSNAP_BASE_URL}/v2/farcaster/notifications?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Hypersnap notifications failed (${res.status})`);
  const json = (await res.json()) as {
    notifications?: HaatzNotification[];
    next?: { cursor?: string | null };
  } | null;
  const out: FarcasterNotification[] = [];
  for (const n of Array.isArray(json?.notifications) ? json.notifications : []) {
    const normalized = normalize(n);
    if (normalized) out.push(normalized);
  }
  return { notifications: out, nextCursor: json?.next?.cursor || null };
}
