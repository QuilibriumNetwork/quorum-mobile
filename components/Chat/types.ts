/**
 * Display types for Chat components
 *
 * These types represent what the UI needs to render, abstracting away
 * the differences between mock data and real API data.
 */

import { ImageSourcePropType } from 'react-native';
import type { Message as SharedMessage, Space, Channel, SpaceMember, MessageSendStatus } from '@quilibrium/quorum-shared';
import type { DirectCastMessage } from '@/services/farcasterClient';
import { formatMessageTime } from '@/utils/dateFormat';

// Message type categories for rendering
export type MessageRenderType =
  | 'post'        // Regular text message
  | 'system'      // Join/leave/kick events
  | 'embed'       // Image/video
  | 'sticker'     // Sticker
  | 'deleted'     // Deleted message placeholder
  | 'call-event'  // Voice/video call event (1-to-1)
  | 'space-call'  // Space (group) call indicator
  | 'cast'        // Farcaster cast from a linked channel
  | 'error'       // Malformed message — surfaced inline so prod issues are visible without logs
  | 'unsupported'; // Known-but-unrendered or genuinely unknown type — filtered out of the list, never bubble-rendered

/**
 * Default-deny allowlist of types mobile persists AND renders. Single source of
 * truth shared by the receive paths (WebSocketContext live + batch) and the
 * render fallback below. Anything not here fails closed: dropped before save,
 * and mapped to 'unsupported' (then filtered out) if a pre-fix build persisted
 * it — so a new/unrecognized desktop type produces nothing, not a junk bubble.
 * Applied types (reaction/edit/remove/update-profile) and dropped control types
 * (pin/mute/thread) are excluded because they never reach the save path.
 */
export const PERSISTABLE_TYPES: ReadonlySet<string> = new Set([
  'post',
  'embed',
  'sticker',
  'join',
  'leave',
  'kick',
  'event',
  'call-event',
  'space-call-start',
  'space-call-end',
]);

/**
 * Types the DM default-deny guard must NOT drop, even though they aren't in
 * PERSISTABLE_TYPES. These are applied/control types that mobile does not yet
 * process on the DM receive path — dropping (and inbox-deleting) them would
 * silently discard a real cross-device action. Until a proper DM handler exists,
 * the guard lets them fall through unchanged (today's behavior: saved-but-hidden,
 * not deleted from the server), so no data is lost.
 *
 * Currently EMPTY: `edit-message` was here while mobile had no DM edit handler;
 * the real DM edit send + receive now exists (WebSocketContext DM paths), so it
 * was removed and the guard treats a malformed edit as a normal drop. Keep this
 * set as the documented escape hatch: a future half-built DM control feature can
 * be added here to fall through instead of being dropped, then removed once its
 * real handler lands.
 */
export const DM_GUARD_PASSTHROUGH_TYPES: ReadonlySet<string> = new Set([]);

// Invariant: every persistable type must have a real render branch in
// getMessageRenderType (i.e. not fall through to 'unsupported'), or the receive
// path would save it while the render path filters it out — a message that
// exists on disk but is invisible. The reverse (a render branch with no set
// membership) is intentional for applied types (remove-message -> 'deleted')
// that are consumed before the save path, so it isn't checked here. Dev-only;
// stripped from production bundles by the `__DEV__` guard.
if (__DEV__) {
  for (const t of PERSISTABLE_TYPES) {
    const rt = getMessageRenderType({ content: { type: t } } as unknown as SharedMessage);
    if (rt === 'unsupported') {
      // eslint-disable-next-line no-console
      console.error(
        `[Chat/types] PERSISTABLE_TYPES contains '${t}' but getMessageRenderType maps it to 'unsupported' — ` +
        `add a render branch or remove it from PERSISTABLE_TYPES.`
      );
    }
  }
}

// Reaction display info
export interface DisplayReaction {
  emoji: string;
  count: number;
  memberIds: string[];
  hasReacted: boolean; // Whether current user reacted
}

