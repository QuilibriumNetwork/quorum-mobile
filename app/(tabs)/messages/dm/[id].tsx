/**
 * DM chat screen — wraps DMChatArea with data hooks.
 */

import { DMChatArea, type MessageUserInfo } from '@/components/Chat';
import { FarcasterDirectMessageView } from '@/components/Chat/FarcasterDirectMessageView';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useConversation } from '@/hooks/chat/useConversations';
import { useUnifiedConversations } from '@/hooks/chat/useUnifiedConversations';
import { useStorageAdapter } from '@/context/StorageContext';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@quilibrium/quorum-shared';
import type { Conversation } from '@quilibrium/quorum-shared';
import { useUserPublicProfile } from '@/hooks/useUserPublicProfile';
import { useBookmarks } from '@/hooks/useUserConfig';
import { useCall } from '@/context';
import { useMiniappOverlay } from '@/context/MiniappOverlayContext';
import { truncateAddress } from '@/utils/formatAddress';
import { useTheme } from '@/theme';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

// Prefetch helpers: warm the lazy chunks in the background after the screen
// mounts so the first tap on the info icon / a profile opens instantly instead
// of waiting on the on-demand import. Paths are declared once and reused by both
// React.lazy() and the prefetch so they can't drift.
const importUserProfileModal = () => import('@/components/UserProfileModal');
const importDMSettingsSheet = () => import('@/components/Chat/DMSettingsSheet');

const UserProfileModal = React.lazy(importUserProfileModal);
const DMSettingsSheet = React.lazy(() =>
  importDMSettingsSheet().then((m) => ({ default: m.DMSettingsSheet }))
);

