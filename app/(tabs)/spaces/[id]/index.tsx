/**
 * Space detail screen — channels list
 *
 * Shows a list of channels (grouped by group) for a selected space.
 * Header provides quick access to settings and invite.
 */

import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { ChannelStatusGlyphs } from '@/components/Chat/ChannelStatusGlyphs';
import { useChannels } from '@/hooks/chat/useChannels';
import { useReplyTracking } from '@/hooks/chat/useReplyTracking';
import { useMentionTracking } from '@/hooks/chat/useMentionTracking';
import { useSpace } from '@/hooks/chat/useSpaces';
import { textStyles, useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { haptics } from '@/utils/haptics';
import type { Group } from '@quilibrium/quorum-shared';
import { resolveChannelIconColor } from '@/utils/channelIcon';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

// Prefetch helpers: warm the lazy chunks in the background after the screen
// mounts so the first tap on the gear / invite opens instantly instead of
// waiting on the on-demand import.
const importSpaceSettingsModal = () => import('@/components/SpaceSettingsModal');
const importInviteModal = () => import('@/components/InviteModal');

const SpaceSettingsModal = React.lazy(importSpaceSettingsModal);
const InviteModal = React.lazy(importInviteModal);

export default function SpaceChannelsScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const spaceId = typeof params.id === 'string' ? params.id : undefined;
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  // Warm the lazy modal chunks in the background once the screen is open so the
  // first open of space settings / invite is instant.
  useEffect(() => {
    void importSpaceSettingsModal();
    void importInviteModal();
  }, []);

  const { data: spaceData, isLoading } = useSpace(spaceId, { enabled: !!spaceId });
  useChannels(spaceId, { enabled: !!spaceId });
  const { getReplyCount } = useReplyTracking();
  const { getMentionCount } = useMentionTracking();

  const [settingsVisible, setSettingsVisible] = useState(false);
  const [inviteVisible, setInviteVisible] = useState(false);

  const styles = useMemo(() => createStyles(theme, insets), [theme, insets]);

  const handleSelectChannel = useCallback(
    (channelId: string) => {
      haptics.light();
      if (!spaceId) return;
      router.push(`/spaces/${spaceId}/${channelId}`);
    },
    [spaceId]
  );

  if (!spaceId) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: 'Space' }} />
        <View style={styles.center}>
          <Text style={styles.error}>Invalid space</Text>
        </View>
      </View>
    );
  }

  if (isLoading || !spaceData) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: 'Loading...' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: spaceData.spaceName,
          headerRight: () => (
            <View style={styles.headerActions}>
              <TouchableOpacity
                onPress={() => setInviteVisible(true)}
                style={styles.headerButton}
                hitSlop={8}
              >
                <IconSymbol name="person.badge.plus" size={22} color={theme.colors.textMain} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setSettingsVisible(true)}
                style={styles.headerButton}
                hitSlop={8}
              >
                <IconSymbol name="gearshape" size={22} color={theme.colors.textMain} />
              </TouchableOpacity>
            </View>
          ),
        }}
      />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        contentInsetAdjustmentBehavior="automatic"
      >
        {spaceData.description ? (
          <Text style={styles.description}>{spaceData.description}</Text>
        ) : null}

        {(spaceData.groups ?? []).map((group: Group, groupIndex: number) => (
          <View key={`group-${groupIndex}`} style={styles.groupSection}>
            <Text style={styles.groupTitle} numberOfLines={1}>{group.groupName.toUpperCase()}</Text>
            {group.channels.map((channel) => {
              // One badge = mentions + replies combined (desktop sums them into
              // a single "channel-mentions-bubble"). The dot is a separate
              // "has something for you" signal.
              // NOTE: desktop's unread dot is driven by lastReadTimestamp (any
              // unread message, even without a mention). That timestamp isn't
              // plumbed to this screen yet, so the dot here proxies "has a
              // mention/reply count". Full unread-dot parity is a follow-up that
              // needs lastReadTimestamp wired in.
              const replies = getReplyCount(spaceId, channel.channelId) ?? 0;
              const mentions = getMentionCount(spaceId, channel.channelId) ?? 0;
              const badgeCount = mentions + replies;
              return (
                <TouchableOpacity
                  key={channel.channelId}
                  style={styles.channelRow}
                  onPress={() => handleSelectChannel(channel.channelId)}
                  activeOpacity={0.6}
                >
                  {/* Fixed-width slot so the icon never shifts when the dot appears */}
                  <View style={styles.unreadDotSlot}>
                    {badgeCount > 0 && <View style={styles.unreadDot} />}
                  </View>
                  <IconSymbol
                    name={(channel.icon || 'hashtag') as IconSymbolName}
                    size={18}
                    color={resolveChannelIconColor(channel.iconColor, theme.colors.textMuted)}
                    variant={channel.iconVariant ?? 'outline'}
                  />
                  <Text style={[styles.channelName, badgeCount > 0 && styles.channelNameUnread]} numberOfLines={1}>
                    {channel.channelName}
                  </Text>
                  {badgeCount > 0 && (
                    <View style={styles.unreadBadge}>
                      <Text style={styles.unreadText}>
                        {badgeCount > 99 ? '99+' : badgeCount}
                      </Text>
                    </View>
                  )}
                  <ChannelStatusGlyphs
                    channel={channel}
                    defaultChannelId={spaceData.defaultChannelId}
                    size={15}
                  />
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </ScrollView>

      {settingsVisible && (
        <Suspense fallback={null}>
          <SpaceSettingsModal
            visible
            onClose={() => setSettingsVisible(false)}
            spaceId={spaceId}
            onSpaceDeleted={() => {
              setSettingsVisible(false);
              router.back();
            }}
            onSpaceLeft={() => {
              setSettingsVisible(false);
              router.back();
            }}
          />
        </Suspense>
      )}

      {inviteVisible && (
        <Suspense fallback={null}>
          <InviteModal
            visible
            onClose={() => setInviteVisible(false)}
            spaceId={spaceId}
            spaceName={spaceData.spaceName}
          />
        </Suspense>
      )}
    </View>
  );
}

const createStyles = (theme: AppTheme, insets: EdgeInsets) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.surface1,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    error: {
      ...theme.textStyles.body,
      color: theme.colors.danger,
    },
    scrollContent: {
      // iOS uses contentInsetAdjustmentBehavior="automatic" with the
      // transparent large-title header, so top padding isn't needed there.
      // Android Stack header is opaque and takes layout space, so no extra
      // padding required either.
      paddingTop: Skin.space(8),
      paddingBottom: insets.bottom + 100, // clear blur tab bar
    },
    description: {
      ...theme.textStyles.subheadline,
      color: theme.colors.textMuted,
      paddingHorizontal: Skin.space(16),
      paddingBottom: Skin.space(16),
    },
    groupSection: {
      marginBottom: Skin.space(16),
    },
    groupTitle: {
      ...theme.textStyles.footnote,
      color: theme.colors.textMuted,
      paddingHorizontal: Skin.space(16),
      marginBottom: Skin.space(4),
      letterSpacing: 0.6,
    },
    channelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      // Left edge aligns the dot slot with the group title's left padding.
      // The dot slot (16px) + gap (10px) = 26px before the icon, giving
      // visible indentation relative to the group title text at x=16.
      paddingLeft: Skin.space(16),
      paddingRight: Skin.space(16),
      paddingVertical: Skin.space(8),
      gap: Skin.space(10),
    },
    channelName: {
      flex: 1,
      ...theme.textStyles.body,
      color: theme.colors.textMain,
    },
    channelNameUnread: {
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
    },
    // Fixed slot so the icon never shifts whether or not the dot is shown.
    // Width = dot (6px) + breathing room to 16px slot total.
    unreadDotSlot: {
      width: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // Accent dot — desktop's .channel-unread-dot spec.
    unreadDot: {
      width: 6,
      height: 6,
      borderRadius: Skin.radius(3),
      backgroundColor: theme.colors.primary,
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
    headerActions: {
      flexDirection: 'row',
      gap: Skin.space(12),
    },
    headerButton: {
      padding: Skin.space(4),
    },
  });
