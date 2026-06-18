/**
 * Notifications tab — unified feed of Farcaster notifications (mentions,
 * replies, likes, recasts, follows) and our own chat notifications. Both
 * sources are merged + sorted newest-first via useUnifiedNotifications.
 *
 * Tapping an entry deep-links: messages route to their channel/DM, casts
 * open the cast thread modal-style flow via the feed tab. Marking-as-seen
 * happens on mount and when new entries land while the tab is open, so
 * the bell-icon badge clears in real time.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { Stack, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFloatingTabBarPadding } from '@/hooks/useFloatingTabBarPadding';
import { textStyles, useTheme, type AppTheme } from '@/theme';
import { useAuth } from '@/context/AuthContext';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { useOtaUpdate } from '@/hooks/useOtaUpdate';
import {
  clearNotificationLog,
  markNotificationsSeen,
  removeNotificationLogEntry,
} from '@/services/notifications/notificationLog';
import { markAllFarcasterNotificationsRead } from '@/services/farcasterClient';
import {
  useUnifiedNotifications,
  type UnifiedNotification,
} from '@/hooks/useUnifiedNotifications';
import * as Skin from '@/theme/skins/geometry';

function formatTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function NotificationsScreen() {
  const { theme } = useTheme();
  const listPadding = useFloatingTabBarPadding();
  const { farcasterAuthToken } = useAuth();
  const {
    items,
    isLoading,
    isFetchingMore,
    hasMore,
    fetchMore,
    refetch,
    farcasterEnabled,
    farcasterError,
  } = useUnifiedNotifications();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const styles = useMemo(() => createStyles(theme), [theme]);

  // Mark seen on mount and again whenever the feed grows while the user
  // is already on this screen — without the second pass a notification
  // landing during the session would stay flagged unread until next mount.
  // Also mirror the "all read" state to Farcaster so the user's web/iOS
  // Farcaster client doesn't keep showing the same items as unread.
  // Best-effort; failures are swallowed so a network blip on the Farcaster
  // side doesn't block our local clear.
  useEffect(() => {
    markNotificationsSeen();
    if (farcasterAuthToken) {
      markAllFarcasterNotificationsRead(farcasterAuthToken).catch(() => {
        /* ignore — local seen state is still cleared */
      });
    }
  }, [items.length, farcasterAuthToken]);

  const handlePress = useCallback((entry: UnifiedNotification) => {
    const link = entry.link;
    if (!link) return;
    if (link.type === 'message') {
      if (link.spaceId && link.channelId) {
        router.push(`/spaces/${link.spaceId}/${link.channelId}`);
      } else if (link.conversationId) {
        router.push(`/(tabs)/messages/dm/${encodeURIComponent(link.conversationId)}`);
      }
    } else if (link.type === 'cast') {
      // Bounce to the feed tab; it owns the thread modal/cast viewer.
      // Param names match what feed/index.tsx consumes via
      // useLocalSearchParams. Username is required upstream — fall back
      // to a placeholder if the notification didn't carry one (rare;
      // only happens for actor-less server messages).
      router.push({
        pathname: '/(tabs)/feed',
        params: {
          username: link.username ?? '',
          castHashPrefix: link.castHash,
        },
      });
    } else if (link.type === 'frame') {
      // Mini-app notifications — route to the wallet tab, which hosts
      // the BrowserModal that knows how to render frame URLs. Wallet
      // picks up the param via useLocalSearchParams and opens the
      // modal on mount.
      router.push({
        pathname: '/(tabs)/wallet',
        params: { miniAppUrl: link.url },
      });
    }
  }, []);

  const handleDelete = useCallback((entry: UnifiedNotification) => {
    if (entry.source === 'chat' && entry.raw?.chat) {
      removeNotificationLogEntry(entry.raw.chat.id);
    }
    // Farcaster items are read-only — server is the source of truth, we
    // can't dismiss individual ones. Leave the trash button hidden for
    // those (rendered branch below).
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.resolve(refetch());
    } finally {
      setRefreshing(false);
    }
  }, [refetch]);

  const renderItem = useCallback(
    ({ item }: { item: UnifiedNotification }) => {
      const showTrash = item.source === 'chat';
      return (
        <Pressable
          style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
          onPress={() => handlePress(item)}
        >
          {item.actorAvatarUrl ? (
            <Image source={{ uri: item.actorAvatarUrl }} style={styles.avatar} />
          ) : item.source === 'farcaster' ? (
            <DefaultAvatar displayName={item.title} address={item.id} size={36} />
          ) : (
            <View style={styles.iconWrap}>
              <IconSymbol name="bell.fill" color={theme.colors.primary} size={18} />
            </View>
          )}
          <View style={styles.body}>
            <View style={styles.titleRow}>
              <Text style={styles.title} numberOfLines={1}>
                {item.title}
              </Text>
              {item.source === 'farcaster' && (
                <View style={styles.sourceTag}>
                  <Text style={styles.sourceTagLabel}>Farcaster</Text>
                </View>
              )}
            </View>
            {!!item.body && (
              <Text style={styles.subtitle} numberOfLines={2}>{item.body}</Text>
            )}
            <Text style={styles.time}>{formatTime(item.timestamp)}</Text>
          </View>
          {showTrash && (
            <TouchableOpacity
              onPress={() => handleDelete(item)}
              hitSlop={8}
              style={styles.trashButton}
            >
              <IconSymbol name="trash" color={theme.colors.textMuted} size={18} />
            </TouchableOpacity>
          )}
        </Pressable>
      );
    },
    [styles, theme.colors.primary, theme.colors.textMuted, handlePress, handleDelete],
  );

  // OTA bolt: shown in the in-screen header's right slot when an
  // update is available. Same affordance as before, just hoisted out
  // of the native Stack header into the same in-screen row layout
  // that spaces + messages use.
  const ota = useOtaUpdate();
  const showOta = ota.isUpdateAvailable || ota.isUpdatePending;

  // "Clear chat" used to live in the header. With the header slots taken
  // by navigation actions, expose the clear action as a small inline link
  // above the list when it's relevant. Farcaster items aren't dismissable
  // (server-owned), so the link only appears when there's chat to clear.
  const hasChat = items.some(i => i.source === 'chat');

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Use an in-screen header to match spaces + messages exactly —
          the native Stack header was visually heavier and broke the
          design system across tabs. */}
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Text style={styles.heading}>Notifications</Text>
        <View style={styles.headerSlotRight}>
          {showOta ? (
            <TouchableOpacity
              onPress={() => { void ota.applyUpdate(); }}
              hitSlop={8}
              style={styles.headerIconButton}
              accessibilityLabel="Apply update"
            >
              <IconSymbol name="bolt.fill" color="#0A84FF" size={20} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
      {farcasterError && farcasterEnabled && (
        // Inline banner — visible whether or not chat notifications are
        // present. This is the only way the user can tell that their
        // Farcaster fetch failed; we have no working console-log path
        // in production. Shows the HTTP status / response snippet from
        // FarcasterNotificationsFetchError so the cause is debuggable.
        <View style={styles.errorBanner}>
          <IconSymbol name="exclamationmark.circle" color="#fff" size={16} />
          <Text style={styles.errorText} numberOfLines={3}>
            Couldn't load Farcaster notifications: {farcasterError.message}
          </Text>
        </View>
      )}
      {hasChat && (
        <View style={styles.clearRow}>
          <TouchableOpacity onPress={clearNotificationLog} hitSlop={8}>
            <Text style={{ color: theme.colors.primary, fontSize: Skin.font(13), fontWeight: '600' }}>
              Clear chat notifications
            </Text>
          </TouchableOpacity>
        </View>
      )}
      {items.length === 0 && !isLoading ? (
        <View style={styles.empty}>
          <IconSymbol name="bell" color={theme.colors.textMuted} size={42} />
          <Text style={styles.emptyTitle}>No notifications yet</Text>
          <Text style={styles.emptySubtitle}>
            {farcasterEnabled
              ? 'New mentions, replies, and chat messages will show up here.'
              : 'Sign in with Farcaster in your profile to see mentions and replies here too.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.divider} />}
          contentContainerStyle={{ paddingBottom: listPadding }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.primary}
            />
          }
          onEndReached={() => {
            if (hasMore) fetchMore();
          }}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            isFetchingMore ? (
              <View style={{ padding: Skin.space(16), alignItems: 'center' }}>
                <ActivityIndicator color={theme.colors.primary} />
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.surface1,
    },
    header: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      paddingHorizontal: Skin.space(16),
      paddingTop: Skin.space(8),
      paddingBottom: Skin.space(4),
    },
    headerSlotRight: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'flex-end' as const,
    },
    heading: {
      ...theme.textStyles.title3,
      color: theme.colors.textMain,
      flex: 1,
    },
    headerIconButton: { padding: Skin.space(8) },
    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: Skin.space(12),
      paddingHorizontal: Skin.space(32),
    },
    emptyTitle: {
      fontSize: Skin.font(17),
      fontWeight: '600',
      color: theme.colors.textMain,
    },
    emptySubtitle: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: Skin.font(20),
    },
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingVertical: Skin.space(14),
      paddingHorizontal: Skin.space(16),
      gap: Skin.space(12),
    },
    iconWrap: {
      width: 36,
      height: 36,
      borderRadius: Skin.radius(18),
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatar: {
      width: 36,
      height: 36,
      borderRadius: Skin.radius(18),
      backgroundColor: theme.colors.surface3,
    },
    body: {
      flex: 1,
      gap: Skin.space(2),
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
    },
    title: {
      flex: 1,
      fontSize: Skin.font(15),
      fontWeight: '600',
      color: theme.colors.textMain,
    },
    sourceTag: {
      paddingHorizontal: Skin.space(6),
      paddingVertical: Skin.space(2),
      borderRadius: Skin.radius(4),
      backgroundColor: '#8B5CF6' + '22',
    },
    sourceTagLabel: {
      fontSize: Skin.font(10),
      fontWeight: '700',
      color: '#8B5CF6',
    },
    subtitle: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      lineHeight: Skin.font(18),
    },
    time: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginTop: Skin.space(2),
    },
    trashButton: {
      padding: Skin.space(4),
      alignSelf: 'flex-start',
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.surface3,
      marginLeft: Skin.space(64),
    },
    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(10),
      backgroundColor: theme.colors.danger,
    },
    clearRow: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(8),
    },
    errorText: {
      flex: 1,
      color: '#fff',
      fontSize: Skin.font(13),
      lineHeight: Skin.font(18),
    },
  });
