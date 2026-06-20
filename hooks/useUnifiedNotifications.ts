/**
 * useUnifiedNotifications — merges Farcaster notifications (mentions,
 * replies, likes, recasts, follows) with the local chat notification log
 * (every showMessageNotification call gets logged). The notifications
 * tab + the bell-icon badge both consume this so they stay in sync.
 *
 * Items are normalized to a single shape and sorted newest-first.
 * Unread count is the number of items with timestamp > lastSeen, where
 * lastSeen is shared across both sources via MMKV.
 */

import { useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  flattenFarcasterNotifications,
  useFarcasterNotifications,
} from './useFarcasterNotifications';
import { useHaatzNotifications } from './useHaatzNotifications';
import { isScamCast } from '@/services/farcaster/scamFilter';
import {
  getLastSeenTimestamp,
  useNotificationLog,
  type NotificationLogEntry,
} from '@/services/notifications/notificationLog';
import type {
  FarcasterNotification,
  FarcasterNotificationType,
} from '@/services/farcasterClient';

export type UnifiedNotificationSource = 'chat' | 'farcaster';

export interface UnifiedNotification {
  id: string;
  source: UnifiedNotificationSource;
  /** ms epoch — used for sort order and unread comparison. */
  timestamp: number;
  title: string;
  body?: string;
  actorAvatarUrl?: string;
  /** Routing payload — consumer picks branch on `type` to deep-link. */
  link?:
    | { type: 'message'; spaceId?: string; channelId?: string; conversationId?: string }
    | { type: 'cast'; castHash: string; username?: string }
    | { type: 'frame'; url: string };
  /** Original objects in case a renderer wants more detail. */
  raw?: { chat?: NotificationLogEntry; farcaster?: FarcasterNotification };
}

function actorName(n: FarcasterNotification): string {
  // Mini-app / frame notifications often have no user actor at all —
  // they come from the app itself. Use the app's name as the "who" so
  // the entry isn't shown as "Someone — mini-app". The frame object
  // is populated by the normalizer when the preview shape includes
  // any frame/miniApp/app metadata.
  if (n.frame?.name) return n.frame.name;
  return (
    n.actor?.displayName ??
    n.actor?.username ??
    (n.actor?.fid != null ? `fid:${n.actor.fid}` : 'Someone')
  );
}

function castSnippet(n: FarcasterNotification): string {
  const text = n.content?.cast?.text ?? '';
  return text.length > 140 ? text.slice(0, 140) + '…' : text;
}

function othersSuffix(total: number | undefined): string {
  if (!total || total <= 1) return '';
  const others = total - 1;
  return ` and ${others} other${others === 1 ? '' : 's'}`;
}

function reactionVerb(n: FarcasterNotification): string {
  // The /notifications-for-tab response carries `reaction.type` on each
  // preview item — usually "like". Default to "liked" when present;
  // reserve room for other reaction types Warpcast may add later.
  const t = n.reactionType?.toLowerCase();
  if (!t || t === 'like') return 'liked';
  return `reacted (${t}) to`;
}

function farcasterTitleAndBody(n: FarcasterNotification): { title: string; body?: string } {
  const who = actorName(n);
  const suffix = othersSuffix(n.totalItemCount);
  switch (n.type as FarcasterNotificationType) {
    case 'cast-reaction':
    case 'cast-like':
    case 'like':
      return {
        title: `${who}${suffix} ${reactionVerb(n)} your cast`,
        body: castSnippet(n) || undefined,
      };
    case 'cast-recast':
    case 'recast':
      return {
        title: `${who}${suffix} recasted your cast`,
        body: castSnippet(n) || undefined,
      };
    case 'cast-mention':
    case 'mention':
      return { title: `${who} mentioned you`, body: castSnippet(n) || undefined };
    case 'cast-reply':
    case 'reply':
      return { title: `${who} replied to your cast`, body: castSnippet(n) || undefined };
    case 'cast-quote':
    case 'quote':
      return { title: `${who} quoted your cast`, body: castSnippet(n) || undefined };
    case 'follow':
      return { title: `${who}${suffix} followed you` };
    default:
      // Mini-app / frame notifications carry a body from the app —
      // show it directly with the app name as the title. Avoids the
      // ugly "Someone • mini-app" fallback that comes from joining
      // the unresolved actor + raw type name.
      if (n.frame?.body) {
        return { title: who, body: n.frame.body };
      }
      // Other unknown types — best-effort generic title without the
      // raw type slug, which leaked Warpcast internals to the user.
      return { title: who, body: castSnippet(n) || undefined };
  }
}

