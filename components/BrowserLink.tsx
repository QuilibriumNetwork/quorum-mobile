import React from 'react';
import { StyleProp, Text, TextStyle, ViewStyle } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useOpenLink } from '@/hooks/useOpenLink';
import { useTheme } from '@/theme';

interface BrowserLinkProps {
  url: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}

/**
 * A tappable URL in a message body (the link-card branch of MessagesList).
 *
 * Routes through the same `useOpenLink` as every other chat link, so a YouTube
 * link in a link card hands off to the YouTube app exactly like one tapped in a
 * message, and everything else opens the in-app browser in link mode.
 *
 * This used to push the standalone `/browser` route, which had its own copy of
 * the browser chrome and an "open externally" button whose entire body was
 * `router.back()`. It also carried an `openInApp={false}` branch that was an
 * empty stub. Both are gone; the route has been deleted.
 */
export default function BrowserLink({
  url,
  children,
  style,
  textStyle,
}: BrowserLinkProps) {
  const { theme } = useTheme();
  const openLink = useOpenLink();

  const baseTextStyle: TextStyle = {
    color: theme.colors.primary,
    textDecorationLine: 'underline',
  };
  const mergedTextStyle: StyleProp<TextStyle> = [baseTextStyle, textStyle];

  return (
    <TouchableOpacity
      onPress={() => openLink(url)}
      style={style}
      activeOpacity={0.7}
      accessibilityRole="link"
      accessibilityLabel={typeof children === 'string' ? children : url}
    >
      {typeof children === 'string' ? (
        <Text style={mergedTextStyle}>{children}</Text>
      ) : (
        children
      )}
    </TouchableOpacity>
  );
}
