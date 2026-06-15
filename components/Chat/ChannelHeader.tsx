import { IconSymbol } from '@/components/ui/IconSymbol';
import type { AppTheme } from '@/theme';
import React from 'react';
import { Dimensions, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Expands the tap target of header icon buttons without changing layout (the
// glyphs and their 16px spacing stay identical). Horizontal slop is kept at 8
// so adjacent icons' touch zones meet but don't overlap; vertical slop is
// larger since nothing sits above/below in the header row. ~34x42 effective.
const headerIconHitSlop = { top: 12, bottom: 12, left: 8, right: 8 };

interface ChannelHeaderProps {
  channelName: string;
  sidebarsVisible: boolean;
  onShowSidebars: () => void;
  onInvite?: () => void;
  onOpenSettings?: () => void;
  onOpenPinnedMessages?: () => void;
  onOpenBookmarks?: () => void;
  onOpenSearch?: () => void;
  pinnedCount?: number;
  theme: AppTheme;
}

export const ChannelHeader = React.memo(function ChannelHeader({
  channelName,
  sidebarsVisible,
  onShowSidebars,
  onInvite,
  onOpenSettings,
  onOpenPinnedMessages,
  onOpenBookmarks,
  onOpenSearch,
  pinnedCount = 0,
  theme,
}: ChannelHeaderProps) {
  const styles = createStyles(theme);

  return (
    <View style={styles.container}>
      <View style={styles.left}>
        {!sidebarsVisible && (
          <TouchableOpacity onPress={onShowSidebars} style={styles.menuButton} hitSlop={headerIconHitSlop}>
            <IconSymbol name="line.3.horizontal" color={theme.colors.textMuted} size={20} />
          </TouchableOpacity>
        )}
        <IconSymbol name="number" color={theme.colors.textMuted} size={16} />
        <Text style={styles.title}>{channelName}</Text>
      </View>
      <View style={styles.right}>
        {onOpenSearch && (
          <TouchableOpacity style={styles.headerIconButton} onPress={onOpenSearch} hitSlop={headerIconHitSlop}>
            <IconSymbol name="magnifyingglass" color={theme.colors.textMuted} size={18} />
          </TouchableOpacity>
        )}
        {onOpenPinnedMessages && (
          <TouchableOpacity style={styles.headerIconButton} onPress={onOpenPinnedMessages} hitSlop={headerIconHitSlop}>
            <IconSymbol name="pin.fill" color={pinnedCount > 0 ? theme.colors.primary : theme.colors.textMuted} size={18} />
          </TouchableOpacity>
        )}
        {onOpenBookmarks && (
          <TouchableOpacity style={styles.headerIconButton} onPress={onOpenBookmarks} hitSlop={headerIconHitSlop}>
            <IconSymbol name="bookmark" color={theme.colors.textMuted} size={18} />
          </TouchableOpacity>
        )}
        {onInvite && (
          <TouchableOpacity style={styles.headerIconButton} onPress={onInvite} hitSlop={headerIconHitSlop}>
            <IconSymbol name="person.badge.plus" color={theme.colors.textMuted} size={18} />
          </TouchableOpacity>
        )}
        {onOpenSettings && (
          <TouchableOpacity style={styles.headerIconButton} onPress={onOpenSettings} hitSlop={headerIconHitSlop}>
            <IconSymbol name="gearshape" color={theme.colors.textMuted} size={18} />
          </TouchableOpacity>
        )}
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
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  menuButton: {
    marginRight: Skin.space(12),
  },
  title: {
    color: theme.colors.textMain,
    fontFamily: theme.fonts.medium.fontFamily,
    fontWeight: theme.fonts.medium.fontWeight,
    marginLeft: Skin.space(8),
  },
  headerIconButton: {
    marginRight: Skin.space(16),
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface5,
    borderRadius: Skin.radius(4),
    paddingHorizontal: Skin.space(8),
    paddingVertical: Skin.space(4),
  },
  searchInput: {
    color: theme.colors.textMain,
    fontSize: Skin.font(14),
    marginLeft: Skin.space(8),
    width: 80,
    fontFamily: theme.fonts.regular.fontFamily,
  },
});

export default ChannelHeader;
