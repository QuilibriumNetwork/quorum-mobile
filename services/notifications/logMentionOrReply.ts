/**
 * logMentionOrReply — single entry point both WebSocket receive paths (live +
 * catch-up) call to persist a mention/reply into the mentions inbox log.
 *
 * Extracted into one helper so the two call sites in WebSocketContext can't
 * drift (they previously duplicated the reply/mention detection blocks). It
 * reuses the SAME shared detection the badge counters use:
 *   - replies: `replyMetadata.parentAuthor === me`
 *   - mentions: `getMentionType` (user/role/everyone) — the shared util whose
 *     docstring calls out notification-UI categorization. We still pass through
 *     `isMentionedWithSettings` semantics by gating on the caller's
 *     `notifyForBadge` (mute) + checking the enabled types here.
 *
 * Returns void; appends 0 or 1 entry. Dedup is handled by the log (stable id).
 *
 * ## Why every name here goes through `@/utils/resolveMemberName`, not `@/identity`
 *
 * Both call sites (`WebSocketContext.tsx`'s live and catch-up handlers) run on
 * the WebSocket message-receive path — there is no React component above this
 * function, so `useResolvedMemberName`'s hooks, and the network verification
 * they trigger, cannot run here. `resolveMemberName` degrades instead of
 * verifying: it will render a `.q` for whatever sits in a row's
 * `primary_username`, no questions asked (`messageSenderName.test.ts` proves
 * both directions of that).
 *
 * What actually keeps a mention or a sender name here from forging a `.q` is
 * one level upstream: `ctx.getSpaceMember` is wired to `storage.getSpaceMember`,
 * and `WebSocketContext.tsx`'s roster-update handler never writes an incoming
 * claim into `primary_username` — only into `claimed_primary_username`, which
 * this file's calls into `resolveMemberName` never read. A name that has not
 * been promoted (verified, inside a React tree, and never persisted back to
 * storage) simply is not on the row this function sees. It falls through to
 * the global name or the truncated address instead — the same member's chat
 * bubble may show `alice.q` while this notification shows `Alice`, and that
 * mismatch is correct: showing the unverified claim on a lock screen would be
 * the exact forgery the identity architecture exists to prevent.
 * `logMentionOrReply.test.ts`'s "the sender name degrades, it never forges"
 * block exercises both the safe shape and, as a contrast, what a promoted row
 * would render, to prove it is the FIELD doing the protecting and not the
 * function.
 */

import {
  getUserRoles,
  isMentionedWithSettings,
  type Message,
  type Space,
} from '@quilibrium/quorum-shared';
import {
  appendMentionReplyLog,
  markChannelMentionsRead,
  type DmEntry,
  type SpaceMentionEntry,
} from './mentionReplyLog';
import { getActiveChannelKey } from '@/hooks/chat/useReplyTracking';
import {
  getLocalNotificationTypes,
  isConversationMutedForCurrentUser,
} from '@/services/config';
import { messagePreview, messageSenderName, type MessagePreview } from '@/utils/messagePreview';
import { renderMentionsAsPlainText } from '@/utils/mentionTokens';
import {
  formatResolvedName,
  resolveMemberName,
  type ResolvableMember,
  type SelfIdentity,
} from '@/utils/resolveMemberName';

export interface LogMentionOrReplyCtx {
  spaceId: string;
  channelId: string;
  /** Current user's full address; nothing is logged without it. */
  userAddress: string | null | undefined;
  /** Space object for role resolution + mention-type checks (may be undefined). */
  space?: Space;
  /** Channel display name for the row breadcrumb, if cheaply available. */
  channelName?: string;
  /** Mute/notify gate — same `shouldNotifyForContext` result the badge uses. */
  notifyForBadge: boolean;
  /**
   * Resolve a space member — used for the sender's display name AND for any
   * addresses mentioned inside the message body.
   *
   * Declared loosely because the roster reaches us from several queries and not
   * all of them type the two-slot identity fields; `resolveMemberName` reads
   * whichever are present.
   */
  getSpaceMember: (
    spaceId: string,
    memberId: string
  ) => Promise<Partial<ResolvableMember> | undefined>;
}

