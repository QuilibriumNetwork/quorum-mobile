import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { ChannelStatusGlyphs } from '@/components/Chat/ChannelStatusGlyphs';
import { SpaceBannerHeader } from '@/components/SpaceBannerHeader';
import { SpaceDescriptionSheet } from '@/components/SpaceDescriptionSheet';
import { useChannels } from '@/hooks/chat/useChannels';
import { useReplyTracking } from '@/hooks/chat/useReplyTracking';
import { useMentionTracking } from '@/hooks/chat/useMentionTracking';
import { useChannelMute } from '@/hooks/chat/useChannelMute';
import { useSpace } from '@/hooks/chat/useSpaces';
import { useTheme, type AppTheme } from '@/theme';
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

  useEffect(() => {
    void importSpaceSettingsModal();
    void importInviteModal();
  }, []);

  const { data: spaceData, isLoading } = useSpace(spaceId, { enabled: !!spaceId });
  useChannels(spaceId, { enabled: !!spaceId });
  const { mutedChannels, isSpaceMuted } = useChannelMute(spaceId);
  const spaceMuted = isSpaceMuted();
  const { getReplyCount } = useReplyTracking();
  const { getMentionCount } = useMentionTracking();

  const [settingsVisible, setSettingsVisible] = useState(false);
  const [inviteVisible, setInviteVisible] = useState(false);
  const [descriptionVisible, setDescriptionVisible] = useState(false);

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
      <Stack.Screen options={{ headerShown: false }} />

      <SpaceBannerHeader
        space={spaceData}
        insetTop={insets.top}
        onBack={() => router.back()}
        onInvite={() => setInviteVisible(true)}
        onSettings={() => setSettingsVisible(true)}
        onDescriptionPress={() => setDescriptionVisible(true)}
        isMuted={spaceMuted}
      />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
      >
        {(spaceData.groups ?? []).map((group: Group, groupIndex: number) => (
          <View key={`group-${groupIndex}`} style={styles.groupSection}>
            <Text style={styles.groupTitle} numberOfLines={1}>{group.groupName.toUpperCase()}</Text>
            {group.channels.map((channel) => {
              const replies = getReplyCount(spaceId, channel.channelId) ?? 0;
              const mentions = getMentionCount(spaceId, channel.channelId) ?? 0;
              const badgeCount = mentions + replies;
              // Per-row muted treatment fires only for an INDIVIDUALLY muted
              // channel — a whole-space mute is shown on the space header/icon
              // instead, so the channel list doesn't read as all-broken.
              const muted = mutedChannels.has(channel.channelId);
              return (
                <TouchableOpacity
                  key={channel.channelId}
                  style={styles.channelRow}
                  onPress={() => handleSelectChannel(channel.channelId)}
                  activeOpacity={0.6}
                >
                  <View style={styles.unreadDotSlot}>
                    {badgeCount > 0 && <View style={styles.unreadDot} />}
                  </View>
                  <IconSymbol
                    name={(channel.icon || 'hashtag') as IconSymbolName}
                    size={18}
                    color={resolveChannelIconColor(channel.iconColor, theme.colors.textMuted)}
                    variant={channel.iconVariant ?? 'outline'}
                  />
                  <Text
                    style={[
                      styles.channelName,
                      badgeCount > 0 && styles.channelNameUnread,
                      muted && styles.channelNameMuted,
                    ]}
                    numberOfLines={1}
                  >
                    {channel.channelName}
                  </Text>
                  {muted && (
                    <IconSymbol
                      name="bell.slash.fill"
                      size={14}
                      color={theme.colors.textMuted}
                      style={styles.channelMuteIcon}
                    />
                  )}
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

      {descriptionVisible && (
        <SpaceDescriptionSheet
          visible
          onClose={() => setDescriptionVisible(false)}
          space={spaceData}
        />
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
      paddingTop: Skin.space(24),
      paddingBottom: insets.bottom + 160,
    },
    groupSection: {
      marginBottom: Skin.space(16),
    },
    groupTitle: {
      ...theme.textStyles.footnote,
      color: theme.colors.textSubtle,
      paddingHorizontal: Skin.space(16),
      marginBottom: Skin.space(4),
      letterSpacing: 0.6,
    },
    channelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: Skin.space(16),
      paddingRight: Skin.space(16),
      paddingVertical: Skin.space(8),
      gap: Skin.space(10),
    },
    channelMuteIcon: {
      marginLeft: Skin.space(2),
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
    // Muted channel: the NAME reads muted (a solid muted-color token, not opacity,
    // and not the icon) alongside the bell-off marker.
    channelNameMuted: {
      color: theme.colors.textMuted,
    },
    unreadDotSlot: {
      width: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
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
  });
