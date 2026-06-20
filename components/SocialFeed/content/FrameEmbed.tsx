import type { AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { Image } from 'expo-image';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { SCREEN_WIDTH } from '../utils';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

const staticStyles = createSkinnable(() => StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  image: {
    width: SCREEN_WIDTH,
    height: SCREEN_WIDTH * 0.525, // Standard frame aspect ratio
  },
  buttonRow: {
    paddingVertical: Skin.space(12),
    paddingHorizontal: Skin.space(16),
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: Skin.border(1),
  },
  buttonText: {
    fontSize: Skin.font(15),
    fontWeight: '600',
  },
  iconMargin: {
    marginLeft: Skin.space(6),
  },
}));

interface FrameEmbedProps {
  imageUrl: string;
  buttonTitle: string;
  actionUrl: string;
  theme: AppTheme;
  onPress: () => void;
}

/**
 * Farcaster Frame (mini-app) embed display.
 */
export function FrameEmbed({
  imageUrl,
  buttonTitle,
  actionUrl,
  theme,
  onPress,
}: FrameEmbedProps) {
  const styles = useMemo(() => ({
    image: [staticStyles.image, { backgroundColor: theme.colors.surface3 }],
    buttonRow: [staticStyles.buttonRow, { backgroundColor: theme.colors.surface2, borderTopColor: theme.colors.surface3 }],
    buttonText: [staticStyles.buttonText, { color: theme.colors.textStrong }],
  }), [theme.colors.surface2, theme.colors.surface3, theme.colors.textStrong]);

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.9}
      style={staticStyles.container}
    >
      <Image
        source={{ uri: imageUrl }}
        style={styles.image}
        contentFit="cover"
        // Reset animated-GIF source on recycled cell reuse — see AutoHeightImage.
        recyclingKey={imageUrl}
      />
      <View style={styles.buttonRow}>
        <Text style={styles.buttonText}>
          {buttonTitle}
        </Text>
        <IconSymbol
          name="arrow.up.right"
          color={theme.colors.textMuted}
          size={14}
          style={staticStyles.iconMargin}
        />
      </View>
    </TouchableOpacity>
  );
}

export default FrameEmbed;