function senderIdOf(message: Message): string | undefined {
  return 'senderId' in message.content
    ? (message.content as { senderId?: string }).senderId
    : undefined;
}

/**
 * Decide which kind (if any) this message represents for the current user.
 * Reply takes precedence over mention when a message is both (matches desktop's
 * single-entry behavior — one notification per message).
 *
 * Mention typing uses `isMentionedWithSettings` per-type rather than
 * `getMentionType`, because `getMentionType` (a) ignores role mentions entirely
 * and (b) does NOT gate `@everyone` on the sender's `mention:everyone`
 * permission. `isMentionedWithSettings` handles all three correctly and is the
 * exact predicate the badge counters use, so the inbox and the badge can never
 * disagree on what counts as a mention.
 */
function classify(
  message: Message,
  ctx: LogMentionOrReplyCtx
): SpaceMentionEntry['kind'] | null {
  const me = ctx.userAddress;
  if (!me) return null;
  const sender = senderIdOf(message);
  if (sender === me) return null; // never self-notify

  // The user's per-space choice of which types notify them (you/everyone/
  // roles/reply), synced via UserConfig. Defaults to all enabled. A type the
  // user disabled produces no inbox entry and no badge.
  const enabled = getLocalNotificationTypes(me, ctx.spaceId);

  // Reply to one of my messages.
  if (
    enabled.includes('reply') &&
    message.replyMetadata?.parentAuthor &&
    message.replyMetadata.parentAuthor === me
  ) {
    return 'reply';
  }

  const userRoles = getUserRoles(me, ctx.space).map((r) => r.roleId);
  const check = (type: 'mention-you' | 'mention-everyone' | 'mention-roles') =>
    enabled.includes(type) &&
    isMentionedWithSettings(message, {
      userAddress: me,
      enabledTypes: [type],
      userRoles,
      space: ctx.space,
    });

  // Priority: direct > everyone > role (a direct @you is the strongest signal).
  if (check('mention-you')) return 'mention-you';
  if (check('mention-everyone')) return 'mention-everyone';
  if (check('mention-roles')) return 'mention-roles';
  return null;
}

export async function logMentionOrReply(
  message: Message,
  ctx: LogMentionOrReplyCtx
): Promise<void> {
  if (!ctx.notifyForBadge || !ctx.userAddress) return;

  const kind = classify(message, ctx);
  if (!kind) return;

  const senderId = senderIdOf(message) ?? '';
  const senderMember =
    ctx.spaceId && senderId
      ? await ctx.getSpaceMember(ctx.spaceId, senderId)
      : undefined;
  // `messageSenderName` takes the narrower `string | undefined` shape; the
  // roster's identity fields are nullable, so normalize rather than widening
  // that util's contract for one caller.
  const senderNameFields = senderMember
    ? {
        display_name: senderMember.display_name ?? undefined,
        name: senderMember.name ?? undefined,
        global_display_name: senderMember.global_display_name ?? undefined,
        primary_username: senderMember.primary_username ?? undefined,
      }
    : undefined;
  const senderName = messageSenderName(
    senderId || undefined,
    ctx.userAddress ?? undefined,
    senderId && senderNameFields ? { [senderId]: senderNameFields } : undefined
  );
  // A RESOLVED display name only (no address fallback) — the row shows the
  // author prefix solely when we have a real name, so unsynced senders don't
  // surface a raw "Qm..." hash.
  //
  // Now through the same resolver used for names INSIDE the message body a few
  // lines above, rather than reading the override slot by hand. Reading it by
  // hand meant a member whose identity lives in the global slot (every
  // freshly-joined member, once joins stopped stamping the override) got NO
  // author prefix at all, and a QNS `.q` name could never appear here.
  const resolvedSender =
    senderId && senderNameFields
      ? resolveMemberName({ ...senderNameFields, address: senderId })
      : undefined;
  const senderDisplayName =
    resolvedSender && !resolvedSender.isAddressFallback
      ? formatResolvedName(resolvedSender)
      : undefined;

  const entry: SpaceMentionEntry = {
    id: `${ctx.spaceId}:${ctx.channelId}:${message.messageId}`,
    kind,
    spaceId: ctx.spaceId,
    spaceName: ctx.space?.spaceName,
    channelId: ctx.channelId,
    channelName: ctx.channelName,
    threadId: message.threadId,
    senderId,
    senderName,
    senderDisplayName,
    // Mention tokens are left RAW and resolved when the panel renders, by
    // `partitionNotifications`' `resolveName` (bound to `@/identity` in
    // `useUnifiedNotifications`). Resolving them here instead meant they were
    // named by `resolveMemberName` on a path with no React tree, which can
    // never verify a QNS claim — so a `.q` could not appear in a notification
    // for anyone, including the viewer, however the same member rendered one
    // channel away. Desktop resolves these in its panel for the same reason.
    preview: messagePreview(message),
    createdAt: message.createdDate || Date.now(),
  };
  appendMentionReplyLog(entry);

  // If the user is already viewing this channel, keep the entry read (Level 2):
  // it still appears in the inbox, but it must not bump the channel bubble or
  // the unread emphasis. Mirrors the old active-channel suppression on the
  // integer counters.
  if (getActiveChannelKey() === `${ctx.spaceId}:${ctx.channelId}`) {
    markChannelMentionsRead(ctx.spaceId, ctx.channelId, entry.createdAt);
  }
}

