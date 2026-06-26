/**
 * Messages tab — unified inbox
 *
 * Shows a single list combining spaces and DMs sorted by most recent activity.
 * Tap a space → navigate to channels list. Tap a DM → navigate to chat.
 */

import { useFloatingTabBarPadding } from '@/hooks/useFloatingTabBarPadding';
import { FloatingTabScreen } from '@/components/ui/FloatingTabScreen';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { FarcasterLogoIcon } from '@/components/ui/FarcasterLogoIcon';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { coerceMessagePreview, previewKindIcon } from '@/utils/messagePreview';
import { useAuth } from '@/context/AuthContext';
import type { Conversation } from '@/hooks/chat';
import { useDMMute } from '@/hooks/chat/useDMMute';
import { useUnifiedConversations } from '@/hooks/chat/useUnifiedConversations';
import { useStorageAdapter } from '@/context/StorageContext';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@quilibrium/quorum-shared';
import { textStyles, useTheme, type AppTheme } from '@/theme';
import { haptics } from '@/utils/haptics';
import { truncateAddress } from '@/utils/formatAddress';
import { isValidAvatarUri } from '@/utils/validation';
import { FlashList } from '@shopify/flash-list';
import { router, Stack } from 'expo-router';
import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Platform, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

// Prefetch helper: warm the lazy chunk in the background so the first tap on the
// "new conversation" button opens the modal instantly (no on-demand import wait).
const importNewConversationModal = () => import('@/components/NewConversationModal');
const NewConversationModal = React.lazy(importNewConversationModal);

// Long-pressing a conversation row opens the same settings sheet as the DM
// header gear. Lazy so the chunk only loads on first long-press.
const DMSettingsSheet = React.lazy(() =>
  import('@/components/Chat/DMSettingsSheet').then((m) => ({ default: m.DMSettingsSheet }))
);

// Row for the DMs list
interface InboxItem {
  id: string;
  title: string;
  icon?: string;
  address?: string;
  timestamp: number;
  unreadCount: number;
  isRepudiable?: boolean;
  isFarcaster?: boolean;
  isMuted?: boolean;
  subtitle?: string;
  /** IconSymbol name for a media/event preview (image, call, etc.). */
  subtitleIcon?: IconSymbolName;
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
  onLongPress: (item: InboxItem) => void;
}

