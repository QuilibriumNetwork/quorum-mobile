import type { AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';

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

const staticStyles = StyleSheet.create({
  padding12: {
    padding: 12,
  },
  contentSmall: {
    flex: 1,
    padding: 12,
    justifyContent: 'center',
  },
});

const createStyles = (theme: AppTheme) => StyleSheet.create({
  containerLarge: {
    backgroundColor: theme.colors.surface2,
    borderRadius: 12,
    overflow: 'hidden',
    marginHorizontal: 12,
  },
  imageLarge: {
    width: '100%',
    height: 180,
    backgroundColor: theme.colors.surface3,
  },
  titleLarge: {
    color: theme.colors.textStrong,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  descriptionLarge: {
    color: theme.colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 4,
  },
  domainLarge: {
    color: theme.colors.textMuted,
    fontSize: 12,
  },
  containerSmall: {
    backgroundColor: theme.colors.surface2,
    borderRadius: 12,
    overflow: 'hidden',
    marginHorizontal: 12,
    flexDirection: 'row',
  },
  imageSmall: {
    width: 100,
    height: 100,
    backgroundColor: theme.colors.surface3,
  },
  titleSmall: {
    color: theme.colors.textStrong,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  descriptionSmall: {
    color: theme.colors.textMuted,
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 4,
  },
  domainSmall: {
    color: theme.colors.textMuted,
    fontSize: 11,
  },
});

export default LinkPreview;
