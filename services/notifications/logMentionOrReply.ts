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
  type MentionReplyEntry,
  type MentionReplyKind,
} from './mentionReplyLog';
import { getActiveChannelKey } from '@/hooks/chat/useReplyTracking';
import { messagePreview, messageSenderName } from '@/utils/messagePreview';

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
  /** Resolve a space member (for sender display name). */
  getSpaceMember: (
    spaceId: string,
    memberId: string
  ) => Promise<{ display_name?: string; name?: string } | undefined>;
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
): MentionReplyKind | null {
  const me = ctx.userAddress;
  if (!me) return null;
  const sender = senderIdOf(message);
  if (sender === me) return null; // never self-notify

  // Reply to one of my messages.
  if (
    message.replyMetadata?.parentAuthor &&
    message.replyMetadata.parentAuthor === me
  ) {
    return 'reply';
  }

  const userRoles = getUserRoles(me, ctx.space).map((r) => r.roleId);
  const check = (type: 'mention-you' | 'mention-everyone' | 'mention-roles') =>
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
  const senderName = messageSenderName(
    senderId || undefined,
    ctx.userAddress ?? undefined,
    senderId && senderMember ? { [senderId]: senderMember } : undefined
  );

  const entry: MentionReplyEntry = {
    id: `${ctx.spaceId}:${ctx.channelId}:${message.messageId}`,
    kind,
    spaceId: ctx.spaceId,
    channelId: ctx.channelId,
    channelName: ctx.channelName,
    threadId: message.threadId,
    senderId,
    senderName,
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
