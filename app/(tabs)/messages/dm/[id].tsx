/**
 * DM chat screen — wraps DMChatArea with data hooks.
 */

import { DMChatArea, DMChatHeader, type MessageUserInfo } from '@/components/Chat';
import { FarcasterDirectMessageView } from '@/components/Chat/FarcasterDirectMessageView';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { useConversation } from '@/hooks/chat/useConversations';
import { useDMConversationSettings } from '@/hooks/chat/useDMConversationSettings';
import { useDMMute } from '@/hooks/chat/useDMMute';
import { useDeleteConversationSignal } from '@/hooks/chat/useDeleteConversationSignal';
import { useUnifiedConversations } from '@/hooks/chat/useUnifiedConversations';
import { useStorageAdapter } from '@/context/StorageContext';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@quilibrium/quorum-shared';
import type { Conversation } from '@quilibrium/quorum-shared';
import { useUserPublicProfile } from '@/hooks/useUserPublicProfile';
import { resolveConversationTitle } from '@/utils/conversationTitle';
import { useBookmarks, useReceiptSettings } from '@/hooks/useUserConfig';
import { useCall } from '@/context';
import { useMiniappOverlay } from '@/context/MiniappOverlayContext';
import { useTheme } from '@/theme';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useComposerPanelVisible } from '@/services/ui/composerPanelVisible';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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

