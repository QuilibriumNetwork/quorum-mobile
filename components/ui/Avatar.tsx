/**
 * Avatar — the generic presentational avatar: an image with size presets, a
 * plain text fallback, and an optional status badge.
 *
 * ## Which of these five do I reach for?
 *
 * There are five avatar components and their names do not make the choice
 * obvious, so:
 *
 * - **`Avatar`** (this file) — a self-contained UI primitive. Size presets
 *   (`xs`–`xl`), an optional press handler, an optional status dot. Its
 *   fallback is whatever STRING you hand it, drawn flat on `surface3`. It
 *   knows nothing about users, names or identity resolution. Reach for it in
 *   generic UI, or when you want the status badge.
 *
 * - **`DefaultAvatar`** — a person with no photo. Renders deterministic
 *   initials on a colour derived from their name. Use this, not `Avatar`'s
 *   string fallback, anywhere a real user is shown: the colour is stable per
 *   person and matches desktop.
 *
 * - **`AvatarInitials`** — the shared initials + gradient renderer underneath
 *   `DefaultAvatar` (users) and `SpaceIcon` (spaces). Call it directly only if
 *   you are building a third thing of that kind.
 *
 * - **`CachedAvatar`** — a photo in a list. Disk-cached, and rebinds correctly
 *   when a recycled row is reused. This is the one for feeds and long lists;
 *   it can fall back to `DefaultAvatar` via `fallbackName`.
 *
 * - **`ApexAvatarRing`** — not an avatar. A decorative ring drawn AROUND one
 *   for Apex subscribers; wraps any of the above.
 *
 * Rule of thumb: showing a **person** → `DefaultAvatar` or `CachedAvatar`.
 * Showing **anything else** → `Avatar`.
 */

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
 * `fallback` is truncated to two characters and upper-cased, and renders flat
 * on `surface3` — it is NOT the deterministic per-person gradient. For a real
 * user prefer `DefaultAvatar`, which is (see the file header).
 *
 * @example
 * ```tsx
 * <Avatar source={user.avatar} size="md" />
 *
 * <Avatar fallback="AR" size="lg" showBadge badgeColor="green" />
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
      borderRadius: Skin.circleOrSquare(dimension / 2),
      position: 'relative',
    },
    image: {
      width: dimension,
      height: dimension,
      borderRadius: Skin.circleOrSquare(dimension / 2),
    },
    fallbackContainer: {
      width: dimension,
      height: dimension,
      borderRadius: Skin.circleOrSquare(dimension / 2),
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
      // Status dot, no content — stays a circle on every skin.
      borderRadius: Skin.circle(badgeSize / 2),
      backgroundColor: badgeColor || theme.colors.success,
      borderWidth: Skin.border(2),
      borderColor: theme.colors.background,
    },
  });
};

export default Avatar;
