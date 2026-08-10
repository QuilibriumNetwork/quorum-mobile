/**
 * Space chat screen — wraps SpaceChatArea with data hooks.
 */

import { ChannelHeader, SpaceChatArea, type MemberMap, type MessageUserInfo } from '@/components/Chat';
import { useAuth } from '@/context/AuthContext';
import { useOpenLink } from '@/hooks/useOpenLink';
import { useChannels } from '@/hooks/chat/useChannels';
import { useHasPermission, useRoles } from '@/hooks/chat/useRoleManagement';
import { setActiveChannel, clearActiveChannel } from '@/hooks/chat/useReplyTracking';
import { markChannelMentionsRead } from '@/services/notifications/mentionReplyLog';
import { useStartDirectMessage } from '@/hooks/chat/useStartDirectMessage';
import { useBlockUser } from '@/hooks/chat/useBlockUser';
import { useSpace, useSpaceMembers } from '@/hooks/chat/useSpaces';
import { useBookmarks } from '@/hooks/useUserConfig';
import { getSpaceKey } from '@/services/config/spaceStorage';
import { useTheme } from '@/theme';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useComposerPanelVisible } from '@/services/ui/composerPanelVisible';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useWebSocket, useSpaceCall } from '@/context';
import { useQueryClient } from '@tanstack/react-query';
import { canManageReadOnlyChannel, logger, queryKeys, type Message } from '@quilibrium/quorum-shared';
import { createSpaceCallId, sendSpaceCallStartMessage } from '@/services/space/spaceMessageService';
import { useToast } from '@/context/ToastContext';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

// Prefetch helpers: warm the lazy chunks in the background after the screen
// mounts so the first tap on the gear / invite / a profile opens instantly
// instead of waiting on the on-demand import. SpaceSettingsModal in particular
// is a large component, so warming it removes a noticeable first-open delay.
const importUserProfileModal = () => import('@/components/UserProfileModal');
const importInviteModal = () => import('@/components/InviteModal');
const importSpaceSettingsModal = () => import('@/components/SpaceSettingsModal');

const UserProfileModal = React.lazy(importUserProfileModal);
const InviteModal = React.lazy(importInviteModal);
const SpaceSettingsModal = React.lazy(importSpaceSettingsModal);
const CastThreadModal = React.lazy(() => import('@/components/CastThreadModal'));

