/**
 * BookmarksPanel - Shows a list of bookmarked messages
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { BaseModal } from '@/components/shared/BaseModal';
import { formatTime } from './types';
import type { Bookmark } from '@quilibrium/quorum-shared';
import type { AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

interface BookmarksPanelProps {
  visible: boolean;
  onClose: () => void;
  bookmarks: Bookmark[];
  onRemoveBookmark: (bookmarkId: string) => void;
  onNavigateToBookmark?: (bookmark: Bookmark) => void;
  theme: AppTheme;
}

export const BookmarksPanel = React.memo(function BookmarksPanel({
  visible,
  onClose,
  bookmarks,
  onRemoveBookmark,
  onNavigateToBookmark,
  theme,
}: BookmarksPanelProps) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  // Sort bookmarks by creation date (newest first)
  const sortedBookmarks = useMemo(() => {
    return [...bookmarks].sort((a, b) => b.createdAt - a.createdAt);
  }, [bookmarks]);

  const handleRemove = (bookmarkId: string) => {
    Alert.alert(
      'Remove Bookmark',
      'Are you sure you want to remove this bookmark?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => onRemoveBookmark(bookmarkId),
        },
      ]
    );
  };

  const getContentIcon = (contentType: string) => {
    switch (contentType) {
      case 'image':
        return 'photo';
      case 'sticker':
        return 'star.square';
      default:
        return 'text.bubble';
    }
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.7} fillHeight>
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <IconSymbol name="bookmark.fill" size={18} color={theme.colors.primary} />
            <Text style={styles.headerTitle}>
              Bookmarks ({bookmarks.length})
            </Text>
          </View>
        </View>

        {sortedBookmarks.length === 0 ? (
          <View style={styles.emptyState}>
            <IconSymbol name="bookmark" size={36} color={theme.colors.textMuted} />
            <Text style={styles.emptyText}>No bookmarks yet</Text>
            <Text style={styles.emptySubtext}>
              Long press a message and tap Bookmark to save it here
            </Text>
          </View>
        ) : (
          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {sortedBookmarks.map((bookmark) => (
              <TouchableOpacity
                key={bookmark.bookmarkId}
                style={styles.bookmarkItem}
                activeOpacity={0.7}
                onPress={() => {
                  onNavigateToBookmark?.(bookmark);
                  onClose();
                }}
              >
                <View style={styles.bookmarkIconContainer}>
                  <IconSymbol
                    name={getContentIcon(bookmark.cachedPreview?.contentType ?? 'text')}
                    size={16}
                    color={theme.colors.textMuted}
                  />
                </View>
                <View style={styles.bookmarkContent}>
                  <View style={styles.bookmarkHeader}>
                    <Text style={styles.bookmarkSender} numberOfLines={1}>
                      {bookmark.cachedPreview?.senderName ?? 'Unknown'}
                    </Text>
                    <Text style={styles.bookmarkSource}>
                      {bookmark.cachedPreview?.sourceName ?? ''}
                    </Text>
                  </View>
                  <Text style={styles.bookmarkText} numberOfLines={2}>
                    {bookmark.cachedPreview?.textSnippet ?? ''}
                  </Text>
                  <Text style={styles.bookmarkDate}>
                    {bookmark.cachedPreview?.messageDate
                      ? formatTime(bookmark.cachedPreview.messageDate)
                      : ''}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={(e) => {
                    e.stopPropagation();
                    handleRemove(bookmark.bookmarkId);
                  }}
                  style={styles.removeButton}
                  hitSlop={8}
                >
                  <IconSymbol name="bookmark.slash" size={16} color={theme.colors.textMuted} />
                </TouchableOpacity>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>
    </BaseModal>
  );
});

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Skin.space(20),
      paddingVertical: Skin.space(12),
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.border ?? theme.colors.surface3,
    },
    headerLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
    },
    headerTitle: {
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textStrong,
    },
    emptyState: {
      alignItems: 'center',
      paddingVertical: Skin.space(40),
      paddingHorizontal: Skin.space(32),
    },
    emptyText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
      marginTop: Skin.space(12),
    },
    emptySubtext: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textSubtle,
      textAlign: 'center',
      marginTop: Skin.space(4),
    },
    scrollView: {
      flex: 1,
    },
    scrollContent: {
      padding: Skin.space(12),
    },
    bookmarkItem: {
      flexDirection: 'row',
      backgroundColor: theme.colors.surface3 ?? theme.colors.surface2,
      borderRadius: Skin.radius(10),
      padding: Skin.space(12),
      marginBottom: Skin.space(8),
      alignItems: 'flex-start',
    },
    bookmarkIconContainer: {
      width: 32,
      height: 32,
      borderRadius: Skin.radius(16),
      backgroundColor: theme.colors.surface5 ?? theme.colors.surface3,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: Skin.space(10),
    },
    bookmarkContent: {
      flex: 1,
    },
    bookmarkHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: Skin.space(2),
    },
    bookmarkSender: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textStrong,
      flex: 1,
    },
    bookmarkSource: {
      fontSize: Skin.font(11),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textSubtle,
      marginLeft: Skin.space(8),
    },
    bookmarkText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
      lineHeight: Skin.font(20),
    },
    bookmarkDate: {
      fontSize: Skin.font(11),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textSubtle,
      marginTop: Skin.space(4),
    },
    removeButton: {
      padding: Skin.space(4),
      marginLeft: Skin.space(8),
    },
  });

export default BookmarksPanel;
