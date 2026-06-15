/**
 * Space detail screen — channels list
 *
 * Shows a list of channels (grouped by group) for a selected space.
 * Header provides quick access to settings and invite.
 */

import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { useChannels } from '@/hooks/chat/useChannels';
import { useReplyTracking } from '@/hooks/chat/useReplyTracking';
import { useSpace } from '@/hooks/chat/useSpaces';
import { textStyles, useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { haptics } from '@/utils/haptics';
import type { Group } from '@quilibrium/quorum-shared';
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

        {(spaceData.groups ?? []).map((group: Group) => (
          <View key={group.groupName} style={styles.groupSection}>
            <Text style={styles.groupTitle}>{group.groupName.toUpperCase()}</Text>
            {group.channels.map((channel) => {
              const unread = getReplyCount(spaceId, channel.channelId) ?? 0;
              return (
                <TouchableOpacity
                  key={channel.channelId}
                  style={styles.channelRow}
                  onPress={() => handleSelectChannel(channel.channelId)}
                  activeOpacity={0.6}
                >
                  <IconSymbol
                    name={(channel.icon || 'number') as IconSymbolName}
                    size={18}
                    color={channel.iconColor || theme.colors.textMuted}
                  />
                  <Text style={styles.channelName} numberOfLines={1}>
                    {channel.channelName}
                  </Text>
                  {unread > 0 && (
                    <View style={styles.unreadBadge}>
                      <Text style={styles.unreadText}>
                        {unread > 99 ? '99+' : unread}
                      </Text>
                    </View>
                  )}
                  <IconSymbol
                    name="chevron.right"
                    size={14}
                    color={theme.colors.textMuted}
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
      ...theme.textStyles.caption2,
      color: theme.colors.textMuted,
      paddingHorizontal: Skin.space(16),
      marginBottom: Skin.space(4),
      letterSpacing: 0.8,
    },
    channelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(12),
      gap: Skin.space(10),
    },
    channelName: {
      flex: 1,
      ...theme.textStyles.body,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
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
