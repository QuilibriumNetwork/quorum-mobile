import type { AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { LikeIcon, getLikeIconType } from './LikeIcon';
import { SnapIcon } from './SnapIcon';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

interface CastActionsProps {
  castHash: string;
  castText: string;
  likeCount: number;
  replyCount: number;
  recastCount: number;
  isLiked: boolean;
  isRecast: boolean;
  theme: AppTheme;
  likeStates: Map<string, { liked: boolean; count: number }>;
  onLikeToggle: (castHash: string, currentlyLiked: boolean, currentCount: number) => void;
  onReplyPress?: () => void;
  /** Opens the tip flow for this cast. Button is hidden when omitted
   *  (e.g. viewing your own cast, or no tipping surface available). */
  onTipPress?: () => void;
}

/**
 * Like, reply, and recast action buttons for a cast.
 */
export const CastActions = React.memo(function CastActions({
  castHash,
  castText,
  likeCount,
  replyCount,
  recastCount,
  isLiked,
  isRecast,
  theme,
  likeStates,
  onLikeToggle,
  onReplyPress,
  onTipPress,
}: CastActionsProps) {
  const optimistic = likeStates.get(castHash);
  const liked = optimistic?.liked ?? isLiked;
  const count = optimistic?.count ?? likeCount;

  // Determine the like icon type based on cast text
  const likeIconType = useMemo(() => getLikeIconType(castText), [castText]);

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.actionButton}
        onPress={() => onLikeToggle(castHash, liked, count)}
      >
        <LikeIcon
          type={likeIconType}
          isLiked={liked}
          color={theme.colors.textMuted}
          activeColor={theme.colors.danger}
          size={20}
        />
        {count > 0 && (
          <Text style={[styles.countText, { color: theme.colors.textMuted }]}>
            {count}
          </Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.actionButton}
        onPress={onReplyPress}
      >
        <IconSymbol name="bubble.left" color={theme.colors.textMuted} size={20} />
        {replyCount > 0 && (
          <Text style={[styles.countText, { color: theme.colors.textMuted }]}>
            {replyCount}
          </Text>
        )}
      </TouchableOpacity>

      <View style={styles.actionButton}>
        <IconSymbol
          name="arrow.triangle.2.circlepath"
          color={isRecast ? theme.colors.success : theme.colors.textMuted}
          size={20}
        />
        {recastCount > 0 && (
          <Text style={[styles.countText, { color: theme.colors.textMuted }]}>
            {recastCount}
          </Text>
        )}
      </View>

      {onTipPress && (
        <TouchableOpacity style={styles.actionButton} onPress={onTipPress}>
          <SnapIcon color={theme.colors.textMuted} size={24} />
        </TouchableOpacity>
      )}
    </View>
  );
});

const styles = createSkinnable(() => StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: Skin.space(16),
    marginTop: Skin.space(4),
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(6),
  },
  countText: {
    fontSize: Skin.font(13),
  },
}));

export default CastActions;