// Display-oriented message for rendering
export interface DisplayMessage {
  id: string;
  userId: string;
  userName: string;
  userAvatar: ImageSourcePropType | string;
  timestamp: number;
  timeString: string;
  content: string;
  hasLink?: boolean;
  link?: string;
  linkText?: string;
  // Send status for optimistic updates
  sendStatus?: MessageSendStatus;
  sendError?: string;
  // Original message if available
  originalMessage?: SharedMessage;
  // Render type for different message displays
  renderType: MessageRenderType;
  // System message specific
  systemEventType?: 'join' | 'leave' | 'kick';
  // Embed/media specific
  imageUrl?: string;
  thumbnailUrl?: string;
  videoUrl?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  // Sticker specific
  stickerId?: string;
  // Reactions on this message
  reactions?: DisplayReaction[];
  // Edit info
  isEdited?: boolean;
  editedAt?: number;
  // True only when prior versions are actually retained (saveEditHistory on).
  // `isEdited` shows the "(edited)" marker on ANY edit; this gates the
  // "View Edit History" action, which has nothing to show without stored edits.
  hasEditHistory?: boolean;
  // Reply info
  isReply?: boolean;
  replyToMessageId?: string;
  replyToAuthor?: string;
  replyToPreview?: string;
  // Space call specific
  spaceCallId?: string;
  spaceCallMediaType?: 'audio' | 'video';
  spaceCallEnded?: boolean;
  // Farcaster cast (when renderType === 'cast')
  cast?: any;
  castChannelKey?: string;
  // Error detail (when renderType === 'error') — surfaced inline so prod
  // users can screenshot the row and we can trace what's malformed
  // without needing to reproduce or wire up logs.
  errorDetail?: string;
}

// Display-oriented server/space for rendering
export interface DisplayServer {
  id: string;
  name: string;
  icon: ImageSourcePropType | string;
  unread: boolean;
  // Original space if available
  originalSpace?: Space;
}

// Display-oriented channel for rendering
export interface DisplayChannel {
  id: string;
  name: string;
  unread: boolean;
  mentionCount?: number;
  topic?: string;
  // Original channel if available
  originalChannel?: Channel;
}

// Display-oriented channel group for rendering
export interface DisplayGroup {
  name: string;
  channels: DisplayChannel[];
}

// Member lookup map
export type MemberMap = Record<string, SpaceMember>;

/**
 * Per-message time inside a chat. Delegates to the shared message-date formatter
 * (locale-driven clock; older messages bucket to weekday / "N days ago" instead
 * of the ambiguous locale-numeric date the old impl produced).
 * - Today: locale time (e.g. "16:40" or "4:40 PM")
 * - Yesterday: "Yesterday at 16:40"
 * - Last week: weekday ("Monday")
 * - Older: "3 days ago"
 */
export function formatTime(timestamp: number): string {
  return formatMessageTime(timestamp);
}

// Image URL pattern - matches common image hosting URLs
const IMAGE_URL_PATTERN = /https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s]*)?/gi;
const TENOR_GIF_PATTERN = /https?:\/\/(?:media\.tenor\.com|c\.tenor\.com)[^\s]+/gi;
// Cloudflare image delivery URLs (used by Farcaster)
const IMAGE_DELIVERY_PATTERN = /https?:\/\/imagedelivery\.net\/[^\s]+/gi;

/**
 * Extract image URLs from text content
 */
export function extractImageUrls(text: string): string[] {
  const urls: string[] = [];

  // Match standard image extensions
  const imageMatches = text.match(IMAGE_URL_PATTERN) || [];
  urls.push(...imageMatches);

  // Match Tenor GIF URLs (don't always have .gif extension)
  const tenorMatches = text.match(TENOR_GIF_PATTERN) || [];
  urls.push(...tenorMatches);

  // Match Cloudflare image delivery URLs (used by Farcaster)
  const imageDeliveryMatches = text.match(IMAGE_DELIVERY_PATTERN) || [];
  urls.push(...imageDeliveryMatches);

  // Deduplicate
  return [...new Set(urls)];
}

