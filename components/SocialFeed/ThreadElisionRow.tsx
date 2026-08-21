import type { AppTheme } from '@/theme';
import React from 'react';
import { Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

/** Diameter of the feed avatar; the dotted gutter centers on it so the
 *  elision reads as part of the avatar-to-avatar thread line. */
const AVATAR_COLUMN_WIDTH = 44;

/**
 * The "…" row inside a feed thread unit: collapsed conversation context
 * between the thread root and the reply tail (or above the unit when the
 * root is beyond reach). Rendered as a dotted continuation of the thread
 * connector line, aligned to the avatar gutter, with a tappable label that
 * opens the full thread.
 *
 * This row is presentation for context that is NOT loaded — it never fetches
 * anything itself.
 */
export function ThreadElisionRow({
  theme,
  onPress,
}: {
  theme: AppTheme;
  onPress?: () => void;
}) {
  const dot = {
    width: Skin.border(2),
    height: Skin.border(2),
    borderRadius: Skin.circleOrSquare(1),
    backgroundColor: theme.colors.textMuted,
  } as const;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Show full thread"
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: Skin.contentRowPaddingH(),
        paddingVertical: Skin.space(2),
      }}
    >
      <View
        style={{
          width: AVATAR_COLUMN_WIDTH,
          alignItems: 'center',
          gap: Skin.space(3),
          paddingVertical: Skin.space(2),
        }}
      >
        <View style={dot} />
        <View style={dot} />
        <View style={dot} />
      </View>
      <Text
        style={{
          color: theme.colors.accent,
          fontSize: Skin.font(13),
          marginLeft: Skin.space(12),
        }}
      >
        Show full thread
      </Text>
    </TouchableOpacity>
  );
}

export default ThreadElisionRow;
