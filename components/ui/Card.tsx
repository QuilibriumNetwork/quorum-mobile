import React from 'react';
import { StyleSheet, View, StyleProp, ViewStyle } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useTheme, type AppTheme } from '@/theme';
import { LinearGradient } from 'expo-linear-gradient';
import * as Skin from '@/theme/skins/geometry';
import { frameAccentBorder, framePanelGlow } from '@/theme/skins/frame';

type CardVariant = 'default' | 'gradient' | 'bordered';
type CardPadding = 'none' | 'sm' | 'md' | 'lg';

interface CardProps {
  /** Card content */
  children: React.ReactNode;
  /** Visual variant */
  variant?: CardVariant;
  /** Padding preset */
  padding?: CardPadding;
  /** Press handler - makes card touchable */
  onPress?: () => void;
  /** Custom style */
  style?: StyleProp<ViewStyle>;
  /** Test ID */
  testID?: string;
}

/**
 * Themed card container with multiple variants.
 *
 * @example
 * ```tsx
 * <Card variant="default" padding="md">
 *   <Text>Card content</Text>
 * </Card>
 *
 * <Card variant="gradient" onPress={handlePress}>
 *   <Text>Tappable gradient card</Text>
 * </Card>
 * ```
 */
export function Card({
  children,
  variant = 'default',
  padding = 'md',
  onPress,
  style,
  testID,
}: CardProps) {
  const { theme, isDark } = useTheme();
  const styles = createStyles(theme, isDark, variant, padding);

  const content = (
    <View style={styles.inner}>
      {children}
    </View>
  );

  if (variant === 'gradient') {
    const gradientColors: [string, string] = isDark
      ? [theme.colors.surface3, theme.colors.surface4]
      : [theme.colors.accent, theme.colors.accentDark];

    const gradientContent = (
      <LinearGradient
        colors={gradientColors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.card, styles.gradient, style]}
        testID={testID}
      >
        {content}
      </LinearGradient>
    );

    if (onPress) {
      return (
        <TouchableOpacity onPress={onPress} activeOpacity={0.8}>
          {gradientContent}
        </TouchableOpacity>
      );
    }

    return gradientContent;
  }

  if (onPress) {
    return (
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.8}
        style={[styles.card, style]}
        testID={testID}
      >
        {content}
      </TouchableOpacity>
    );
  }

  return (
    <View style={[styles.card, style]} testID={testID}>
      {content}
    </View>
  );
}

const createStyles = (
  theme: AppTheme,
  isDark: boolean,
  variant: CardVariant,
  padding: CardPadding
) => {
  const getPadding = () => {
    switch (padding) {
      case 'none':
        return 0;
      case 'sm':
        return 8;
      case 'md':
        return 16;
      case 'lg':
        return 24;
    }
  };

  const getBackgroundColor = () => {
    switch (variant) {
      case 'default':
        return theme.colors.surface2;
      case 'bordered':
        return 'transparent';
      case 'gradient':
        return 'transparent';
    }
  };

  return StyleSheet.create({
    card: {
      backgroundColor: getBackgroundColor(),
      borderRadius: Skin.radius(12),
      overflow: 'hidden',
      ...(variant === 'bordered' ? {
        borderWidth: Skin.border(1),
        borderColor: theme.colors.border,
      } : {}),
      // Decorative skin frame (accent ring + glow) when the skin opts in.
      ...frameAccentBorder(theme),
      ...framePanelGlow(theme),
    },
    gradient: {
      backgroundColor: 'transparent',
    },
    inner: {
      padding: getPadding(),
    },
  });
};

export default Card;