/**
 * Strip image URLs from text content
 */
export function stripImageUrls(text: string): string {
  return text
    .replace(IMAGE_URL_PATTERN, '')
    .replace(TENOR_GIF_PATTERN, '')
    .replace(IMAGE_DELIVERY_PATTERN, '')
    .replace(/\[Media\]/gi, '') // Also strip [Media] placeholder
    .trim();
}

/**
 * Extract display text from message content
 */
export function getMessageText(message: SharedMessage, memberName?: string): string {
  const content = message.content;
  if (!content) return '';
  if (content.type === 'post') {
    const text = content.text;
    return Array.isArray(text) ? text.join('\n') : text;
  }
  if (content.type === 'event') {
    return content.text;
  }
  if (content.type === 'sticker') {
    return '';  // Stickers render visually
  }
  if (content.type === 'embed') {
    // Embeds may carry an optional caption alongside the image. The
    // send path (sendEmbedMessage in spaceMessageService) puts it under
    // content.text. Older messages without a caption fall through to ''.
    const caption = (content as { text?: string }).text;
    return typeof caption === 'string' ? caption : '';
  }
  if (content.type === 'join') {
    return `${memberName ?? 'Someone'} joined the space`;
  }
  if (content.type === 'leave') {
    return `${memberName ?? 'Someone'} left the space`;
  }
  if (content.type === 'kick') {
    return `${memberName ?? 'Someone'} was removed from the space`;
  }
  if (content.type === 'edit-message') {
    const text = content.editedText;
    return Array.isArray(text) ? text.join('\n') : text;
  }
  if (content.type === 'remove-message') {
    return 'This message was deleted';
  }
  if (content.type === 'call-event') {
    const c = content as any;
    const icon = c.mediaType === 'video' ? 'Video' : 'Voice';
    if (c.event === 'completed' && c.duration) {
      const mins = Math.floor(c.duration / 60);
      const secs = c.duration % 60;
      const dur = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      return `${icon} call \u00B7 ${dur}`;
    }
    if (c.event === 'missed') return `Missed ${icon.toLowerCase()} call`;
    if (c.event === 'declined') return `${icon} call \u00B7 Declined`;
    if (c.event === 'failed') return `${icon} call \u00B7 Failed`;
    return `${icon} call`;
  }
  if (content.type === 'space-call-start') {
    const label = content.mediaType === 'video' ? 'Video' : 'Voice';
    return `${label} call started`;
  }
  if (content.type === 'space-call-end') {
    return 'Call ended';
  }
  return '';
}

/**
 * Determine render type from message content
 */
export function getMessageRenderType(message: SharedMessage): MessageRenderType {
  const content = message.content;
  if (!content) return 'error';
  switch (content.type) {
    case 'join':
    case 'leave':
    case 'kick':
    case 'event':
      return 'system';
    case 'embed':
      return 'embed';
    case 'sticker':
      return 'sticker';
    case 'remove-message':
      return 'deleted';
    case 'call-event':
      return 'call-event';
    case 'space-call-start':
    case 'space-call-end':
      return 'space-call';
    case 'post':
      return 'post';
    default:
      // Default-deny: unknown types map to 'unsupported' (not 'post', which made
      // phantom empty bubbles). Catches types persisted by an older build; the
      // chat areas filter 'unsupported' out before the list.
      return 'unsupported';
  }
}

/**
 * Convert Reaction[] to DisplayReaction[]
 */
export function toDisplayReactions(
  reactions: SharedMessage['reactions'],
  currentUserId?: string
): DisplayReaction[] {
  return reactions.map((r) => ({
    emoji: r.emojiName || r.emojiId,
    count: r.count,
    memberIds: r.memberIds,
    hasReacted: currentUserId ? r.memberIds.includes(currentUserId) : false,
  }));
}

