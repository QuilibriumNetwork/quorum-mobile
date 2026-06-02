import type { AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import { Text, TextStyle, View } from 'react-native';
import { useTranslatable } from '@/services/translation/useTranslatable';
import { TranslateToggle } from '@/components/translation/TranslateToggle';

interface CastTextProps {
  text: string;
  style?: TextStyle;
  theme: AppTheme;
  onMentionPress?: (username: string) => void;
  onChannelPress?: (channelKey: string) => void;
  onLinkPress?: (url: string) => void;
  /** Show an on-device "See translation" toggle for non-target-language text. */
  enableTranslate?: boolean;
}

type TextPart = {
  type: 'text' | 'mention' | 'channel' | 'link';
  value: string;
};

// Match URLs, @mentions (after whitespace/start), and /channels (after whitespace/start)
// URLs are matched first to prevent their paths being parsed as channels
const combinedRegex = /(https?:\/\/[^\s]+)|(?<=^|[\s])(@[a-zA-Z0-9._-]+)|(?<=^|[\s])(\/[a-zA-Z0-9_-]+)/g;

function parseText(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let lastIndex = 0;
  let match;

  // Reset regex state (global flag means lastIndex persists)
  combinedRegex.lastIndex = 0;

  while ((match = combinedRegex.exec(text)) !== null) {
    // Add text before this match
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }

    // Add the match itself
    if (match[1]) {
      // URL
      parts.push({ type: 'link', value: match[1] });
    } else if (match[2]) {
      // @mention
      parts.push({ type: 'mention', value: match[2].slice(1) }); // Remove @ prefix
    } else if (match[3]) {
      // /channel
      parts.push({ type: 'channel', value: match[3].slice(1) }); // Remove / prefix
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return parts;
}

/**
 * Renders cast text with tappable @mentions, /channels, and links.
 */
export const CastText = React.memo(function CastText({
  text,
  style,
  theme,
  onMentionPress,
  onChannelPress,
  onLinkPress,
  enableTranslate = false,
}: CastTextProps) {
  const { showToggle, displayText, state, label, errorText, toggle } = useTranslatable(
    text,
    enableTranslate
  );
  // Parse the displayed text (original or translated) so mentions/links in the
  // translated copy still highlight.
  const parts = useMemo(() => parseText(displayText), [displayText]);
  const accentStyle = useMemo(() => ({ color: theme.colors.accent }), [theme.colors.accent]);

  const body = (
    <Text style={style}>
      {parts.map((part, index) => {
        if (part.type === 'link') {
          return (
            <Text
              key={index}
              style={accentStyle}
              onPress={() => onLinkPress?.(part.value)}
            >
              {part.value}
            </Text>
          );
        } else if (part.type === 'mention') {
          return (
            <Text
              key={index}
              style={accentStyle}
              onPress={() => onMentionPress?.(part.value)}
            >
              @{part.value}
            </Text>
          );
        } else if (part.type === 'channel') {
          return (
            <Text
              key={index}
              style={accentStyle}
              onPress={() => onChannelPress?.(part.value)}
            >
              /{part.value}
            </Text>
          );
        }
        return <Text key={index}>{part.value}</Text>;
      })}
    </Text>
  );

  // Only wrap in a View (and show the toggle) when translation applies; the
  // bare <Text> path is preserved for the common same-language case.
  if (!showToggle) return body;
  return (
    <View>
      {body}
      <TranslateToggle
        state={state}
        label={label}
        errorText={errorText}
        onPress={toggle}
        theme={theme}
      />
    </View>
  );
});

export default CastText;
