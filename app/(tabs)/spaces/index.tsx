import { SpaceIcon } from '@/components/ui/SpaceIcon';
import { HeaderAvatar } from '@/components/HeaderAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useSpaces } from '@/hooks/chat/useSpaces';
import { isValidAvatarUri } from '@/utils/validation';
import { useReplyTracking } from '@/hooks/chat/useReplyTracking';
import { useSpaceActivity } from '@/hooks/chat/useSpaceActivity';
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
  const { getReplyCount } = useReplyTracking();
  const { getActivity } = useSpaceActivity();

  const [search, setSearch] = useState('');
  const [spaceModalVisible, setSpaceModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Warm the add-space modal chunk in the background once the screen is open.
  useEffect(() => {
    void importSpaceModal();
  }, []);

  const styles = useMemo(() => createStyles(theme, isDark), [theme, isDark]);

  const items = useMemo<SpaceItem[]>(() => {
    const rows: SpaceItem[] = [];
    for (const space of (spaces as Space[]) ?? []) {
      let unread = 0;
      let channelCount = 0;
      for (const group of space.groups ?? []) {
        for (const ch of group.channels ?? []) {
          channelCount++;
          unread += getReplyCount(space.spaceId, ch.channelId) ?? 0;
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
      });
    }

    const q = search.trim().toLowerCase();
    const filtered = q ? rows.filter(r => r.name.toLowerCase().includes(q)) : rows;
    filtered.sort((a, b) => b.timestamp - a.timestamp);
    return filtered;
  }, [spaces, search, getReplyCount, getActivity]);

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
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <View style={styles.headerSlotLeft}>
          <HeaderAvatar />
        </View>
        <View style={styles.headerSlotCenter}>
          <Text style={styles.heading}>Spaces</Text>
        </View>
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
          estimatedItemSize={72}
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
    </View>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean) =>
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
    heading: { ...theme.textStyles.title3, color: theme.colors.textMain, textAlign: 'center' as const },
    // Side slots take their natural width; center slot flex-fills the
    // remainder. This way the title gets ~75-80% of the screen width
    // (vs. the ~33% it had under equal flex), avoiding both wrapping
    // and ellipsizing on common screen sizes.
    headerSlotLeft: { alignItems: 'flex-start' as const, flexDirection: 'row' as const },
    headerSlotCenter: { flex: 1, alignItems: 'center' as const, justifyContent: 'center' as const, paddingHorizontal: Skin.space(8) },
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
    emptySubtitle: { ...theme.textStyles.subheadline, color: theme.colors.textMuted, textAlign: 'center', paddingHorizontal: Skin.space(40) },
    emptyButton: { marginTop: Skin.space(16), paddingHorizontal: Skin.space(20), paddingVertical: Skin.space(10), borderRadius: Skin.radius(20) },
    emptyButtonText: { ...theme.textStyles.subheadline, color: '#fff', fontWeight: '600' },
    listContent: { paddingBottom: Skin.space(100) },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(12),
      gap: Skin.space(12),
    },
    avatarContainer: {},
    avatar: { width: 48, height: 48, borderRadius: Skin.radius(12) },
    rowContent: { flex: 1, gap: Skin.space(2) },
    rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    rowTitle: { ...theme.textStyles.body, color: theme.colors.textMain, fontWeight: '600', flex: 1, marginRight: Skin.space(8) },
    rowTime: { ...theme.textStyles.caption1, color: theme.colors.textMuted },
    rowBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    rowSubtitle: { ...theme.textStyles.subheadline, color: theme.colors.textMuted, flex: 1 },
    badge: { minWidth: 20, height: 20, borderRadius: Skin.radius(10), alignItems: 'center', justifyContent: 'center', paddingHorizontal: Skin.space(6) },
    badgeText: { ...theme.textStyles.caption2, color: '#fff', fontWeight: '700' },
  });
