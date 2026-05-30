/**
 * Space chat screen — wraps SpaceChatArea with data hooks.
 */

import { SpaceChatArea, type MemberMap, type MessageUserInfo } from '@/components/Chat';
import { useAuth } from '@/context/AuthContext';
import { useMiniappOverlay } from '@/context/MiniappOverlayContext';
import { useChannels } from '@/hooks/chat/useChannels';
import { useHasPermission } from '@/hooks/chat/useRoleManagement';
import { useReplyTracking, setActiveChannel, clearActiveChannel } from '@/hooks/chat/useReplyTracking';
import { useSpace, useSpaceMembers } from '@/hooks/chat/useSpaces';
import { useBookmarks } from '@/hooks/useUserConfig';
import { getSpaceKey } from '@/services/config/spaceStorage';
import { useTheme } from '@/theme';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import React, { Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useWebSocket, useSpaceCall } from '@/context';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys, type Message } from '@quilibrium/quorum-shared';
import { sendSpaceCallStartMessage } from '@/services/space/spaceMessageService';

const UserProfileModal = React.lazy(() => import('@/components/UserProfileModal'));
const InviteModal = React.lazy(() => import('@/components/InviteModal'));
const SpaceSettingsModal = React.lazy(() => import('@/components/SpaceSettingsModal'));
const CastThreadModal = React.lazy(() => import('@/components/CastThreadModal'));

