/**
 * Messages tab — unified inbox
 *
 * Shows a single list combining spaces and DMs sorted by most recent activity.
 * Tap a space → navigate to channels list. Tap a DM → navigate to chat.
 */

import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { HeaderAvatar } from '@/components/HeaderAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth } from '@/context/AuthContext';
import type { Conversation } from '@/hooks/chat';
import { useUnifiedConversations } from '@/hooks/chat/useUnifiedConversations';
import { textStyles, useTheme, type AppTheme } from '@/theme';
import { haptics } from '@/utils/haptics';
import { truncateAddress } from '@/utils/formatAddress';
import { isValidAvatarUri } from '@/utils/validation';
import { FlashList } from '@shopify/flash-list';
import { router, Stack } from 'expo-router';
import React, { Suspense, useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Platform, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

const NewConversationModal = React.lazy(() => import('@/components/NewConversationModal'));

// Row for the DMs list
interface InboxItem {
  id: string;
  title: string;
  icon?: string;
  timestamp: number;
  unreadCount: number;
  isRepudiable?: boolean;
  isFarcaster?: boolean;
  subtitle?: string;
  subtitlePrefix?: string;
  placeholder?: boolean;
}

function formatRelativeTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return timeStr;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString();
}

interface InboxRowProps {
  item: InboxItem;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
  onPress: (item: InboxItem) => void;
}