/**
 * Convert shared Message to DisplayMessage
 */
import { truncateAddress } from '@/utils/formatAddress';

function formatAddressDisplay(address: string): string {
  return truncateAddress(address, 'medium');
}

/**
 * Build a short error description for a malformed message. Goal is
 * something a user can screenshot in production that we can act on
 * without a repro — not a full pretty-printed JSON dump, but enough to
 * identify the message and what's missing.
 */
function buildMessageErrorDetail(message: SharedMessage): string {
  const parts: string[] = [];
  if (!message.content) parts.push('no content');
  else if (typeof message.content !== 'object') parts.push(`bad content type: ${typeof message.content}`);
  else if (!('type' in message.content)) parts.push('content missing type');

  const id = message.messageId ? `msg ${String(message.messageId).slice(0, 12)}` : 'msg <no id>';
  const sender = (message as unknown as { publicKey?: string }).publicKey;
  const senderStr = sender ? ` · sender ${String(sender).slice(0, 8)}` : '';
  const ts = message.createdDate ? new Date(message.createdDate).toISOString() : '';
  return `${parts.join(', ') || 'malformed'} (${id}${senderStr}${ts ? ` · ${ts}` : ''})`;
}

export function toDisplayMessage(
  message: SharedMessage,
  members: MemberMap,
  currentUserId?: string
): DisplayMessage {
  // Defensive: if a stored message has no `content` (corrupt save,
  // partial decrypt result, malformed control envelope), render an
  // inline error row instead of throwing. The error row surfaces enough
  // identifying info that a production screenshot is debuggable without
  // logs.
  const content = (message.content as SharedMessage['content'] | undefined) ?? null;
  const senderId = content && 'senderId' in content && typeof content.senderId === 'string'
    ? content.senderId
    : (message as unknown as { publicKey?: string }).publicKey ?? 'unknown';
  const member = members[senderId];
  const memberName = member?.display_name || member?.name || formatAddressDisplay(senderId);
  const renderType = getMessageRenderType(message);
  const errorDetail = renderType === 'error'
    ? buildMessageErrorDetail(message)
    : undefined;

  // Base display message
  const displayMessage: DisplayMessage = {
    id: message.messageId,
    userId: senderId,
    userName: memberName,
    userAvatar: member?.profile_image ?? '',
    timestamp: message.createdDate,
    timeString: formatTime(message.createdDate),
    content: getMessageText(message, memberName),
    sendStatus: message.sendStatus,
    sendError: message.sendError,
    originalMessage: message,
    renderType,
    errorDetail,
  };

  // Bail out cleanly for malformed messages with no content. The base
  // displayMessage above is enough to render the error row without
  // touching any of the type-specific branches below.
  if (!content) return displayMessage;

  // Add system event type for system messages
  if (content.type === 'join' || content.type === 'leave' || content.type === 'kick') {
    displayMessage.systemEventType = content.type;
  }

  // Add embed/media info
  if (content.type === 'embed') {
    displayMessage.imageUrl = content.imageUrl;
    displayMessage.thumbnailUrl = content.thumbnailUrl;
    displayMessage.videoUrl = content.videoUrl;
    if (content.width) displayMessage.mediaWidth = parseInt(content.width, 10);
    if (content.height) displayMessage.mediaHeight = parseInt(content.height, 10);
  }

  // Desktop (and converged mobile) sends a captioned/standalone image as a
  // `post` with the image bytes inlined in `content.embeddedMedia`, NOT as an
  // `embed`. Extract the image here so it renders through the existing embed
  // image path; the `post.text` stays as the caption (already in
  // displayMessage.content via getMessageText).
  let renderedEmbeddedMedia = false;
  if (content.type === 'post' && Array.isArray(content.embeddedMedia) && content.embeddedMedia.length > 0) {
    const media = content.embeddedMedia;
    const image = media.find((m) => m.type === 'image');
    if (image) {
      // Match a thumbnail to the full image by shared `key` (the large-GIF /
      // thumbnailed case). data is raw base64 (no data: prefix) — wrap it.
      const thumbnail = media.find((m) => m.type === 'image-thumbnail' && m.key === image.key);
      displayMessage.renderType = 'embed';
      displayMessage.imageUrl = `data:${image.mimeType};base64,${image.data}`;
      if (thumbnail) {
        displayMessage.thumbnailUrl = `data:${thumbnail.mimeType};base64,${thumbnail.data}`;
      }
      renderedEmbeddedMedia = true;
    }
  }

  // Back-compat: older desktop builds sent images as "[Media]" + an inline
  // image URL in the post text. Only scan when embeddedMedia didn't already
  // produce an image, so we don't double-handle a converged message.
  if (!renderedEmbeddedMedia && content.type === 'post' && displayMessage.content) {
    const embeddedImages = extractImageUrls(displayMessage.content);
    if (embeddedImages.length > 0) {
      // Upgrade to embed render type and extract the image
      displayMessage.renderType = 'embed';
      displayMessage.imageUrl = embeddedImages[0];
      // Strip the URL from the display text
      displayMessage.content = stripImageUrls(displayMessage.content);
    }
  }

  // Add sticker info
  if (content.type === 'sticker') {
    displayMessage.stickerId = content.stickerId;
  }

  // Add space call info
  if (content.type === 'space-call-start') {
    displayMessage.spaceCallId = content.callId;
    displayMessage.spaceCallMediaType = content.mediaType;
    displayMessage.spaceCallEnded = false;
  }
  if (content.type === 'space-call-end') {
    displayMessage.spaceCallId = content.callId;
    displayMessage.spaceCallEnded = true;
  }

  // Add reactions
  if (message.reactions && message.reactions.length > 0) {
    displayMessage.reactions = toDisplayReactions(message.reactions, currentUserId);
  }

  // Add edit info. The "(edited)" marker must show on ANY edit, independent of
  // whether prior versions are retained: a message whose saveEditHistory is off
  // still bumps modifiedDate past createdDate but carries an empty edits array.
  // Driving isEdited off edits.length alone would hide the marker for every
  // history-off edit. hasEditHistory stays tied to the actual stored edits.
  if (message.edits && message.edits.length > 0) {
    displayMessage.isEdited = true;
    displayMessage.hasEditHistory = true;
    displayMessage.editedAt = message.edits[message.edits.length - 1].modifiedDate;
  } else if (message.modifiedDate > message.createdDate) {
    displayMessage.isEdited = true;
    displayMessage.editedAt = message.modifiedDate;
  }

  // Add reply info
  if ('repliesToMessageId' in content && content.repliesToMessageId) {
    displayMessage.isReply = true;
    displayMessage.replyToMessageId = content.repliesToMessageId;
    if (message.replyMetadata?.parentAuthor) {
      const parentMember = members[message.replyMetadata.parentAuthor];
      displayMessage.replyToAuthor =
        parentMember?.display_name || parentMember?.name || formatAddressDisplay(message.replyMetadata.parentAuthor);
    }
  }

  return displayMessage;
}

