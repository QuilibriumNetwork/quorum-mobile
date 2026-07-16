import { useFloatingTabBarPadding } from '@/hooks/useFloatingTabBarPadding';
import { FloatingTabScreen } from '@/components/ui/FloatingTabScreen';
import { SpaceIcon } from '@/components/ui/SpaceIcon';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useSpaces } from '@/hooks/chat/useSpaces';
import { isValidAvatarUri } from '@/utils/validation';
import { useChannelMentionUnread } from '@/services/notifications/mentionReplyLog';
import { useSpaceActivity } from '@/hooks/chat/useSpaceActivity';
import { useMutedSpaceIds } from '@/hooks/chat/useChannelMute';
import { formatRowTime } from '@/utils/dateFormat';
import { textStyles, useTheme, type AppTheme } from '@/theme';
import { haptics } from '@/utils/haptics';
import type { Space } from '@quilibrium/quorum-shared';
import { FlashList } from '@shopify/flash-list';
import { router, Stack } from 'expo-router';
import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

// Prefetch helper: warm the lazy chunk in the background so the first tap on the
// "+" add-space button opens the modal instantly (no on-demand import wait).
const importSpaceModal = () => import('@/components/SpaceModal');
const SpaceModal = React.lazy(importSpaceModal);

interface SpaceItem {
  id: string;
  name: string;
  icon?: string;
  memberCount: number;
  channelCount: number;
  unreadCount: number;
  timestamp: number;
  isMuted: boolean;
}

// Conversation-row time via the shared formatter: today → locale time,
// 1–6 days → "Nd", older → "Jun 28" / "Jun 28, 2025".
function formatRelativeTime(timestamp: number): string {
  return formatRowTime(timestamp);
}

