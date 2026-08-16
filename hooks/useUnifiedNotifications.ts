/**
 * useUnifiedNotifications — gathers the notification panel's inputs (the two
 * Farcaster feeds, the Quorum mention log, the background-push chat log, mute
 * state, dismissal watermark) and hands them to `partitionNotifications`.
 *
 * All the actual logic — cross-source dedup, dismissal, muted-DM exclusion,
 * badge arithmetic — lives in that pure module so it can be unit-tested
 * without a renderer. This file should stay thin.
 *
 * Two sections come back: "Quorum" (mentions/replies plus background message
 * pings) and "Farcaster". The notifications tab and the
 * bell-icon badge both consume this so they stay in sync.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  flattenFarcasterNotifications,
  useFarcasterNotifications,
} from './useFarcasterNotifications';
import { useHaatzNotifications } from './useHaatzNotifications';
import { useDMMute } from '@/hooks/chat/useDMMute';
import { useUnifiedConversations } from '@/hooks/chat/useUnifiedConversations';
import type { Conversation } from '@/hooks/chat/useConversations';
import { coerceMessagePreview } from '@/utils/messagePreview';
import { mentionedAddresses } from '@/utils/mentionTokens';
import { truncateAddress } from '@/utils/formatAddress';
import { useNameResolver } from '@/identity';
import { formatResolvedName } from '@/identity/useResolvedName';
import { qnsLookupAddresses, MAX_QNS_LOOKUPS } from '@/hooks/chat/useConversationsWithQnsNames';
import {
  getLastSeenTimestamp,
  useNotificationLog,
} from '@/services/notifications/notificationLog';
import {
  getQuorumTabSeenAt,
  useMentionReplyLog,
} from '@/services/notifications/mentionReplyLog';
import {
  useFarcasterClearedBefore,
  useFarcasterDismissedKeys,
} from '@/services/notifications/farcasterDismissal';
import { partitionNotifications } from '@/services/notifications/partitionNotifications';
import type {
  ConversationDetail,
  NotificationNameResolver,
  UnifiedNotification,
} from '@/services/notifications/partitionNotifications';

// Re-exported so existing consumers keep importing the row type from the hook.
export type {
  UnifiedNotification,
  UnifiedNotificationSource,
} from '@/services/notifications/partitionNotifications';

export interface UnifiedNotificationsResult {
  items: UnifiedNotification[];
  /** Quorum mentions/replies + background message pings, newest-first. */
  quorumItems: UnifiedNotification[];
  /** Farcaster activity, newest-first. */
  farcasterFeedItems: UnifiedNotification[];
  unreadCount: number;
  /** Farcaster rows currently hidden by dismissal — watermark and per-row
   *  trash together (dev panel). */
  dismissedCount: number;
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

export interface UseUnifiedNotificationsOptions {
  /**
   * Join the background message pings to the live conversation list so their
   * rows name the sender and show the message instead of reading "New
   * Messages". Costs mounting the Farcaster conversations query (a background
   * poll), so only the panel asks for it — the tab badge counts rows and does
   * not care what they say.
   */
  enrichConversations?: boolean;
}

/**
 * A resolvable last-message sender: a Quorum (not Farcaster — `address` there
 * is a synthetic `fid:<n>`, a separate identity namespace with no roster and
 * no `.q`; routing it through the member resolver would resolve a Farcaster
 * author against Quorum rosters) 1:1 conversation whose last message wasn't
 * the viewer's own ('You' names no member — it is a literal, never a lookup).
 */
function isResolvableQuorumSender(c: Conversation): boolean {
  return (
    c.type === 'direct' &&
    c.source !== 'farcaster' &&
    !!c.lastMessageSenderName &&
    c.lastMessageSenderName !== 'You'
  );
}

/**
 * A Quorum 1:1 conversation whose PARTNER has a real address.
 *
 * Deliberately NOT `isResolvableQuorumSender`, which additionally requires that
 * the partner sent the last message. That is the right test for the "who spoke"
 * prefix and the wrong one for the row's TITLE: the title names the same person
 * whichever way the last message went, so gating it on the sender left every
 * conversation you replied to most recently titled with an unresolved name.
 *
 * A Farcaster row carries the synthetic address `fid:<n>` — a separate identity
 * namespace with no Quorum profile and no `.q` — so it is excluded here for the
 * same reason `qnsLookupAddresses` excludes it.
 */
function isQuorumDirectPartner(c: Conversation): boolean {
  return (
    c.type === 'direct' &&
    c.source !== 'farcaster' &&
    !!c.address &&
    !c.address.startsWith('fid:')
  );
}