export interface LogDirectMessageCtx {
  /** Unified conversation id — the same one the DM route takes. */
  conversationId: string;
  /** Sender's full address. */
  senderId: string;
  /**
   * What to title the row with — the conversation's display name exactly as
   * the Messages tab shows it, resolved profile or truncated address. Unlike
   * a space mention (where an unresolved sender falls back to no prefix rather
   * than showing a raw hash), a DM row has nothing else to say, so it shows
   * whatever the inbox row for the same conversation shows.
   */
  senderName?: string;
  /** Current user's full address; nothing is logged without it. */
  userAddress: string | null | undefined;
  message: Message;
}

/**
 * Persist an incoming Quorum DM into the notifications inbox log.
 *
 * The counterpart to `logMentionOrReply` for the DM receive paths, which had no
 * equivalent — space messages logged themselves at their receive point and DMs
 * simply did not, which is why they never appeared in the panel at all.
 *
 * Written through the mention log rather than the background-ping log because
 * that is the path with the detail to render a real row. Keyed per CONVERSATION
 * (see `DmEntry`), so an active chat refreshes one row instead of appending one
 * per message.
 *
 * Returns void; appends 0 or 1 entry.
 */
export function logDirectMessage(ctx: LogDirectMessageCtx): void {
  const me = ctx.userAddress;
  if (!me) return;
  if (ctx.senderId === me) return; // never self-notify (self-sync echoes)
  // Same gate the push path uses. A muted conversation produces no row and no
  // banner — the conversation stays reachable from the Messages tab.
  if (isConversationMutedForCurrentUser(ctx.conversationId)) return;

  const raw = messagePreview(ctx.message);
  // An event with nothing to say (a receipt, a profile update) is not a row.
  if (!raw.text.trim()) return;
  // No roster to resolve against in a DM, but a raw `@<Qm…>` must still not
  // reach the row — the truncating fallback handles it.
  const preview: MessagePreview = {
    ...raw,
    text: renderMentionsAsPlainText(raw.text),
  };

  const entry: DmEntry = {
    id: `dm:${ctx.conversationId}`,
    kind: 'dm',
    conversationId: ctx.conversationId,
    senderId: ctx.senderId,
    senderName: ctx.senderName,
    preview,
    createdAt: ctx.message.createdDate || Date.now(),
  };
  appendMentionReplyLog(entry);
}
