/**
 * Pure core of the unified notifications panel.
 *
 * Everything here is a plain function over plain data — no React, no MMKV, no
 * network — so the panel's real behavior (dedup across the two Farcaster
 * sources, dismissal, muted-DM exclusion, badge arithmetic) can be unit-tested
 * without a renderer. `useUnifiedNotifications` is a thin wrapper that gathers
 * the inputs and calls `partitionNotifications`.
 */

import { isScamCast } from '@/services/farcaster/scamFilter';
import { isDismissed, reachedWatermark } from './farcasterDismissal';
import { notificationLogOrigin, type NotificationLogEntry } from './notificationLog';
import type { MentionReplyEntry } from './mentionReplyLog';
import type {
  FarcasterNotification,
  FarcasterNotificationType,
} from '@/services/farcasterClient';

export type UnifiedNotificationSource = 'chat' | 'farcaster' | 'quorum';

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
  raw?: {
    chat?: NotificationLogEntry;
    farcaster?: FarcasterNotification;
    quorum?: MentionReplyEntry;
  };
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

export function farcasterToUnified(n: FarcasterNotification): UnifiedNotification {
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
export function blendFarcasterSources(
  official: readonly FarcasterNotification[],
  haatz: readonly FarcasterNotification[],
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

export function chatToUnified(e: NotificationLogEntry): UnifiedNotification {
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

function quorumTitle(e: MentionReplyEntry): string {
  const who = e.senderName || 'Someone';
  switch (e.kind) {
    case 'mention-you':
      return `${who} mentioned you`;
    case 'mention-everyone':
      return `${who} mentioned @everyone`;
    case 'mention-roles':
      return `${who} mentioned a role you have`;
    case 'reply':
      return `${who} replied to you`;
    default:
      return who;
  }
}

/** Channel breadcrumb + message preview text, e.g. "#general · hey there". */
function quorumBody(e: MentionReplyEntry): string {
  const channel = e.channelName ? `#${e.channelName}` : '#channel';
  const crumb = e.threadId ? `${channel} › Thread` : channel;
  const text = e.preview?.text?.trim();
  return text ? `${crumb} · ${text}` : crumb;
}

export function quorumToUnified(e: MentionReplyEntry): UnifiedNotification {
  return {
    id: `quorum:${e.id}`,
    source: 'quorum',
    timestamp: e.createdAt,
    title: quorumTitle(e),
    body: quorumBody(e),
    link: { type: 'message', spaceId: e.spaceId, channelId: e.channelId },
    raw: { quorum: e },
  };
}

function isNotScam(n: FarcasterNotification): boolean {
  // Suppress notifications whose target/preview cast references the
  // hyrpia.xyz wallet-drainer scam — see scamFilter.ts.
  return !isScamCast(n.content?.cast as unknown as Parameters<typeof isScamCast>[0]);
}

export interface PartitionInput {
  quorumEntries: readonly MentionReplyEntry[];
  /** Background-push mirrors. These are QUORUM messages, not Farcaster. */
  chatEntries: readonly NotificationLogEntry[];
  officialFarcaster: readonly FarcasterNotification[];
  haatzFarcaster: readonly FarcasterNotification[];
  /** Farcaster dismissal watermark; 0 = never cleared. */
  clearedBefore: number;
  mutedConversations: ReadonlySet<string>;
  /** Chat-log "seen" watermark, for the badge. */
  lastSeen: number;
  /** Quorum mention-log unread count (its own watermark), for the badge. */
  quorumTabUnread: number;
}

export interface PartitionResult {
  /** "Mentions & messages" section: space mentions/replies + background pings. */
  quorumItems: UnifiedNotification[];
  /** "Farcaster" section: Farcaster activity only. */
  farcasterFeedItems: UnifiedNotification[];
  /** Both sections merged, newest-first. */
  items: UnifiedNotification[];
  unreadCount: number;
  /** True once the fetched official pages reach the dismissal watermark. */
  reachedWatermark: boolean;
}

export function partitionNotifications(input: PartitionInput): PartitionResult {
  const {
    quorumEntries,
    chatEntries,
    officialFarcaster,
    haatzFarcaster,
    clearedBefore,
    mutedConversations,
    lastSeen,
    quorumTabUnread,
  } = input;

  const official = officialFarcaster.filter(isNotScam);
  const haatz = haatzFarcaster.filter(isNotScam);

  // BLEND BEFORE DISMISSING — order matters and is load-bearing.
  // `blendFarcasterSources` drops haatz items whose key an official item
  // already covers. Filter the official list FIRST and a dismissed like-group
  // falls out of that key set, so its per-actor haatz duplicates stop being
  // deduped and resurface as one fresh row per liker for a cast the user just
  // cleared.
  const blended = blendFarcasterSources(official, haatz);
  const visibleFarcaster = blended.filter((n) => !isDismissed(n.timestamp, clearedBefore));

  // Gate pagination on the OFFICIAL feed only — it is the paginated source
  // (haatz is a single capped fetch, so its depth says nothing about whether
  // more official pages are worth loading). Uses the raw pre-dismissal list:
  // the filtered one has by definition dropped the evidence this needs.
  const reached = reachedWatermark(official, clearedBefore);

  // Muted DMs are excluded from the panel entirely, consistent with the badge
  // and push suppression. The conversation stays reachable via the Messages
  // tab. Chat rows are the only rows that carry a conversationId, so this is
  // a no-op for the rest — but it MUST travel with the chat rows.
  const notMutedDM = (e: UnifiedNotification): boolean => {
    const convId = e.link?.type === 'message' ? e.link.conversationId : undefined;
    return !(convId && mutedConversations.has(convId));
  };

  const chatItems = chatEntries.map(chatToUnified).filter(notMutedDM);
  // Background pings are raised for BOTH Quorum messages and Farcaster direct
  // casts into one undifferentiated log, so they have to be split by origin —
  // filing the whole log under either heading mislabels the other half.
  const quorumChat = chatItems.filter(
    (e) => e.raw?.chat && notificationLogOrigin(e.raw.chat) === 'quorum',
  );
  const farcasterChat = chatItems.filter(
    (e) => e.raw?.chat && notificationLogOrigin(e.raw.chat) === 'farcaster',
  );

  // Section 1 — Quorum: space mentions/replies + Quorum background pings.
  // Space channel mute is already enforced upstream at log-write time via
  // shouldNotifyForContext.
  const quorumItems = [...quorumEntries.map(quorumToUnified), ...quorumChat];
  quorumItems.sort((a, b) => b.timestamp - a.timestamp);

  // Section 2 — Farcaster activity + Farcaster direct-cast pings.
  const farcasterOnly = visibleFarcaster.map(farcasterToUnified);
  const farcasterFeedItems = [...farcasterOnly, ...farcasterChat];
  farcasterFeedItems.sort((a, b) => b.timestamp - a.timestamp);

  const items = [...quorumItems, ...farcasterFeedItems];
  items.sort((a, b) => b.timestamp - a.timestamp);

  // Tab badge (Level 1). Three sources, each with its own "seen" model:
  //  - Quorum mentions: entries newer than the last tab-open, counted by the
  //    mention log itself (decoupled from per-channel read state).
  //  - background pings: the chat log's lastSeen. These are NOT covered by the
  //    mention log's watermark, so they must be counted separately — folding
  //    them in silently stops the badge from reflecting them.
  //  - Farcaster: prefer the server isUnread flag (survives a mark-all-read
  //    performed on the web client), else fall back to lastSeen.
  // Counted over `chatItems` (both origins) and `farcasterOnly` (real Farcaster
  // notifications) rather than the two SECTION arrays — the Farcaster section
  // also holds Farcaster direct-cast pings, which are chat rows, so summing the
  // sections would count those twice.
  const chatUnread = chatItems.reduce((n, e) => (e.timestamp > lastSeen ? n + 1 : n), 0);
  const farcasterUnread = farcasterOnly.reduce((n, e) => {
    const isUnread = e.raw?.farcaster?.isUnread;
    if (typeof isUnread === 'boolean') return isUnread ? n + 1 : n;
    return e.timestamp > lastSeen ? n + 1 : n;
  }, 0);

  return {
    quorumItems,
    farcasterFeedItems,
    items,
    unreadCount: quorumTabUnread + chatUnread + farcasterUnread,
    reachedWatermark: reached,
  };
}