export function useUnifiedNotifications(
  options: UseUnifiedNotificationsOptions = {},
): UnifiedNotificationsResult {
  const { enrichConversations = false } = options;
  const { farcasterAuthToken } = useAuth();
  const { entries: chatEntries } = useNotificationLog();
  const { entries: quorumEntries } = useMentionReplyLog();
  const farcasterQuery = useFarcasterNotifications(farcasterAuthToken ?? undefined);
  // Supplementary auth-free source (hypersnap/haatz). Blended in and
  // deduped against the official feed so notifications still show when the
  // farcaster.xyz bearer token is missing or expired.
  const haatzQuery = useHaatzNotifications();
  // Consuming the hook (vs reading MMKV) makes the panel recompute the moment
  // a mute toggles.
  const { mutedConversations } = useDMMute();
  // Local dismissal watermark — Farcaster rows can't be cleared server-side.
  const clearedBefore = useFarcasterClearedBefore();
  // …and the per-row trash, which the watermark alone can't express.
  const dismissedKeys = useFarcasterDismissedKeys();

  // Render-time enrichment source for the message rows. Covers BOTH products:
  // the Farcaster direct-cast pings (whose log stores only a routing id, on
  // purpose) and the Quorum DM rows (whose log stores no avatar). Joined back
  // on every render rather than written into the log.
  const dmConversations = useUnifiedConversations({ enabled: enrichConversations });

  // `c.lastMessageSenderName` is frozen at message-receive time
  // (WebSocketContext.tsx) — a rename between then and now leaves it stale
  // forever. The write stays (standing decision); this resolves the CURRENT
  // name through the identity ladder instead of reading that string.
  //
  // 'You' (set by useSendDirectMessage/useSendDirectEmbedMessage for the
  // viewer's own last message) is a literal, never a lookup — it names no
  // member. Every other real Quorum conversation on mobile is 1:1 (there is
  // no group-DM creation flow), so the only possible non-self sender IS the
  // conversation's own `address` — the same address `conversationSnippet`'s
  // `displayName` already names, which is exactly why a resolvable sender
  // stops showing a redundant prefix once it agrees with a fresh title, the
  // same way it already suppressed one against the frozen title.
  //
  // Global ladder, no spaceId: a DM partner is never a Space roster member.
  const { resolve, requestNames } = useNameResolver();

  // Bounded the same way ShareInviteSheet/MessagesList bound their own
  // fan-out: `dmConversations.conversations` can be every conversation the
  // user has scrolled through this session, not just what's visible, so a
  // request per partner would repeat that fetch storm.
  // `qnsLookupAddresses` expects most-recent-first input, which
  // `useUnifiedConversations` already sorts by.
  const resolvableSenderAddresses = useMemo(
    () =>
      qnsLookupAddresses(
        (dmConversations.conversations as Conversation[])
          // Every Quorum DM partner, not only whoever spoke last: the row's
          // TITLE names the partner either way, so enriching only last-senders
          // meant a conversation you replied to most recently could never gain
          // their `.q`. Still one capped batch, so the wider set costs no extra
          // requests.
          .filter(isQuorumDirectPartner)
          .map((c) => ({ address: c.address })),
        MAX_QNS_LOOKUPS,
      ),
    [dmConversations.conversations],
  );
  useEffect(() => {
    requestNames(resolvableSenderAddresses);
  }, [resolvableSenderAddresses, requestNames]);

  const conversationDetails = useMemo(() => {
    const map = new Map<string, ConversationDetail>();
    for (const c of dmConversations.conversations as Conversation[]) {
      const senderName = c.lastMessageSenderName;
      const senderIsSelf = senderName === 'You';

      // The PARTNER's name, through the identity ladder.
      //
      // `displayName` used to be the raw stored `c.displayName`, so a DM
      // notification titled the row with whatever string the conversation was
      // created with — no `.q`, ever, however the same person rendered in the
      // conversation itself. Only `senderName` below was resolved, and the row
      // title does not use it (`quorumToUnified` prefers `displayName`).
      //
      // `global: true` — a DM partner is never a Space roster member, so there
      // is no per-space tier that could apply.
      const partnerAddress = isQuorumDirectPartner(c) ? c.address : undefined;
      const resolvedPartner = partnerAddress
        ? formatResolvedName(resolve(partnerAddress, { global: true }))
        : undefined;
      // `undefined` when the ladder had nothing better than the address itself,
      // so the stored string still wins. For an unsynced partner that string is
      // often a real name, and it is never worse than a hash.
      const partnerName =
        resolvedPartner && partnerAddress && resolvedPartner !== truncateAddress(partnerAddress)
          ? resolvedPartner
          : undefined;

      map.set(c.conversationId, {
        displayName: partnerName ?? c.displayName ?? '',
        // Farcaster rows store a plain string, Quorum rows the typed preview
        // — coerce so this doesn't depend on which wrote it.
        preview: coerceMessagePreview(c.lastMessagePreview).text || undefined,
        senderName: senderIsSelf
          ? 'You'
          : isResolvableQuorumSender(c)
            // The partner IS the sender in this branch, so reuse the one
            // resolution rather than running the ladder twice for one row.
            ? (partnerName ?? senderName)
            // No resolvable address — a Farcaster row (synthetic `fid:<n>`
            // address, a separate identity namespace) or a hypothetical group
            // conversation, which mobile never creates today. The stored
            // string is still load-bearing for these.
            : senderName,
        avatarUrl: c.icon || undefined,
      });
    }
    return map;
  }, [dmConversations.conversations, resolve]);

  // ── Space mention/reply rows: resolve names at RENDER, like desktop ──────
  //
  // `logMentionOrReply` froze the author's name and every in-body mention into
  // the stored row, on the WebSocket receive path. Nothing verifies a QNS claim
  // there — there is no React tree above it — so a `.q` could never appear in a
  // notification, for anyone including the viewer, however the same member
  // rendered one channel away. Desktop resolves these in the panel
  // (`NotificationPanel.tsx`, `<MemberName spaceId={rowSpaceId} enrich />`), and
  // the DM rows above already do it here for the same reason.
  //
  // Scoped to the ROW's space, not globally: that is what keeps a deliberate
  // per-space nickname outranking the `.q`, matching what the channel shows.
  const quorumSpaceAddresses = useMemo(() => {
    const rows: { address?: string }[] = [];
    for (const e of quorumEntries) {
      if (e.kind === 'dm') continue;
      if (e.senderId) rows.push({ address: e.senderId });
      const text = e.preview?.text;
      if (text) for (const a of mentionedAddresses(text)) rows.push({ address: a });
    }
    // Same cap as every other fan-out on this list. `quorumEntries` is
    // newest-first, so the rows that lose enrichment past the cap are the
    // oldest — and they degrade to their global name, never to something wrong.
    return qnsLookupAddresses(rows, MAX_QNS_LOOKUPS);
  }, [quorumEntries]);

  useEffect(() => {
    requestNames(quorumSpaceAddresses);
  }, [quorumSpaceAddresses, requestNames]);

  const resolveName = useCallback<NotificationNameResolver>(
    (address, spaceId) => {
      if (!address) return undefined;
      const resolved = resolve(address, spaceId ? { spaceId } : { global: true });
      // `ResolvedMemberName` carries no "nothing matched" flag — the ladder
      // signals it by handing back the truncated address itself
      // (`resolveWithFallback`). Compare against that rather than inventing a
      // second way to spell the same condition.
      //
      // `undefined` rather than the hash, so the caller falls back to whatever
      // name the log froze at write time: for a member who has since left, or
      // whose roster never synced, that stored string is often a real name and
      // is never worse than an address.
      if (resolved.name === truncateAddress(address)) return undefined;
      return formatResolvedName(resolved);
    },
    [resolve],
  );

  const officialFarcaster = useMemo(
    () => flattenFarcasterNotifications(farcasterQuery.data?.pages),
    [farcasterQuery.data?.pages],
  );

  const partition = useMemo(
    () =>
      partitionNotifications({
        quorumEntries,
        chatEntries,
        conversationDetails,
        resolveName,
        officialFarcaster,
        haatzFarcaster: haatzQuery.data ?? [],
        clearedBefore,
        dismissedKeys,
        mutedConversations,
        lastSeen: getLastSeenTimestamp(),
        quorumTabSeenAt: getQuorumTabSeenAt(),
      }),
    [
      quorumEntries,
      chatEntries,
      conversationDetails,
      officialFarcaster,
      haatzQuery.data,
      clearedBefore,
      dismissedKeys,
      mutedConversations,
    ],
  );

  return {
    items: partition.items,
    quorumItems: partition.quorumItems,
    farcasterFeedItems: partition.farcasterFeedItems,
    unreadCount: partition.unreadCount,
    dismissedCount: partition.dismissedCount,
    isLoading: farcasterQuery.isLoading || haatzQuery.isLoading,
    isFetchingMore: farcasterQuery.isFetchingNextPage,
    // Stop paging once the fetched pages reach the dismissal watermark —
    // everything older is dismissed, so further pages would be entirely
    // filtered out and infinite scroll would spin for nothing.
    hasMore: !!farcasterQuery.hasNextPage && !partition.reachedWatermark,
    fetchMore: () => {
      if (
        farcasterQuery.hasNextPage &&
        !farcasterQuery.isFetchingNextPage &&
        !partition.reachedWatermark
      ) {
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
      partition.farcasterFeedItems.length > 0
        ? null
        : ((farcasterQuery.error as Error | null) ?? null),
  };
}
