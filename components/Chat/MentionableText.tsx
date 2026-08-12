/**
 * MentionableText - Renders text with @mentions, #channels, links, and :emoji: patterns
 *
 * Supports:
 * - @username mentions (highlighted and tappable)
 * - #channel links (highlighted and tappable)
 * - URLs (highlighted and tappable)
 * - Custom space emojis (rendered as images)
 * - Standard Unicode emojis via shortcodes
 */

import type { AppTheme } from '@/theme';
import React, { useMemo, useEffect } from 'react';
import { Text, Image, StyleSheet, TextStyle, View } from 'react-native';
import type { Emoji, SpaceMember, Channel, Role } from '@quilibrium/quorum-shared';
import { getEmojiByName } from '@/data/emojiNames';
import { useNameResolver } from '@/identity';
import { formatResolvedName } from '@/identity/useResolvedName';
import { qnsLookupAddresses, MAX_QNS_LOOKUPS } from '@/hooks/chat/useConversationsWithQnsNames';
import { findMentionTokens } from '@/utils/mentionTokens';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';
import { useTranslatable } from '@/services/translation/useTranslatable';
import { TranslateToggle } from '@/components/translation/TranslateToggle';

interface MentionableTextProps {
  text: string;
  customEmojis: Emoji[];
  members?: SpaceMember[];
  /** The Space this text lives in, if any — passed through to `@/identity`
   *  so a mentioned member's per-space nickname outranks their `.q` here the
   *  same way it does everywhere else. Omitting it silently falls back to
   *  the global ladder. */
  spaceId?: string;
  /** Space roles, so a plain (non-markdown) message resolves `@roleTag` to a
   *  styled mention pill instead of leaving it as raw text. */
  roles?: Role[];
  /** Whether this message's `@everyone` was authorized (mentions.everyone set AND
   *  the sender holds mention:everyone). When false, `@everyone` renders as plain
   *  text — same trust rule the notification path enforces. */
  everyoneAuthorized?: boolean;
  channels?: Channel[];
  currentUserId?: string;
  style?: TextStyle;
  mentionStyle?: TextStyle;
  channelStyle?: TextStyle;
  emojiSize?: number;
  largeEmojiSize?: number;
  onMentionPress?: (userId: string) => void;
  onChannelPress?: (channelId: string) => void;
  onLinkPress?: (url: string) => void;
  theme?: AppTheme;
  /** Show an on-device "See translation" toggle for non-target-language text. */
  enableTranslate?: boolean;
  /**
   * Inline trailing node (e.g. a DM receipt) rendered as the last child inside
   * the terminal <Text> so it flows on the same line as the message text and
   * wraps with it. Sits before the translation toggle when both are present.
   */
  receipt?: React.ReactNode;
  /**
   * View-based form of `receipt`, required by the emoji-only branches below.
   * Those lay the trailing group out as a flex child, and an inline <Image>
   * inside a <Text> that is a flex child draws outside its measured box — which
   * left the receipt and the unsigned warning sitting in different places.
   * Falls back to `receipt` when a caller hasn't supplied it.
   */
  receiptBlock?: React.ReactNode;
}

// Mention tokenizing lives in utils/mentionTokens so the notification path can
// share it — see that file. Channel matching is done by looking up actual
// channel names, not regex.
const EMOJI_REGEX = /:([a-zA-Z0-9_-]+):/g;
// URL regex - matches http(s) URLs
const URL_REGEX = /https?:\/\/[^\s<>"\])}]+/gi;

type PartType = 'text' | 'mention' | 'channel' | 'emoji' | 'standard_emoji' | 'link';

interface TextPart {
  type: PartType;
  content: string;
  // For mentions. `label` — not `displayName` — deliberately: this already
  // holds the text to render after `@` (a member resolved through
  // `@/identity`, a role's own tag, or the literal "everyone"), and naming
  // it like a raw member field would falsely resemble the exact pattern the
  // raw-name-field audit (`__tests__/rawNameFieldAudit.test.ts`) exists to
  // catch.
  userId?: string;
  label?: string;
  isSelf?: boolean;
  // For channels
  channelId?: string;
  channelName?: string;
  // For emojis
  emoji?: Emoji;
  standardEmoji?: string;
  // For links
  url?: string;
}

// Regex to detect if text is only emojis (Unicode emojis, no other content)
// Uses Emoji_Presentation to match only emojis that display as emoji by default
// Excludes digits 0-9 and other text characters that are technically in \p{Emoji}
const EMOJI_ONLY_REGEX = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{FE0F}\s]+$/u;

