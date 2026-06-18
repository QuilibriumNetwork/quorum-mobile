import { SpaceIcon } from '@/components/ui/SpaceIcon';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useToast } from '@/context/ToastContext';
import { useWebSocket } from '@/context/WebSocketContext';
import { isValidAvatarUri } from '@/utils/validation';
import { textStyles, useTheme, type AppTheme } from '@/theme';
import { useExploreSpaces, SPACE_CATEGORIES } from '@/hooks/chat/useExploreSpaces';
import { useSpaces } from '@/hooks/chat/useSpaces';
import { useJoinSpace } from '@/hooks/chat/useSpaceActions';
import { getQuorumClient } from '@/services/api/quorumClient';
import type { DirectoryEntry } from '@/services/api/quorumClient';
import { haptics } from '@/utils/haptics';
import { router, Stack } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Image, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { SegmentedPills, type SegmentedPillItem } from '@/components/ui/SegmentedPills';
import { useHeaderHeight } from '@react-navigation/elements';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';


function formatMemberCount(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return `${count}`;
}

export default function DiscoverSpacesScreen() {
  const { theme, isDark } = useTheme();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const { isConnected } = useWebSocket();
  const { showToast } = useToast();
  const { data: joinedSpaces } = useSpaces();
  const joinSpaceMutation = useJoinSpace();

  const {
    search, setSearch,
    category, setCategory,
    entries, isLoading, hasMore,
    loadMore, refetch,
  } = useExploreSpaces();

  const [joiningId, setJoiningId] = useState<string | null>(null);
  const styles = createStyles(theme, isDark);

  const joinedIds = new Set((joinedSpaces ?? []).map((s: { spaceId: string }) => s.spaceId));

  const handleJoin = useCallback(async (entry: DirectoryEntry) => {
    if (!isConnected) {
      showToast({ type: 'error', title: 'Not Connected', message: 'Please check your connection.' });
      return;
    }

    setJoiningId(entry.space_address);
    haptics.selection();

    try {
      const client = getQuorumClient();
      const spaceData = await client.fetchSpace(entry.space_address);
      if (!spaceData?.inviteUrl) {
        showToast({ type: 'error', title: 'Unable to Join', message: 'This space has no public invite link.' });
        return;
      }

      await joinSpaceMutation.mutateAsync({
        inviteLink: spaceData.inviteUrl,
      });

      router.push(`/spaces/${entry.space_address}`);
    } catch (error) {
      showToast({
        type: 'error',
        title: 'Failed to Join',
        message: error instanceof Error ? error.message : 'Failed to join',
      });
    } finally {
      setJoiningId(null);
    }
  }, [isConnected, joinSpaceMutation, showToast]);

  const renderEntry = useCallback(({ item }: { item: DirectoryEntry }) => {
    const isJoined = joinedIds.has(item.space_address);
    const isJoining = joiningId === item.space_address;

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          {isValidAvatarUri(item.icon) ? (
            <Image source={{ uri: item.icon }} style={styles.cardIcon} />
          ) : (
            <SpaceIcon name={item.name} size={48} style={styles.cardIcon} />
          )}
          <View style={styles.cardInfo}>
            <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.cardCategory}>
              {item.category || 'community'}
              {item.member_count != null ? ` \u00B7 ${formatMemberCount(item.member_count)} member${item.member_count !== 1 ? 's' : ''}` : ''}
            </Text>
          </View>
          {isJoined ? (
            <TouchableOpacity
              style={[styles.joinButton, styles.joinedButton]}
              onPress={() => router.push(`/spaces/${item.space_address}`)}
            >
              <Text style={[styles.joinButtonText, styles.joinedButtonText]}>Open</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.joinButton}
              onPress={() => handleJoin(item)}
              disabled={isJoining}
            >
              {isJoining ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.joinButtonText}>Join</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
        {item.description ? (
          <Text style={styles.cardDescription} numberOfLines={2}>{item.description}</Text>
        ) : null}
      </View>
    );
  }, [styles, joinedIds, joiningId, handleJoin]);

  return (
    <View style={[styles.container, { paddingTop: headerHeight }]}>
      <Stack.Screen options={{ title: 'Discover Spaces' }} />

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

      <SegmentedPills
        contentContainerStyle={styles.categoryRow}
        variant="solid"
        itemRole="button"
        items={SPACE_CATEGORIES.map<SegmentedPillItem>((cat) => ({
          // value is `SpaceCategory | null`; the "All" pill uses a string
          // sentinel since pill keys must be strings.
          key: cat.value ?? 'all',
          label: cat.label,
        }))}
        activeKey={category ?? 'all'}
        onChange={(key) => setCategory(key === 'all' ? null : (key as typeof category))}
      />

      {isLoading && entries.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : entries.length === 0 ? (
        <View style={styles.center}>
          <IconSymbol name="globe" size={48} color={theme.colors.textMuted} />
          <Text style={styles.emptyTitle}>No spaces found</Text>
          <Text style={styles.emptySubtitle}>
            {search ? 'Try a different search' : 'No public spaces in this category yet'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.space_address}
          renderItem={renderEntry}
          contentContainerStyle={[styles.listContent, { paddingBottom: Skin.space(100) + insets.bottom }]}
          onEndReached={hasMore ? loadMore : undefined}
          onEndReachedThreshold={0.5}
        />
      )}
    </View>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.surface1 },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
      borderRadius: Skin.radius(10),
      marginHorizontal: Skin.space(16),
      marginTop: Skin.space(8),
      marginBottom: Skin.space(8),
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
    categoryRow: {
      paddingHorizontal: Skin.space(16),
      paddingBottom: Skin.space(8),
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: Skin.space(8),
      paddingBottom: Skin.space(80),
    },
    emptyTitle: { ...theme.textStyles.headline, color: theme.colors.textMain, marginTop: Skin.space(12) },
    emptySubtitle: { ...theme.textStyles.subheadline, color: theme.colors.textMuted, textAlign: 'center', paddingHorizontal: Skin.space(40) },
    // paddingBottom is applied inline (Skin.space(100) + insets.bottom) so the
    // last card clears the system nav bar in edge-to-edge mode.
    listContent: { paddingHorizontal: Skin.space(16) },
    card: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(14),
      marginBottom: Skin.space(10),
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
    },
    cardIcon: { width: 48, height: 48, borderRadius: Skin.radius(12) },
    cardInfo: { flex: 1, gap: Skin.space(2) },
    cardName: { ...theme.textStyles.body, color: theme.colors.textMain, fontWeight: '600' },
    cardCategory: { ...theme.textStyles.caption1, color: theme.colors.textMuted, textTransform: 'capitalize' },
    cardDescription: { ...theme.textStyles.subheadline, color: theme.colors.textMuted, marginTop: Skin.space(8) },
    joinButton: {
      backgroundColor: theme.colors.primary,
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(8),
      borderRadius: Skin.radius(16),
      minWidth: 60,
      alignItems: 'center',
    },
    joinedButton: {
      backgroundColor: 'transparent',
      borderWidth: Skin.border(1),
      borderColor: theme.colors.border,
    },
    joinButtonText: { ...theme.textStyles.footnote, color: '#fff', fontWeight: '600' },
    joinedButtonText: { color: theme.colors.textMuted },
  });