export default function DMChatScreen() {
  const params = useLocalSearchParams<{
    id: string;
    // Optional seed for opening a Farcaster DM with someone not yet in the
    // conversation list (e.g. from a profile "Message" button).
    fcFid?: string;
    fcUsername?: string;
    fcDisplayName?: string;
    fcPfp?: string;
  }>();
  const conversationId = typeof params.id === 'string' ? decodeURIComponent(params.id) : undefined;

  // Warm the lazy modal chunks in the background once the screen is open so the
  // first open of the info sheet / a profile is instant (no on-demand import wait).
  useEffect(() => {
    void importDMSettingsSheet();
    void importUserProfileModal();
  }, []);

  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const containerStyle = useMemo(
    () => [
      styles.container,
      {
        paddingBottom: tabBarHeight,
        backgroundColor: theme.colors.surface1,
      },
    ],
    [tabBarHeight, theme.colors.surface1]
  );

  // Grab the conversation from unified conversations first (has richest data)
  const { conversations } = useUnifiedConversations();
  const conversationFromList = useMemo(
    () => conversations.find((c) => c.conversationId === conversationId),
    [conversations, conversationId]
  );

  const isFarcasterConversation = conversationId?.startsWith('farcaster:') ?? false;

  // Fall back to local storage if not yet in unified list
  const { data: conversationFromStorage } = useConversation(conversationId, {
    enabled: !!conversationId && !isFarcasterConversation && !conversationFromList,
  });

  // When opening a Farcaster DM with someone we've never messaged, the
  // conversation won't be in the list/storage yet. Synthesize a minimal one
  // from the route seed + derived conversation id so the composer can send
  // the first message (which creates it server-side).
  const syntheticFarcasterConversation = useMemo<Conversation | undefined>(() => {
    if (!isFarcasterConversation || conversationFromList || !conversationId) return undefined;
    const fcFid = params.fcFid ? parseInt(params.fcFid, 10) : NaN;
    if (!Number.isFinite(fcFid)) return undefined;
    return {
      conversationId,
      type: 'direct',
      timestamp: Date.now(),
      address: `fid:${fcFid}`,
      icon: params.fcPfp || '',
      displayName: params.fcDisplayName || (params.fcUsername ? `@${params.fcUsername}` : `fid:${fcFid}`),
      source: 'farcaster',
      farcasterConversationId: conversationId.slice('farcaster:'.length),
      farcasterFid: fcFid,
      farcasterUsername: params.fcUsername || undefined,
      farcasterParticipantFids: [fcFid],
      unreadCount: 0,
    } as Conversation;
  }, [isFarcasterConversation, conversationFromList, conversationId, params.fcFid, params.fcUsername, params.fcDisplayName, params.fcPfp]);

  const conversationBase = conversationFromList ?? conversationFromStorage ?? syntheticFarcasterConversation;

  const recipientAddress = useMemo(() => {
    if (!conversationId || isFarcasterConversation) return undefined;
    return conversationId.split('/')[0];
  }, [conversationId, isFarcasterConversation]);

  // Fetch the recipient's public profile for back-fill. DMChatArea's
  // member map already does this, but the screen-level header needs it
  // independently — the recipient might not be in any space member
  // list yet, and the local Conversation row often has an empty
  // displayName/icon if no message has been received yet.
  const recipientPublicProfile = useUserPublicProfile(recipientAddress, {
    enabled: !!recipientAddress && !isFarcasterConversation,
  }).data;

  // Merge: public profile fills gaps left by the local conversation row.
  // Preference order favors the LOCAL row (manually entered display
  // name, chat-broadcasted profile updates) over the public profile;
  // public profile is used only when the local fields are empty.
  const conversation = useMemo(() => {
    if (!conversationBase) return conversationBase;
    if (!recipientPublicProfile) return conversationBase;
    return {
      ...conversationBase,
      displayName: conversationBase.displayName || recipientPublicProfile.display_name,
      icon: conversationBase.icon || recipientPublicProfile.profile_image,
    };
  }, [conversationBase, recipientPublicProfile]);

  const { bookmarks, addBookmark, removeBookmark, isBookmarked } = useBookmarks();

  const storage = useStorageAdapter();
  const queryClient = useQueryClient();

  const draftsRef = useRef<Map<string, string>>(new Map());

  const { openMiniapp } = useMiniappOverlay();
  const [selectedUserProfile, setSelectedUserProfile] = useState<MessageUserInfo | null>(null);
  const [settingsVisible, setSettingsVisible] = useState(false);

  const handleShowSidebars = useCallback(() => {
    router.back();
  }, []);

  const handleUserPress = useCallback((info: MessageUserInfo) => {
    // For an avatar tap in a DM, MessagesList has no `members` prop to
    // draw Farcaster linkage from (it's space-only), so anything other
    // than the basics arrives undefined. When the tapped user is the
    // counterparty of THIS conversation, enrich from the conversation
    // record itself (Farcaster DMs always carry these; Quorum DMs may
    // have them populated via the peer's public profile / registration).
    if (
      conversation &&
      conversation.address &&
      info.userId === conversation.address &&
      (info.farcasterFid === undefined || !info.farcasterUsername)
    ) {
      setSelectedUserProfile({
        ...info,
        farcasterFid: info.farcasterFid ?? conversation.farcasterFid,
        farcasterUsername: info.farcasterUsername ?? conversation.farcasterUsername,
      });
      return;
    }
    setSelectedUserProfile(info);
  }, [conversation]);

  const handleLinkPress = useCallback((url: string) => {
    // Chat-link URLs are user-provided and may target LAN dev hosts, so
    // pass `allowInsecureLAN` to keep dev-time previews working.
    openMiniapp({ url, isQNative: false, allowInsecureLAN: true });
  }, [openMiniapp]);

  const handleOpenFarcasterCast = useCallback((username: string, castHashPrefix: string) => {
    router.push({ pathname: '/feed', params: { username, castHashPrefix } });
  }, []);

  const handleJoinSpaceFromLink = useCallback((spaceId: string, channelId: string) => {
    router.push(`/spaces/${spaceId}/${channelId}`);
  }, []);

  const handleOpenDmSettings = useCallback(() => {
    setSettingsVisible(true);
  }, []);

  // Delete this conversation locally (DMs are E2E-encrypted, so this only
  // removes it from this device). The confirm lives in DMSettingsSheet; this
  // is the previously-unwired effect. Refresh the conversation list and leave
  // the now-deleted screen.
  const handleDeleteConversation = useCallback(async () => {
    if (!conversationId) return;
    await storage.deleteConversation(conversationId);
    queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all('direct') });
    router.back();
  }, [conversationId, storage, queryClient]);

  const { initiateCall } = useCall();
  const handleCallPress = useCallback(() => {
    if (!conversationId || !recipientAddress || !conversation) return;
    initiateCall({
      conversationId,
      recipientAddress,
      recipientDisplayName: conversation.displayName || recipientAddress.slice(0, 12),
      recipientAvatar: conversation.icon || '',
      mediaType: 'audio',
    });
  }, [conversationId, recipientAddress, conversation, initiateCall]);

  const handleVideoCallPress = useCallback(() => {
    if (!conversationId || !recipientAddress || !conversation) return;
    initiateCall({
      conversationId,
      recipientAddress,
      recipientDisplayName: conversation.displayName || recipientAddress.slice(0, 12),
      recipientAvatar: conversation.icon || '',
      mediaType: 'video',
    });
  }, [conversationId, recipientAddress, conversation, initiateCall]);

  // Title + header components are declared BEFORE the early returns so
  // their hooks run in the same order on every render. Previously these
  // sat below the `if (!conversation) return ...` guards, which made
  // the hook count jump between the first render (no conversation, 59
  // hooks) and the second (conversation arrived, 61 hooks). React's
  // hook-order check fires that exact path.
  const title =
    conversation?.displayName ||
    (conversation?.address ? truncateAddress(conversation.address, 'long') : 'Conversation');

  const headerRight = useCallback(() => (
    <View style={styles.headerRight}>
      {!isFarcasterConversation && (
        <>
          <TouchableOpacity onPress={handleVideoCallPress} hitSlop={8}>
            <IconSymbol name="video" color={theme.colors.primary} size={20} />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleCallPress} hitSlop={8}>
            <IconSymbol name="phone" color={theme.colors.primary} size={20} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setSettingsVisible(true)} hitSlop={8}>
            <IconSymbol name="info.circle" color={theme.colors.primary} size={20} />
          </TouchableOpacity>
        </>
      )}
    </View>
  ), [theme, isFarcasterConversation, handleVideoCallPress, handleCallPress]);

  // Tapping the avatar or name in the header opens the same profile
  // modal that tapping a pfp inside the chat opens. Builds a minimal
  // MessageUserInfo from the conversation row + public-profile merge.
  const handleHeaderPress = useCallback(() => {
    if (!conversation || !conversation.address) return;
    setSelectedUserProfile({
      userId: conversation.address,
      userName: conversation.displayName || conversation.address.slice(0, 12),
      userAvatar: conversation.icon,
      // Forward Farcaster linkage from the conversation row so the
      // profile modal can render the linked-FC row. Without this the
      // header-tap path looked identical to a Farcaster-less profile
      // even on conversations where we have the FID and username.
      farcasterFid: conversation.farcasterFid,
      farcasterUsername: conversation.farcasterUsername,
    });
  }, [conversation]);

  const headerTitle = useCallback(() => {
    if (!conversation) return null;
    return (
      <TouchableOpacity
        onPress={handleHeaderPress}
        activeOpacity={0.7}
        hitSlop={8}
        style={styles.headerTitle}
        accessibilityLabel={`Open ${title}'s profile`}
      >
        {conversation.icon ? (
          <Image source={{ uri: conversation.icon }} style={styles.headerAvatar} />
        ) : (
          <DefaultAvatar displayName={title} address={conversation.address || ''} size={28} />
        )}
        <Text style={[styles.headerName, { color: theme.colors.textMain }]} numberOfLines={1}>
          {title}
        </Text>
      </TouchableOpacity>
    );
  }, [conversation, title, theme, handleHeaderPress]);

  if (!conversationId) {
    return (
      <View style={containerStyle}>
        <Stack.Screen options={{ title: 'Chat' }} />
      </View>
    );
  }

  if (!conversation) {
    return (
      <View style={containerStyle}>
        <Stack.Screen options={{ title: 'Loading...' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  // Farcaster DM gets its own specialized view
  if (isFarcasterConversation) {
    return (
      <View style={containerStyle}>
        <Stack.Screen options={{ title, headerTitle, headerRight }} />
        <FarcasterDirectMessageView
          conversation={conversation}
          onBack={handleShowSidebars}
          theme={theme}
          onOpenFarcasterCast={handleOpenFarcasterCast}
          onLinkPress={handleLinkPress}
          bottomInset={0}
          tabBarHeight={tabBarHeight}
        />

      </View>
    );
  }

  return (
    <View style={containerStyle}>
      <Stack.Screen options={{ title, headerTitle, headerRight }} />

      <DMChatArea
        conversationId={conversationId}
        conversationData={conversation}
        isFarcasterConversation={false}
        recipientAddress={recipientAddress}
        onShowSidebars={handleShowSidebars}
        onUserPress={handleUserPress}
        onLinkPress={handleLinkPress}
        onOpenFarcasterCast={handleOpenFarcasterCast}
        onJoinSpaceFromLink={handleJoinSpaceFromLink}
        onOpenDmSettings={handleOpenDmSettings}
        onCallPress={handleCallPress}
        onVideoCallPress={handleVideoCallPress}
        bookmarks={bookmarks}
        isBookmarked={isBookmarked}
        addBookmark={addBookmark}
        removeBookmark={removeBookmark}
        tabBarHeight={tabBarHeight}
        theme={theme}
        draftsRef={draftsRef}
      />


      {selectedUserProfile && (
        <Suspense fallback={null}>
          <UserProfileModal
            visible
            onClose={() => setSelectedUserProfile(null)}
            user={selectedUserProfile}
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

      {settingsVisible && (
        <Suspense fallback={null}>
          <DMSettingsSheet
            visible
            onClose={() => setSettingsVisible(false)}
            conversationId={conversationId}
            displayName={title}
            theme={theme}
            onDeleteConversation={handleDeleteConversation}
            isRepudiable={conversation.isRepudiable}
            saveEditHistory={conversation.saveEditHistory}
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
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(8),
  },
  headerAvatar: {
    width: 28,
    height: 28,
    borderRadius: Skin.radius(14),
  },
  headerName: {
    fontSize: Skin.font(17),
    fontWeight: '600',
    maxWidth: 180,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(16),
  },
}));