// Matches ONE emoji cluster: a base pictographic char plus any variation
// selectors and ZWJ-joined follow-ups (so 👨‍👩‍👧 counts as one). Used to count
// how many emojis an emoji-only message holds, for the size tiers below.
const EMOJI_CLUSTER_REGEX =
  /\p{Extended_Pictographic}(\u{FE0F}?(‍\p{Extended_Pictographic}\u{FE0F}?)*)/gu;

// Emoji-only messages render bigger than inline emoji, in three tiers by count:
//   1 emoji  → largest (a single reaction-style emoji reads big)
//   2–3      → the current large size
//   4+       → default inline size (a wall of emoji shouldn't dominate the row)
// Multipliers are applied to the base body font size.
function emojiOnlyScale(count: number): number {
  if (count <= 1) return 6; // a lone emoji renders extra-large (2x the old size)
  if (count <= 3) return 2;
  return 1;
}

// Line box for enlarged emoji. Emoji glyphs draw beyond the nominal em box on
// both platforms, so the line box needs ~20% headroom: pinning lineHeight to
// the font size clips the glyph tops/bottoms, while leaving it unset gives
// Android's emoji font an oversized line box (the old empty-gap-below bug).
function emojiLineHeight(size: number): number {
  return Math.round(size * 1.2);
}

// Count emoji clusters in an emoji-only string (whitespace ignored).
function countEmojiClusters(text: string): number {
  const matches = text.replace(/\s+/g, '').match(EMOJI_CLUSTER_REGEX);
  return matches ? matches.length : 0;
}