const InboxRow = React.memo(function InboxRow({ item, styles, theme, onPress }: InboxRowProps) {
  const handlePress = useCallback(() => onPress(item), [item, onPress]);

  return (
    <TouchableOpacity style={styles.row} onPress={handlePress} activeOpacity={0.6}>
      <View style={styles.avatarContainer}>
        {isValidAvatarUri(item.icon) ? (
          <Image source={{ uri: item.icon }} style={styles.dmAvatar} />
        ) : (
          <DefaultAvatar address={item.id} size={48} style={styles.dmAvatar} />
        )}
        {item.isFarcaster && (
          <View style={styles.farcasterBadge}>
            <Image
              source={require('@/assets/images/farcaster.png')}
              style={styles.farcasterLogo}
            />
          </View>
        )}
      </View>

      <View style={styles.rowContent}>
        <View style={styles.rowTop}>
          <Text style={styles.title} numberOfLines={1}>
            {item.title}
          </Text>
          {item.placeholder ? null : (
            <Text style={styles.time}>{formatRelativeTime(item.timestamp)}</Text>
          )}
        </View>
        <View style={styles.rowBottom}>
          <Text
            style={[styles.subtitle, item.placeholder && styles.subtitlePlaceholder]}
            numberOfLines={1}
          >
            {item.subtitlePrefix ? (
              <Text style={styles.subtitlePrefix}>{item.subtitlePrefix}: </Text>
            ) : null}
            {item.subtitle ?? 'No messages yet'}
          </Text>
          {item.unreadCount > 0 && (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadText}>
                {item.unreadCount > 99 ? '99+' : item.unreadCount}
              </Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
});

export default function MessagesInbox() {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();

  const {
    conversations,
    isLoading: dmsLoading,
    isRefreshing,
    refetch: refetchDMs,
    fetchNextPage,
    hasNextPage,
  } = useUnifiedConversations();
  const [search, setSearch] = useState('');
  const [newConversationVisible, setNewConversationVisible] = useState(false);
  const [manualRefresh, setManualRefresh] = useState(false);

  const styles = useMemo(() => createStyles(theme, isDark), [theme, isDark]);

  // DMs list
  const items = useMemo<InboxItem[]>(() => {
    const rows: InboxItem[] = [];

    for (const conv of (conversations as Conversation[]) ?? []) {
      const hasUnread = conv.lastReadTimestamp ? conv.timestamp > conv.lastReadTimestamp : false;
      const preview = conv.lastMessagePreview;
      const senderName = conv.lastMessageSenderName;
      rows.push({
        id: conv.conversationId,
        title:
          conv.displayName ||
          (conv.address ? truncateAddress(conv.address, 'long') : 'Conversation'),
        icon: conv.icon,
        timestamp: conv.timestamp,
        unreadCount: hasUnread ? 1 : 0,
        isRepudiable: conv.isRepudiable,
        isFarcaster: conv.source === 'farcaster',
        subtitle: preview || undefined,
        subtitlePrefix: preview && senderName ? senderName : undefined,
        placeholder: !preview,
      });
    }

    // Filter by search
    const q = search.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) => r.title.toLowerCase().includes(q))
      : rows;

    // Sort by timestamp desc
    filtered.sort((a, b) => b.timestamp - a.timestamp);
    return filtered;
  }, [conversations, search]);

  const handlePressItem = useCallback((item: InboxItem) => {
    haptics.light();
    router.push(`/messages/dm/${encodeURIComponent(item.id)}`);
  }, []);

  const handleRefresh = useCallback(async () => {
    setManualRefresh(true);
    try {
      await refetchDMs();
    } finally {
      setManualRefresh(false);
    }
  }, [refetchDMs]);

  const handleEndReached = useCallback(() => {
    if (hasNextPage) fetchNextPage();
  }, [hasNextPage, fetchNextPage]);

  // Header "+" button — opens the new direct message modal.
  const handleOpenNewConversation = useCallback(() => {
    haptics.selection();
    setNewConversationVisible(true);
  }, []);

  const handleCloseNewConversation = useCallback(() => {
    setNewConversationVisible(false);
  }, []);

  const handleConversationCreated = useCallback((conversationId: string) => {
    setNewConversationVisible(false);
    router.push(`/messages/dm/${encodeURIComponent(conversationId)}`);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: InboxItem }) => (
      <InboxRow item={item} styles={styles} theme={theme} onPress={handlePressItem} />
    ),
    [styles, theme, handlePressItem]
  );

  const loading = dmsLoading;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Stack.Screen
        options={{
          headerShown: false,
        }}
      />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerSlotLeft}>
          <HeaderAvatar />
        </View>
        <View style={styles.headerSlotCenter}>
          <Text style={styles.heading}>Messages</Text>
        </View>
        <View style={styles.headerSlotRight}>
          <TouchableOpacity
            onPress={handleOpenNewConversation}
            style={styles.headerIconButton}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="New conversation"
          >
            <IconSymbol name="square.and.pencil" size={22} color={theme.colors.textMain} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Search */}
      <View style={styles.searchContainer}>
        <IconSymbol name="magnifyingglass" size={18} color={theme.colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search"
          placeholderTextColor={theme.colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {search.length > 0 && (
          <TouchableOpacity
            onPress={() => setSearch('')}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
          >
            <IconSymbol name="xmark.circle.fill" size={18} color={theme.colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {/* DMs list */}
      {loading && items.length === 0 ? (
        <View style={styles.emptyContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.emptyContainer}>
          <IconSymbol name="message" size={48} color={theme.colors.textMuted} />
          <Text style={styles.emptyTitle}>No conversations</Text>
          <Text style={styles.emptySubtitle}>
            {search ? 'Try a different search' : 'Start a conversation to see it here'}
          </Text>
        </View>
      ) : (
        <FlashList
          data={items}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          // Rows are 68px when there's no subtitle wrap, ~82px with one line
          // of preview text. Use a slightly-over average so FlashList doesn't
          // unmount cells it thinks are off-screen when they actually aren't.
          estimatedItemSize={82}
          // Keep more off-screen cells alive so scrolling back up doesn't
          // briefly blank the first few rows while they remount.
          drawDistance={1200}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={manualRefresh}
              onRefresh={handleRefresh}
              tintColor={theme.colors.textMuted}
            />
          }
        />
      )}

      {/* New direct message — opened from the header "+" button */}
      {newConversationVisible && (
        <Suspense fallback={null}>
          <NewConversationModal
            visible
            onClose={handleCloseNewConversation}
            onConversationCreated={handleConversationCreated}
          />
        </Suspense>
      )}
    </View>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.surface1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(12),
    },
    heading: {
      ...theme.textStyles.title3,
      color: theme.colors.textStrong,
      textAlign: 'center' as const,
    },
    // Side slots natural width, center flex-fills. Same pattern across
    // spaces / wallet / notifications.
    headerSlotLeft: {
      alignItems: 'flex-start' as const,
      flexDirection: 'row' as const,
    },
    headerSlotCenter: {
      flex: 1,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      paddingHorizontal: Skin.space(8),
    },
    headerSlotRight: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'flex-end' as const,
    },
    headerActions: {
      flexDirection: 'row',
      gap: Skin.space(16),
      alignItems: 'center',
    },
    headerIconButton: {
      padding: Skin.space(4),
    },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      paddingHorizontal: Skin.space(12),
      marginHorizontal: Skin.space(16),
      marginBottom: Skin.space(8),
      gap: Skin.space(8),
    },
    searchInput: {
      flex: 1,
      paddingVertical: Platform.OS === 'ios' ? 10 : 6,
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
    },
    listContent: {
      paddingBottom: Skin.space(120),
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(10),
      gap: Skin.space(12),
    },
    avatarContainer: {
      position: 'relative',
    },
    spaceAvatar: {
      width: 48,
      height: 48,
      borderRadius: Skin.radius(12), // legacy — no longer used (spaces now in rail)
    },
    dmAvatar: {
      width: 48,
      height: 48,
      borderRadius: Skin.radius(24), // full circle for people
    },
    farcasterBadge: {
      position: 'absolute',
      bottom: -2,
      right: -2,
      width: 18,
      height: 18,
      borderRadius: Skin.radius(9),
      backgroundColor: theme.colors.surface1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    farcasterLogo: {
      width: 14,
      height: 14,
      borderRadius: Skin.radius(7),
    },
    rowContent: {
      flex: 1,
      justifyContent: 'center',
      gap: Skin.space(2),
    },
    rowTop: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: Skin.space(8),
    },
    rowBottom: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: Skin.space(8),
    },
    title: {
      flex: 1,
      ...theme.textStyles.headline,
      color: theme.colors.textStrong,
    },
    subtitle: {
      flex: 1,
      ...theme.textStyles.subheadline,
      color: theme.colors.textMuted,
    },
    subtitlePrefix: {
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    subtitlePlaceholder: {
      fontStyle: 'italic',
      color: theme.colors.textMuted,
    },
    time: {
      ...theme.textStyles.footnote,
      color: theme.colors.textMuted,
    },
    unreadBadge: {
      minWidth: 20,
      height: 20,
      borderRadius: Skin.radius(10),
      paddingHorizontal: Skin.space(6),
      backgroundColor: theme.colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    unreadText: {
      fontSize: Skin.font(11),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#fff',
    },
    emptyContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: Skin.space(24),
      gap: Skin.space(8),
    },
    emptyTitle: {
      ...theme.textStyles.headline,
      color: theme.colors.textMain,
    },
    emptySubtitle: {
      ...theme.textStyles.subheadline,
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
    emptyAction: {
      marginTop: Skin.space(12),
      paddingHorizontal: Skin.space(20),
      paddingVertical: Skin.space(10),
      borderRadius: Skin.radius(20),
      backgroundColor: theme.colors.primary,
    },
    emptyActionText: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#fff',
    },

    // Spaces rail
    spacesRailContainer: {
      marginBottom: Skin.space(4),
    },
    spacesRailHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Skin.space(16),
      paddingTop: Skin.space(4),
      paddingBottom: Skin.space(8),
    },
    spacesRailTitle: {
      ...theme.textStyles.caption2,
      letterSpacing: 0.8,
      color: theme.colors.textMuted,
    },
    spacesRailCount: {
      ...theme.textStyles.caption2,
      color: theme.colors.textMuted,
      letterSpacing: 0.4,
    },
    spacesRailContent: {
      paddingHorizontal: Skin.space(12),
      gap: Skin.space(12),
      paddingBottom: Skin.space(8),
    },
    spaceTile: {
      alignItems: 'center',
      width: 64,
      gap: Skin.space(4),
    },
    spaceAvatarContainer: {
      position: 'relative',
    },
    spaceTileAvatar: {
      width: 56,
      height: 56,
      borderRadius: Skin.radius(14),
    },
    spaceAddTile: {
      width: 56,
      height: 56,
      borderRadius: Skin.radius(14),
      backgroundColor: theme.colors.surface3,
      borderWidth: Skin.border(1),
      borderStyle: 'dashed',
      borderColor: theme.colors.surface4,
      alignItems: 'center',
      justifyContent: 'center',
    },
    spaceTileName: {
      ...theme.textStyles.caption1,
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
    spaceUnreadBadge: {
      position: 'absolute',
      top: -4,
      right: -4,
      minWidth: 18,
      height: 18,
      borderRadius: Skin.radius(9),
      paddingHorizontal: Skin.space(5),
      backgroundColor: theme.colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: Skin.border(2),
      borderColor: theme.colors.surface1,
    },
    spaceUnreadText: {
      fontSize: Skin.font(10),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#fff',
    },
  });
