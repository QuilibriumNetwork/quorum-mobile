import React, { useState } from 'react';
import { ImageSourcePropType, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { Image } from 'expo-image';
import { useTheme, type AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

// expo-image caching policy for avatars
const AVATAR_CACHE_POLICY = 'disk' as const;

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

interface AvatarProps {
  /** Image source - can be require() or { uri: string } */
  source?: ImageSourcePropType | string;
  /** Size preset */
  size?: AvatarSize;
  /** Fallback text (usually initials) */
  fallback?: string;
  /** Show online/status badge */
  showBadge?: boolean;
  /** Badge color */
  badgeColor?: string;
  /** Press handler */
  onPress?: () => void;
  /** Custom style */
  style?: ViewStyle;
  /** Test ID */
  testID?: string;
}

const SIZE_MAP: Record<AvatarSize, number> = {
  xs: 24,
  sm: 32,
  md: 40,
  lg: 56,
  xl: 80,
};

const FONT_SIZE_MAP: Record<AvatarSize, number> = {
  xs: 10,
  sm: 12,
  md: 14,
  lg: 20,
  xl: 28,
};

/**
 * Avatar component with image, fallback, and optional status badge.
 *
 * @example
 * ```tsx
 * <Avatar source={user.avatar} size="md" />
 *
 * <Avatar fallback="JD" size="lg" showBadge badgeColor="green" />
 *
 * <Avatar source={{ uri: imageUrl }} onPress={handlePress} />
 * ```
 */
export function Avatar({
  source,
  size = 'md',
  fallback,
  showBadge = false,
  badgeColor,
  onPress,
  style,
  testID,
}: AvatarProps) {
  const { theme } = useTheme();
  const [imageError, setImageError] = useState(false);

  const dimension = SIZE_MAP[size];
  const fontSize = FONT_SIZE_MAP[size];
  const styles = createStyles(theme, dimension, fontSize, badgeColor);

  // Normalize source
  const imageSource: ImageSourcePropType | undefined =
    typeof source === 'string' ? { uri: source } : source;

  const shouldShowImage = imageSource && !imageError;
  const shouldShowFallback = !shouldShowImage && fallback;

  const avatarContent = (
    <View style={[styles.container, style]} testID={testID}>
      {shouldShowImage ? (
        <Image
          source={imageSource}
          style={styles.image}
          cachePolicy={AVATAR_CACHE_POLICY}
          transition={0}
          onError={() => setImageError(true)}
        />
      ) : shouldShowFallback ? (
        <View style={styles.fallbackContainer}>
          <Text style={styles.fallbackText}>
            {fallback.slice(0, 2).toUpperCase()}
          </Text>
        </View>
      ) : (
        <View style={styles.fallbackContainer}>
          <Text style={styles.fallbackText}>?</Text>
        </View>
      )}

      {showBadge && (
        <View style={styles.badge} />
      )}
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.8}>
        {avatarContent}
      </TouchableOpacity>
    );
  }

  return avatarContent;
}

const createStyles = (
  theme: AppTheme,
  dimension: number,
  fontSize: number,
  badgeColor?: string
) => {
  const badgeSize = Math.max(8, dimension * 0.25);

  return StyleSheet.create({
    container: {
      width: dimension,
      height: dimension,
      borderRadius: dimension / 2,
      position: 'relative',
    },
    image: {
      width: dimension,
      height: dimension,
      borderRadius: dimension / 2,
    },
    fallbackContainer: {
      width: dimension,
      height: dimension,
      borderRadius: dimension / 2,
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
    },
    fallbackText: {
      fontSize: fontSize,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.primary,
    },
    badge: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      width: badgeSize,
      height: badgeSize,
      borderRadius: badgeSize / 2,
      backgroundColor: badgeColor || theme.colors.success,
      borderWidth: Skin.border(2),
      borderColor: theme.colors.background,
    },
  });
};

export default Avatar;