function MentionableTextBase({
  text: rawText,
  customEmojis,
  members = [],
  spaceId,
  roles = [],
  everyoneAuthorized = false,
  channels = [],
  currentUserId,
  style,
  mentionStyle,
  channelStyle,
  emojiSize = 20,
  largeEmojiSize = 40,
  onMentionPress,
  onChannelPress,
  onLinkPress,
  theme,
  enableTranslate = false,
  receipt,
  receiptBlock,
}: MentionableTextProps) {
  // On-device translation. `text` below is the displayed copy (original or
  // translated), so all parsing/rendering downstream is unchanged.
  const { showToggle, displayText, state, label, errorText, toggle } = useTranslatable(
    rawText,
    enableTranslate
  );
  const text = displayText;

  // A pill's name resolution: `resolve` is a plain function, safe to call
  // inside the `parts` useMemo's loop below. Only the `useNameResolver()`
  // hook call itself lives here, at the top — never a hook per mention.
  const { resolve, requestNames } = useNameResolver();

  // Wrap a rendered text node with the translation toggle when applicable.
  // Requires a theme to style the toggle; without one we render text only.
  const renderWithToggle = (node: React.ReactElement): React.ReactElement => {
    if (!showToggle || !theme) return node;
    return (
      <View>
        {node}
        <TranslateToggle
          state={state}
          label={label}
          errorText={errorText}
          onPress={toggle}
          theme={theme}
        />
      </View>
    );
  };

  // Create lookup maps
  const emojiMap = useMemo(() => {
    const map: Record<string, Emoji> = {};
    customEmojis.forEach((e) => {
      map[e.name.toLowerCase()] = e;
    });
    return map;
  }, [customEmojis]);

  const memberMap = useMemo(() => {
    const map: Record<string, SpaceMember> = {};
    // ADDRESS ONLY. A user mention is `@<address>` — that is what the composer
    // writes, and it is the only form the notification path honours
    // (`extractMentionsFromText` in shared extracts `@<address>` and nothing
    // else). Keying on names too used to turn a hand-typed `@Name` into a pill
    // that is styled, tappable, and notifies nobody.
    //
    // Names cannot identify a person anyway: they are not unique, and a plain
    // object map means the later member silently wins a collision and the pill
    // opens the wrong profile.
    //
    // The markdown path is switched off the same legacy branch in
    // `MessageRenderer` (by not passing `members` to `prepareMessageContent`),
    // so both render paths agree. Change them together or the same `@Name` is a
    // pill in a formatted message and plain text in a plain one.
    //
    // Roles are unaffected — bare `@roleTag` IS honoured by the notifier, and
    // `roleMap` below still resolves them.
    members.forEach((m) => {
      if (m.address) map[m.address.toLowerCase()] = m;
    });
    return map;
  }, [members]);

  // Role lookup by lowercased roleTag, so `@roleTag` resolves to a pill in the
  // plain (non-markdown) render path the way the markdown renderer already does.
  const roleMap = useMemo(() => {
    const map: Record<string, Role> = {};
    roles.forEach((r) => {
      if (r.roleTag) map[r.roleTag.toLowerCase()] = r;
    });
    return map;
  }, [roles]);

  // Create channel lookup map sorted by name length (longest first) for greedy matching
  const sortedChannels = useMemo(() => {
    return [...channels].sort((a, b) => b.channelName.length - a.channelName.length);
  }, [channels]);

  // Parse text into parts
  const parts = useMemo((): TextPart[] => {
    if (!text) {
      return [{ type: 'text', content: '' }];
    }

    // Collect all matches with their positions
    interface Match {
      type: PartType;
      start: number;
      end: number;
      content: string;
      data?: {
        userId?: string;
        label?: string;
        isSelf?: boolean;
        channelId?: string;
        channelName?: string;
        emoji?: Emoji;
        standardEmoji?: string;
        url?: string;
      };
    }

    const matches: Match[] = [];

    // Find @mentions and @everyone. Tokenizing is shared with the notification
    // path (utils/mentionTokens); resolving a token to a member or a role stays
    // here, because only this surface holds the full roster.
    for (const token of findMentionTokens(text)) {
      if (token.kind === 'everyone') {
        // Only style @everyone when the sender was actually authorized to use it
        // (mentions.everyone set AND sender holds mention:everyone — computed by
        // the caller). An unauthorized/spoofed @everyone renders as plain text,
        // matching how the notification path already refuses to honor it.
        if (everyoneAuthorized) {
          matches.push({
            type: 'mention',
            start: token.start,
            end: token.end,
            content: token.raw,
            data: { userId: 'everyone', label: 'everyone', isSelf: false },
          });
        }
        continue;
      }
      const name = token.key.toLowerCase();
      const member = memberMap[name];
      if (member) {
        matches.push({
          type: 'mention',
          start: token.start,
          end: token.end,
          content: token.raw,
          data: {
            userId: member.address,
            label: formatResolvedName(resolve(member.address, { spaceId })),
            isSelf: member.address === currentUserId,
          },
        });
        continue;
      }
      // Not a member — is it a role? Only the BARE form carries a role tag
      // (`@<…>` is always an address), and it resolves to a styled mention pill
      // whose display name is the role tag, matching the markdown path and
      // desktop (one accent color for all mention types, not the role color).
      const role = token.kind === 'bare' ? roleMap[name] : undefined;
      if (role) {
        matches.push({
          type: 'mention',
          start: token.start,
          end: token.end,
          content: token.raw,
          data: { userId: `role:${role.roleId}`, label: role.roleTag, isSelf: false },
        });
      }
    }

    // Find #channels - search for actual channel names after each #
    // Uses pre-sorted channels (longest first) for greedy matching with early exit
    let searchStart = 0;
    while (searchStart < text.length) {
      const hashIndex = text.indexOf('#', searchStart);
      if (hashIndex === -1) break;

      // Get the text after the #
      const afterHash = text.slice(hashIndex + 1);
      const afterHashLower = afterHash.toLowerCase();

      // Canonical wire format first: #<channelId>. Match by id, render the name.
      let foundChannel: Channel | null = null;
      let matchLen = 0; // chars consumed after the '#'
      if (afterHash.startsWith('<')) {
        const close = afterHash.indexOf('>');
        if (close > 0) {
          const id = afterHash.slice(1, close);
          const byId = channels.find((c) => c.channelId === id);
          if (byId) {
            foundChannel = byId;
            matchLen = close + 1; // include the closing '>'
          }
        }
      }

      // Legacy / human-typed: #channelName (matched by name, longest first).
      if (!foundChannel) {
        for (const channel of sortedChannels) {
          if (afterHashLower.startsWith(channel.channelName.toLowerCase())) {
            foundChannel = channel;
            matchLen = channel.channelName.length;
            break; // Early exit - first match is longest due to pre-sorting
          }
        }
      }

      if (foundChannel) {
        matches.push({
          type: 'channel',
          start: hashIndex,
          end: hashIndex + 1 + matchLen,
          content: '#' + foundChannel.channelName,
          data: {
            channelId: foundChannel.channelId,
            channelName: foundChannel.channelName,
          },
        });
        searchStart = hashIndex + 1 + matchLen;
      } else {
        searchStart = hashIndex + 1;
      }
    }

    // Find :emoji: patterns
    let match: RegExpExecArray | null;
    EMOJI_REGEX.lastIndex = 0;
    while ((match = EMOJI_REGEX.exec(text)) !== null) {
      const emojiName = match[1].toLowerCase();
      const customEmoji = emojiMap[emojiName];
      if (customEmoji) {
        matches.push({
          type: 'emoji',
          start: match.index,
          end: match.index + match[0].length,
          content: match[0],
          data: { emoji: customEmoji },
        });
      } else {
        const standardEmoji = getEmojiByName(emojiName);
        if (standardEmoji) {
          matches.push({
            type: 'standard_emoji',
            start: match.index,
            end: match.index + match[0].length,
            content: match[0],
            data: { standardEmoji },
          });
        }
      }
    }

    // Find URLs
    URL_REGEX.lastIndex = 0;
    while ((match = URL_REGEX.exec(text)) !== null) {
      // Clean up trailing punctuation that might have been captured
      let url = match[0];
      // Remove trailing punctuation that's likely not part of the URL
      while (url.length > 0 && /[.,;:!?]$/.test(url)) {
        url = url.slice(0, -1);
      }
      matches.push({
        type: 'link',
        start: match.index,
        end: match.index + url.length,
        content: url,
        data: { url },
      });
    }

    // Sort matches by position
    matches.sort((a, b) => a.start - b.start);

    // Remove overlapping matches (keep first)
    const filteredMatches: Match[] = [];
    let lastEnd = 0;
    for (const m of matches) {
      if (m.start >= lastEnd) {
        filteredMatches.push(m);
        lastEnd = m.end;
      }
    }

    // Build parts array
    const result: TextPart[] = [];
    let currentIndex = 0;

    for (const m of filteredMatches) {
      // Add text before this match
      if (m.start > currentIndex) {
        result.push({
          type: 'text',
          content: text.slice(currentIndex, m.start),
        });
      }

      // Add the match
      if (m.type === 'mention') {
        result.push({
          type: 'mention',
          content: m.content,
          userId: m.data!.userId,
          label: m.data!.label,
          isSelf: m.data!.isSelf,
        });
      } else if (m.type === 'channel') {
        result.push({
          type: 'channel',
          content: m.content,
          channelId: m.data!.channelId,
          channelName: m.data!.channelName,
        });
      } else if (m.type === 'emoji') {
        result.push({
          type: 'emoji',
          content: m.content,
          emoji: m.data!.emoji,
        });
      } else if (m.type === 'standard_emoji') {
        result.push({
          type: 'standard_emoji',
          content: m.content,
          standardEmoji: m.data!.standardEmoji,
        });
      } else if (m.type === 'link') {
        result.push({
          type: 'link',
          content: m.content,
          url: m.data!.url,
        });
      }

      currentIndex = m.end;
    }

    // Add remaining text
    if (currentIndex < text.length) {
      result.push({
        type: 'text',
        content: text.slice(currentIndex),
      });
    }

    if (result.length === 0) {
      return [{ type: 'text', content: text }];
    }

    return result;
  }, [text, emojiMap, memberMap, roleMap, everyoneAuthorized, sortedChannels, currentUserId, resolve, spaceId]);

  // Enrich the addresses actually @mentioned in THIS message, so a pill can
  // show a verified `.q` on first view rather than only after some other
  // surface happened to enrich the same address first. Bounded to what fits
  // in one message (a handful of real mentions in the common case), unlike a
  // list surface — but still capped at `MAX_QNS_LOOKUPS` for defense against
  // a message engineered to name-drop the whole roster; `requestNames`
  // dedupes against addresses already requested, so re-rendering the same
  // message (or mentioning the same person again elsewhere) costs nothing.
  const mentionedMemberAddresses = useMemo(() => {
    const addresses = parts
      .filter((p) => p.type === 'mention' && !!p.userId && p.userId !== 'everyone' && !p.userId.startsWith('role:'))
      .map((p) => ({ address: p.userId! }));
    return qnsLookupAddresses(addresses, MAX_QNS_LOOKUPS);
  }, [parts]);
  useEffect(() => {
    requestNames(mentionedMemberAddresses);
  }, [mentionedMemberAddresses, requestNames]);

  // Check if we have any special content
  const hasSpecialContent = parts.some(
    (p) => p.type === 'emoji' || p.type === 'standard_emoji' || p.type === 'mention' || p.type === 'channel' || p.type === 'link'
  );

  if (!hasSpecialContent) {
    // Check if text is only Unicode emojis
    const isEmojiOnly = text && EMOJI_ONLY_REGEX.test(text.trim());
    if (isEmojiOnly) {
      const base = style?.fontSize || 16;
      const size = base * emojiOnlyScale(countEmojiClusters(text));
      // Line height via emojiLineHeight — see its comment for why neither
      // unset nor font-size-pinned works.
      // Emoji-only: lay out in a bottom-aligned row so the (small) trailing
      // indicators sit at the bottom of the (large) emoji rather than floating
      // up the tall line box. `receipt` is a <Text>-wrapped node, valid here.
      return renderWithToggle(
        <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
          {/* flexShrink so a wide emoji run gives way to the trailing indicators
              rather than squeezing them into a width that makes them wrap. */}
          <Text style={[style, { fontSize: size, lineHeight: emojiLineHeight(size), flexShrink: 1 }]}>{text}</Text>
          {receiptBlock ?? receipt}
        </View>
      );
    }
    return renderWithToggle(
      <Text style={style}>
        {text}
        {receipt}
      </Text>
    );
  }

  // Check if message is emoji-only
  const isEmojiOnlyMessage = parts.every(
    (p) =>
      p.type === 'emoji' ||
      p.type === 'standard_emoji' ||
      (p.type === 'text' && p.content.trim() === '')
  );
  // Count emojis (custom-image parts + Unicode clusters in standard parts) so an
  // emoji-only message scales by the same 1 / 2–3 / 4+ tiers as the plain path.
  const emojiOnlyCount = isEmojiOnlyMessage
    ? parts.reduce(
        (n, p) =>
          n +
          (p.type === 'emoji'
            ? 1
            : p.type === 'standard_emoji'
            ? countEmojiClusters(p.standardEmoji ?? p.content)
            : 0),
        0
      )
    : 0;
  const emojiScale = isEmojiOnlyMessage ? emojiOnlyScale(emojiOnlyCount) : 1;
  const baseFont = style?.fontSize || 16;
  const scaledFont = baseFont * emojiScale;
  // Image emoji scale with the tier too; inline (with-text) keeps emojiSize.
  const effectiveEmojiSize = isEmojiOnlyMessage
    ? (largeEmojiSize / 2) * emojiScale
    : emojiSize;
  // Line height via emojiLineHeight — see its comment for why neither unset
  // nor font-size-pinned works.
  const effectiveStyle = isEmojiOnlyMessage
    ? { ...style, fontSize: scaledFont, lineHeight: emojiLineHeight(scaledFont) }
    : style;

  // Mention/channel styling — color-only (no highlighted background). The bg
  // pill read too heavy on mobile, so mentions render as a colored, medium-
  // weight run. Keep in sync with MessageMarkdownRenderer's pill style.
  const defaultMentionStyle: TextStyle = {
    color: theme?.colors?.primary || '#5865F2',
    fontWeight: '600',
  };

  // All mentions use the same accent color (no special self-mention hue) for a
  // consistent look.
  const selfMentionStyle: TextStyle = defaultMentionStyle;

  const defaultChannelStyle: TextStyle = {
    color: theme?.colors?.primary || '#5865F2',
    fontWeight: '600',
  };

  const linkStyle: TextStyle = {
    color: theme?.colors?.primary || '#5865F2',
    textDecorationLine: 'underline',
  };

  const renderedParts = parts.map((part, index) => {
        if (part.type === 'mention') {
          const isEveryone = part.userId === 'everyone';
          // Role mentions are styled like a mention but not tappable (the
          // userId is a `role:<id>` sentinel, not a user address).
          const isRole = part.userId?.startsWith('role:') ?? false;
          const mStyle = isEveryone
            ? defaultMentionStyle
            : part.isSelf
            ? selfMentionStyle
            : defaultMentionStyle;
          if (!isEveryone && !isRole && onMentionPress && part.userId) {
            return (
              <Text
                key={`mention-${index}`}
                style={[mStyle, mentionStyle]}
                onPress={() => onMentionPress(part.userId!)}
              >
                @{part.label}
              </Text>
            );
          }
          return (
            <Text key={`mention-${index}`} style={[mStyle, mentionStyle]}>
              @{part.label}
            </Text>
          );
        }

        if (part.type === 'channel') {
          if (onChannelPress && part.channelId) {
            return (
              <Text
                key={`channel-${index}`}
                style={[defaultChannelStyle, channelStyle]}
                onPress={() => onChannelPress(part.channelId!)}
              >
                #{part.channelName}
              </Text>
            );
          }
          return (
            <Text key={`channel-${index}`} style={[defaultChannelStyle, channelStyle]}>
              #{part.channelName}
            </Text>
          );
        }

        if (part.type === 'emoji' && part.emoji) {
          return (
            <View
              key={`emoji-${index}`}
              style={[localStyles.emojiContainer, { width: effectiveEmojiSize, height: effectiveEmojiSize }]}
            >
              <Image
                source={{ uri: part.emoji.imgUrl }}
                style={[localStyles.emoji, { width: effectiveEmojiSize, height: effectiveEmojiSize }]}
                resizeMode="contain"
              />
            </View>
          );
        }

        if (part.type === 'standard_emoji' && part.standardEmoji) {
          return <Text key={`standard-${index}`}>{part.standardEmoji}</Text>;
        }

        if (part.type === 'link' && part.url) {
          if (onLinkPress) {
            return (
              <Text
                key={`link-${index}`}
                style={linkStyle}
                onPress={() => onLinkPress(part.url!)}
              >
                {part.content}
              </Text>
            );
          }
          // If no handler, just render as styled text (not tappable)
          return (
            <Text key={`link-${index}`} style={linkStyle}>
              {part.content}
            </Text>
          );
        }

        return <Text key={`text-${index}`}>{part.content}</Text>;
  });

  // Emoji-only (custom/shortcode): bottom-align the trailing indicators against
  // the large emoji, same as the plain emoji path above. Otherwise keep them
  // inline in the text so they flow and wrap with it.
  if (isEmojiOnlyMessage) {
    return renderWithToggle(
      <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
        {/* flexShrink so a wide emoji run gives way to the trailing indicators
            rather than squeezing them into a width that makes them wrap. */}
        <Text style={[effectiveStyle, { flexShrink: 1 }]}>{renderedParts}</Text>
        {receiptBlock ?? receipt}
      </View>
    );
  }
  return renderWithToggle(
    <Text style={effectiveStyle}>
      {renderedParts}
      {receipt}
    </Text>
  );
}


const localStyles = createSkinnable(() => StyleSheet.create({
  emojiContainer: {
    marginBottom: Skin.space(-4),
  },
  emoji: {},
}));

// Memoized: this is rendered once per message row and re-parses text +
// mentions on every render. The DM view polls every few seconds, so without
// memoization every poll re-parsed every visible message's text — a big
// chunk of the redraw churn that OOM'd low-RAM devices.
export const MentionableText = React.memo(MentionableTextBase);

export default MentionableText;