function farcasterToUnified(n: FarcasterNotification): UnifiedNotification {
  const { title, body } = farcasterTitleAndBody(n);
  const cast = n.content?.cast;
  // Routing priority: a cast (the most specific deep-link target) wins
  // over a frame URL. Mini-app notifications typically have NO cast,
  // only a frame.targetUrl — those route to the in-app browser via a
  // `frame` link type.
  let link: UnifiedNotification['link'] | undefined;
  if (cast?.hash) {
    link = {
      type: 'cast',
      castHash: cast.hash,
      username: cast.author?.username ?? n.actor?.username,
    };
  } else if (n.frame?.targetUrl) {
    link = { type: 'frame', url: n.frame.targetUrl };
  }
  return {
    id: `fc:${n.id}`,
    source: 'farcaster',
    timestamp: n.timestamp,
    title,
    body,
    // Prefer the actor avatar; fall back to the frame's icon for
    // mini-app entries so the row has a recognizable affordance.
    actorAvatarUrl: n.actor?.pfp?.url ?? n.frame?.iconUrl,
    link,
    raw: { farcaster: n },
  };
}

type CanonicalType = 'like' | 'recast' | 'mention' | 'reply' | 'quote' | 'follow' | 'other';

/**
 * Collapse the two sources' wildly different type vocabularies into one
 * canonical bucket so we can dedup across them. The official farcaster.xyz
 * feed and haatz use different (and, on the official side, not fully
 * documented) spellings — `cast-like` vs `likes` vs `reactions`, `cast-reply`
 * vs `replies`, etc. Substring matching is deliberately tolerant so an
 * unanticipated spelling on either side doesn't silently fall to `other` and
 * break dedup (the bug that let mirrored notifications show twice).
 *
 * `reactions` is ambiguous (Warpcast groups likes AND recasts under it), so we
 * disambiguate with `reactionType` when the type itself is generic.
 */
function canonicalType(n: FarcasterNotification): CanonicalType {
  const t = (n.type ?? '').toLowerCase();
  if (t.includes('follow')) return 'follow';
  if (t.includes('quote')) return 'quote';
  if (t.includes('mention')) return 'mention';
  if (t.includes('repl')) return 'reply';
  if (t.includes('recast')) return 'recast';
  if (t.includes('react') || t.includes('like')) {
    return (n.reactionType ?? '').toLowerCase().includes('recast') ? 'recast' : 'like';
  }
  return 'other';
}

/** Canonicalize a cast hash for keying: lowercase, strip an optional 0x. */
function normHash(hash: string | undefined): string | undefined {
  return hash ? hash.toLowerCase().replace(/^0x/, '') : undefined;
}

/**
 * Heuristic cross-source dedup key. The two sources share no ids and won't
 * agree on timestamps to the second, so we key on stable semantic fields:
 *
 *   - likes/recasts: the official feed AGGREGATES these per cast ("X and 5
 *     others liked"), so we key at cast level — this drops every per-actor
 *     haatz like for a cast already covered by the official aggregate.
 *   - replies/mentions/quotes: distinct per (actor, cast).
 *   - follows: keyed by actor fid (no cast involved).
 *
 * Returns null when the notification lacks the fields to build a key, in
 * which case it's never treated as a duplicate.
 */
function dedupKey(n: FarcasterNotification): string | null {
  const ct = canonicalType(n);
  const castHash = normHash(n.content?.cast?.hash);
  const actorFid = n.actor?.fid;
  if (ct === 'follow') return actorFid != null ? `follow:${actorFid}` : null;
  // Likes/recasts reference a SHARED cast (yours) and aggregate across many
  // actors, so key per (type, cast) — type separates a like from a recast on
  // the same cast.
  if (ct === 'like' || ct === 'recast') return castHash ? `${ct}:${castHash}` : null;
  // Replies/mentions/quotes (and any other cast-bearing notification) each
  // reference the NEW cast that was created, whose hash is globally unique —
  // so key by the hash ALONE. This deliberately ignores both the actor (the
  // official feed often omits it for mentions, putting the author on the cast
  // instead — the actor-fid asymmetry that let mentions slip through) and the
  // specific label (a reply that also mentions you can arrive as `reply` from
  // one source and `mention` from the other — same cast, one notification).
  if (castHash) return `cast:${castHash}`;
  return null;
}

/**
 * Merge the official farcaster.xyz feed with the haatz feed, dropping any
 * haatz item that the official feed already represents. Official items are
 * preferred (richer: stable id, unread flag, aggregation counts, pfp).
 */
