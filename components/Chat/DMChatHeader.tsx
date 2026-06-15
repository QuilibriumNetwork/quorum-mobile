/**
 * DMChatHeader - Header for DM conversation chat view
 */

import type { AppTheme } from '@/theme';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { truncateAddress } from '@/utils/formatAddress';
import type { Conversation } from '@/hooks/chat/useConversations';
import React, { useMemo } from 'react';
import { Dimensions, Image, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Expands the tap target of header icon buttons without changing layout (the
// glyphs and their 16px spacing stay identical). Horizontal slop is kept at 8
// so adjacent icons' touch zones meet but don't overlap; vertical slop is
// larger since nothing sits above/below in the header row. ~34x42 effective.
const headerIconHitSlop = { top: 12, bottom: 12, left: 8, right: 8 };

interface DMChatHeaderProps {
  conversation: Conversation;
  sidebarsVisible: boolean;
  onShowSidebars: () => void;
  onInfoPress?: () => void;
  onOpenSearch?: () => void;
  onCallPress?: () => void;
  onVideoCallPress?: () => void;
  theme: AppTheme;
}

export const DMChatHeader = React.memo(function DMChatHeader({
  conversation,
  sidebarsVisible,
  onShowSidebars,
  onInfoPress,
  onOpenSearch,
  onCallPress,
  onVideoCallPress,
  theme,
}: DMChatHeaderProps) {
  const styles = createStyles(theme);

  // Format display name
  const displayName = useMemo(() => {
    if (conversation.displayName) return conversation.displayName;
    return truncateAddress(conversation.address, 'long');
  }, [conversation.displayName, conversation.address]);

  return (
    <View style={styles.container}>
      <View style={styles.left}>
        {!sidebarsVisible && (
          <TouchableOpacity
            onPress={onShowSidebars}
            style={styles.menuButton}
            hitSlop={{ top: 12, bottom: 12, left: 10, right: 10 }}
          >
            <IconSymbol name="line.3.horizontal" color={theme.colors.textMuted} size={20} />
          </TouchableOpacity>
        )}
        {conversation.icon ? (
          <Image source={{ uri: conversation.icon }} style={styles.avatar} />
        ) : (
          <DefaultAvatar displayName={conversation.displayName} address={conversation.address || ''} size={32} />
        )}
        <Text style={styles.title} numberOfLines={1}>{displayName}</Text>
      </View>
      <View style={styles.right}>
        {onVideoCallPress && (
          <TouchableOpacity style={styles.headerIconButton} onPress={onVideoCallPress} hitSlop={headerIconHitSlop}>
            <IconSymbol name="video" color={theme.colors.textMuted} size={18} />
          </TouchableOpacity>
        )}
        {onCallPress && (
          <TouchableOpacity style={styles.headerIconButton} onPress={onCallPress} hitSlop={headerIconHitSlop}>
            <IconSymbol name="phone" color={theme.colors.textMuted} size={18} />
          </TouchableOpacity>
        )}
        {onOpenSearch && (
          <TouchableOpacity style={styles.headerIconButton} onPress={onOpenSearch} hitSlop={headerIconHitSlop}>
            <IconSymbol name="magnifyingglass" color={theme.colors.textMuted} size={18} />
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.headerIconButton} onPress={onInfoPress} hitSlop={headerIconHitSlop}>
          <IconSymbol name="info.circle" color={theme.colors.textMuted} size={18} />
        </TouchableOpacity>
      </View>
    </View>
  );
});

const createStyles = (theme: AppTheme) => StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: theme.colors.surface3,
    paddingHorizontal: Skin.space(16),
    paddingVertical: Skin.space(12),
    borderBottomWidth: Skin.border(1),
    borderBottomColor: theme.colors.border,
    width: SCREEN_WIDTH,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  menuButton: {
    marginRight: Skin.space(12),
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: Skin.radius(16),
    backgroundColor: theme.colors.surface5,
  },
  title: {
    color: theme.colors.textMain,
    fontFamily: theme.fonts.medium.fontFamily,
    fontWeight: theme.fonts.medium.fontWeight,
    marginLeft: Skin.space(10),
    flex: 1,
  },
  headerIconButton: {
    marginLeft: Skin.space(16),
  },
});

export default DMChatHeader;
