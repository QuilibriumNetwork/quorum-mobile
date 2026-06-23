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
import { ActivityIndicator, Image, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { Stack, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFloatingTabBarPadding } from '@/hooks/useFloatingTabBarPadding';
import { FloatingTabScreen } from '@/components/ui/FloatingTabScreen';
import { SegmentedPills } from '@/components/ui/SegmentedPills';
import { textStyles, useTheme, type AppTheme } from '@/theme';
import { useAuth } from '@/context/AuthContext';
import { useMiniappOverlay } from '@/context/MiniappOverlayContext';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { useOtaUpdate } from '@/hooks/useOtaUpdate';
import {
  clearNotificationLog,
  markNotificationsSeen,
  removeNotificationLogEntry,
} from '@/services/notifications/notificationLog';
import { clearMentionReplyLog, markQuorumTabSeen } from '@/services/notifications/mentionReplyLog';
import { markAllFarcasterNotificationsRead } from '@/services/farcasterClient';
import {
  useUnifiedNotifications,
  type UnifiedNotification,
} from '@/hooks/useUnifiedNotifications';
import * as Skin from '@/theme/skins/geometry';

// Max preview lines for a Quorum row's message. The panel is a triage surface
// (tap through to read in full), so cap it: long replies don't dominate the list.
const QUORUM_PREVIEW_LINES = 2;

/** Leading icon (IconSymbol name) for a Quorum mention/reply row, by kind.
 *  Mirrors the composer + space-settings iconography so the inbox reads
 *  consistently: @everyone = bullhorn (composer autocomplete), @role = shield
 *  (Roles tab + role pills), @you = at, reply = reply arrow. */
function quorumRowIcon(entry: UnifiedNotification): IconSymbolName {
  switch (entry.raw?.quorum?.kind) {
    case 'reply':
      return 'arrowshape.turn.up.left.fill';
    case 'mention-everyone':
      return 'bullhorn';
    case 'mention-roles':
      return 'shield';
    case 'mention-you':
    default:
      return 'at';
  }
}

/** Location parts for a Quorum row — space (loud) + channel breadcrumb (muted). */
function quorumLocation(entry: UnifiedNotification): { space: string; channel: string } {
  const q = entry.raw?.quorum;
  const space = q?.spaceName?.trim() || 'Space';
  const channel = q?.channelName ? `#${q.channelName}` : '#channel';
  return { space, channel: q?.threadId ? `${channel} › Thread` : channel };
}

function formatTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function NotificationsScreen() {
  const { theme, isDark } = useTheme();
  const listPadding = useFloatingTabBarPadding();
  const { farcasterAuthToken } = useAuth();
  const {
    items,
    quorumItems,
    farcasterFeedItems,
    isLoading,
    isFetchingMore,
    hasMore,
    fetchMore,
    refetch,
    farcasterEnabled,
    farcasterError,
  } = useUnifiedNotifications();
  const insets = useSafeAreaInsets();
  const { openMiniapp } = useMiniappOverlay();
  const [refreshing, setRefreshing] = useState(false);
  // Source filter. Pills only render when there's a Farcaster feed to filter
  // against (see below), so single-source users never see a pointless filter.
  const [sourceFilter, setSourceFilter] = useState<'all' | 'quorum' | 'farcaster'>('all');
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
    // Level 1 — mark the Quorum section seen so the tab badge clears on open.
    // This does NOT mark per-channel mentions read (Level 2 clears on channel
    // open), per the two-level read-state model.
    markQuorumTabSeen();
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
      // Mini-app notifications — open the global miniapp overlay directly.
      // The provider wraps every tab, so the BrowserModal renders above the
      // notifications screen immediately. (Previously this bounced through
      // the wallet tab via a `?miniAppUrl=` param, which depended on the
      // wallet screen mounting and reading the param — fragile across tab
      // navigation and the likely reason taps didn't present the mini app.)
      openMiniapp({ url: link.url, isQNative: false });
    }
  }, [openMiniapp]);

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
          ) : item.source === 'quorum' ? (
            <View style={styles.iconWrap}>
              <IconSymbol name={quorumRowIcon(item)} color={theme.colors.primary} size={18} />
            </View>
          ) : (
            <View style={styles.iconWrap}>
              <IconSymbol name="bell.fill" color={theme.colors.primary} size={18} />
            </View>
          )}
          {item.source === 'quorum' ? (
            // Location-first layout: lead with "Space › #channel" (loud), then
            // the message preview, then the time. The mention type is conveyed
            // by the leading icon, so no redundant "X mentioned you" title.
            <View style={styles.body}>
              <Text style={styles.locationLine} numberOfLines={1}>
                {quorumLocation(item).space}
                <Text style={styles.locationChannel}>
                  {'  '}
                  {quorumLocation(item).channel}
                </Text>
              </Text>
              {!!item.raw?.quorum?.preview?.text && (
                <Text style={styles.quorumMessage} numberOfLines={QUORUM_PREVIEW_LINES}>
                  {item.raw.quorum.preview.text}
                </Text>
              )}
              <Text style={styles.time}>{formatTime(item.timestamp)}</Text>
            </View>
          ) : (
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
          )}
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

  // Pills only earn their space when there's actually a Farcaster feed to filter
  // against — a user with no Farcaster (or no Farcaster items) sees a single
  // Quorum list and no filter chrome.
  const showFilterPills = farcasterFeedItems.length > 0 && quorumItems.length > 0;
  // If the pills disappear (e.g. last Farcaster item ages out), don't leave the
  // view stuck on a now-hidden filter.
  const activeFilter = showFilterPills ? sourceFilter : 'all';

  // Two sections: Quorum mentions/replies, then Farcaster activity. Empty
  // sections are dropped so we never render a lone header. The source filter
  // hides the non-selected section.
  const sections = useMemo(() => {
    const out: { key: string; title: string; data: UnifiedNotification[] }[] = [];
    if (quorumItems.length && activeFilter !== 'farcaster') {
      out.push({ key: 'quorum', title: 'Mentions & replies', data: quorumItems });
    }
    if (farcasterFeedItems.length && activeFilter !== 'quorum') {
      out.push({ key: 'farcaster', title: 'Farcaster', data: farcasterFeedItems });
    }
    return out;
  }, [quorumItems, farcasterFeedItems, activeFilter]);

  // Secondary "Clear all" — empties the inbox (deletes the Quorum log + the chat
  // log) and marks the tab seen. Named "Clear all" (not "Mark all read") because
  // it removes the rows, not just their unread state. The list otherwise
  // persists as history; per-channel bubbles clear on channel open (Level 2).
  const handleClearAll = useCallback(() => {
    clearMentionReplyLog();
    clearNotificationLog();
    markNotificationsSeen();
    // Advance the Level-1 watermark to now so mentions arriving right after the
    // clear are compared against the clear time, not a stale tab-open time.
    markQuorumTabSeen();
  }, []);

  return (
    <FloatingTabScreen surfaceColor={theme.colors.surface1} isDark={isDark} style={{ paddingTop: insets.top }}>
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
      {showFilterPills && (
        <View style={styles.filterRow}>
          <SegmentedPills
            items={[
              { key: 'all', label: 'All' },
              { key: 'quorum', label: 'Quorum' },
              { key: 'farcaster', label: 'Farcaster' },
            ]}
            activeKey={activeFilter}
            onChange={(k) => setSourceFilter(k as 'all' | 'quorum' | 'farcaster')}
            itemRole="button"
            scrollable={false}
          />
        </View>
      )}
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
      {items.length > 0 && (
        <View style={styles.clearRow}>
          <TouchableOpacity onPress={handleClearAll} hitSlop={8}>
            <Text style={{ color: theme.colors.primary, fontSize: Skin.font(13), fontWeight: '600' }}>
              Clear all
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
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionHeaderLabel}>{section.title}</Text>
            </View>
          )}
          stickySectionHeadersEnabled={false}
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
    </FloatingTabScreen>
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
    // Quorum location-first row: loud space name, muted channel, then message.
    locationLine: {
      fontSize: Skin.font(15),
      fontWeight: '700',
      color: theme.colors.textMain,
    },
    locationChannel: {
      fontSize: Skin.font(14),
      fontWeight: '400',
      color: theme.colors.textMuted,
    },
    quorumMessage: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      lineHeight: Skin.font(18),
      marginTop: Skin.space(2),
    },
    sectionHeader: {
      paddingHorizontal: Skin.space(16),
      paddingTop: Skin.space(14),
      paddingBottom: Skin.space(6),
      backgroundColor: theme.colors.surface1,
    },
    sectionHeaderLabel: {
      fontSize: Skin.font(12),
      fontWeight: '700',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      color: theme.colors.textMuted,
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
    filterRow: {
      paddingHorizontal: Skin.space(16),
      paddingTop: Skin.space(4),
      paddingBottom: Skin.space(8),
    },
    errorText: {
      flex: 1,
      color: '#fff',
      fontSize: Skin.font(13),
      lineHeight: Skin.font(18),
    },
  });