export default function SpaceChannelChat() {
  const params = useLocalSearchParams<{ id: string; channelId: string }>();
  const spaceId = typeof params.id === 'string' ? params.id : undefined;
  const channelId = typeof params.channelId === 'string' ? params.channelId : undefined;

  const { theme } = useTheme();
  const { user } = useAuth();
  const { enqueueOutbound, isConnected } = useWebSocket();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();

  const { data: spaceData } = useSpace(spaceId, { enabled: !!spaceId });
  const { data: membersData } = useSpaceMembers(spaceId, { enabled: !!spaceId });
  const { data: channelsData } = useChannels(spaceId, { enabled: !!spaceId });

  const { bookmarks, addBookmark, removeBookmark, isBookmarked } = useBookmarks();

  const isSpaceOwner = useMemo(() => {
    if (!spaceId) return false;
    return !!getSpaceKey(spaceId, 'owner');
  }, [spaceId]);

  const hasRolePin = useHasPermission(spaceId, user?.address, 'message:pin');
  const hasRoleDelete = useHasPermission(spaceId, user?.address, 'message:delete');
  const hasPinPermission = hasRolePin || isSpaceOwner;
  const hasDeletePermission = hasRoleDelete || isSpaceOwner;

  const memberMap = useMemo<MemberMap>(() => {
    if (!membersData) return {};
    return membersData.reduce((acc: MemberMap, m) => {
      acc[m.address] = m;
      return acc;
    }, {} as MemberMap);
  }, [membersData]);

  const draftsRef = useRef<Map<string, string>>(new Map());

  // Reply-count badge: clear whenever this channel becomes the active
  // route, and mark it as the active channel so further replies that
  // land while we're here don't re-bump the badge. Both halves are
  // necessary — without the active marker the WebSocket increment
  // would race the clear and leave the count stuck at 1.
  const { clearReplyCount } = useReplyTracking();
  React.useEffect(() => {
    if (!spaceId || !channelId) return;
    clearReplyCount(spaceId, channelId);
    setActiveChannel(spaceId, channelId);
    return () => clearActiveChannel(spaceId, channelId);
  }, [spaceId, channelId, clearReplyCount]);

  // Self-heal: kick off a hub-log catch-up whenever the user opens this
  // channel. The on-connect orchestrator only sees spaces that existed
  // at connect time, so users who joined a space mid-session (before the
  // post-join hook landed) wouldn't get any log entries until they
  // reconnect. This fires log-since(storedCursor) opportunistically;
  // server returns nothing if we're already up to date, so it's safe to
  // run on every mount.
  React.useEffect(() => {
    if (!spaceId) return;
    void (async () => {
      const { subscribeAndCatchUpHubLog } = await import('@/services/space/hubLogSync');
      await subscribeAndCatchUpHubLog(spaceId, enqueueOutbound);
    })();
  }, [spaceId, enqueueOutbound]);

  // Overlay state — miniapps go through the global overlay (a single
  // BrowserModal lives at the tabs layout, preserving WebView state
  // across minimize/restore).
  const { openMiniapp } = useMiniappOverlay();
  const [selectedUserProfile, setSelectedUserProfile] = useState<MessageUserInfo | null>(null);
  const [inviteVisible, setInviteVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [castThread, setCastThread] = useState<{ username: string; castHashPrefix: string } | null>(null);

  const handleShowSidebars = useCallback(() => {
    router.back();
  }, []);

  const handleUserPress = useCallback((info: MessageUserInfo) => {
    setSelectedUserProfile(info);
  }, []);

  const handleLinkPress = useCallback((url: string) => {
    // Chat-link URLs are user-provided and may target LAN dev hosts, so
    // pass through `allowInsecureLAN` for SSL bypass.
    openMiniapp({ url, isQNative: false, allowInsecureLAN: true });
  }, [openMiniapp]);

  const handleOpenFarcasterCast = useCallback((username: string, castHashPrefix: string) => {
    // Open the cast's thread inline as a modal instead of routing to the feed
    // tab — keeps the user in the space chat context.
    setCastThread({ username, castHashPrefix });
  }, []);

  const handleJoinSpaceFromLink = useCallback((newSpaceId: string, newChannelId: string) => {
    router.push(`/spaces/${newSpaceId}/${newChannelId}`);
  }, []);

  const handleOpenInviteModal = useCallback(() => setInviteVisible(true), []);
  const handleOpenSpaceSettings = useCallback(() => setSettingsVisible(true), []);


  const handleChannelLinkPress = useCallback(
    (newChannelId: string) => {
      if (!spaceId) return;
      router.replace(`/spaces/${spaceId}/${newChannelId}`);
    },
    [spaceId]
  );

  const channelName = useMemo(() => {
    if (!channelsData || !channelId) return 'Channel';
    const ch = channelsData.find((c) => c.channelId === channelId);
    return ch?.channelName ?? 'Channel';
  }, [channelsData, channelId]);

  const queryClient = useQueryClient();
  const { joinCall: joinSpaceCall } = useSpaceCall();

  const startSpaceCall = useCallback(async (mediaType: 'audio' | 'video') => {
    if (!spaceId || !channelId || !user?.address) return;
    if (!isConnected) {
      Alert.alert('Not connected', 'Please wait for the connection to be established.');
      return;
    }
    try {
      const result = await sendSpaceCallStartMessage({
        spaceId, channelId, senderAddress: user.address, mediaType,
      });

      // Optimistic insert — self-echoes are skipped by the batch processor
      // so we need to add the message to the cache immediately
      const callMessage: Message = result.message;
      const messagesKey = queryKeys.messages.infinite(spaceId, channelId);
      queryClient.setQueryData<{ pages: { messages: Message[] }[]; pageParams: unknown[] }>(messagesKey, (old) => {
        if (!old) {
          return { pages: [{ messages: [callMessage], nextCursor: null, prevCursor: null }], pageParams: [undefined] };
        }
        return {
          ...old,
          pages: old.pages.map((page, i) =>
            i === 0 ? { ...page, messages: [...page.messages, callMessage] } : page
          ),
        };
      });

      enqueueOutbound(async () => [result.wsEnvelope]);

      // Auto-join the call we just started
      const callId = (result.message.content as any).callId;
      if (callId) {
        joinSpaceCall(callId, spaceId, channelId, mediaType === 'video');
      }
    } catch {
      Alert.alert('Error', 'Failed to start call.');
    }
  }, [spaceId, channelId, user?.address, isConnected, enqueueOutbound, queryClient, joinSpaceCall]);

  const headerRight = useCallback(() => (
    <View style={styles.headerRight}>
      <TouchableOpacity onPress={() => startSpaceCall('video')} hitSlop={8}>
        <IconSymbol name="video" color={theme.colors.primary} size={20} />
      </TouchableOpacity>
      <TouchableOpacity onPress={() => startSpaceCall('audio')} hitSlop={8}>
        <IconSymbol name="phone" color={theme.colors.primary} size={20} />
      </TouchableOpacity>
      {isSpaceOwner && (
        <TouchableOpacity onPress={handleOpenInviteModal} hitSlop={8}>
          <IconSymbol name="person.badge.plus" color={theme.colors.primary} size={20} />
        </TouchableOpacity>
      )}
      <TouchableOpacity onPress={handleOpenSpaceSettings} hitSlop={8}>
        <IconSymbol name="gearshape" color={theme.colors.primary} size={20} />
      </TouchableOpacity>
    </View>
  ), [theme, isSpaceOwner, startSpaceCall, handleOpenInviteModal, handleOpenSpaceSettings]);

  return (
    <View
      style={[
        styles.container,
        {
          paddingBottom: tabBarHeight,
          backgroundColor: theme.colors.surface1,
        },
      ]}
    >
      <Stack.Screen
        options={{
          title: channelName ? `# ${channelName}` : 'Channel',
          headerRight,
        }}
      />


      <SpaceChatArea
        spaceId={spaceId}
        channelId={channelId}
        spaceData={spaceData}
        channelsData={channelsData}
        membersData={membersData}
        memberMap={memberMap}
        isSpaceOwner={isSpaceOwner}
        hasPinPermission={hasPinPermission}
        hasDeletePermission={hasDeletePermission}
        onShowSidebars={handleShowSidebars}
        onUserPress={handleUserPress}
        onLinkPress={handleLinkPress}
        onOpenFarcasterCast={handleOpenFarcasterCast}
        onJoinSpaceFromLink={handleJoinSpaceFromLink}
        onOpenInviteModal={handleOpenInviteModal}
        onOpenSpaceSettings={handleOpenSpaceSettings}
        bookmarks={bookmarks}
        isBookmarked={isBookmarked}
        addBookmark={addBookmark}
        removeBookmark={removeBookmark}
        tabBarHeight={tabBarHeight}
        theme={theme}
        draftsRef={draftsRef}
        onChannelLinkPress={handleChannelLinkPress}
        isDMsSelected={false}
      />


      {selectedUserProfile && (
        <Suspense fallback={null}>
          <UserProfileModal
            visible
            onClose={() => setSelectedUserProfile(null)}
            user={selectedUserProfile}
            spaceId={spaceId}
            isSpaceOwner={isSpaceOwner}
            onOpenFarcasterProfile={({ fid, username }) => {
              setSelectedUserProfile(null);
              router.push({
                pathname: '/(tabs)/feed',
                params: {
                  profileFid: String(fid),
                  ...(username ? { profileUsername: username } : {}),
                },
              });
            }}
          />
        </Suspense>
      )}

      {inviteVisible && spaceId && (
        <Suspense fallback={null}>
          <InviteModal
            visible
            onClose={() => setInviteVisible(false)}
            spaceId={spaceId}
            spaceName={spaceData?.spaceName ?? 'Space'}
          />
        </Suspense>
      )}

      {settingsVisible && spaceId && (
        <Suspense fallback={null}>
          <SpaceSettingsModal
            visible
            onClose={() => setSettingsVisible(false)}
            spaceId={spaceId}
            onSpaceDeleted={() => {
              setSettingsVisible(false);
              router.back();
              router.back();
            }}
            onSpaceLeft={() => {
              setSettingsVisible(false);
              router.back();
              router.back();
            }}
          />
        </Suspense>
      )}

      {castThread && (
        <Suspense fallback={null}>
          <CastThreadModal
            visible
            onClose={() => setCastThread(null)}
            username={castThread.username}
            castHashPrefix={castThread.castHashPrefix}
          />
        </Suspense>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
});