// Dev-only "DM test burst" control (T2 of the transport-debugging tool
// suite). Gated at the require() itself, not just at render — `__DEV__`
// inlines to `false` in a release build, so this whole line reduces to
// `const DmBurstSheet = null` and the require() (and therefore every module
// it pulls in: DmBurstSheet.tsx, dmBurstPrefs, dmBurstRecorder) never
// executes. Mirrors services/crypto/initEnvelopeGuard.ts's lazy MMKV
// require, which exists for the same "must not run outside its gate" reason.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const DmBurstSheetModule = __DEV__ ? (require('@/components/dev/DmBurstSheet') as typeof import('@/components/dev/DmBurstSheet')) : null;
const DmBurstSheet = DmBurstSheetModule?.DmBurstSheet ?? null;

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
  const tabBarHeight = useBottomTabBarHeight();
  // The header is ours now, so we own the status-bar inset it used to get for
  // free from the native navigation bar.
  const insets = useSafeAreaInsets();
  // While the composer emoji panel is open the tab bar is hidden, so reclaim
  // its space: zero the bottom padding here and pass 0 chrome height to the
  // chat area so the panel extends to the screen bottom with no gap.
  const composerPanelOpen = useComposerPanelVisible();
  const effectiveChromeHeight = composerPanelOpen ? 0 : tabBarHeight;
  const containerStyle = useMemo(
    () => [
      styles.container,
      {
        // No paddingBottom — the chat area fills the full screen so messages
        // scroll behind the floating composer + tab bar (Telegram-style), the
        // same as the channel screen. The composer floats above the tab bar
        // (DMChatArea positions it at bottom: tabBarHeight) and the list pads
        // its content to clear it. effectiveChromeHeight is still passed to the
        // chat area so the composer floats at the right height.
        backgroundColor: theme.colors.surface1,
      },
    ],
    [theme.colors.surface1]
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
  const [burstVisible, setBurstVisible] = useState(false);

  const handleShowSidebars = useCallback(() => {
    // Normally pops back to the conversation list. The fallback matters: a DM
    // opened from a push-notification tap or a deep link may have no history
    // entry beneath it, and router.back() would then be a silent no-op leaving
    // the user stuck in the conversation.
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)/messages');
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

  // Dev-build-only entry for T2 (DM test burst) — see the desktop repo's
  // .agents/tasks/2026-07-29-transport-debug-workflow-and-tooling.md §2.
  const handleOpenDevBurst = useCallback(() => {
    setBurstVisible(true);
  }, []);

  // DM mute is config-backed (syncs across devices). `isMuted`/`toggleMute`
  // read straight from the local config (bookmark pattern), so no per-device
  // divergence.
  const { isMuted, toggleMute } = useDMMute();
  const conversationMuted = conversationId ? isMuted(conversationId) : false;
  const handleToggleMute = useCallback(() => {
    if (!conversationId) return;
    toggleMute(conversationId);
  }, [conversationId, toggleMute]);

  // Per-conversation settings live in UserConfig.conversationSettings, so they
  // sync across this user's devices (same carrier as mute). Writes persist
  // OVERRIDES ONLY: a value equal to the inherited global/default is written as
  // `undefined` so it keeps inheriting, which keeps the synced blob free of
  // default-valued entries and lets a later change to the global still apply.
  const { getOverride, saveOverrides, globalNonRepudiable } = useDMConversationSettings();
  const { deliveryReceipts: globalDeliveryReceipts, readReceipts: globalReadReceipts } =
    useReceiptSettings();

  // Dual-read while the one-time migration sweep may not have run yet: synced
  // override first, then the legacy field on the local Conversation record.
  const readSetting = useCallback(
    (key: 'isRepudiable' | 'saveEditHistory' | 'deliveryReceipts' | 'readReceipts') =>
      conversationId
        ? getOverride(conversationId, key) ?? conversation?.[key]
        : undefined,
    [conversationId, getOverride, conversation]
  );

  // Signing default comes from the global "always sign" preference (desktop's
  // UserConfig.nonRepudiable, default on), so an unset conversation follows it.
  const effectiveIsRepudiable = readSetting('isRepudiable') ?? !globalNonRepudiable;
  const effectiveSaveEditHistory = readSetting('saveEditHistory') ?? false;
  // Receipts stay raw (undefined = inherit) — the sheet renders `?? global` and
  // shows the "Reset to global" link only while an override exists.
  const conversationDeliveryReceipts = readSetting('deliveryReceipts');
  const conversationReadReceipts = readSetting('readReceipts');

  // The edit hooks (useEditDirectMessage) read this and, when off, drop prior
  // versions instead of accumulating — matching desktop (default false), so
  // only "on" is a genuine override worth storing.
  const handleToggleEditHistory = useCallback(
    (value: boolean) => {
      if (!conversationId) return;
      saveOverrides(conversationId, { saveEditHistory: value ? true : undefined });
    },
    [conversationId, saveOverrides]
  );

  // "Always sign messages" persists the inverse as isRepudiable. The send path
  // and composer lock read the effective value back. Stored only when it differs
  // from the global preference.
  const handleToggleRepudiable = useCallback(
    (value: boolean) => {
      if (!conversationId) return;
      saveOverrides(conversationId, {
        isRepudiable: value === !globalNonRepudiable ? undefined : value,
      });
    },
    [conversationId, saveOverrides, globalNonRepudiable]
  );

  // Per-conversation DM receipt override; effective value = override ?? global.
  // Delivery-off cascades read-off, matching desktop.
  const handleSetDeliveryReceipts = useCallback(
    (value: boolean) => {
      if (!conversationId) return;
      saveOverrides(
        conversationId,
        value ? { deliveryReceipts: true } : { deliveryReceipts: false, readReceipts: false }
      );
    },
    [conversationId, saveOverrides]
  );
  const handleSetReadReceipts = useCallback(
    (value: boolean) => {
      if (!conversationId) return;
      saveOverrides(conversationId, { readReceipts: value });
    },
    [conversationId, saveOverrides]
  );
  // Reset delivery override also clears read (read inherits when delivery does),
  // matching desktop; reset read clears read only. Clearing keeps an
  // empty-but-timestamped entry, which is what propagates the reset to the
  // user's other devices.
  const handleResetDelivery = useCallback(() => {
    if (!conversationId) return;
    saveOverrides(conversationId, { deliveryReceipts: undefined, readReceipts: undefined });
  }, [conversationId, saveOverrides]);
  const handleResetRead = useCallback(() => {
    if (!conversationId) return;
    saveOverrides(conversationId, { readReceipts: undefined });
  }, [conversationId, saveOverrides]);

  // The chat area reads signing off the conversation record it's handed, so
  // hand it the EFFECTIVE value (synced override → legacy local field → global).
  // Without this the composer lock and send path would still follow the stale
  // device-local field after a change made on another device.
  const conversationForChat = useMemo(() => {
    if (!conversation) return conversation;
    if (conversation.isRepudiable === effectiveIsRepudiable) return conversation;
    return { ...conversation, isRepudiable: effectiveIsRepudiable };
  }, [conversation, effectiveIsRepudiable]);

  // Delete this conversation. Like desktop, we FIRST signal the counterparty
  // (a `delete-conversation` control message) so they reset their encryption
  // session and the next message cleanly re-handshakes — they do NOT delete
  // their copy. Then we delete locally (DMs are E2E-encrypted; this only removes
  // it from this device). The confirm lives in DMSettingsSheet.
  const sendDeleteConversationSignal = useDeleteConversationSignal();
  const handleDeleteConversation = useCallback(async () => {
    if (!conversationId) return;
    // Best-effort signal first (Quorum DMs only — Farcaster has no such control
    // message and no recipientAddress). Failure must not block the local delete.
    if (recipientAddress && !isFarcasterConversation) {
      await sendDeleteConversationSignal(conversationId, recipientAddress);
    }
    await storage.deleteConversation(conversationId);
    queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all('direct') });
    router.back();
  }, [conversationId, recipientAddress, isFarcasterConversation, sendDeleteConversationSignal, storage, queryClient]);

  // Declared BEFORE the early returns so hooks run in the same order on every
  // render. Previously the title and header components sat below the
  // `if (!conversation) return ...` guards, which made the hook count jump
  // between the first render (no conversation) and the second (conversation
  // arrived) — React's hook-order check fires on exactly that.
  //
  // The same helper the inbox row uses, so the header and the list cannot call
  // the same partner two different things. The rule it applies — `displayName`
  // is a GLOBAL name, not a per-conversation override, because a DM cannot be
  // renamed — is documented there.
  //
  // `primary_username` comes straight from the fetched profile rather than
  // through the conversation row: `conversation` is a union whose base half does
  // not declare the field, and this is its only consumer.
  //
  // It sits above the call handlers because they name the person on the
  // ringing screen. Leaving it below meant their `useCallback` closed over a
  // title computed before the `.q` had arrived and, since their deps do not
  // include the public profile, never picked up the corrected one.
  const title = useMemo(
    () =>
      resolveConversationTitle({
        address: conversation?.address,
        displayName: conversation?.displayName,
        primary_username: recipientPublicProfile?.primary_username,
      }),
    [conversation?.address, conversation?.displayName, recipientPublicProfile?.primary_username],
  );

  const { initiateCall } = useCall();
  const handleCallPress = useCallback(() => {
    if (!conversationId || !recipientAddress || !conversation) return;
    initiateCall({
      conversationId,
      recipientAddress,
      recipientDisplayName: title,
      recipientAvatar: conversation.icon || '',
      mediaType: 'audio',
    });
  }, [conversationId, recipientAddress, conversation, title, initiateCall]);

  const handleVideoCallPress = useCallback(() => {
    if (!conversationId || !recipientAddress || !conversation) return;
    initiateCall({
      conversationId,
      recipientAddress,
      recipientDisplayName: title,
      recipientAvatar: conversation.icon || '',
      mediaType: 'video',
    });
  }, [conversationId, recipientAddress, conversation, title, initiateCall]);

  // Tapping the avatar or name in the header opens the same profile
  // modal that tapping a pfp inside the chat opens. Builds a minimal
  // MessageUserInfo from the conversation row + public-profile merge.
  const handleHeaderPress = useCallback(() => {
    if (!conversation || !conversation.address) return;
    setSelectedUserProfile({
      userId: conversation.address,
      // The resolved name, not the raw row. This one value reaches further
      // than it looks: the profile modal hands it straight to the kick, mute
      // and block confirmations, so a raw name here means those three
      // destructive dialogs name the person differently from every other
      // surface — including the header the user just tapped.
      userName: title,
      userAvatar: conversation.icon,
      // Forward Farcaster linkage from the conversation row so the
      // profile modal can render the linked-FC row. Without this the
      // header-tap path looked identical to a Farcaster-less profile
      // even on conversations where we have the FID and username.
      farcasterFid: conversation.farcasterFid,
      farcasterUsername: conversation.farcasterUsername,
    });
  }, [conversation, title]);

  // The bar is ours, not the navigation stack's — see ScreenHeader for why.
  // Each branch below still sets the route `title`, so anything reading it
  // (deep links, accessibility) gets a meaningful value even though nothing
  // renders it.
  const dmHeader = conversation ? (
    <DMChatHeader
      title={title}
      icon={conversation.icon}
      address={conversation.address || ''}
      insetTop={insets.top}
      onBack={handleShowSidebars}
      onTitlePress={handleHeaderPress}
      isFarcasterConversation={isFarcasterConversation}
      onVideoCall={handleVideoCallPress}
      onAudioCall={handleCallPress}
      onOpenSettings={() => setSettingsVisible(true)}
      onDevBurst={__DEV__ ? handleOpenDevBurst : undefined}
      theme={theme}
    />
  ) : null;

  if (!conversationId) {
    return (
      <View style={containerStyle}>
        <Stack.Screen options={{ headerShown: false, title: 'Chat' }} />
        <ScreenHeader title="Chat" insetTop={insets.top} onBack={handleShowSidebars} theme={theme} />
      </View>
    );
  }

  if (!conversation) {
    return (
      <View style={containerStyle}>
        <Stack.Screen options={{ headerShown: false, title: 'Chat' }} />
        <ScreenHeader title="Chat" insetTop={insets.top} onBack={handleShowSidebars} theme={theme} />
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
        <Stack.Screen options={{ headerShown: false, title }} />
        {dmHeader}
        <FarcasterDirectMessageView
          conversation={conversation}
          onBack={handleShowSidebars}
          theme={theme}
          onOpenFarcasterCast={handleOpenFarcasterCast}
          onLinkPress={handleLinkPress}
          bottomInset={0}
          tabBarHeight={effectiveChromeHeight}
          restingChromeHeight={tabBarHeight}
        />

      </View>
    );
  }

  return (
    <View style={containerStyle}>
      <Stack.Screen options={{ headerShown: false, title }} />
      {dmHeader}

      <DMChatArea
        conversationId={conversationId}
        conversationData={conversationForChat ?? conversation}
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
        tabBarHeight={effectiveChromeHeight}
        restingChromeHeight={tabBarHeight}
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
            isRepudiable={effectiveIsRepudiable}
            onToggleRepudiable={handleToggleRepudiable}
            saveEditHistory={effectiveSaveEditHistory}
            onToggleEditHistory={handleToggleEditHistory}
            isMuted={conversationMuted}
            onToggleMute={handleToggleMute}
            deliveryReceipts={conversationDeliveryReceipts}
            readReceipts={conversationReadReceipts}
            globalDeliveryReceipts={globalDeliveryReceipts}
            globalReadReceipts={globalReadReceipts}
            onSetDeliveryReceipts={handleSetDeliveryReceipts}
            onSetReadReceipts={handleSetReadReceipts}
            onResetDelivery={handleResetDelivery}
            onResetRead={handleResetRead}
          />
        </Suspense>
      )}

      {__DEV__ && DmBurstSheet && burstVisible && recipientAddress && (
        <DmBurstSheet
          visible
          onClose={() => setBurstVisible(false)}
          conversationId={conversationId}
          recipientAddress={recipientAddress}
          isRepudiable={effectiveIsRepudiable}
          theme={theme}
        />
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
}));
