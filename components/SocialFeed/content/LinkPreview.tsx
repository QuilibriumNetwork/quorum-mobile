import type { AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { Image } from 'expo-image';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

interface LinkPreviewProps {
  url?: string;
  title?: string;
  description?: string;
  domain?: string;
  image?: string;
  useLargeImage?: boolean;
  theme: AppTheme;
  onPress?: () => void;
}

/**
 * URL preview card with optional image.
 */
export function LinkPreview({
  url,
  title,
  description,
  domain,
  image,
  useLargeImage,
  theme,
  onPress,
}: LinkPreviewProps) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  if (!title) return null;

  const handlePress = () => {
    onPress?.();
  };

  if (useLargeImage && image) {
    return (
      <TouchableOpacity
        style={styles.containerLarge}
        onPress={handlePress}
        activeOpacity={0.8}
      >
        <Image
          source={{ uri: image }}
          style={styles.imageLarge}
          contentFit="cover"
          // Reset animated-GIF source on recycled cell reuse — see AutoHeightImage.
          recyclingKey={image}
        />
        <View style={staticStyles.padding12}>
          <Text
            style={styles.titleLarge}
            numberOfLines={2}
          >
            {title}
          </Text>
          {description && (
            <Text
              style={styles.descriptionLarge}
              numberOfLines={2}
            >
              {description}
            </Text>
          )}
          {domain && (
            <Text style={styles.domainLarge}>
              {domain}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      style={styles.containerSmall}
      onPress={handlePress}
      activeOpacity={0.8}
    >
      {image && (
        <Image
          source={{ uri: image }}
          style={styles.imageSmall}
          contentFit="cover"
          // Reset animated-GIF source on recycled cell reuse — see AutoHeightImage.
          recyclingKey={image}
        />
      )}
      <View style={staticStyles.contentSmall}>
        <Text
          style={styles.titleSmall}
          numberOfLines={2}
        >
          {title}
        </Text>
        {description && (
          <Text
            style={styles.descriptionSmall}
            numberOfLines={2}
          >
            {description}
          </Text>
        )}
        {domain && (
          <Text style={styles.domainSmall}>
            {domain}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const staticStyles = createSkinnable(() => StyleSheet.create({
  padding12: {
    padding: Skin.space(12),
  },
  contentSmall: {
    flex: 1,
    padding: Skin.space(12),
    justifyContent: 'center',
  },
}));

const createStyles = (theme: AppTheme) => StyleSheet.create({
  containerLarge: {
    backgroundColor: theme.colors.surface2,
    borderRadius: Skin.radius(12),
    overflow: 'hidden',
    marginHorizontal: Skin.space(12),
  },
  imageLarge: {
    width: '100%',
    height: 180,
    backgroundColor: theme.colors.surface3,
  },
  titleLarge: {
    color: theme.colors.textStrong,
    fontSize: Skin.font(15),
    fontWeight: '600',
    marginBottom: Skin.space(4),
  },
  descriptionLarge: {
    color: theme.colors.textMuted,
    fontSize: Skin.font(13),
    lineHeight: Skin.font(18),
    marginBottom: Skin.space(4),
  },
  domainLarge: {
    color: theme.colors.textMuted,
    fontSize: Skin.font(12),
  },
  containerSmall: {
    backgroundColor: theme.colors.surface2,
    borderRadius: Skin.radius(12),
    overflow: 'hidden',
    marginHorizontal: Skin.space(12),
    flexDirection: 'row',
  },
  imageSmall: {
    width: 100,
    height: 100,
    backgroundColor: theme.colors.surface3,
  },
  titleSmall: {
    color: theme.colors.textStrong,
    fontSize: Skin.font(14),
    fontWeight: '600',
    marginBottom: Skin.space(4),
  },
  descriptionSmall: {
    color: theme.colors.textMuted,
    fontSize: Skin.font(12),
    lineHeight: Skin.font(16),
    marginBottom: Skin.space(4),
  },
  domainSmall: {
    color: theme.colors.textMuted,
    fontSize: Skin.font(11),
  },
});

export default LinkPreview;