function blendFarcasterSources(
  official: FarcasterNotification[],
  haatz: FarcasterNotification[],
): FarcasterNotification[] {
  const officialKeys = new Set<string>();
  for (const n of official) {
    const k = dedupKey(n);
    if (k) officialKeys.add(k);
  }
  const extra = haatz.filter((n) => {
    const k = dedupKey(n);
    return !k || !officialKeys.has(k);
  });
  return [...official, ...extra];
}

function chatToUnified(e: NotificationLogEntry): UnifiedNotification {
  const data = e.data;
  const link: UnifiedNotification['link'] | undefined =
    data?.type === 'message'
      ? {
          type: 'message',
          spaceId: data.spaceId,
          channelId: data.channelId,
          conversationId: data.conversationId,
        }
      : undefined;
  return {
    id: `chat:${e.id}`,
    source: 'chat',
    timestamp: e.createdAt,
    title: e.title,
    body: e.body,
    link,
    raw: { chat: e },
  };
}

export interface UnifiedNotificationsResult {
  items: UnifiedNotification[];
  unreadCount: number;
  isLoading: boolean;
  isFetchingMore: boolean;
  hasMore: boolean;
  fetchMore: () => void;
  refetch: () => void;
  farcasterEnabled: boolean;
  /** Surfaces fetch errors to the screen so the user can see why the
   *  Farcaster portion of the feed is empty (auth expiry, 5xx, etc.)
   *  instead of being told there are no notifications. */
  farcasterError: Error | null;
}

export function useUnifiedNotifications(): UnifiedNotificationsResult {
  const { farcasterAuthToken } = useAuth();
  const { entries: chatEntries } = useNotificationLog();
  const farcasterQuery = useFarcasterNotifications(farcasterAuthToken ?? undefined);
  // Supplementary auth-free source (hypersnap/haatz). Blended in and
  // deduped against the official feed so notifications still show when the
  // farcaster.xyz bearer token is missing or expired.
  const haatzQuery = useHaatzNotifications();

  const farcasterItems = useMemo(() => {
    const isNotScam = (n: FarcasterNotification) =>
      // Suppress notifications whose target/preview cast references the
      // hyrpia.xyz wallet-drainer scam — see scamFilter.ts.
      !isScamCast(n.content?.cast as unknown as Parameters<typeof isScamCast>[0]);
    const official = flattenFarcasterNotifications(farcasterQuery.data?.pages).filter(isNotScam);
    const haatz = (haatzQuery.data ?? []).filter(isNotScam);
    return blendFarcasterSources(official, haatz);
  }, [farcasterQuery.data?.pages, haatzQuery.data]);

  const items = useMemo(() => {
    const merged: UnifiedNotification[] = [
      ...chatEntries.map(chatToUnified),
      ...farcasterItems.map(farcasterToUnified),
    ];
    merged.sort((a, b) => b.timestamp - a.timestamp);
    return merged;
  }, [chatEntries, farcasterItems]);

  const unreadCount = useMemo(() => {
    // Prefer the server's per-notification isUnread for Farcaster items
    // (it survives mark-all-read calls from the web client), fall back
    // to lastSeen for chat items where we don't have a server flag.
    const lastSeen = getLastSeenTimestamp();
    return items.reduce((n, e) => {
      if (e.source === 'farcaster') {
        const isUnread = e.raw?.farcaster?.isUnread;
        if (typeof isUnread === 'boolean') return isUnread ? n + 1 : n;
      }
      return e.timestamp > lastSeen ? n + 1 : n;
    }, 0);
  }, [items]);

  return {
    items,
    unreadCount,
    isLoading: farcasterQuery.isLoading || haatzQuery.isLoading,
    isFetchingMore: farcasterQuery.isFetchingNextPage,
    hasMore: !!farcasterQuery.hasNextPage,
    fetchMore: () => {
      if (farcasterQuery.hasNextPage && !farcasterQuery.isFetchingNextPage) {
        void farcasterQuery.fetchNextPage();
      }
    },
    refetch: () => {
      void farcasterQuery.refetch();
      void haatzQuery.refetch();
    },
    farcasterEnabled: !!farcasterAuthToken,
    // Only surface the official-feed error when the blended list is empty —
    // if haatz (or anything) filled the feed, a farcaster.xyz auth lapse or
    // 5xx shouldn't show an error banner. Per the resilience requirement:
    // don't error out just because the official source didn't appear.
    farcasterError:
      farcasterItems.length > 0 ? null : ((farcasterQuery.error as Error | null) ?? null),
  };
}
