import type { AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { Image } from 'expo-image';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import type { EmbeddedCast } from '@/hooks/useFarcasterFeed';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

interface QuoteCastProps {
  cast: EmbeddedCast;
  theme: AppTheme;
  onPress?: () => void;
}

/**
 * Embedded/quoted cast display.
 */
export function QuoteCast({ cast, theme, onPress }: QuoteCastProps) {
  const hasImage = cast.embeds?.images && cast.embeds.images.length > 0;
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <TouchableOpacity
      style={styles.container}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <View style={staticStyles.padding12}>
        {/* Author row */}
        <View style={staticStyles.authorRow}>
          <CachedAvatar
            source={cast.author.pfp?.url ? { uri: cast.author.pfp.url } : null}
            style={styles.avatar}
          />
          <Text style={styles.displayName}>
            {cast.author.displayName}
          </Text>
          <Text style={styles.username}>
            @{cast.author.username}
          </Text>
        </View>
        {/* Cast text */}
        <Text
          style={styles.castText}
          numberOfLines={4}
        >
          {cast.text}
        </Text>
      </View>
      {/* Image preview */}
      {hasImage && cast.embeds?.images?.[0]?.url && (
        <Image
          source={{ uri: cast.embeds.images[0].url }}
          style={styles.image}
          contentFit="cover"
          cachePolicy="disk"
        />
      )}
    </TouchableOpacity>
  );
}

const staticStyles = createSkinnable(() => StyleSheet.create({
  padding12: {
    padding: Skin.space(12),
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Skin.space(8),
  },
}));

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      overflow: 'hidden',
      marginHorizontal: Skin.space(12),
      borderWidth: Skin.border(1),
      borderColor: theme.colors.surface3,
    },
    avatar: {
      width: 24,
      height: 24,
      borderRadius: Skin.radius(12),
      marginRight: Skin.space(8),
      backgroundColor: theme.colors.surface3,
    },
    displayName: {
      color: theme.colors.textStrong,
      fontWeight: '600',
      fontSize: Skin.font(14),
    },
    username: {
      color: theme.colors.textMuted,
      fontSize: Skin.font(13),
      marginLeft: Skin.space(4),
    },
    castText: {
      color: theme.colors.textMain,
      fontSize: Skin.font(14),
      lineHeight: Skin.font(20),
    },
    image: {
      width: '100%',
      height: 150,
      backgroundColor: theme.colors.surface3,
    },
  });
}

export default QuoteCast;