const SpaceRow = React.memo(function SpaceRow({
  item,
  styles,
  theme,
  onPress,
}: {
  item: SpaceItem;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
  onPress: (id: string) => void;
}) {
  const handlePress = useCallback(() => onPress(item.id), [onPress, item.id]);

  return (
    <TouchableOpacity style={styles.row} onPress={handlePress} activeOpacity={0.6}>
      <View style={styles.avatarContainer}>
        {isValidAvatarUri(item.icon) ? (
          <Image source={{ uri: item.icon }} style={styles.avatar} />
        ) : (
          <SpaceIcon name={item.name} size={48} style={styles.avatar} />
        )}
        {item.isMuted && (
          <View style={styles.mutedBadge}>
            <IconSymbol name="bell.slash" size={11} color={theme.colors.textSubtle} />
          </View>
        )}
      </View>
      <View style={styles.rowContent}>
        <View style={styles.rowTop}>
          <Text style={styles.rowTitle} numberOfLines={1}>{item.name}</Text>
          {item.timestamp > 0 && (
            <Text style={styles.rowTime}>{formatRelativeTime(item.timestamp)}</Text>
          )}
        </View>
        <View style={styles.rowBottom}>
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {item.channelCount} channel{item.channelCount !== 1 ? 's' : ''}
          </Text>
          {item.unreadCount > 0 && (
            <View style={[styles.badge, { backgroundColor: theme.colors.primary }]}>
              <Text style={styles.badgeText}>
                {item.unreadCount > 99 ? '99+' : item.unreadCount}
              </Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
});

export default function SpacesIndex() {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { data: spaces, isLoading, refetch } = useSpaces();
  const { getUnreadCount } = useChannelMentionUnread();
  const { getActivity } = useSpaceActivity();

  const [search, setSearch] = useState('');
  const [spaceModalVisible, setSpaceModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Warm the add-space modal chunk in the background once the screen is open.
  useEffect(() => {
    void importSpaceModal();
  }, []);

  const listPadding = useFloatingTabBarPadding();
  const styles = useMemo(() => createStyles(theme, isDark, listPadding), [theme, isDark, listPadding]);

  const spaceIds = useMemo(
    () => ((spaces as Space[]) ?? []).map(s => s.spaceId),
    [spaces],
  );
  const mutedSpaceIds = useMutedSpaceIds(spaceIds);

  const items = useMemo<SpaceItem[]>(() => {
    const rows: SpaceItem[] = [];
    for (const space of (spaces as Space[]) ?? []) {
      let unread = 0;
      let channelCount = 0;
      for (const group of space.groups ?? []) {
        for (const ch of group.channels ?? []) {
          channelCount++;
          unread += getUnreadCount(space.spaceId, ch.channelId);
        }
      }
      const activity = getActivity(space.spaceId);
      rows.push({
        id: space.spaceId,
        name: space.spaceName,
        icon: space.iconUrl,
        memberCount: 0,
        channelCount,
        unreadCount: unread,
        timestamp: activity?.timestamp ?? space.modifiedDate ?? space.createdDate ?? 0,
        isMuted: mutedSpaceIds.has(space.spaceId),
      });
    }

    const q = search.trim().toLowerCase();
    const filtered = q ? rows.filter(r => r.name.toLowerCase().includes(q)) : rows;
    filtered.sort((a, b) => b.timestamp - a.timestamp);
    return filtered;
  }, [spaces, search, getUnreadCount, getActivity, mutedSpaceIds]);

  const handlePress = useCallback((spaceId: string) => {
    haptics.light();
    router.push(`/spaces/${spaceId}`);
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await refetch(); } finally { setRefreshing(false); }
  }, [refetch]);

  const handleOpenAddSpace = useCallback(() => {
    haptics.selection();
    setSpaceModalVisible(true);
  }, []);

  const handleSpaceCreated = useCallback((spaceId: string) => {
    setSpaceModalVisible(false);
    router.push(`/spaces/${spaceId}`);
  }, []);

  const handleSpaceJoined = useCallback((spaceId: string) => {
    setSpaceModalVisible(false);
    router.push(`/spaces/${spaceId}`);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: SpaceItem }) => (
      <SpaceRow item={item} styles={styles} theme={theme} onPress={handlePress} />
    ),
    [styles, theme, handlePress],
  );

  return (
    <FloatingTabScreen surfaceColor={theme.colors.surface1} isDark={isDark} style={{ paddingTop: insets.top }}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <Text style={styles.heading}>Spaces</Text>
        <View style={styles.headerSlotRight}>
          <TouchableOpacity onPress={() => router.push('/spaces/discover')} style={styles.headerIconButton} hitSlop={8}>
            <IconSymbol name="safari" size={22} color={theme.colors.textMain} />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleOpenAddSpace} style={styles.headerIconButton} hitSlop={8}>
            <IconSymbol name="plus" size={22} color={theme.colors.textMain} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.searchContainer}>
        <IconSymbol name="magnifyingglass" size={18} color={theme.colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search spaces"
          placeholderTextColor={theme.colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')}>
            <IconSymbol name="xmark.circle.fill" size={18} color={theme.colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {isLoading && items.length === 0 ? (
        <View style={styles.emptyContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.emptyContainer}>
          <IconSymbol name="bubble.left.and.bubble.right" size={48} color={theme.colors.textMuted} />
          <Text style={styles.emptyTitle}>
            {search ? 'No matching spaces' : 'No spaces yet'}
          </Text>
          <Text style={styles.emptySubtitle}>
            {search ? 'Try a different search' : 'Join or create a space to get started'}
          </Text>
          {!search && (
            <TouchableOpacity
              style={[styles.emptyButton, { backgroundColor: theme.colors.primary }]}
              onPress={handleOpenAddSpace}
            >
              <Text style={styles.emptyButtonText}>Add Space</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <FlashList
          data={items}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          drawDistance={800}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.textMuted}
            />
          }
        />
      )}

      {spaceModalVisible && (
        <Suspense fallback={null}>
          <SpaceModal
            visible
            onClose={() => setSpaceModalVisible(false)}
            onSpaceCreated={handleSpaceCreated}
            onSpaceJoined={handleSpaceJoined}
          />
        </Suspense>
      )}
    </FloatingTabScreen>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean, listPadding: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.surface1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Skin.space(16),
      paddingTop: Skin.space(8),
      paddingBottom: Skin.space(4),
    },
    heading: { ...theme.textStyles.title3, color: theme.colors.textMain, flex: 1 },
    headerSlotRight: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'flex-end' as const, gap: Skin.space(4) },
    headerIconButton: { padding: Skin.space(8) },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
      borderRadius: Skin.radius(10),
      marginHorizontal: Skin.space(16),
      marginVertical: Skin.space(8),
      paddingHorizontal: Skin.space(10),
      height: 36,
      gap: Skin.space(6),
    },
    searchInput: {
      flex: 1,
      ...theme.textStyles.body,
      color: theme.colors.textMain,
      paddingVertical: 0,
    },
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      gap: Skin.space(8),
      paddingBottom: Skin.space(80),
    },
    emptyTitle: { ...theme.textStyles.headline, color: theme.colors.textMain, marginTop: Skin.space(12) },
    emptySubtitle: { ...theme.textStyles.subheadline, color: theme.colors.textSubtle, textAlign: 'center', paddingHorizontal: Skin.space(40) },
    emptyButton: { marginTop: Skin.space(16), paddingHorizontal: Skin.space(20), paddingVertical: Skin.space(10), borderRadius: Skin.radius(20) },
    emptyButtonText: { ...theme.textStyles.subheadline, color: '#fff', fontWeight: '600' },
    listContent: { paddingBottom: listPadding },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(12),
      gap: Skin.space(12),
    },
    avatarContainer: { position: 'relative' },
    avatar: { width: 48, height: 48, borderRadius: Skin.radius(12) },
    // Muted-space marker: bell-off chip at the top-left of the space icon,
    // mirroring the muted-contact badge in the messages list.
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
    rowContent: { flex: 1, gap: Skin.space(2) },
    rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    rowTitle: { ...theme.textStyles.body, color: theme.colors.textMain, fontWeight: '600', flex: 1, marginRight: Skin.space(8) },
    rowTime: { ...theme.textStyles.caption1, color: theme.colors.textSubtle },
    rowBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    rowSubtitle: { ...theme.textStyles.subheadline, color: theme.colors.textSubtle, flex: 1 },
    badge: { minWidth: 20, height: 20, borderRadius: Skin.radius(10), alignItems: 'center', justifyContent: 'center', paddingHorizontal: Skin.space(6) },
    badgeText: { ...theme.textStyles.caption2, color: '#fff', fontWeight: '700' },
  });
