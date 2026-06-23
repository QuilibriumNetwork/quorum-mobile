/**
 * Utility to derive a one-line text preview from a Message's content.
 * Used by the unified inbox (space activity), the DM conversation list, and the
 * mentions/replies notification log.
 *
 * The preview is a TYPED `{ kind, text }` pair — NOT a string with a baked-in
 * emoji prefix. Renderers prepend the matching icon (via IconSymbol) so we stay
 * within the "no emoji in production UI" rule and the icon styling is owned by
 * the UI, not the data. `previewKindIcon()` maps a kind to a Tabler icon name.
 *
 * Older builds stored `preview` as a raw string (sometimes with an emoji
 * prefix). `coerceMessagePreview()` upgrades those legacy values on read so old
 * MMKV rows render cleanly (no emoji, no crash) without a data migration.
 */

import type { Message, MessageContent } from '@quilibrium/quorum-shared';
import type { IconSymbolName } from '@/components/ui/IconSymbol';

/** Discriminator for the media/event class of a message preview. */
export type MessagePreviewKind =
  | 'text'
  | 'image'
  | 'video'
  | 'sticker'
  | 'reaction'
  | 'call'
  | 'missed-call'
  | 'video-call'
  | 'join'
  | 'leave'
  | 'kick'
  | 'update-profile'
  | 'remove-message';

/** Typed preview: a kind (for the leading icon) plus the human text. */
export interface MessagePreview {
  kind: MessagePreviewKind;
  /** Display text WITHOUT any emoji prefix. May be empty (icon-only rows). */
  text: string;
}

/**
 * IconSymbol name for a preview kind, or `undefined` for plain text (no icon).
 * These are the SF-Symbol-style keys that `components/ui/IconSymbol.tsx` maps to
 * Tabler glyphs — NOT raw Tabler names. Unknown keys render null, so every value
 * here is verified against IconSymbol's map. `text` returns undefined so prose
 * previews don't get a spurious leading glyph.
 */
export function previewKindIcon(kind: MessagePreviewKind): IconSymbolName | undefined {
  switch (kind) {
    case 'image':
      return 'photo';
    case 'video':
      return 'video';
    case 'sticker':
      return 'sparkles';
    case 'reaction':
      return 'face.smiling';
    case 'call':
      return 'phone';
    case 'missed-call':
      return 'phone.down';
    case 'video-call':
      return 'video';
    case 'join':
      return 'person.badge.plus';
    case 'leave':
      return 'person';
    case 'kick':
      return 'xmark.circle';
    case 'update-profile':
      return 'pencil';
    case 'remove-message':
      return 'trash';
    case 'text':
    default:
      return undefined;
  }
}

export function messagePreview(
  message: Message | { content?: unknown } | null | undefined
): MessagePreview {
  if (!message) return { kind: 'text', text: '' };
  const content = (message as Message).content as MessageContent | undefined;
  if (!content) return { kind: 'text', text: '' };

  if (typeof content === 'string') return { kind: 'text', text: content };
  if (typeof content !== 'object') return { kind: 'text', text: '' };

  const c = content as MessageContent & Record<string, unknown>;
  const type = c.type;

  switch (type) {
    case 'post':
    case 'event': {
      const text = c.text;
      if (Array.isArray(text)) return { kind: 'text', text: text.join('') };
      return { kind: 'text', text: typeof text === 'string' ? text : '' };
    }
    case 'embed': {
      if (c.videoUrl) return { kind: 'video', text: 'Video' };
      return { kind: 'image', text: 'Image' };
    }
    case 'sticker':
      return { kind: 'sticker', text: 'Sticker' };
    case 'call-event': {
      const isVideo = c.mediaType === 'video';
      const missed = c.event === 'missed';
      const kind: MessagePreviewKind = missed
        ? 'missed-call'
        : isVideo
          ? 'video-call'
          : 'call';
      const text = missed ? 'Missed call' : isVideo ? 'Video call' : 'Call';
      return { kind, text };
    }
    case 'reaction':
      return { kind: 'reaction', text: `Reacted ${c.reaction ?? ''}`.trim() };
    case 'join':
      return { kind: 'join', text: 'Joined' };
    case 'leave':
      return { kind: 'leave', text: 'Left' };
    case 'kick':
      return { kind: 'kick', text: 'Kicked a member' };
    case 'update-profile':
      return { kind: 'update-profile', text: 'Updated profile' };
    case 'remove-message':
      return { kind: 'remove-message', text: 'Message removed' };
    default:
      return { kind: 'text', text: '' };
  }
}

/** Legacy emoji prefixes that older builds baked into the stored string. */
const LEGACY_EMOJI_PREFIX = /^(?:🎨|📷|📹)\s*/u;

/**
 * Upgrade a possibly-legacy stored preview to the typed shape. Accepts:
 *  - a `MessagePreview` (returned as-is),
 *  - a legacy string (emoji prefix stripped → `{ kind:'text', text }`),
 *  - the old raw-content object shape some DM rows stored
 *    (`{ type, text, videoUrl, reaction }`) → reuses `messagePreview`,
 *  - null/undefined → empty text preview.
 * Never throws — defensive on read so stale MMKV rows can't crash a list.
 */
export function coerceMessagePreview(value: unknown): MessagePreview {
  if (value == null) return { kind: 'text', text: '' };
  if (typeof value === 'string') {
    return { kind: 'text', text: value.replace(LEGACY_EMOJI_PREFIX, '') };
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Already-typed preview.
    if (typeof obj.kind === 'string' && typeof obj.text === 'string') {
      return obj as unknown as MessagePreview;
    }
    // Legacy raw-content object — derive via the normal path.
    if ('type' in obj || 'text' in obj || 'videoUrl' in obj || 'reaction' in obj) {
      return messagePreview({ content: obj });
    }
  }
  return { kind: 'text', text: '' };
}

/**
 * Sender name helper — returns the sender's display name when possible, or
 * a short-form of the address otherwise.
 */
export function messageSenderName(
  senderAddress: string | undefined,
  currentUserAddress: string | undefined,
  memberMap?: Record<string, { display_name?: string; name?: string }>
): string | undefined {
  if (!senderAddress) return undefined;
  if (currentUserAddress && senderAddress === currentUserAddress) return 'You';
  const member = memberMap?.[senderAddress];
  const name = member?.display_name || member?.name;
  if (name) return name;
  if (senderAddress.length > 12) return `${senderAddress.slice(0, 8)}...`;
  return senderAddress;
}