const InboxRow = React.memo(function InboxRow({ item, styles, theme, onPress, onLongPress }: InboxRowProps) {
  const handlePress = useCallback(() => onPress(item), [item, onPress]);
  const handleLongPress = useCallback(() => onLongPress(item), [item, onLongPress]);

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={350}
      activeOpacity={0.6}
    >
      <View style={styles.avatarContainer}>
        {isValidAvatarUri(item.icon) ? (
          <Image source={{ uri: item.icon }} style={styles.dmAvatar} />
        ) : (
          <DefaultAvatar displayName={item.title} address={item.id} size={48} style={styles.dmAvatar} />
        )}
        {item.isFarcaster && (
          <View style={styles.farcasterBadge}>
            <FarcasterLogoIcon size={8} color="#fff" />
          </View>
        )}
        {item.isMuted && (
          <View style={styles.mutedBadge}>
            <IconSymbol name="bell.slash" size={11} color={theme.colors.textSubtle} />
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
            {item.subtitleIcon ? (
              <>
                <IconSymbol name={item.subtitleIcon} size={13} color={theme.colors.textMuted} />
                {' '}
              </>
            ) : null}
            {item.subtitle ?? (item.subtitleIcon ? '' : 'No messages yet')}
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

  // Warm the new-conversation modal chunk in the background once the screen is open.
  useEffect(() => {
    void importNewConversationModal();
  }, []);

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

  const listPadding = useFloatingTabBarPadding();
  const styles = useMemo(() => createStyles(theme, isDark, listPadding), [theme, isDark, listPadding]);

  // Muted DMs (config-backed, syncs across devices). `isMuted` is keyed on the
  // muted set, so the list memo re-runs on toggle via its dep on `isMuted`.
  const { isMuted, toggleMute } = useDMMute();

  const storage = useStorageAdapter();
  const queryClient = useQueryClient();

  // Long-press → conversation settings sheet for that row.
  const [settingsItem, setSettingsItem] = useState<InboxItem | null>(null);
  const handleLongPressItem = useCallback((item: InboxItem) => {
    // Farcaster DMs don't have the Quorum conversation-settings surface.
    if (item.isFarcaster) return;
    haptics.medium();
    setSettingsItem(item);
  }, []);

  const handleToggleMuteFromSheet = useCallback(() => {
    if (settingsItem) toggleMute(settingsItem.id);
  }, [settingsItem, toggleMute]);

  // Delete the conversation locally (same as the DM-screen sheet does).
  const handleDeleteFromSheet = useCallback(async () => {
    if (!settingsItem) return;
    await storage.deleteConversation(settingsItem.id);
    queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all('direct') });
    setSettingsItem(null);
  }, [settingsItem, storage, queryClient]);

  // DMs list
  const items = useMemo<InboxItem[]>(() => {
    const rows: InboxItem[] = [];

    for (const conv of (conversations as Conversation[]) ?? []) {
      const hasUnread = conv.lastReadTimestamp ? conv.timestamp > conv.lastReadTimestamp : false;
      const senderName = conv.lastMessageSenderName;
      // Coerce any preview shape (typed, legacy string, raw object) to
      // {kind,text}; an empty text with no icon means "no message yet".
      const preview =
        conv.lastMessagePreview != null ? coerceMessagePreview(conv.lastMessagePreview) : undefined;
      const previewText = preview?.text || undefined;
      const previewIcon = preview ? previewKindIcon(preview.kind) : undefined;
      const hasPreview = !!(previewText || previewIcon);
      rows.push({
        id: conv.conversationId,
        title:
          conv.displayName ||
          (conv.address ? truncateAddress(conv.address, 'long') : 'Conversation'),
        icon: conv.icon,
        address: conv.address,
        timestamp: conv.timestamp,
        unreadCount: hasUnread ? 1 : 0,
        isRepudiable: conv.isRepudiable,
        isFarcaster: conv.source === 'farcaster',
        isMuted: isMuted(conv.conversationId),
        subtitle: previewText,
        subtitleIcon: previewIcon,
        subtitlePrefix: hasPreview && senderName ? senderName : undefined,
        placeholder: !hasPreview,
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
    // `isMuted` is a useCallback keyed on the muted set, so its identity changes
    // on every toggle — that alone re-runs this memo. No separate
    // `mutedConversations` dep needed.
  }, [conversations, search, isMuted]);

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
      <InboxRow
        item={item}
        styles={styles}
        theme={theme}
        onPress={handlePressItem}
        onLongPress={handleLongPressItem}
      />
    ),
    [styles, theme, handlePressItem, handleLongPressItem]
  );

  const loading = dmsLoading;

  return (
    <FloatingTabScreen surfaceColor={theme.colors.surface1} isDark={isDark} style={{ paddingTop: insets.top }}>
      <Stack.Screen
        options={{
          headerShown: false,
        }}
      />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.heading}>Messages</Text>
        <View style={styles.headerSlotRight}>
          <TouchableOpacity
            onPress={handleOpenNewConversation}
            style={styles.headerIconButton}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="New conversation"
          >
            <IconSymbol name="person.badge.plus" size={22} color={theme.colors.textMain} />
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

      {/* Conversation settings — opened by long-pressing a row. Shows the
          recipient's pfp + name above the title since there's no other
          on-screen context for which conversation was hit. */}
      {settingsItem && (
        <Suspense fallback={null}>
          <DMSettingsSheet
            visible
            onClose={() => setSettingsItem(null)}
            conversationId={settingsItem.id}
            displayName={settingsItem.title}
            theme={theme}
            avatarUri={settingsItem.icon}
            address={settingsItem.address ?? settingsItem.id.split('/')[0]}
            isMuted={isMuted(settingsItem.id)}
            onToggleMute={handleToggleMuteFromSheet}
            onDeleteConversation={handleDeleteFromSheet}
          />
        </Suspense>
      )}
    </FloatingTabScreen>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean, listPadding: number) =>
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
      flex: 1,
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
      paddingBottom: listPadding,
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
      backgroundColor: '#855DCD', // Farcaster brand purple
      borderWidth: Skin.border(2),
      borderColor: theme.colors.surface1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // Muted indicator: bell-off badge at the top-left of the pfp (mirrors
    // desktop's dm-muted-badge). Neutral surface chip so it reads as a status,
    // not an action.
    mutedBadge: {
      position: 'absolute',
      top: -2,
      left: -2,
      width: 18,
      height: 18,
      borderRadius: Skin.radius(9),
      backgroundColor: theme.colors.surface3,
      borderWidth: Skin.border(2),
      borderColor: theme.colors.surface1,
      alignItems: 'center',
      justifyContent: 'center',
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
      color: theme.colors.textSubtle,
    },
    subtitlePrefix: {
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    subtitlePlaceholder: {
      fontStyle: 'italic',
      color: theme.colors.textSubtle,
    },
    time: {
      ...theme.textStyles.footnote,
      color: theme.colors.textSubtle,
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
      color: theme.colors.textSubtle,
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
      color: theme.colors.textSubtle,
    },
    spacesRailCount: {
      ...theme.textStyles.caption2,
      color: theme.colors.textSubtle,
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
      color: theme.colors.textSubtle,
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