export default function SpaceChannelChat() {
  const params = useLocalSearchParams<{ id: string; channelId: string }>();
  const spaceId = typeof params.id === 'string' ? params.id : undefined;
  const channelId = typeof params.channelId === 'string' ? params.channelId : undefined;

  // Warm the lazy modal chunks in the background once the screen is open so the
  // first open of space settings / invite / a profile is instant.
  useEffect(() => {
    void importSpaceSettingsModal();
    void importUserProfileModal();
    void importInviteModal();
  }, []);

  const { theme } = useTheme();
  const { user } = useAuth();
  const { enqueueOutbound, isConnected } = useWebSocket();
  const tabBarHeight = useBottomTabBarHeight();
  // The header is ours now, so we own the status-bar inset it used to get for
  // free from the native navigation bar.
  const insets = useSafeAreaInsets();
  // While the composer emoji panel is open the tab bar is hidden, so reclaim
  // its space (zero padding + 0 chrome height) and let the panel reach the
  // screen bottom.
  const composerPanelOpen = useComposerPanelVisible();
  const effectiveChromeHeight = composerPanelOpen ? 0 : tabBarHeight;

  const { data: spaceData } = useSpace(spaceId, { enabled: !!spaceId });
  const { data: membersData } = useSpaceMembers(spaceId, { enabled: !!spaceId });
  const { data: channelsData } = useChannels(spaceId, { enabled: !!spaceId });

  const { bookmarks, addBookmark, removeBookmark, isBookmarked } = useBookmarks();
  const startDirectMessage = useStartDirectMessage();
  const { toggleBlockUser, isUserBlocked } = useBlockUser(spaceId);

  const isSpaceOwner = useMemo(() => {
    if (!spaceId) return false;
    return !!getSpaceKey(spaceId, 'owner');
  }, [spaceId]);

  // Pin/delete permissions: regular channels use the role permission; read-only
  // channels ALSO grant pin/delete to managers (a role in managerRoleIds) —
  // matching desktop + the shared checker + the receive-side guard in
  // WebSocketContext. Previously mobile only checked the role permission and
  // wrongly hid pin/delete from read-only-channel managers.
  // NOTE: `isSpaceOwner` is NOT used here — receivers can't verify ownership
  // (no ownerAddress on the wire), so the receive-side guard would drop an
  // owner's pin/delete unless they hold a role granting it. `isSpaceOwner`
  // stays for owner-only UI (invite, settings entry) only.
  const roleCanPin = useHasPermission(spaceId, user?.address, 'message:pin');
  const roleCanDelete = useHasPermission(spaceId, user?.address, 'message:delete');

  // The space's roles, passed to UserProfileModal so the owner can assign /
  // remove roles from a member's profile (tapped from a message avatar).
  // Without this prop the modal's role section never renders.
  const { data: roles } = useRoles(spaceId);

  // The current channel object (not just its name). Read-only channels need
  // isReadOnly + managerRoleIds to gate posting.
  const currentChannel = useMemo(() => {
    if (!channelsData || !channelId) return undefined;
    return channelsData.find((c) => c.channelId === channelId);
  }, [channelsData, channelId]);

  // Read-only channel manager status: true iff the channel is read-only AND
  // the user holds a role in managerRoleIds. Used to extend pin/delete to
  // managers in read-only channels (matching desktop + the shared checker).
  const isReadOnlyManager = useMemo(() => {
    if (!currentChannel?.isReadOnly || !user?.address) return false;
    return canManageReadOnlyChannel(user.address, false, spaceData ?? undefined, currentChannel);
  }, [currentChannel, spaceData, user?.address]);

  // Read-only channels: managers get pin/delete. Regular channels: role permission.
  const hasPinPermission = currentChannel?.isReadOnly ? isReadOnlyManager : roleCanPin;
  const hasDeletePermission = currentChannel?.isReadOnly ? isReadOnlyManager : roleCanDelete;

  // Can the current user post here? Regular channels: always. Read-only
  // channels: only managers (a role in managerRoleIds). No owner bypass —
  // receivers can't verify ownership, so owners must hold a manager role,
  // matching desktop + the receive-side guard in WebSocketContext.
  const canPost = useMemo(() => {
    if (!currentChannel?.isReadOnly) return true;
    if (!user?.address) return false;
    return canManageReadOnlyChannel(user.address, false, spaceData ?? undefined, currentChannel);
  }, [currentChannel, spaceData, user?.address]);

  const memberMap = useMemo<MemberMap>(() => {
    if (!membersData) return {};
    return membersData.reduce((acc: MemberMap, m) => {
      acc[m.address] = m;
      return acc;
    }, {} as MemberMap);
  }, [membersData]);

  const draftsRef = useRef<Map<string, string>>(new Map());

  // Mentions/replies bubble (Level 2 of the two-level read-state model):
  // mark this channel read on open so its per-space bubble clears, and mark it
  // the active channel so mentions that LAND while we're viewing are also kept
  // read (the WS writer re-marks the active channel — see logMentionOrReply).
  React.useEffect(() => {
    if (!spaceId || !channelId) return;
    markChannelMentionsRead(spaceId, channelId);
    setActiveChannel(spaceId, channelId);
    return () => clearActiveChannel(spaceId, channelId);
  }, [spaceId, channelId]);

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

  // Overlay state — links and miniapps go through the global overlay (a single
  // BrowserModal lives at the tabs layout, preserving WebView state
  // across minimize/restore).
  const [selectedUserProfile, setSelectedUserProfile] = useState<MessageUserInfo | null>(null);
  const [inviteVisible, setInviteVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [castThread, setCastThread] = useState<{ username: string; castHashPrefix: string } | null>(null);
  // Starting a call now blocks on the join, which takes seconds (relay circuit,
  // SFU round trip, microphone permission) and shows no UI of its own until the
  // call screen appears. Without this the header buttons look dead and invite
  // exactly the repeat taps the duplicate-join guard then has to absorb.
  const [startingCall, setStartingCall] = useState(false);
  const startingCallRef = useRef(false);

  const handleShowSidebars = useCallback(() => {
    // Normally this pops back to the space's channel list. The fallback matters:
    // if this screen was reached without a history entry beneath it (a push
    // notification tap, a deep link, a channel link followed by a replace),
    // router.back() is a no-op and the user is stranded in the channel with no
    // way out but force-quitting. Route to the channel list explicitly instead.
    if (router.canGoBack()) {
      router.back();
      return;
    }
    if (spaceId) router.replace(`/spaces/${spaceId}`);
  }, [spaceId]);

  const handleUserPress = useCallback((info: MessageUserInfo) => {
    setSelectedUserProfile(info);
  }, []);

  // Routes YouTube out to the native app and everything else into the in-app
  // browser in link mode. Shared with DMs so the two cannot drift apart.
  const handleLinkPress = useOpenLink();

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

  const channelName = currentChannel?.channelName ?? 'Channel';

  const queryClient = useQueryClient();
  const { joinCall: joinSpaceCall } = useSpaceCall();
  const { showToast } = useToast();

  /**
   * Start a call: JOIN FIRST, announce second.
   *
   * The `space-call-start` message is not a notification about the call, it IS
   * the channel's call banner — every member renders a joinable "call in
   * progress" from it. Sending it before knowing the room came up (which is
   * what this did) meant a failed join left a banner with no matching
   * `space-call-end`, live-looking and unjoinable, for everyone, forever.
   * Announcing only after the join succeeds makes a failure cost nothing but a
   * toast.
   */
  const startSpaceCall = useCallback(async (mediaType: 'audio' | 'video') => {
    if (!spaceId || !channelId || !user?.address) return;
    if (!isConnected) {
      showToast({
        type: 'error',
        title: 'Not connected',
        message: 'Please wait for the connection to be established.',
      });
      return;
    }
    if (startingCallRef.current) return;
    startingCallRef.current = true;
    setStartingCall(true);

    const callId = createSpaceCallId(user.address);
    try {
      const joined = await joinSpaceCall(callId, spaceId, channelId, mediaType === 'video');
      // `false` means the join was declined as a duplicate, so there is no
      // call under this id — announcing it would mint exactly the orphan
      // banner this ordering exists to prevent.
      if (!joined) return;
    } catch (e) {
      logger.debug('[SpaceCall] start failed:', e);
      showToast({
        type: 'error',
        title: 'Could not start the call',
        message: 'The call service could not be reached. Please try again.',
      });
      return;
    } finally {
      startingCallRef.current = false;
      setStartingCall(false);
    }

    try {
      const result = await sendSpaceCallStartMessage({
        spaceId, channelId, senderAddress: user.address, mediaType, callId,
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
    } catch (e) {
      // We are in the call, but the channel was never told. Non-destructive on
      // purpose: hanging up a working call because its announcement failed
      // would be a worse outcome than a call others cannot see.
      logger.debug('[SpaceCall] start announcement failed:', e);
      showToast({
        type: 'info',
        title: 'You are in the call',
        message: 'Others may not see it in the channel.',
      });
    }
  }, [spaceId, channelId, user?.address, isConnected, enqueueOutbound, queryClient, joinSpaceCall, showToast]);

  const handleStartVideoCall = useCallback(() => { void startSpaceCall('video'); }, [startSpaceCall]);
  const handleStartAudioCall = useCallback(() => { void startSpaceCall('audio'); }, [startSpaceCall]);

  return (
    <View
      style={[
        styles.container,
        {
          // No paddingBottom — the chat area fills the full screen so messages
          // scroll behind the floating composer + tab bar (Telegram-style). The
          // composer floats above the tab bar and the list pads its content to
          // clear it. effectiveChromeHeight is still passed to the chat area so
          // the composer floats at the right height and the list pads correctly.
          backgroundColor: theme.colors.surface1,
        },
      ]}
    >
      {/*
        The bar is ours, not the navigation stack's — see ChannelHeader for why.
        The screen keeps `title` set so anything that reads the route's title
        (deep links, accessibility, the space screen's own back affordance)
        still gets a meaningful value even though nothing renders it here.
      */}
      <Stack.Screen
        options={{
          headerShown: false,
          title: channelName ? `# ${channelName}` : 'Channel',
        }}
      />

      <ChannelHeader
        channelName={channelName}
        insetTop={insets.top}
        onBack={handleShowSidebars}
        onStartVideoCall={handleStartVideoCall}
        onStartAudioCall={handleStartAudioCall}
        startingCall={startingCall}
        onInvite={isSpaceOwner ? handleOpenInviteModal : undefined}
        onOpenSettings={handleOpenSpaceSettings}
        theme={theme}
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
        canPost={canPost}
        isReadOnlyChannel={!!currentChannel?.isReadOnly}
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
        tabBarHeight={effectiveChromeHeight}
        restingChromeHeight={tabBarHeight}
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
            channelId={channelId}
            roles={roles}
            isSpaceOwner={isSpaceOwner}
            onStartDM={(userId) => {
              setSelectedUserProfile(null);
              startDirectMessage(userId);
            }}
            onBlockUser={(userId) => toggleBlockUser(userId)}
            isUserBlocked={isUserBlocked(selectedUserProfile.userId)}
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

const styles = createSkinnable(() => StyleSheet.create({
  container: {
    flex: 1,
  },
}));