/**
 * Convert shared Space to DisplayServer
 */
export function toDisplayServer(space: Space): DisplayServer {
  return {
    id: space.spaceId,
    name: space.spaceName,
    // Pass iconUrl as string so ServerSidebar can check if it's a data URI
    icon: space.iconUrl || '',
    unread: false, // Would need to track read state
    originalSpace: space,
  };
}

/**
 * Convert shared Channel to DisplayChannel
 */
export function toDisplayChannel(channel: Channel): DisplayChannel {
  return {
    id: channel.channelId,
    name: channel.channelName,
    unread: (channel.mentionCount ?? 0) > 0,
    mentionCount: channel.mentionCount ?? 0,
    topic: channel.channelTopic,
    originalChannel: channel,
  };
}

/**
 * Convert Farcaster DirectCastMessage to DisplayMessage
 */
export function directCastToDisplayMessage(
  message: DirectCastMessage,
  currentUserFid?: number
): DisplayMessage {
  const sender = message.senderContext;
  const pfpUrl = sender?.pfp?.url ?? '';
  const senderName = sender?.displayName ?? sender?.username ?? `fid:${message.senderFid}`;

  // Determine render type based on message type
  let renderType: MessageRenderType = 'post';
  let systemEventType: 'join' | 'leave' | 'kick' | undefined;
  let content = message.message;

  if (message.type === 'group_membership_addition') {
    renderType = 'system';
    systemEventType = 'join';
    // actionTargetUserContext contains who was added, senderContext is who invited them
    const target = message.actionTargetUserContext;
    const targetName = target?.displayName ?? target?.username ?? `fid:${message.message}`;
    content = `${targetName} joined the conversation`;
  } else if (message.type === 'group_membership_removal') {
    renderType = 'system';
    systemEventType = 'leave';
    // actionTargetUserContext contains who was removed
    const target = message.actionTargetUserContext;
    const targetName = target?.displayName ?? target?.username ?? `fid:${message.message}`;
    content = `${targetName} left the conversation`;
  } else if (message.type === 'group_name_change') {
    renderType = 'system';
    content = `${senderName} changed the group name`;
  }

  // Check if message is deleted
  if (message.isDeleted) {
    renderType = 'deleted';
    content = 'This message was deleted';
  }

  const displayMessage: DisplayMessage = {
    id: message.messageId,
    userId: String(sender?.fid ?? message.senderFid),
    userName: senderName,
    userAvatar: pfpUrl,
    timestamp: message.serverTimestamp,
    timeString: formatTime(message.serverTimestamp),
    content,
    renderType,
    systemEventType,
  };

  // Check for embedded image URLs in message text (e.g., imagedelivery.net)
  if (renderType === 'post' && content) {
    const embeddedImages = extractImageUrls(content);
    if (embeddedImages.length > 0) {
      displayMessage.renderType = 'embed';
      displayMessage.imageUrl = embeddedImages[0];
      // Strip the URL from the display text
      displayMessage.content = stripImageUrls(content);
    }
  }

  // Add reactions if present
  if (message.reactions && message.reactions.length > 0) {
    const viewerReactions = message.viewerContext?.reactions ?? [];
    displayMessage.reactions = message.reactions.map((r) => ({
      emoji: r.reaction,
      count: r.count,
      memberIds: [],
      hasReacted: viewerReactions.includes(r.reaction),
    }));
  }

  // Add reply info
  if (message.inReplyTo) {
    displayMessage.isReply = true;
    displayMessage.replyToMessageId = message.inReplyTo.messageId;
    displayMessage.replyToAuthor =
      message.inReplyTo.senderContext?.displayName ??
      message.inReplyTo.senderContext?.username ??
      `fid:${message.inReplyTo.senderFid}`;
  }

  // Handle optimistic messages (sending state)
  const messageWithOptimistic = message as DirectCastMessage & { _optimistic?: boolean };
  if (messageWithOptimistic._optimistic) {
    displayMessage.sendStatus = 'sending';
  }

  return displayMessage;
}

/**
 * Wrap a Farcaster cast as a DisplayMessage so it can be merged into the chat
 * stream and rendered inline by MessagesList.
 */
export function castToDisplayMessage(cast: any, channelKey: string): DisplayMessage {
  const author = cast?.author ?? {};
  const pfpUrl: string | undefined = author?.pfp?.url;
  return {
    // Prefix to avoid collision with Quorum message IDs
    id: `cast:${cast.hash}`,
    userId: `fc:${author.fid ?? ''}`,
    userName: author.displayName ?? author.username ?? 'Unknown',
    userAvatar: pfpUrl ?? '',
    timestamp: cast.timestamp ?? 0,
    timeString: '',
    content: cast.text ?? '',
    renderType: 'cast',
    cast,
    castChannelKey: channelKey,
  };
}
