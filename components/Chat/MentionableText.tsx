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
import React, { useMemo } from 'react';
import { Text, Image, StyleSheet, TextStyle, View } from 'react-native';
import type { Emoji, SpaceMember, Channel } from '@quilibrium/quorum-shared';
import { getEmojiByName } from '@/data/emojiNames';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';
import { useTranslatable } from '@/services/translation/useTranslatable';
import { TranslateToggle } from '@/components/translation/TranslateToggle';

interface MentionableTextProps {
  text: string;
  customEmojis: Emoji[];
  members?: SpaceMember[];
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
}

// Regex patterns for @mentions, URLs, and :emoji:
// Channel matching is done by looking up actual channel names, not regex
const MENTION_REGEX = /@([a-zA-Z0-9_.\-]+)/g;
const EMOJI_REGEX = /:([a-zA-Z0-9_-]+):/g;
// URL regex - matches http(s) URLs
const URL_REGEX = /https?:\/\/[^\s<>"\])}]+/gi;

type PartType = 'text' | 'mention' | 'channel' | 'emoji' | 'standard_emoji' | 'link';

interface TextPart {
  type: PartType;
  content: string;
  // For mentions
  userId?: string;
  displayName?: string;
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

function MentionableTextBase({
  text: rawText,
  customEmojis,
  members = [],
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
}: MentionableTextProps) {
  // On-device translation. `text` below is the displayed copy (original or
  // translated), so all parsing/rendering downstream is unchanged.
  const { showToggle, displayText, state, label, errorText, toggle } = useTranslatable(
    rawText,
    enableTranslate
  );
  const text = displayText;

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
    members.forEach((m) => {
      // Map by display_name, name, and address for flexible matching
      if (m.display_name) map[m.display_name.toLowerCase()] = m;
      if (m.name) map[m.name.toLowerCase()] = m;
      if (m.address) map[m.address.toLowerCase()] = m;
    });
    return map;
  }, [members]);

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
        displayName?: string;
        isSelf?: boolean;
        channelId?: string;
        channelName?: string;
        emoji?: Emoji;
        standardEmoji?: string;
        url?: string;
      };
    }

    const matches: Match[] = [];

    // Find @mentions
    MENTION_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MENTION_REGEX.exec(text)) !== null) {
      const name = match[1].toLowerCase();
      const member = memberMap[name];
      if (member) {
        matches.push({
          type: 'mention',
          start: match.index,
          end: match.index + match[0].length,
          content: match[0],
          data: {
            userId: member.address,
            displayName: member.display_name || member.name || member.address,
            isSelf: member.address === currentUserId,
          },
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
      const afterHash = text.slice(hashIndex + 1).toLowerCase();

      // Find first match from sorted channels (already sorted longest first)
      let foundChannel: Channel | null = null;
      for (const channel of sortedChannels) {
        if (afterHash.startsWith(channel.channelName.toLowerCase())) {
          foundChannel = channel;
          break; // Early exit - first match is longest due to pre-sorting
        }
      }

      if (foundChannel) {
        matches.push({
          type: 'channel',
          start: hashIndex,
          end: hashIndex + 1 + foundChannel.channelName.length,
          content: '#' + foundChannel.channelName,
          data: {
            channelId: foundChannel.channelId,
            channelName: foundChannel.channelName,
          },
        });
        searchStart = hashIndex + 1 + foundChannel.channelName.length;
      } else {
        searchStart = hashIndex + 1;
      }
    }

    // Find :emoji: patterns
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
          displayName: m.data!.displayName,
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
  }, [text, emojiMap, memberMap, sortedChannels, currentUserId]);

  // Check if we have any special content
  const hasSpecialContent = parts.some(
    (p) => p.type === 'emoji' || p.type === 'standard_emoji' || p.type === 'mention' || p.type === 'channel' || p.type === 'link'
  );

  if (!hasSpecialContent) {
    // Check if text is only Unicode emojis
    const isEmojiOnly = text && EMOJI_ONLY_REGEX.test(text.trim());
    if (isEmojiOnly) {
      return renderWithToggle(
        <Text style={[style, { fontSize: (style?.fontSize || 16) * 2 }]}>{text}</Text>
      );
    }
    return renderWithToggle(<Text style={style}>{text}</Text>);
  }

  // Check if message is emoji-only
  const isEmojiOnlyMessage = parts.every(
    (p) =>
      p.type === 'emoji' ||
      p.type === 'standard_emoji' ||
      (p.type === 'text' && p.content.trim() === '')
  );
  const effectiveEmojiSize = isEmojiOnlyMessage ? largeEmojiSize : emojiSize;
  const effectiveStyle = isEmojiOnlyMessage
    ? { ...style, fontSize: (style?.fontSize || 16) * 2 }
    : style;

  // Default styles for mentions and channels
  const defaultMentionStyle: TextStyle = {
    color: theme?.colors?.primary || '#5865F2',
    backgroundColor: (theme?.colors?.primary || '#5865F2') + '20',
    borderRadius: Skin.radius(3),
    paddingHorizontal: Skin.space(2),
  };

  const selfMentionStyle: TextStyle = {
    ...defaultMentionStyle,
    backgroundColor: (theme?.colors?.warning || '#FAA61A') + '30',
  };

  const defaultChannelStyle: TextStyle = {
    color: theme?.colors?.primary || '#5865F2',
  };

  const linkStyle: TextStyle = {
    color: theme?.colors?.primary || '#5865F2',
    textDecorationLine: 'underline',
  };

  return renderWithToggle(
    <Text style={effectiveStyle}>
      {parts.map((part, index) => {
        if (part.type === 'mention') {
          const mStyle = part.isSelf ? selfMentionStyle : defaultMentionStyle;
          if (onMentionPress && part.userId) {
            return (
              <Text
                key={`mention-${index}`}
                style={[mStyle, mentionStyle]}
                onPress={() => onMentionPress(part.userId!)}
              >
                @{part.displayName}
              </Text>
            );
          }
          return (
            <Text key={`mention-${index}`} style={[mStyle, mentionStyle]}>
              @{part.displayName}
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
      })}
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
