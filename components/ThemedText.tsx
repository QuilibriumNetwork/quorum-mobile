import { StyleSheet, Text, type TextProps } from 'react-native';

import { useTheme } from '@/theme';
import { useThemeColor } from '@/hooks/useThemeColor';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

export type ThemedTextProps = TextProps & {
  lightColor?: string;
  darkColor?: string;
  type?: 'default' | 'title' | 'defaultSemiBold' | 'subtitle' | 'link';
};

export function ThemedText({
  style,
  lightColor,
  darkColor,
  type = 'default',
  ...rest
}: ThemedTextProps) {
  const { theme } = useTheme();
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text');

  return (
    <Text
      style={[
        { color, fontFamily: theme.fonts.regular.fontFamily },
        type === 'default' ? styles.default : undefined,
        type === 'title' ? [styles.title, { fontFamily: theme.fonts.bold.fontFamily }] : undefined,
        type === 'defaultSemiBold' ? [styles.defaultSemiBold, { fontFamily: theme.fonts.medium.fontFamily }] : undefined,
        type === 'subtitle' ? [styles.subtitle, { fontFamily: theme.fonts.bold.fontFamily }] : undefined,
        type === 'link' ? [styles.link, { color: theme.colors.primary }] : undefined,
        style,
      ]}
      {...rest}
    />
  );
}

const styles = createSkinnable(() => StyleSheet.create({
  default: {
    fontSize: Skin.font(16),
    lineHeight: Skin.font(24),
  },
  defaultSemiBold: {
    fontSize: Skin.font(16),
    lineHeight: Skin.font(24),
    fontWeight: '600',
  },
  title: {
    fontSize: Skin.font(32),
    fontWeight: 'bold',
    lineHeight: Skin.font(32),
  },
  subtitle: {
    fontSize: Skin.font(20),
    fontWeight: 'bold',
  },
  link: {
    lineHeight: Skin.font(30),
    fontSize: Skin.font(16),
  },
}));
