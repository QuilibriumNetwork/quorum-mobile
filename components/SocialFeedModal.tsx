import { useMiniappOverlay } from '@/context/MiniappOverlayContext';
import ComposeChannelPickerModal from '@/components/ComposeChannelPickerModal';
import { HeaderAvatar } from '@/components/HeaderAvatar';
import { InviteLinkCard, containsInviteLink } from '@/components/Chat/InviteLinkCard';
import type { ComposeCastOptions, ComposeCastResult } from '@/services/miniapp';
import { AudioSpaceEmbed } from '@/components/SocialFeed/content/AudioSpaceEmbed';
import { LiveSpacesStrip } from '@/components/SocialFeed/content/LiveSpacesStrip';
import { FarcasterTokenEmbed } from '@/components/SocialFeed/content/FarcasterTokenEmbed';
import { LikeIcon, getLikeIconType } from '@/components/SocialFeed/content/LikeIcon';
import { SnapIcon } from '@/components/SocialFeed/content/SnapIcon';
import TipModal, { type TipTarget } from '@/components/wallet/TipModal';
import { ActionSheet, type ActionRowItem } from '@/components/shared/ActionSheet';
import { ActionRow, ActionRowGroup } from '@/components/shared/ActionRow';
import { useMiniappManifest } from '@/hooks/useMiniappManifest';
import { useOgMetadata } from '@/hooks/useOgMetadata';
import { SnapEmbed, useSnapDetection } from '@/components/SocialFeed/content/SnapEmbed';
import { AutoHeightImage } from '@/components/SocialFeed/media/AutoHeightImage';
import { ImageViewer } from '@/components/SocialFeed/media/ImageViewer';
import { VideoViewer } from '@/components/SocialFeed/media/VideoViewer';
import { extractYouTubeMatchesFromText, YouTubeEmbed, parseYouTubeUrl } from '@/components/SocialFeed/media/YouTubeEmbed';
import { MentionAutocomplete, getMentionInfo, replaceMention, type MentionInfo } from '@/components/SocialFeed/MentionAutocomplete';
import { GovernanceView, ProposalDetailView } from '@/components/SocialFeed/views';
import { ProposalVoteBlock } from '@/components/SocialFeed/views/ProposalVoteBlock';
import { useHegemonyGovernance } from '@/hooks/useHegemonyGovernance';
import type { ChannelCast as GovernanceChannelCast, CastReply as GovernanceCastReply } from '@/services/governance/governanceClient';
import { parseVote as parseGovernanceVote } from '@/services/governance/governanceClient';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { ApexAvatarRing } from '@/components/ui/ApexAvatarRing';
import { useApexStatusForFids } from '@/hooks/useApex';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { SpaceIcon } from '@/components/ui/SpaceIcon';
import { useAuth } from '@/context/AuthContext';
import { useConversations, type ConversationWithPreview } from '@/hooks/chat/useConversations';
import { useFarcasterConversations, useSendFarcasterDirectCast } from '@/hooks/chat/useFarcasterDirectCasts';
import { useSendDirectMessage } from '@/hooks/chat/useSendDirectMessage';
import { useSendSpaceMessage } from '@/hooks/chat/useSendSpaceMessage';
import { useSpaces } from '@/hooks/chat/useSpaces';
import { useFarcasterChannel, type ChannelCast } from '@/hooks/useFarcasterChannel';
import { useFarcasterFeed, type EmbeddedCast } from '@/hooks/useFarcasterFeed';
import { useBlockedFids } from '@/hooks/useBlockedFids';
import { useMutedFids } from '@/hooks/useMutedFids';
import { ProfileOverflowButton } from '@/components/SocialFeed/ProfileOverflowButton';
import { CastOverflowButton } from '@/components/SocialFeed/CastOverflowButton';
import { Translatable } from '@/components/translation/Translatable';
import { useSurface } from '@/theme/skins/surfaces';
import { ProfileActionButtons } from '@/components/SocialFeed/ProfileActionButtons';
import { useFarcasterProfile, type ProfileCast } from '@/hooks/useFarcasterProfile';
import {
  useDebouncedValue,
  useSearchCasts,
  useSearchChannels,
  useSearchSummary,
  useSearchUsers,
  useUserFollowedChannels,
  type SearchCast,
  type SearchChannel,
  type SearchUser,
} from '@/hooks/useFarcasterSearch';
import { parseFarcasterUrl, useFarcasterThread, type FlattenedCast } from '@/hooks/useFarcasterThread';
import { useFarcasterCastLimits, isLongCast } from '@/hooks/useFarcasterPro';
import { followUser, likeCast, recastCast, unlikeCast, unrecastCast, uploadImageForCast } from '@/services/farcasterClient';
import { useFarcasterSubmitCast } from '@/hooks/useFarcasterSubmitCast';
import { useFeedOptimistic } from '@/context/FeedOptimisticContext';
import type { PendingCast } from '@/services/feed/optimisticFeedStore';
import { uploadVideoForCast } from '@/services/farcaster/videoUpload';
import { pickMedia, type ProcessedAttachment } from '@/services/media/imageAttachment';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import {
  logger,
  useFarcasterCast,
  useFarcasterCastByUrl,
  useFarcasterChannelByParentUrl,
  type Channel,
  type NormalizedCast,
  type Space,
} from '@quilibrium/quorum-shared';
import { useQueryClient } from '@tanstack/react-query';
import { useFarcasterUserPersistent } from '@/hooks/useFarcasterUserPersistent';
import { useFarcasterUsersPrefetch } from '@/hooks/useFarcasterUsersPrefetch';
import { useVideoPlayer, VideoView } from 'expo-video';
import { setAudioModeAsync } from 'expo-audio';
import { Image as ExpoImage } from 'expo-image';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, BackHandler, Dimensions, Image, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, TextInput, View, type KeyboardEvent, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import ReanimatedModule, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { ReportModal } from '@/components/ReportModal';
import * as Skin from '@/theme/skins/geometry';

const ReanimatedView = ReanimatedModule.View;

const SCREEN_WIDTH = Dimensions.get('window').width;
const SCREEN_HEIGHT = Dimensions.get('window').height;

// Configure audio mode for silent switch (one-time setup)
let audioModeConfigured = false;
async function ensureAudioMode() {
  if (audioModeConfigured) return;
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'duckOthers',
      allowsRecording: false,
    });
    audioModeConfigured = true;
  } catch (e) {
    // Silently fail - audio will still work, just not in silent mode
  }
}

// Memoized carousel tile — keeps the per-image onPress closure inside a
// memoized component so paging (activeIndex updates) doesn't re-render
// every image in the carousel.
const CarouselImageTile = React.memo(function CarouselImageTile({
  url,
  index,
  maxHeight,
  theme,
  onImagePress,
}: {
  url: string;
  index: number;
  maxHeight: number;
  theme: AppTheme;
  onImagePress?: (url: string, index: number) => void;
}) {
  const handlePress = useCallback(() => onImagePress?.(url, index), [onImagePress, url, index]);
  return (
    <View
      style={{
        width: SCREEN_WIDTH,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <AutoHeightImage
        uri={url}
        maxHeight={maxHeight}
        maxWidth={SCREEN_WIDTH}
        style={{ backgroundColor: theme.colors.surface3 }}
        onPress={onImagePress ? handlePress : undefined}
      />
    </View>
  );
});

function ImageCarousel({ urls, maxHeight, theme, onImagePress }: { urls: string[]; maxHeight: number; theme: AppTheme; onImagePress?: (url: string, index: number) => void }) {
  const [activeIndex, setActiveIndex] = useState(0);

  const handleScroll = useCallback((event: { nativeEvent: { contentOffset: { x: number } } }) => {
    const contentOffsetX = event.nativeEvent.contentOffset.x;
    const index = Math.round(contentOffsetX / SCREEN_WIDTH);
    setActiveIndex(index);
  }, []);

  return (
    <View style={{ width: SCREEN_WIDTH }}>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        decelerationRate="fast"
        snapToInterval={SCREEN_WIDTH}
        snapToAlignment="start"
        contentContainerStyle={{ width: SCREEN_WIDTH * urls.length }}
      >
        {urls.map((url, index) => (
          <CarouselImageTile
            key={index}
            url={url}
            index={index}
            maxHeight={maxHeight}
            theme={theme}
            onImagePress={onImagePress}
          />
        ))}
      </ScrollView>
      <View style={{
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: Skin.space(12),
        gap: Skin.space(6),
      }}>
        {urls.map((_, index) => (
          <View
            key={index}
            style={{
              width: 6,
              height: 6,
              borderRadius: Skin.radius(3),
              backgroundColor: index === activeIndex ? theme.colors.textMain : theme.colors.surface4,
            }}
          />
        ))}
      </View>
    </View>
  );
}

function formatDuration(ms?: number): string {
  if (!ms) return '';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Slug-like = no slashes or colons. Hypersnap sometimes sets
// `channel.id` to the parent_url itself (e.g.
// `chain://eip155:7777777/erc721:0x…`); if we trust that as the slug
// we end up rendering the raw URI inline, which both looks broken and
// overflows the header.
function slugLikeChannelKey(s: string | null | undefined): s is string {
  return !!s && !/[\/:]/.test(s);
}

/** Resolve a renderable channel handle from the raw key/name pair on a
 *  cast, ignoring chain-URI-shaped keys. Returns null when the cast
 *  has no channel. */
function resolveChannelChip(
  rawKey: string | null | undefined,
  rawName: string | null | undefined,
): { key: string; display: string } | null {
  if (slugLikeChannelKey(rawKey)) {
    return { key: rawKey, display: rawName ?? rawKey };
  }
  if (rawName) {
    const slug = rawName.toLowerCase().replace(/\s+/g, '-');
    return { key: slug, display: rawName };
  }
  return null;
}

// Parse cast text and render @mentions and /channels as tappable links
function CastText({
  text,
  style,
  theme,
  onMentionPress,
  onChannelPress,
  onLinkPress,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
  theme: AppTheme;
  onMentionPress?: (username: string) => void;
  onChannelPress?: (channelKey: string) => void;
  onLinkPress?: (url: string) => void;
}) {
  // Match URLs, @mentions (after whitespace/start), and /channels (after whitespace/start)
  // URLs are matched first to prevent their paths being parsed as channels
  const parts: { type: 'text' | 'mention' | 'channel' | 'link' | 'inviteLink'; value: string }[] = [];
  let lastIndex = 0;

  const combinedRegex = /(https?:\/\/[^\s]+)|(?<=^|[\s])(@[a-zA-Z0-9._-]+)|(?<=^|[\s])(\/[a-zA-Z0-9_-]+)/g;
  let match;

  while ((match = combinedRegex.exec(text)) !== null) {
    // Add text before this match
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }

    // Add the match itself
    if (match[1]) {
      // URL - check if it's a Quorum invite link
      const url = match[1];
      if (containsInviteLink(url)) {
        parts.push({ type: 'inviteLink', value: url });
      } else {
        parts.push({ type: 'link', value: url });
      }
    } else if (match[2]) {
      // @mention
      parts.push({ type: 'mention', value: match[2].slice(1) }); // Remove @ prefix
    } else if (match[3]) {
      // /channel
      parts.push({ type: 'channel', value: match[3].slice(1) }); // Remove / prefix
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }

  // Check if we have any invite links - if so, we need to render as View with blocks
  const hasInviteLinks = parts.some(p => p.type === 'inviteLink');

  if (hasInviteLinks) {
    // Group consecutive non-invite parts into text blocks
    const blocks: { type: 'textBlock' | 'inviteLink'; parts?: typeof parts; value?: string }[] = [];
    let currentTextParts: typeof parts = [];

    for (const part of parts) {
      if (part.type === 'inviteLink') {
        // Flush any accumulated text parts
        if (currentTextParts.length > 0) {
          blocks.push({ type: 'textBlock', parts: currentTextParts });
          currentTextParts = [];
        }
        blocks.push({ type: 'inviteLink', value: part.value });
      } else {
        currentTextParts.push(part);
      }
    }
    // Flush remaining text parts
    if (currentTextParts.length > 0) {
      blocks.push({ type: 'textBlock', parts: currentTextParts });
    }

    return (
      <View style={{ gap: Skin.space(8) }}>
        {blocks.map((block, blockIndex) => {
          if (block.type === 'inviteLink') {
            return <InviteLinkCard key={blockIndex} inviteLink={block.value!} />;
          }
          // Render text block
          return (
            <Text key={blockIndex} style={style}>
              {block.parts!.map((part, index) => {
                if (part.type === 'link') {
                  return (
                    <Text
                      key={index}
                      style={{ color: theme.colors.accent }}
                      onPress={() => onLinkPress?.(part.value)}
                    >
                      {part.value}
                    </Text>
                  );
                } else if (part.type === 'mention') {
                  return (
                    <Text
                      key={index}
                      style={{ color: theme.colors.accent }}
                      onPress={() => onMentionPress?.(part.value)}
                    >
                      @{part.value}
                    </Text>
                  );
                } else if (part.type === 'channel') {
                  return (
                    <Text
                      key={index}
                      style={{ color: theme.colors.accent }}
                      onPress={() => onChannelPress?.(part.value)}
                    >
                      /{part.value}
                    </Text>
                  );
                }
                return <Text key={index}>{part.value}</Text>;
              })}
            </Text>
          );
        })}
      </View>
    );
  }

  // No invite links - render normally as a single Text
  return (
    <Text style={style}>
      {parts.map((part, index) => {
        if (part.type === 'link') {
          return (
            <Text
              key={index}
              style={{ color: theme.colors.accent }}
              onPress={() => onLinkPress?.(part.value)}
            >
              {part.value}
            </Text>
          );
        } else if (part.type === 'mention') {
          return (
            <Text
              key={index}
              style={{ color: theme.colors.accent }}
              onPress={() => onMentionPress?.(part.value)}
            >
              @{part.value}
            </Text>
          );
        } else if (part.type === 'channel') {
          return (
            <Text
              key={index}
              style={{ color: theme.colors.accent }}
              onPress={() => onChannelPress?.(part.value)}
            >
              /{part.value}
            </Text>
          );
        }
        return <Text key={index}>{part.value}</Text>;
      })}
    </Text>
  );
}

// Share action sheet for recast/quote/share options. Moderation
// (report/mute/block) lives in its own CastOverflowButton menu, not here.
interface ShareActionSheetProps {
  visible: boolean;
  castHash: string;
  castAuthor: string;
  isRecasted: boolean;
  recastCount: number;
  token?: string;
  onClose: () => void;
  onRecast: () => void;
  onQuote: () => void;
  onShareToChat: () => void;
  onNativeShare: () => void;
}

function ShareActionSheet({
  visible,
  isRecasted,
  token,
  onClose,
  onRecast,
  onQuote,
  onShareToChat,
  onNativeShare,
}: ShareActionSheetProps) {
  const actions: ActionRowItem[] = [
    {
      icon: 'arrow.triangle.2.circlepath',
      label: isRecasted ? 'Undo recast' : 'Recast',
      active: isRecasted,
      onPress: onRecast,
      disabled: !token,
    },
    {
      icon: 'quote.bubble',
      label: 'Quote',
      onPress: onQuote,
      disabled: !token,
    },
    {
      icon: 'paperplane',
      label: 'Share to chat',
      onPress: onShareToChat,
    },
    {
      icon: 'square.and.arrow.up',
      label: 'Share',
      onPress: onNativeShare,
    },
  ];

  return <ActionSheet visible={visible} onClose={onClose} actions={actions} />;
}

// Share to chat modal - lets user pick a space/channel or DM to share the cast link
interface ShareToChatModalProps {
  visible: boolean;
  castUrl: string;
  theme: AppTheme;
  bottomInset: number;
  onClose: () => void;
  onSent: () => void;
}

// Styles for the ShareToChat row lists. Color-dependent entries are functions
// of theme; the rest are static. Rows themselves come from the shared ActionRow
// primitive — only the section header, group spacing, and avatar chrome live here.
const shareToChatStyles = {
  sectionHeader: (theme: AppTheme) => ({
    fontSize: Skin.font(13),
    fontWeight: '600' as const,
    color: theme.colors.textMuted,
    paddingHorizontal: Skin.space(16),
    paddingTop: Skin.space(16),
    paddingBottom: Skin.space(8),
  }),
  group: {
    marginHorizontal: Skin.space(12),
    marginBottom: Skin.space(4),
  },
  dmAvatar: (theme: AppTheme) => ({
    width: 40,
    height: 40,
    borderRadius: Skin.radius(20),
    backgroundColor: theme.colors.surface3,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  }),
  dmAvatarImage: {
    width: 40,
    height: 40,
    borderRadius: Skin.radius(20),
  },
  farcasterBadge: {
    width: 18,
    height: 18,
    opacity: 0.7,
  },
};

function ShareToChatModal({
  visible,
  castUrl,
  theme,
  bottomInset,
  onClose,
  onSent,
}: ShareToChatModalProps) {
  const { data: conversationsData } = useConversations({ type: 'direct', enabled: visible });
  const { data: farcasterConversationsData } = useFarcasterConversations({ enabled: visible });
  const { data: spacesData } = useSpaces({ enabled: visible });
  const { mutateAsync: sendDirectMessage } = useSendDirectMessage();
  const { mutateAsync: sendFarcasterDirectCast } = useSendFarcasterDirectCast();
  const { mutateAsync: sendSpaceMessage } = useSendSpaceMessage();

  const [selectedSpace, setSelectedSpace] = useState<Space | null>(null);
  const [isSending, setIsSending] = useState(false);

  // Flatten conversations from pages
  const quorumConversations = useMemo(() => {
    return conversationsData?.pages.flatMap(page => page.conversations) ?? [];
  }, [conversationsData]);

  // Flatten Farcaster conversations from pages
  const farcasterConversations = useMemo(() => {
    return farcasterConversationsData?.pages.flatMap(page => page.conversations) ?? [];
  }, [farcasterConversationsData]);

  // Merge and sort all DMs by timestamp (newest first)
  const allDMs = useMemo(() => {
    const quorumWithSource = quorumConversations.map(conv => ({ ...conv, source: 'quorum' as const }));
    const farcasterWithSource = farcasterConversations.map(conv => ({ ...conv, source: 'farcaster' as const }));
    return [...quorumWithSource, ...farcasterWithSource].sort((a, b) => b.timestamp - a.timestamp);
  }, [quorumConversations, farcasterConversations]);

  const spaces = spacesData ?? [];

  // Get channels from selected space
  const channels = useMemo(() => {
    if (!selectedSpace) return [];
    return selectedSpace.groups?.flatMap(group => group.channels ?? []) ?? [];
  }, [selectedSpace]);

  const handleSelectDM = async (conversation: ConversationWithPreview) => {
    try {
      setIsSending(true);
      await sendDirectMessage({
        conversationId: conversation.conversationId,
        recipientAddress: conversation.address,
        text: castUrl,
      });
      onSent();
      onClose();
    } catch {
      // Mutation handles its own error state
    } finally {
      setIsSending(false);
    }
  };

  const handleSelectFarcasterDM = async (conversation: { conversationId: string; farcasterParticipantFids?: number[] }) => {
    try {
      setIsSending(true);
      // Extract the actual Farcaster conversation ID (remove 'farcaster:' prefix)
      const fcConversationId = conversation.conversationId.startsWith('farcaster:')
        ? conversation.conversationId.slice(10)
        : conversation.conversationId;
      const recipientFids = (conversation as any).farcasterParticipantFids ?? [];
      await sendFarcasterDirectCast({
        conversationId: fcConversationId,
        recipientFids,
        message: castUrl,
      });
      onSent();
      onClose();
    } catch {
      // Mutation handles its own error state
    } finally {
      setIsSending(false);
    }
  };

  const handleSelectChannel = async (channel: Channel) => {
    if (!selectedSpace) return;
    try {
      setIsSending(true);
      await sendSpaceMessage({
        spaceId: selectedSpace.spaceId,
        channelId: channel.channelId,
        text: castUrl,
      });
      onSent();
      onClose();
    } catch {
      // Mutation handles its own error state
    } finally {
      setIsSending(false);
    }
  };

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }}>
        <View
          style={{
            flex: 1,
            marginTop: Skin.space(100),
            backgroundColor: theme.colors.background,
            borderTopLeftRadius: Skin.radius(20),
            borderTopRightRadius: Skin.radius(20),
          }}
        >
          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: Skin.space(16),
              paddingVertical: Skin.space(16),
              borderBottomWidth: Skin.border(1),
              borderBottomColor: theme.colors.surface3,
            }}
          >
            {selectedSpace ? (
              <TouchableOpacity
                onPress={() => setSelectedSpace(null)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(8) }}
              >
                <IconSymbol name="chevron.left" size={20} color={theme.colors.textMain} />
                <Text style={{ fontSize: Skin.font(17), fontWeight: '600', color: theme.colors.textMain }}>
                  {selectedSpace.spaceName}
                </Text>
              </TouchableOpacity>
            ) : (
              <Text style={{ fontSize: Skin.font(17), fontWeight: '600', color: theme.colors.textMain }}>
                Share to Chat
              </Text>
            )}
            <TouchableOpacity onPress={onClose}>
              <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>

          {isSending && (
            <View style={{ padding: Skin.space(20), alignItems: 'center' }}>
              <ActivityIndicator color={theme.colors.accent} />
              <Text style={{ color: theme.colors.textMuted, marginTop: Skin.space(8) }}>Sending...</Text>
            </View>
          )}

          {!isSending && !selectedSpace && (
            <ScrollView style={{ flex: 1 }}>
              {/* Spaces Section */}
              {spaces.length > 0 && (
                <>
                  <Text style={shareToChatStyles.sectionHeader(theme)}>SPACES</Text>
                  <ActionRowGroup style={shareToChatStyles.group}>
                    {spaces.map((space) => (
                      <ActionRow
                        key={space.spaceId}
                        leading={
                          <SpaceIcon
                            name={space.spaceName}
                            size={40}
                            style={{ borderRadius: Skin.radius(8) }}
                          />
                        }
                        label={space.spaceName}
                        sublabel={`${space.groups?.reduce((acc, g) => acc + (g.channels?.length ?? 0), 0) ?? 0} channels`}
                        trailing="chevron"
                        onPress={() => setSelectedSpace(space)}
                      />
                    ))}
                  </ActionRowGroup>
                </>
              )}

              {/* DMs Section - Merged and sorted by timestamp */}
              {allDMs.length > 0 && (
                <>
                  <Text style={shareToChatStyles.sectionHeader(theme)}>DIRECT MESSAGES</Text>
                  <ActionRowGroup style={shareToChatStyles.group}>
                    {allDMs.map((conv: any) => {
                      const isFarcaster = conv.source === 'farcaster';
                      const showHandle =
                        isFarcaster && conv.farcasterUsername && conv.displayName !== conv.farcasterUsername;
                      return (
                        <ActionRow
                          key={conv.conversationId}
                          leading={
                            <View style={shareToChatStyles.dmAvatar(theme)}>
                              {conv.icon ? (
                                <Image source={{ uri: conv.icon }} style={shareToChatStyles.dmAvatarImage} />
                              ) : (
                                <IconSymbol name="person.fill" size={20} color={theme.colors.textMuted} />
                              )}
                            </View>
                          }
                          label={
                            conv.displayName ||
                            (isFarcaster ? conv.farcasterUsername : conv.address?.slice(0, 12) + '...') ||
                            'Unknown'
                          }
                          sublabel={showHandle ? `@${conv.farcasterUsername}` : undefined}
                          trailing={
                            isFarcaster ? (
                              <Image
                                source={require('../assets/images/farcaster.png')}
                                style={shareToChatStyles.farcasterBadge}
                              />
                            ) : undefined
                          }
                          onPress={() => (isFarcaster ? handleSelectFarcasterDM(conv) : handleSelectDM(conv))}
                        />
                      );
                    })}
                  </ActionRowGroup>
                </>
              )}

              {spaces.length === 0 && allDMs.length === 0 && (
                <View style={{ padding: Skin.space(40), alignItems: 'center' }}>
                  <Text style={{ color: theme.colors.textMuted, textAlign: 'center' }}>
                    No conversations yet.{'\n'}Start a chat to share to it.
                  </Text>
                </View>
              )}
            </ScrollView>
          )}

          {/* Channel list when space is selected */}
          {!isSending && selectedSpace && (
            <ScrollView style={{ flex: 1 }}>
              <ActionRowGroup style={shareToChatStyles.group}>
                {channels.map((channel) => (
                  <ActionRow
                    key={channel.channelId}
                    icon="number"
                    label={channel.channelName}
                    onPress={() => handleSelectChannel(channel)}
                  />
                ))}
              </ActionRowGroup>
              {channels.length === 0 && (
                <View style={{ padding: Skin.space(40), alignItems: 'center' }}>
                  <Text style={{ color: theme.colors.textMuted }}>No channels in this space</Text>
                </View>
              )}
            </ScrollView>
          )}

          {/* Bottom safe area */}
          <View style={{ height: bottomInset }} />
        </View>
      </View>
    </Modal>
  );
}

function VideoPlayer({
  url,
  downloadUrl,
  thumbnailUrl,
  width,
  height,
  duration,
  theme
}: {
  url: string;
  downloadUrl?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  duration?: number;
  theme: AppTheme;
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Natural aspect ratio measured from the loaded video, used when the
  // embed doesn't carry width/height (common for HLS) so the container
  // matches the real video instead of a 9/16 guess.
  const [measuredAspect, setMeasuredAspect] = useState<number | null>(null);
  const videoRef = useRef<VideoView>(null);
  const aspectRatio = measuredAspect ?? (width && height ? height / width : 9 / 16);
  // Full-width, natural aspect ratio — no max-height cap.
  const calculatedHeight = SCREEN_WIDTH * aspectRatio;

  // Configure audio mode on mount
  useEffect(() => {
    ensureAudioMode();
  }, []);

  // Create video player
  const player = useVideoPlayer(url, (player) => {
    player.loop = false;
  });

  // Listen for playback status changes
  useEffect(() => {
    const subscription = player.addListener('playingChange', (event) => {
      setIsPlaying(event.isPlaying);
    });

    const endSubscription = player.addListener('playToEnd', () => {
      setIsPlaying(false);
      setHasStarted(false);
      player.currentTime = 0;
    });

    // Measure the real video dimensions once the source loads so the
    // container sizes to the natural aspect ratio — the embed often omits
    // width/height (especially for HLS), which otherwise leaves a short
    // 9/16 box that doesn't fill the height of a portrait video.
    const applySize = (size?: { width: number; height: number } | null) => {
      if (size && size.width > 0 && size.height > 0) {
        setMeasuredAspect(size.height / size.width);
      }
    };

    const loadSubscription = player.addListener('sourceLoad', (payload) => {
      const tracks = payload.availableVideoTracks ?? [];
      const best = tracks.reduce<(typeof tracks)[number] | undefined>((acc, t) => {
        const area = (t.size?.width ?? 0) * (t.size?.height ?? 0);
        const accArea = (acc?.size?.width ?? 0) * (acc?.size?.height ?? 0);
        return area > accArea ? t : acc;
      }, undefined);
      applySize(best?.size ?? player.videoTrack?.size);
    });

    // For HLS the track (and its size) often isn't known until it's
    // selected — `videoTrackChange` fires then, with the real dimensions.
    const trackSubscription = player.addListener('videoTrackChange', (payload) => {
      applySize(payload.videoTrack?.size);
    });

    // Once the source is ready the track is usually resolved; read it
    // directly (covers events that fired before this effect subscribed).
    const statusSubscription = player.addListener('statusChange', (payload) => {
      if (payload.status === 'readyToPlay') applySize(player.videoTrack?.size);
    });

    // Immediate read in case the track was already resolved before we
    // attached any listeners (player is created during render).
    applySize(player.videoTrack?.size);

    return () => {
      subscription.remove();
      endSubscription.remove();
      loadSubscription.remove();
      trackSubscription.remove();
      statusSubscription.remove();
    };
  }, [player]);

  // HLS posters: the feed API often omits video dimensions, and expo-video
  // can't report an HLS track's size before playback — so without this the
  // poster sits at the 9/16 fallback until the user presses play (the
  // thread works only because its API *does* include dimensions). Parse
  // `RESOLUTION=WxH` from the m3u8 master manifest (a tiny text fetch) to
  // size the box correctly up front. Only runs when nothing else sized it.
  useEffect(() => {
    if (thumbnailUrl || (width && height)) return;
    if (!/\.m3u8(\?|#|$)/i.test(url)) return;
    let cancelled = false;
    fetch(url)
      .then((r) => r.text())
      .then((text) => {
        if (cancelled) return;
        const m = text.match(/RESOLUTION=(\d+)x(\d+)/i);
        if (m) {
          const w = parseInt(m[1], 10);
          const h = parseInt(m[2], 10);
          if (w > 0 && h > 0) setMeasuredAspect(h / w);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url, thumbnailUrl, width, height]);

  // Also measure the poster thumbnail's aspect ratio when one is present.
  // With a thumbnail poster the VideoView isn't mounted until playback, so
  // the player may not load and `sourceLoad` may not fire — measuring the
  // thumbnail (which matches the video's aspect) keeps the box at the right
  // height in the feed too, not just the thread.
  useEffect(() => {
    if (!thumbnailUrl) return;
    let cancelled = false;
    Image.getSize(
      thumbnailUrl,
      (w, h) => {
        if (!cancelled && w > 0 && h > 0) setMeasuredAspect(h / w);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [thumbnailUrl]);

  // Tap on the play-button overlay → play/pause toggle (or start on
  // first tap). Kept narrow so it doesn't swallow the rest of the
  // surface.
  const handlePlayButtonTap = () => {
    if (!hasStarted) {
      setHasStarted(true);
      setIsPlaying(true);
      player.play();
    } else if (isPlaying) {
      player.pause();
      setIsPlaying(false);
    } else {
      player.play();
      setIsPlaying(true);
    }
  };

  // Tap anywhere else on the video surface → open the in-app fullscreen
  // viewer (native transport controls + close + save + swipe-to-dismiss).
  // Native `enterFullscreen()` on a nativeControls={false} view showed no
  // controls. Pause the inline player so the two don't play over each other.
  const handleSurfaceTap = () => {
    if (isPlaying) {
      player.pause();
      setIsPlaying(false);
    }
    setFullscreen(true);
  };

  return (
    <>
    <Pressable onPress={handleSurfaceTap} style={{ position: 'relative' }}>
      {!hasStarted ? (
        <>
          {thumbnailUrl ? (
            <Image
              source={{ uri: thumbnailUrl }}
              style={{
                width: SCREEN_WIDTH,
                height: calculatedHeight,
                backgroundColor: theme.colors.surface3,
              }}
              resizeMode="cover"
            />
          ) : (
            // No poster URL from the API (typical for hypersnap-bare HLS
            // streams). Show the video's own first frame as the preview via
            // the already-created player — works for HLS too, costs no extra
            // player, and beats a blank box. `pointerEvents="none"` so taps
            // fall through to the play overlay / fullscreen handler.
            <VideoView
              player={player}
              style={{
                width: SCREEN_WIDTH,
                height: calculatedHeight,
                backgroundColor: theme.colors.surface3,
              }}
              contentFit="contain"
              nativeControls={false}
              pointerEvents="none"
              onFirstFrameRender={() => {
                // The frame is now displayed, so the player knows the
                // dimensions — size the box to the real aspect ratio.
                const size = player.videoTrack?.size;
                if (size && size.width > 0 && size.height > 0) {
                  setMeasuredAspect(size.height / size.width);
                }
              }}
            />
          )}
          {/* Play button overlay — tappable on top of the poster, but
              the surrounding area falls through to the outer Pressable
              (which enters fullscreen). */}
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              justifyContent: 'center',
              alignItems: 'center',
            }}
            pointerEvents="box-none"
          >
            <Pressable
              onPress={handlePlayButtonTap}
              hitSlop={12}
              style={{
                width: 60,
                height: 60,
                borderRadius: Skin.radius(30),
                backgroundColor: 'rgba(0, 0, 0, 0.6)',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <IconSymbol name="play.fill" color="#fff" size={28} />
            </Pressable>
          </View>
          {/* Duration badge */}
          {duration && duration > 0 && (
            <View style={{
              position: 'absolute',
              bottom: 8,
              right: 8,
              backgroundColor: 'rgba(0, 0, 0, 0.7)',
              paddingHorizontal: Skin.space(6),
              paddingVertical: Skin.space(2),
              borderRadius: Skin.radius(4),
            }}>
              <Text style={{ color: '#fff', fontSize: Skin.font(12), fontWeight: '500' }}>
                {formatDuration(duration)}
              </Text>
            </View>
          )}
        </>
      ) : (
        <>
          <VideoView
            ref={videoRef}
            player={player}
            style={{
              width: SCREEN_WIDTH,
              height: calculatedHeight,
              backgroundColor: theme.colors.surface3,
            }}
            contentFit="contain"
            nativeControls={false}
            allowsFullscreen
          />
          {/* Pause indicator — tappable to resume; surrounding area
              still routes to handleSurfaceTap (enter fullscreen). */}
          {!isPlaying && (
            <View
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                justifyContent: 'center',
                alignItems: 'center',
              }}
              pointerEvents="box-none"
            >
              <Pressable
                onPress={handlePlayButtonTap}
                hitSlop={12}
                style={{
                  width: 60,
                  height: 60,
                  borderRadius: Skin.radius(30),
                  backgroundColor: 'rgba(0, 0, 0, 0.6)',
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <IconSymbol name="play.fill" color="#fff" size={28} />
              </Pressable>
            </View>
          )}
        </>
      )}
    </Pressable>
    {fullscreen && (
      <VideoViewer visible url={url} downloadUrl={downloadUrl} onClose={() => setFullscreen(false)} />
    )}
    </>
  );
}

function LinkPreview({
  url,
  title,
  description,
  domain,
  image,
  useLargeImage,
  theme,
  onPress,
}: {
  url?: string;
  title?: string;
  description?: string;
  domain?: string;
  image?: string;
  useLargeImage?: boolean;
  theme: AppTheme;
  onPress?: () => void;
}) {
  const handlePress = () => {
    onPress?.();
  };

  // No OG enrichment (typical for hypersnap-sourced casts): render a bare
  // link chip so the URL is still visible + tappable. The user can open
  // it; the embed isn't lost just because the link's host didn't expose
  // OG metadata.
  if (!title && url) {
    return (
      <TouchableOpacity
        style={{
          backgroundColor: theme.colors.surface2,
          borderRadius: Skin.radius(12),
          paddingVertical: Skin.space(10),
          paddingHorizontal: Skin.space(12),
          marginHorizontal: Skin.space(12),
          flexDirection: 'row',
          alignItems: 'center',
          gap: Skin.space(8),
        }}
        onPress={handlePress}
        activeOpacity={0.8}
      >
        <IconSymbol name="link" color={theme.colors.textMuted} size={14} />
        <Text
          style={{ color: theme.colors.textStrong, fontSize: Skin.font(13), flex: 1 }}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {domain || url}
        </Text>
        <IconSymbol name="arrow.up.right" color={theme.colors.textMuted} size={12} />
      </TouchableOpacity>
    );
  }
  if (!title) return null;

  if (useLargeImage && image) {
    return (
      <TouchableOpacity
        style={{
          backgroundColor: theme.colors.surface2,
          borderRadius: Skin.radius(12),
          overflow: 'hidden',
          marginHorizontal: Skin.space(12),
        }}
        onPress={handlePress}
        activeOpacity={0.8}
      >
        <Image
          source={{ uri: image }}
          style={{
            width: '100%',
            height: 180,
            backgroundColor: theme.colors.surface3,
          }}
          resizeMode="cover"
        />
        <View style={{ padding: Skin.space(12) }}>
          <Text
            style={{
              color: theme.colors.textStrong,
              fontSize: Skin.font(15),
              fontWeight: '600',
              marginBottom: Skin.space(4),
            }}
            numberOfLines={2}
          >
            {title}
          </Text>
          {description && (
            <Text
              style={{
                color: theme.colors.textMuted,
                fontSize: Skin.font(13),
                lineHeight: Skin.font(18),
                marginBottom: Skin.space(4),
              }}
              numberOfLines={2}
            >
              {description}
            </Text>
          )}
          {domain && (
            <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(12) }}>
              {domain}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      style={{
        backgroundColor: theme.colors.surface2,
        borderRadius: Skin.radius(12),
        overflow: 'hidden',
        marginHorizontal: Skin.space(12),
        flexDirection: 'row',
      }}
      onPress={handlePress}
      activeOpacity={0.8}
    >
      {image && (
        <Image
          source={{ uri: image }}
          style={{
            width: 100,
            height: 100,
            backgroundColor: theme.colors.surface3,
          }}
          resizeMode="cover"
        />
      )}
      <View style={{ flex: 1, padding: Skin.space(12), justifyContent: 'center' }}>
        <Text
          style={{
            color: theme.colors.textStrong,
            fontSize: Skin.font(14),
            fontWeight: '600',
            marginBottom: Skin.space(4),
          }}
          numberOfLines={2}
        >
          {title}
        </Text>
        {description && (
          <Text
            style={{
              color: theme.colors.textMuted,
              fontSize: Skin.font(12),
              lineHeight: Skin.font(16),
              marginBottom: Skin.space(4),
            }}
            numberOfLines={2}
          >
            {description}
          </Text>
        )}
        {domain && (
          <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(11) }}>
            {domain}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

/**
 * Recognize known channel URI shapes:
 *  - https://warpcast.com/~/channel/<slug>
 *  - https://farcaster.xyz/~/channel/<slug>
 *  - https://farcaster.group/<slug>           (alternative channels host)
 *  - chain://eip155:<chainId>/erc721:<contractAddress>  (Zora/Optimism)
 * Anything starting with chain:// is treated as a channel URI; final
 * disambiguation happens via the hypersnap channel lookup.
 */
// Capture-group 1 is the channel slug. Each alternation handles one host.
const CHANNEL_URL_RE =
  /(?:(?:farcaster|warpcast)\.(?:xyz|com)\/~\/channel\/|farcaster\.group\/)([^\/\?#]+)/;

/**
 * Recognize `https://farcaster.xyz/~/c/<chain>:<contract>` token references.
 * Capture group 1 is the chain slug (e.g. "base"), group 2 is the 0x-prefixed
 * contract address. The host check is anchored to avoid false positives on
 * anything else under the `/~/c/` namespace.
 */
const TOKEN_URL_RE =
  /farcaster\.xyz\/~\/c\/([a-z]+):(0x[a-fA-F0-9]+)/i;

function parseFarcasterTokenUrl(url: string | undefined): { chain: string; contractAddress: string } | null {
  if (!url) return null;
  const m = url.match(TOKEN_URL_RE);
  if (!m) return null;
  return { chain: m[1].toLowerCase(), contractAddress: m[2].toLowerCase() };
}

/** Recognize `https://farcaster.xyz/~/spaces/<uuid>` audio-space URLs. */
const SPACE_URL_RE =
  /^https?:\/\/(?:www\.)?farcaster\.xyz\/~\/spaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

function parseFarcasterSpaceUrl(url: string | undefined): { id: string } | null {
  if (!url) return null;
  const m = url.match(SPACE_URL_RE);
  return m ? { id: m[1].toLowerCase() } : null;
}

function looksLikeChannelUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (url.startsWith('chain://')) return true;
  return CHANNEL_URL_RE.test(url);
}

function extractChannelSlugFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(CHANNEL_URL_RE);
  return m ? m[1] : null;
}

/**
 * Renders the channel badge next to a cast's author name. Source order:
 *  1. explicit channel slug from the cast payload (`post.channel`)
 *  2. /~/channel/<slug> path extraction from a parentUrl
 *  3. hypersnap channel lookup keyed by the raw parentUrl — required for
 *     `chain://eip155:.../erc721:...` URIs that don't carry a slug
 * Falls back to nothing if the URI doesn't resolve.
 */
function ChannelBadge({
  channelSlug,
  parentUrl,
  theme,
  onOpenChannel,
}: {
  channelSlug?: string;
  parentUrl?: string;
  theme: AppTheme;
  onOpenChannel: (channelKey: string) => void;
}) {
  // Hypersnap sometimes returns the raw `parent_url` (e.g.
  // `chain://eip155:7777777/erc721:0x…`) as the "channel id". A
  // slug-shaped string has no slashes or colons; anything else is a
  // URI we should attempt to resolve, not render verbatim.
  const slugIsUsable = slugLikeChannelKey(channelSlug);
  const slugFromUrl = slugIsUsable ? null : extractChannelSlugFromUrl(parentUrl);
  // If the slug itself is a chain URI, use IT as the resolve key.
  // Otherwise, only resolve from `parentUrl` when it's a chain URI.
  const resolveTarget = !slugIsUsable && channelSlug && /^chain:\/\//.test(channelSlug)
    ? channelSlug
    : !slugIsUsable && !slugFromUrl && parentUrl?.startsWith('chain://')
      ? parentUrl
      : undefined;
  const { data: resolved } = useFarcasterChannelByParentUrl(
    resolveTarget,
    { enabled: Boolean(resolveTarget), gcTime: 10 * 60 * 1000 },
  );
  const finalKey = (slugIsUsable ? channelSlug : null) ?? slugFromUrl ?? resolved?.key;
  const finalName = (slugIsUsable ? channelSlug : null) ?? slugFromUrl ?? resolved?.name;
  // Omit entirely when we can't surface a clean slug — chain URIs
  // that don't resolve shouldn't leak into the header.
  if (!finalKey || !slugLikeChannelKey(finalKey)) return null;
  return (
    <TouchableOpacity onPress={() => onOpenChannel(finalKey)}>
      <Text
        style={{ color: theme.colors.accent, fontSize: Skin.font(13) }}
        numberOfLines={1}
      >
        /{finalName ?? finalKey}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * Renders the context line above a cast body. Three cases:
 *  1. parentUrl points at an off-Farcaster URL → "↳ replying to <hostname>"
 *  2. parentAuthor is set → "↳ replying to @username" (resolves FID via hook)
 *  3. only parentHash is known → mini preview of the parent cast, with
 *     graceful "↳ in thread" fallback while it loads or if the lookup fails
 *
 * Channel parentUrls (warpcast/farcaster.xyz/~/channel and chain:// URIs)
 * are deliberately suppressed here since they're already rendered as the
 * channel badge in the header row.
 */
function ParentContextLine({
  cast,
  theme,
  onNavigateToThread,
}: {
  cast: { parentUrl?: string; parentHash?: string; parentAuthor?: { fid: number; username?: string } };
  theme: AppTheme;
  /** When provided, the mini parent-cast preview becomes tappable and
   *  navigates into the parent's thread. The outer card's press handler
   *  shouldn't fire concurrently — Pressable's touch capture wins for
   *  touches inside the inner pressable. */
  onNavigateToThread?: (username: string, hash: string, focusReply?: boolean, placeholderCast?: unknown) => void;
}) {
  const isChannelUrl = looksLikeChannelUrl(cast.parentUrl);
  const showUrlContext = !!cast.parentUrl && !isChannelUrl;
  // Any reply where we know the parent author's FID gets the rich mini-cast
  // preview, not just the bare "replying to @user" line.
  const parentFid = cast.parentAuthor?.fid;
  const canFetchMiniCast =
    !showUrlContext && !!cast.parentHash && Number.isFinite(parentFid) && (parentFid as number) > 0;
  // "Replying to user" text is the fallback: we know it's a reply but
  // can't fetch the parent cast (e.g. parentAuthor known but no parentHash,
  // or the cast lookup hasn't resolved yet).
  const showUserContext = !showUrlContext && !canFetchMiniCast && !!cast.parentAuthor;
  // Pure-hash thread reference (no author info, no URL) — last-resort label.
  const showGenericReply =
    !showUrlContext && !canFetchMiniCast && !showUserContext && !!cast.parentHash;

  const enableUser =
    (showUserContext || (canFetchMiniCast && !cast.parentAuthor?.username)) && !!parentFid;
  const { data: resolvedParent } = useFarcasterUserPersistent(
    enableUser ? parentFid : undefined,
    { enabled: enableUser },
  );

  const { data: parentCast } = useFarcasterCast(
    canFetchMiniCast ? cast.parentHash : undefined,
    canFetchMiniCast ? parentFid : undefined,
    { enabled: canFetchMiniCast, gcTime: 10 * 60 * 1000 },
  );

  if (!showUrlContext && !showUserContext && !canFetchMiniCast && !showGenericReply) return null;

  // The mini preview is the richest representation; render it the moment
  // we have parentCast data, even if the older "showUserContext" branch
  // would have been chosen by the truth-table.
  if (parentCast) {
    const handle = parentCast.author.username
      ? `@${parentCast.author.username}`
      : `fid:${parentCast.author.fid}`;
    // First image embed in the parent cast — either a classified image
    // (hypersnap-classified by host/extension) or a raw URL that ends in
    // an image extension. Same fallback chain QuoteCast uses.
    const previewImage =
      parentCast.embeds.find((e) => e.image?.url)?.image?.url
      ?? parentCast.embeds.find(
        (e) => e.url && /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(e.url),
      )?.url;
    const Wrapper: React.ComponentType<React.ComponentProps<typeof View>> = onNavigateToThread
      ? (props) => (
          <Pressable
            onPress={() =>
              onNavigateToThread(
                parentCast.author.username ?? '',
                parentCast.hash,
                false,
              )
            }
          >
            <View {...props} />
          </Pressable>
        )
      : View;
    return (
      <Wrapper
        style={{
          borderRadius: Skin.radius(8),
          borderWidth: Skin.border(1),
          borderColor: theme.colors.surface3,
          backgroundColor: theme.colors.surface1,
          overflow: 'hidden',
        }}
      >
        <View style={{ padding: Skin.space(8), gap: Skin.space(2) }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6) }}>
            <IconSymbol name="arrowshape.turn.up.left" color={theme.colors.textMuted} size={12} />
            <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(12) }}>
              replying to <Text style={{ color: theme.colors.accent }}>{handle}</Text>
            </Text>
          </View>
          {parentCast.text.trim().length > 0 && (
            <Text
              style={{ color: theme.colors.textMain, fontSize: Skin.font(13), lineHeight: Skin.font(18) }}
              numberOfLines={3}
            >
              {parentCast.text}
            </Text>
          )}
        </View>
        {previewImage && (
          <Image
            source={{ uri: previewImage }}
            style={{ width: '100%', height: 120, backgroundColor: theme.colors.surface3 }}
            resizeMode="contain"
          />
        )}
      </Wrapper>
    );
  }

  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: Skin.space(6) }}>
      <IconSymbol
        name={showUrlContext ? 'link' : 'arrowshape.turn.up.left'}
        color={theme.colors.textMuted}
        size={14}
        style={{ marginTop: Skin.space(2) }}
      />
      {showUrlContext ? (
        <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13), flex: 1 }} numberOfLines={1}>
          replying to{' '}
          <Text style={{ color: theme.colors.accent }}>
            {(() => {
              try {
                return new URL(cast.parentUrl!).hostname.replace('www.', '');
              } catch {
                return cast.parentUrl;
              }
            })()}
          </Text>
        </Text>
      ) : (
        // showUserContext, mini-preview-still-loading, or showGenericReply
        <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13), flex: 1 }}>
          replying to{' '}
          <Text style={{ color: theme.colors.accent }}>
            {cast.parentAuthor?.username
              ? `@${cast.parentAuthor.username}`
              : resolvedParent?.username
                ? `@${resolvedParent.username}`
                : parentFid
                  ? `fid:${parentFid}`
                  : 'cast'}
          </Text>
        </Text>
      )}
    </View>
  );
}

/**
 * Wraps a URL embed: probes for snap support and renders SnapEmbed if detected,
 * otherwise falls back to the regular LinkPreview.
 */
function SnapAwareUrlPreview({
  url,
  snapUrl,
  title,
  description,
  domain,
  image,
  useLargeImage,
  frameImageUrl,
  frameButtonTitle,
  frameActionUrl,
  theme,
  onPress,
  userFid,
  token,
  onOpenUrl,
  onOpenProfile,
  onOpenMiniApp,
}: {
  url?: string;
  snapUrl?: string;
  title?: string;
  description?: string;
  domain?: string;
  image?: string;
  useLargeImage?: boolean;
  frameImageUrl?: string;
  frameButtonTitle?: string;
  frameActionUrl?: string;
  theme: AppTheme;
  onPress?: () => void;
  userFid?: number;
  token?: string;
  onOpenUrl?: (url: string) => void;
  onOpenProfile?: (fid: number) => void;
  onOpenMiniApp?: (url: string) => void;
}) {
  // frameEmbedNext.frameUrl is shared between regular Farcaster frame/miniapp
  // embeds and Snap embeds — so it's only a candidate, not a guarantee. Probe
  // the URL's content-type to decide which renderer to use.
  const candidateUrl = snapUrl || url;
  const isSnap = useSnapDetection(candidateUrl);

  if (isSnap === true && candidateUrl) {
    return (
      <SnapEmbed
        url={candidateUrl}
        theme={theme}
        userFid={userFid}
        token={token}
        onOpenUrl={onOpenUrl}
        onOpenProfile={onOpenProfile}
        onOpenMiniApp={onOpenMiniApp}
      />
    );
  }

  // YouTube — render an inline player for raw YouTube URLs (incl. playlists)
  const youTube = parseYouTubeUrl(url);
  if (youTube) {
    return <YouTubeEmbed videoId={youTube.videoId} playlistId={youTube.playlistId} theme={theme} />;
  }

  // Frame v2 / miniapp card (only when not detected as a snap)
  if (frameImageUrl && frameActionUrl) {
    return (
      <FrameEmbed
        imageUrl={frameImageUrl}
        buttonTitle={frameButtonTitle ?? 'Open'}
        actionUrl={frameActionUrl}
        theme={theme}
        onPress={() => onOpenMiniApp?.(frameActionUrl)}
      />
    );
  }

  return (
    <MiniappAwareLinkPreview
      url={url}
      title={title}
      description={description}
      domain={domain}
      image={image}
      useLargeImage={useLargeImage}
      theme={theme}
      onPress={onPress}
      onOpenMiniApp={onOpenMiniApp}
    />
  );
}

/**
 * Wraps `LinkPreview` with a `.well-known/farcaster.json` probe so
 * hypersnap-sourced embeds (which arrive without OG enrichment) still
 * render as miniapp cards when the host publishes a manifest. While the
 * probe is in flight we render the regular link preview — it's already a
 * reasonable fallback. On success we swap to a frame-style launch card.
 *
 * Skipped for URLs that already came with OG/title from a legacy or
 * cached upstream — those don't benefit from the network round-trip and
 * the title is usually a better signal than the manifest name anyway.
 */
function MiniappAwareLinkPreview({
  url,
  title,
  description,
  domain,
  image,
  useLargeImage,
  theme,
  onPress,
  onOpenMiniApp,
}: {
  url?: string;
  title?: string;
  description?: string;
  domain?: string;
  image?: string;
  useLargeImage?: boolean;
  theme: AppTheme;
  onPress?: () => void;
  onOpenMiniApp?: (url: string) => void;
}) {
  // Probe only when we lack OG enrichment — saves a hit per cell for
  // already-enriched legacy embeds.
  const shouldProbe = Boolean(url) && !title;
  const { data: manifest } = useMiniappManifest(url, { enabled: shouldProbe });
  // Page-level OG / inline-miniapp scrape, only when the manifest
  // didn't resolve. Runs sequentially with the manifest probe so we
  // don't issue both requests for the same URL.
  const ogEnabled = shouldProbe && !manifest;
  const { data: og } = useOgMetadata(url, { enabled: ogEnabled });

  // Self-hosted manifest wins — strongest signal.
  if (manifest) {
    return (
      <FrameEmbed
        imageUrl={manifest.imageUrl ?? manifest.iconUrl}
        buttonTitle={manifest.buttonTitle ?? 'Open'}
        actionUrl={manifest.homeUrl}
        theme={theme}
        onPress={() => onOpenMiniApp?.(manifest.homeUrl)}
      />
    );
  }
  // Inline fc:miniapp / fc:frame meta tag (the page itself ships the
  // launch metadata, but no .well-known manifest).
  if (og?.miniapp?.homeUrl) {
    const m = og.miniapp;
    return (
      <FrameEmbed
        imageUrl={m.imageUrl ?? m.iconUrl ?? og.image ?? ''}
        buttonTitle={m.buttonTitle ?? 'Open'}
        actionUrl={m.homeUrl!}
        theme={theme}
        onPress={() => onOpenMiniApp?.(m.homeUrl!)}
      />
    );
  }
  // Page-scraped OG enriches a plain link card.
  if (og?.title) {
    return (
      <LinkPreview
        url={url}
        title={og.title}
        description={og.description ?? description}
        domain={og.siteName ?? og.domain ?? domain}
        image={og.image ?? image}
        useLargeImage={useLargeImage}
        theme={theme}
        onPress={onPress}
      />
    );
  }

  return (
    <LinkPreview
      url={url}
      title={title}
      description={description}
      domain={domain}
      image={image}
      useLargeImage={useLargeImage}
      theme={theme}
      onPress={onPress}
    />
  );
}

/**
 * Render inline YouTube players for any YouTube URLs that appear in the cast
 * body but aren't already covered by an explicit embed. Returns null when none.
 */
function InlineYouTubeFromText({
  text,
  excludeUrls,
  theme,
}: {
  text: string | undefined;
  excludeUrls: (string | undefined)[];
  theme: AppTheme;
}) {
  const matches = useMemo(
    () => extractYouTubeMatchesFromText(text, excludeUrls),
    [text, excludeUrls],
  );
  if (matches.length === 0) return null;
  return (
    <View style={{ gap: Skin.space(8) }}>
      {matches.map(({ url, match }) => (
        <YouTubeEmbed
          key={url}
          videoId={match.videoId}
          playlistId={match.playlistId}
          theme={theme}
        />
      ))}
    </View>
  );
}

function QuoteCast({
  cast,
  theme,
  onPress,
}: {
  cast: EmbeddedCast;
  theme: AppTheme;
  onPress?: () => void;
}) {
  // Hypersnap quote-cast embeds arrive as bare { fid, hash } stubs — no
  // author/text/image data inline. When we see an empty stub, lazily
  // fetch the real cast and render those fields instead. Cached with
  // gcTime: Infinity so a quoted cast we've seen once stays warm.
  const isStub =
    !cast.author?.username &&
    !cast.author?.displayName &&
    (!cast.text || cast.text.trim().length === 0);
  const enableResolve = isStub && Boolean(cast.hash) && Boolean(cast.author?.fid);
  const { data: resolvedCast } = useFarcasterCast(
    enableResolve ? cast.hash : undefined,
    enableResolve ? cast.author!.fid : undefined,
    { enabled: enableResolve, gcTime: 10 * 60 * 1000 },
  );

  const displayName = cast.author?.displayName || resolvedCast?.author.displayName || '';
  const username = cast.author?.username || resolvedCast?.author.username || '';
  const pfpUrl = cast.author?.pfp?.url || resolvedCast?.author.pfpUrl;
  const text = cast.text || resolvedCast?.text || '';
  const inlineImage = cast.embeds?.images?.[0]?.url;
  const resolvedImage =
    resolvedCast?.embeds.find((e) => e.image?.url)?.image?.url
    ?? resolvedCast?.embeds.find((e) => e.url && /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(e.url))?.url;
  const previewImage = inlineImage || resolvedImage;
  const hasImage = Boolean(previewImage);

  // While the lookup is still in flight, render a minimal loading skeleton
  // rather than a blank card so the user knows there's something here.
  if (isStub && !resolvedCast) {
    return (
      <View
        style={{
          backgroundColor: theme.colors.surface2,
          borderRadius: Skin.radius(12),
          padding: Skin.space(12),
          marginHorizontal: Skin.space(12),
          borderWidth: Skin.border(1),
          borderColor: theme.colors.surface3,
          flexDirection: 'row',
          alignItems: 'center',
          gap: Skin.space(8),
        }}
      >
        <ActivityIndicator size="small" color={theme.colors.textMuted} />
        <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13) }}>
          Loading quoted cast…
        </Text>
      </View>
    );
  }

  return (
    <TouchableOpacity
      style={{
        backgroundColor: theme.colors.surface2,
        borderRadius: Skin.radius(12),
        overflow: 'hidden',
        marginHorizontal: Skin.space(12),
        borderWidth: Skin.border(1),
        borderColor: theme.colors.surface3,
      }}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <View style={{ padding: Skin.space(12) }}>
        {/* Author row */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: Skin.space(8) }}>
          <CachedAvatar
            source={pfpUrl ? { uri: pfpUrl } : null}
            fallbackName={displayName || username}
            style={{
              width: 24,
              height: 24,
              borderRadius: Skin.radius(12),
              marginRight: Skin.space(8),
              backgroundColor: theme.colors.surface3,
            }}
          />
          <Text style={{ color: theme.colors.textStrong, fontWeight: '600', fontSize: Skin.font(14) }}>
            {displayName}
          </Text>
          {username && (
            <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13), marginLeft: Skin.space(4) }}>
              @{username}
            </Text>
          )}
        </View>
        {/* Cast text */}
        {text.length > 0 && (
          <Text
            style={{
              color: theme.colors.textMain,
              fontSize: Skin.font(14),
              lineHeight: Skin.font(20),
            }}
            numberOfLines={4}
          >
            {text}
          </Text>
        )}
      </View>
      {/* Image preview */}
      {hasImage && previewImage && (
        <Image
          source={{ uri: previewImage }}
          style={{
            width: '100%',
            height: 150,
            backgroundColor: theme.colors.surface3,
          }}
          resizeMode="contain"
        />
      )}
    </TouchableOpacity>
  );
}

/**
 * Render a `https://farcaster.xyz/<username>/0x<prefix>` link inline as a
 * quote-cast card. The Farcaster client treats these URLs as cast embeds
 * even when the protocol-level cast.embeds.casts list omits them, so we
 * lazily resolve the cast by (username, prefix) via legacy thread API and
 * render it through the same `QuoteCast` component used for native quote
 * embeds. While the lookup is in flight we show the QuoteCast loading
 * skeleton (matches isStub branch). On a failed/empty lookup we fall back
 * to a minimal "View cast" link card so the link is still actionable.
 */
function FarcasterCastUrlEmbed({
  username,
  castHashPrefix,
  fallbackTitle,
  fallbackDescription,
  theme,
  onPress,
}: {
  username: string;
  castHashPrefix: string;
  fallbackTitle?: string;
  fallbackDescription?: string;
  theme: AppTheme;
  onPress: () => void;
}) {
  const { data: cast, isLoading } = useFarcasterCastByUrl(username, castHashPrefix);

  if (cast) {
    const embedded: EmbeddedCast = {
      hash: cast.hash,
      author: {
        fid: cast.author.fid,
        displayName: cast.author.displayName,
        username: cast.author.username,
        pfp: cast.author.pfpUrl ? { url: cast.author.pfpUrl } : undefined,
      },
      text: cast.text,
      timestamp: cast.timestamp,
      embeds: {
        images: cast.embeds
          .filter((e) => e.image?.url)
          .map((e) => ({ url: e.image!.url!, alt: e.image!.alt })),
        videos: cast.embeds
          .filter((e) => e.video?.url)
          .map((e) => ({ url: e.video!.url, thumbnailUrl: e.video!.thumbnailUrl })),
      },
      replies: { count: cast.reactions.repliesCount },
      reactions: { count: cast.reactions.likesCount },
    };
    return <QuoteCast cast={embedded} theme={theme} onPress={onPress} />;
  }

  if (isLoading) {
    return (
      <View
        style={{
          backgroundColor: theme.colors.surface2,
          borderRadius: Skin.radius(12),
          padding: Skin.space(12),
          marginHorizontal: Skin.space(12),
          borderWidth: Skin.border(1),
          borderColor: theme.colors.surface3,
          flexDirection: 'row',
          alignItems: 'center',
          gap: Skin.space(8),
        }}
      >
        <ActivityIndicator size="small" color={theme.colors.textMuted} />
        <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13) }}>
          Loading quoted cast…
        </Text>
      </View>
    );
  }

  // Resolution failed — render a minimal link card so the URL is still
  // tappable (e.g., when the cast has been deleted server-side).
  return (
    <TouchableOpacity
      style={{
        backgroundColor: theme.colors.surface2,
        borderRadius: Skin.radius(12),
        padding: Skin.space(12),
        borderWidth: Skin.border(1),
        borderColor: theme.colors.surface3,
      }}
      onPress={onPress}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(8) }}>
        <IconSymbol name="bubble.left.and.bubble.right" color={theme.colors.accent} size={16} />
        <Text style={{ color: theme.colors.textStrong, fontWeight: '600', flex: 1 }} numberOfLines={1}>
          {fallbackTitle || 'View cast'}
        </Text>
        <IconSymbol name="chevron.right" color={theme.colors.textMuted} size={14} />
      </View>
      {fallbackDescription && (
        <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13), marginTop: Skin.space(4) }} numberOfLines={2}>
          {fallbackDescription}
        </Text>
      )}
    </TouchableOpacity>
  );
}

function FrameEmbed({
  imageUrl,
  buttonTitle,
  actionUrl,
  theme,
  onPress,
}: {
  imageUrl: string;
  buttonTitle: string;
  actionUrl: string;
  theme: AppTheme;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.9}
      style={{ overflow: 'hidden' }}
    >
      <Image
        source={{ uri: imageUrl }}
        style={{
          width: SCREEN_WIDTH,
          height: SCREEN_WIDTH * 0.525, // Standard frame aspect ratio
          backgroundColor: theme.colors.surface3,
        }}
        resizeMode="cover"
      />
      <View
        style={{
          backgroundColor: theme.colors.surface2,
          paddingVertical: Skin.space(12),
          paddingHorizontal: Skin.space(16),
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          borderTopWidth: Skin.border(1),
          borderTopColor: theme.colors.surface3,
        }}
      >
        <Text
          style={{
            color: theme.colors.textStrong,
            fontSize: Skin.font(15),
            fontWeight: '600',
          }}
        >
          {buttonTitle}
        </Text>
        <IconSymbol
          name="arrow.up.right"
          color={theme.colors.textMuted}
          size={14}
          style={{ marginLeft: Skin.space(6) }}
        />
      </View>
    </TouchableOpacity>
  );
}

function ThreadDetailView({
  username,
  castHashPrefix,
  token,
  theme,
  onClose,
  onOpenMiniApp,
  onOpenProfile,
  onOpenChannel,
  onOpenThread,
  likeStates,
  onLikeToggle,
  onRecastToggle,
  recastStates,
  onQuoteCast,
  onShareToChat,
  followStates,
  onFollow,
  focusReply = false,
  placeholderCast,
  bottomInset = 0,
  currentUserFid,
  onTipPress,
  maxCastLength = DEFAULT_CAST_LENGTH,
  regularCastByteLimit = DEFAULT_CAST_LENGTH,
  governanceByHash,
  onGovernanceVoted,
}: {
  username: string;
  castHashPrefix: string;
  token?: string;
  theme: AppTheme;
  onClose: () => void;
  onOpenMiniApp: (url: string) => void;
  onOpenProfile: (fid: number, username?: string) => void;
  onOpenChannel: (channelKey: string) => void;
  onOpenThread: (username: string, castHashPrefix: string, placeholderCast?: unknown) => void;
  likeStates: Map<string, { liked: boolean; count: number }>;
  onLikeToggle: (castHash: string, currentlyLiked: boolean, currentCount: number) => void;
  onRecastToggle: (castHash: string, currentlyRecasted: boolean, currentCount: number) => void;
  recastStates: Map<string, { recasted: boolean; count: number }>;
  onQuoteCast: (castHash: string, castAuthor: string, castText: string) => void;
  onShareToChat: (castUrl: string) => void;
  followStates: Map<number, boolean>;
  onFollow: (fid: number) => void;
  focusReply?: boolean;
  /** Optional cast snapshot from the surface that pushed this screen.
   *  Used as the mainCast while the network fetch is in flight so the
   *  user sees real content immediately instead of a blank spinner. */
  placeholderCast?: unknown;
  bottomInset?: number;
  currentUserFid?: number;
  /** Opens the tip flow for a cast. Tip button hidden when omitted. */
  onTipPress?: (target: TipTarget) => void;
  maxCastLength?: number;
  regularCastByteLimit?: number;
  /** /hegemony proposals keyed by 0x hash — overlays vote tallies + voter
   *  points onto a proposal's thread. Absent for normal threads. */
  governanceByHash?: Map<string, GovernanceChannelCast>;
  onGovernanceVoted?: () => void;
}) {
  const optimistic = useFeedOptimistic();
  const { parentCasts, mainCast: fetchedMainCast, replies, allCasts, isLoading, error, channelContext, refetch } = useFarcasterThread({
    username,
    castHashPrefix,
    token,
    // Merge optimistic pending replies into the thread so a just-posted
    // reply shows instantly in the right place.
    getPendingReplies: optimistic.pendingRepliesAsThreadCasts,
  });
  // Use the fetched cast once it arrives; fall back to the placeholder
  // for the loading window. Cast shapes from FeedPostCard / search /
  // channel are structurally compatible enough that the renderer below
  // tolerates either — it reads optional fields lazily.
  const mainCast = fetchedMainCast ?? (placeholderCast as typeof fetchedMainCast | undefined);

  // When fresh server thread data arrives: drop optimistic pending replies
  // it now echoes back (matched by author + text + timestamp), and drop
  // reaction overrides the server now reflects (so the live count shows
  // through again instead of the frozen click-time count).
  useEffect(() => {
    if (allCasts && allCasts.length) {
      // Primary: drop a sent reply stub once its real server copy appears in
      // the thread, matched by confirmed hash. Match against SERVER casts
      // only — the merged pending stubs carry their own `realHash`, so
      // including them would make a stub reconcile itself away before the
      // real cast actually lands. (The text+timestamp `reconcilePending`
      // can't match reply stubs anyway: optimistic timestamps are Date.now()
      // ms while server cast timestamps are seconds.)
      const serverHashes = allCasts
        .filter((c) => !(c as { __pending?: unknown }).__pending)
        .map((c) => (c as { hash?: string }).hash)
        .filter((h): h is string => !!h);
      optimistic.reconcilePendingByHash(serverHashes);
      optimistic.reconcilePending(allCasts);
      optimistic.reconcileReactions(allCasts);
    }
    // reconcile* are stable module refs; depend on them (not the whole
    // `optimistic` object, which is a new identity each render) so this
    // runs only when the server thread data actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCasts, optimistic.reconcilePendingByHash, optimistic.reconcilePending, optimistic.reconcileReactions]);

  // Apex gold ring — batched status lookup over every author visible in
  // the thread (parents + main + replies). Degrades silently to no rings.
  const threadAuthorFids = React.useMemo(() => {
    const fids = new Set<number>();
    const mainFid = (mainCast as { author?: { fid?: number } } | undefined)?.author?.fid;
    if (mainFid) fids.add(mainFid);
    for (const c of allCasts ?? []) {
      if (c.author?.fid) fids.add(c.author.fid);
    }
    return Array.from(fids);
  }, [mainCast, allCasts]);
  const apexFids = useApexStatusForFids(threadAuthorFids);

  // /hegemony overlay: when the thread's root cast is a proposal, surface the
  // weighted tally + per-voter points (normal threads show none of this).
  const govProposal = (mainCast as { hash?: string } | undefined)?.hash
    ? governanceByHash?.get(((mainCast as { hash: string }).hash).toLowerCase())
    : undefined;
  const govFidPoints = React.useMemo(() => {
    const m = new Map<number, number>();
    const walk = (rs: GovernanceCastReply[]) => {
      for (const r of rs) {
        m.set(r.authorFid, r.points);
        if (r.replies?.length) walk(r.replies);
      }
    };
    if (govProposal) walk(govProposal.directReplies);
    return m;
  }, [govProposal]);

  // Get current user info for inline reply editor
  const { user: currentUser } = useAuth();
  // Fetch live Farcaster profile so the reply composer shows the user's
  // current Farcaster avatar (the cached pfpUrl in user state may be missing
  // or stale — falling back to it leaves CachedAvatar showing the Quorum
  // default symbol).
  const { author: currentFarcasterProfile } = useFarcasterProfile({
    fid: currentUser?.farcaster?.fid ?? 0,
    token,
    enabled: Boolean(currentUser?.farcaster?.fid),
  });
  const replyAvatarUri =
    currentFarcasterProfile?.pfp?.url ??
    currentUser?.farcaster?.pfpUrl ??
    null;
  const scrollViewRef = useRef<ScrollView>(null);
  const replyInputRef = useRef<TextInput>(null);
  const [isEditorFocused, setIsEditorFocused] = useState(false);
  // Track whether the inline reply editor is in the scroll viewport. Used
  // to hide the floating reply FAB when the user can already see the
  // composer (focus alone isn't enough — they may have scrolled to it
  // without focusing yet).
  const editorYRef = useRef<number | null>(null);
  const [isEditorVisible, setIsEditorVisible] = useState(false);

  // Blocked/muted-user replies are collapsed to a tap-to-reveal placeholder
  // in the thread (the main cast is never hidden — you navigated to it).
  // `revealedBlocked` holds the hashes the viewer chose to expand.
  const { fids: blockedFids } = useBlockedFids();
  const { fids: mutedFids } = useMutedFids();
  const [revealedBlocked, setRevealedBlocked] = useState<Set<string>>(() => new Set());

  // Tap target for both the floating FAB and the auto-scroll-on-mount
  // useEffect below. Focus first so the keyboard starts opening, then
  // scroll twice — once immediately, and once after the keyboard
  // transition completes so we land *above* the now-raised keyboard.
  const scrollToReplyAndFocus = useCallback(() => {
    replyInputRef.current?.focus();
    scrollViewRef.current?.scrollToEnd({ animated: true });
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 350);
  }, []);

  // Auto-scroll to reply editor and focus when navigated via reply button
  useEffect(() => {
    if (focusReply && mainCast && !isLoading) {
      const t = setTimeout(scrollToReplyAndFocus, 300);
      return () => clearTimeout(t);
    }
  }, [focusReply, mainCast, isLoading, scrollToReplyAndFocus]);

  // Reply state
  const [replyText, setReplyText] = useState('');
  const [replyCursorPosition, setReplyCursorPosition] = useState(0);
  const [isPosting, setIsPosting] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replyImages, setReplyImages] = useState<ProcessedAttachment[]>([]);

  // Mention autocomplete state for reply
  const replyMentionInfo = useMemo(
    () => getMentionInfo(replyText, replyCursorPosition),
    [replyText, replyCursorPosition]
  );

  // Handle selecting a user mention in reply
  const handleReplySelectUser = useCallback((user: SearchUser) => {
    if (!replyMentionInfo) return;
    const newText = replaceMention(replyText, replyMentionInfo, user.username);
    setReplyText(newText.slice(0, maxCastLength));
    // Move cursor to after the inserted mention
    setReplyCursorPosition(replyMentionInfo.replaceStart + user.username.length + 1);
  }, [replyText, replyMentionInfo, maxCastLength]);

  // Handle selecting a channel mention in reply
  const handleReplySelectChannel = useCallback((channel: SearchChannel) => {
    if (!replyMentionInfo) return;
    const newText = replaceMention(replyText, replyMentionInfo, channel.key);
    setReplyText(newText.slice(0, maxCastLength));
    // Move cursor to after the inserted mention
    setReplyCursorPosition(replyMentionInfo.replaceStart + channel.key.length + 1);
  }, [replyText, replyMentionInfo, maxCastLength]);

  // Share action sheet state
  const [shareSheetCast, setShareSheetCast] = useState<{
    hash: string;
    author: string;
    authorFid?: number;
    text: string;
    isRecasted: boolean;
    recastCount: number;
  } | null>(null);
  // Separate state for the report flow so the report modal can stay open
  // after the share sheet is dismissed without juggling shared state.
  const [reportCastTarget, setReportCastTarget] = useState<{
    castHash: string;
    castAuthorFid?: number;
  } | null>(null);

  // Allow replying if there's text OR images
  const canReply = Boolean(token && (replyText.trim().length > 0 || replyImages.length > 0) && !isPosting && mainCast);

  const handlePickReplyImage = async () => {
    if (replyImages.length >= 2) {
      setReplyError('Maximum 2 images per reply');
      return;
    }
    const result = await pickMedia('library');
    if (result.success && result.attachment) {
      setReplyImages(prev => [...prev, result.attachment!]);
      setReplyError(null);
    } else if (result.error) {
      setReplyError(result.error);
    }
  };

  const handleRemoveReplyImage = (index: number) => {
    setReplyImages(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmitReply = async () => {
    if (!canReply || !mainCast) return;
    setReplyError(null);
    const text = replyText.trim();

    try {
      setIsPosting(true);

      // Upload any attachments first — their URLs are needed for the cast.
      // Videos go through TUS upload, images through the direct upload.
      const embeds: string[] = [];
      for (const a of replyImages) {
        try {
          if (a.kind === 'video') {
            const v = await uploadVideoForCast(token!, a.localUri);
            embeds.push(v.url);
          } else {
            const uploaded = await uploadImageForCast(token!, a.localUri, a.mimeType);
            embeds.push(uploaded.url);
          }
        } catch (uploadErr: any) {
          // Nothing was posted yet — keep the text so it isn't lost.
          setReplyError(`Failed to upload attachment: ${uploadErr?.message ?? 'Unknown error'}`);
          setIsPosting(false);
          return;
        }
      }

      // Optimistically insert the reply and submit it in the background
      // (with auto-retry). The composer clears, but the text lives in the
      // pending stub — a failed send is recoverable, never lost. The reply
      // shows instantly in the thread via the merge above.
      optimistic.postReply({
        threadHash: mainCast.hash,
        parentHash: mainCast.hash,
        parentFid: mainCast.author.fid,
        text,
        embedUrls: embeds,
      });
      setReplyText('');
      setReplyImages([]);
    } catch (err: unknown) {
      logger.warn(
        '[SocialFeedModal] reply submit threw:',
        err instanceof Error ? err.message : String(err),
      );
      setReplyError(err instanceof Error ? err.message : 'Failed to post reply');
    } finally {
      setIsPosting(false);
    }
  };

  const handleMentionPress = async (mentionUsername: string) => {
    try {
      const response = await fetch(`https://farcaster.xyz/~api/v2/user-by-username?username=${mentionUsername}`, {
        headers: {
          accept: '*/*',
          origin: 'https://farcaster.xyz',
          referer: 'https://farcaster.xyz/',
        },
      });
      if (response.ok) {
        const json = await response.json();
        if (json.result?.fid) {
          onOpenProfile(json.result.fid, mentionUsername);
        }
      }
    } catch {
      // Profile lookup failed — no action needed
    }
  };

  // Image viewer state
  const [viewerState, setViewerState] = useState<{ images: string[]; index: number } | null>(null);

  // Channel URLs we never want to surface as a reply context — they're
  // already rendered as the channel badge in the header row.
  const isChannelParentUrl = (url: string | undefined) => looksLikeChannelUrl(url);

  // True when mainCast's immediate parent is the cast directly above it
  // in `parentCasts` — i.e., the parent chain we render up-screen already
  // contains the reply target, so the ParentContextLine mini-preview
  // would be a duplicate.
  const mainParentHash = (mainCast as { parentHash?: string } | undefined)?.parentHash?.toLowerCase();
  const parentInChain =
    !!mainParentHash &&
    parentCasts.some((p) => p.hash.toLowerCase() === mainParentHash);

  // Compact renderer for an optimistic pending reply: shows the text
  // immediately with a status line ("Sending…" or, after the background
  // submit exhausts its retries, "Failed to send" with Retry / Discard so
  // the user is reprompted — the text is never lost).
  const renderPendingReply = (cast: FlattenedCast, pending: PendingCast) => {
    const indent = Math.min(cast.depth * 12, 48);
    const failed = pending.status === 'failed';
    // 'sent' = the submit landed (realHash set); we're just waiting for the
    // server to index it so the real cast replaces this stub. Show it as
    // settled, not still "Sending…", so it never looks stuck.
    const sent = pending.status === 'sent';
    // Always the current user, so prefer the freshly-resolved Farcaster avatar
    // over the (possibly stale/missing) cached pfp on the pending author.
    const avatarUri = replyAvatarUri ?? pending.author.pfpUrl;
    const handle = pending.author.username ? `@${pending.author.username}` : '';
    const statusText = failed ? 'Failed to send' : sent ? 'Posted' : 'Sending…';
    return (
      <View
        key={pending.localId}
        style={{
          paddingLeft: 16 + indent,
          paddingRight: 16,
          paddingVertical: 12,
          flexDirection: 'row',
          opacity: failed || sent ? 1 : 0.7,
        }}
      >
        {/* Avatar — mirrors a real cast row */}
        <CachedAvatar
          source={avatarUri ? { uri: avatarUri } : null}
          fallbackName={pending.author.displayName || pending.author.username}
          style={{
            width: 44,
            height: 44,
            borderRadius: Skin.radius(22),
            backgroundColor: theme.colors.surface3,
            marginRight: Skin.space(12),
          }}
        />
        <View style={{ flex: 1 }}>
          {/* Header: display name */}
          <Text
            style={{ color: theme.colors.textStrong, fontWeight: '600', fontSize: Skin.font(15) }}
            numberOfLines={1}
          >
            {pending.author.displayName || pending.author.username || 'You'}
          </Text>
          {/* Handle • status (status sits where the timestamp would) */}
          <Text style={{ fontSize: Skin.font(13), marginTop: Skin.space(2) }} numberOfLines={1}>
            <Text style={{ color: theme.colors.textMuted }}>{handle ? `${handle} • ` : ''}</Text>
            <Text style={{ color: failed ? theme.colors.danger : theme.colors.textMuted }}>
              {statusText}
            </Text>
          </Text>
          {/* Body */}
          <Text
            style={{
              color: theme.colors.textMain,
              fontSize: Skin.font(15),
              lineHeight: Skin.font(21),
              marginTop: Skin.space(6),
            }}
          >
            {pending.text}
          </Text>
          {/* Failed-state actions */}
          {failed && (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: Skin.space(8), gap: Skin.space(16) }}>
              <TouchableOpacity onPress={() => optimistic.retryPending(pending.localId)} hitSlop={8}>
                <Text style={{ color: theme.colors.primary, fontSize: Skin.font(13), fontWeight: '600' }}>
                  Retry
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => optimistic.discardPending(pending.localId)} hitSlop={8}>
                <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13) }}>Discard</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    );
  };

  const renderCast = (cast: FlattenedCast, isMain = false, showBackArrow = false) => {
    // Defensive: a malformed cast (typically a placeholder passed in
    // from a surface whose shape differs from the thread API) used to
    // crash here at `cast.author.fid`. Render nothing instead of
    // throwing — the real cast replaces this on fetch completion.
    if (!cast || !cast.author) return null;

    // Optimistic pending reply (not yet confirmed by the server).
    const pendingReply = (cast as { __pending?: PendingCast }).__pending;
    if (pendingReply) return renderPendingReply(cast, pendingReply);

    // Optimistically deleted (the user just removed it) — hide immediately.
    if (cast.hash && optimistic.isDeleted(cast.hash)) return null;

    // Governance: annotate FOR/AGAINST vote replies with the voter's points,
    // but only inside a proposal thread (never in a normal thread).
    const govVote = !isMain && govProposal ? parseGovernanceVote(cast.text ?? '') : null;
    const govVotePts = govVote ? govFidPoints.get(cast.author.fid) ?? 0 : 0;

    // Blocked/muted authors' replies render as a tap-to-reveal placeholder.
    // Never applied to the main cast (the one the viewer opened).
    const isBlockedAuthor = !isMain && cast.author.fid > 0 && blockedFids.has(cast.author.fid);
    const isMutedAuthor = !isMain && cast.author.fid > 0 && mutedFids.has(cast.author.fid);
    if ((isBlockedAuthor || isMutedAuthor) && !revealedBlocked.has(cast.hash)) {
      const blockedBorderWidth = cast.depth > 0 ? Math.min(cast.depth * 2, 6) : 0;
      const verb = isBlockedAuthor ? 'blocked' : 'muted';
      return (
        <TouchableOpacity
          key={cast.hash}
          activeOpacity={0.7}
          onPress={() =>
            setRevealedBlocked((prev) => {
              const next = new Set(prev);
              next.add(cast.hash);
              return next;
            })
          }
          style={{
            borderTopWidth: Skin.border(1),
            borderTopColor: theme.colors.surface3,
            paddingVertical: Skin.space(14),
            borderLeftWidth: blockedBorderWidth,
            borderLeftColor: theme.colors.accent,
            paddingLeft: Skin.space(12),
            paddingRight: Skin.space(12),
            flexDirection: 'row',
            alignItems: 'center',
            gap: Skin.space(8),
          }}
        >
          <IconSymbol name="nosign" color={theme.colors.textMuted} size={16} />
          <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13) }}>
            This user has been {verb}, tap to show message
          </Text>
        </TouchableOpacity>
      );
    }

    const imageUrls = (cast.embeds?.images ?? [])
      .map((img) => img.url)
      .filter((url): url is string => Boolean(url));
    const hasImages = imageUrls.length > 0;
    // Some sources (hypersnap-bare URLs, m3u8 streams) ship a video
    // URL with no thumbnail. VideoPlayer renders a black poster +
    // play-icon overlay in that case, which is better than dropping
    // the embed entirely.
    const videos = (cast.embeds?.videos ?? []).filter((v) => Boolean(v.url));
    const hasVideos = videos.length > 0;

    // Each URL embed renders exactly once — SnapAwareUrlPreview decides between
    // snap UI, frame card, or plain link preview (no duplicates).
    const frameEmbeds: { imageUrl: string; buttonTitle: string; actionUrl: string }[] = [];
    const embeddedCasts = cast.embeds?.casts ?? [];
    const urlPreviews = (cast.embeds?.urls ?? [])
      .filter((u) => {
        if (u.openGraph?.frameEmbedNext?.frameUrl || u.openGraph?.frameEmbedNext?.frameEmbed?.imageUrl) return true;
        const url = u.openGraph?.url || u.openGraph?.sourceUrl || '';
        // Drop farcaster.xyz cast links that are already shown as a quote cast
        if (url.includes('farcaster.xyz/')) {
          const parsed = parseFarcasterUrl(url);
          if (parsed) {
            const alreadyEmbedded = embeddedCasts.some((c: any) =>
              c?.hash?.toLowerCase().startsWith(parsed.castHashPrefix.toLowerCase())
            );
            if (alreadyEmbedded) return false;
          }
        }
        if (containsInviteLink(url)) return true;
        // Keep bare URLs — hypersnap doesn't enrich with OG, but
        // SnapAwareUrlPreview can still render the link.
        return Boolean(url);
      });

    const isNested = cast.depth > 0;
    const borderWidth = isNested ? Math.min(cast.depth * 2, 6) : 0;

    return (
      <View
        key={cast.hash}
        style={{
          borderTopWidth: isMain ? 0 : 1,
          borderTopColor: theme.colors.surface3,
          paddingTop: isMain ? 0 : 12,
          paddingBottom: Skin.space(14),
          borderLeftWidth: borderWidth,
          borderLeftColor: theme.colors.accent,
          paddingLeft: isNested ? 12 : 12,
          paddingRight: Skin.space(12),
          gap: Skin.space(10),
        }}
      >
        {/* Header row */}
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {showBackArrow && (
            <TouchableOpacity
              onPress={onClose}
              style={{ marginRight: Skin.space(12) }}
            >
              <IconSymbol name="chevron.left" color={theme.colors.textMain} size={24} />
            </TouchableOpacity>
          )}
          <View style={{ position: 'relative', marginRight: Skin.space(12) }}>
            <TouchableOpacity onPress={() => onOpenProfile(cast.author.fid, cast.author.username)}>
              <ApexAvatarRing active={apexFids.has(cast.author.fid)} size={44}>
                <CachedAvatar
                  source={cast.author.pfp?.url ? { uri: cast.author.pfp.url } : null}
                  fallbackName={cast.author.displayName || cast.author.username}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: Skin.radius(22),
                    backgroundColor: theme.colors.surface3,
                  }}
                />
              </ApexAvatarRing>
            </TouchableOpacity>
            {/* Follow button - don't show for own profile */}
            {(() => {
              const isFollowing = followStates.get(cast.author.fid) ?? (cast.author.viewerContext?.following === false ? false : true);
              const isOwnProfile = currentUserFid && cast.author.fid === currentUserFid;
              return !isFollowing && cast.author.fid > 0 && !isOwnProfile && (
                <TouchableOpacity
                  style={{
                    position: 'absolute',
                    bottom: -2,
                    right: -2,
                    width: 18,
                    height: 18,
                    borderRadius: Skin.radius(9),
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: theme.colors.primary,
                    borderWidth: Skin.border(2),
                    borderColor: theme.colors.background,
                  }}
                  onPress={() => onFollow(cast.author.fid)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <IconSymbol name="plus" size={10} color="#fff" />
                </TouchableOpacity>
              );
            })()}
          </View>
          <View style={{ flex: 1 }}>
            {(() => {
              const chip = resolveChannelChip(cast.channel?.key, cast.channel?.name);
              const channelKey = chip?.key ?? null;
              const channelDisplayName = chip?.display ?? null;
              const channelName = channelKey ||
                (isMain && channelContext ? (channelContext.key || (channelContext.name ? channelContext.name.toLowerCase().replace(/\s+/g, '-') : null)) : null) ||
                extractChannelSlugFromUrl(cast.parentUrl);

              return (
                <>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6) }}>
                    <TouchableOpacity onPress={() => onOpenProfile(cast.author.fid, cast.author.username)}>
                      <Text style={{ color: theme.colors.textStrong, fontWeight: '600', fontSize: Skin.font(15) }}>
                        {cast.author.displayName}
                      </Text>
                    </TouchableOpacity>
                    {channelName ? (
                      <TouchableOpacity onPress={() => onOpenChannel(channelName)}>
                        <Text style={{ color: theme.colors.accent, fontSize: Skin.font(13) }}>
                          /{channelDisplayName || channelName}
                        </Text>
                      </TouchableOpacity>
                    ) : (
                      // Last-ditch resolution for chain://-based channels
                      // when hypersnap didn't return channel name/key —
                      // ChannelBadge has the lookup hook + caches
                      // results, and renders nothing if even the lookup
                      // fails (better than the raw URI).
                      <ChannelBadge
                        channelSlug={undefined}
                        parentUrl={cast.parentUrl}
                        theme={theme}
                        onOpenChannel={onOpenChannel}
                      />
                    )}
                  </View>
                  <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13), marginTop: Skin.space(2) }}>
                    @{cast.author.username} • {formatTimestamp(cast.timestamp)}
                  </Text>
                </>
              );
            })()}
          </View>
          <CastOverflowButton
            castHash={cast.hash}
            authorFid={cast.author.fid}
            authorUsername={cast.author.username}
            castText={cast.text}
            onReport={(hash, castAuthorFid) => setReportCastTarget({ castHash: hash, castAuthorFid })}
            onDelete={(hash) => optimistic.deleteCast(hash)}
            theme={theme}
          />
        </View>

        {/* Parent context - URL (non-channel), reply to user, or generic
            reply when only a parent hash is known. Suppress when the
            parent is already rendered above in the parent chain — the
            mini preview would just duplicate the cast already visible. */}
        {isMain && !parentInChain && (
          <ParentContextLine
            cast={cast}
            theme={theme}
            onNavigateToThread={(username, hash, focusReply, placeholder) =>
              onOpenThread(username, hash, placeholder)
            }
          />
        )}

        {/* Governance vote badge (proposal threads only) */}
        {govVote && (
          <Text
            style={{
              alignSelf: 'flex-start',
              marginBottom: Skin.space(4),
              fontSize: Skin.font(11),
              fontWeight: '700',
              borderWidth: 1,
              borderRadius: Skin.radius(4),
              paddingHorizontal: Skin.space(6),
              paddingVertical: Skin.space(1),
              color: govVote === 'for' ? theme.colors.accent : theme.colors.warning,
              borderColor: govVote === 'for' ? theme.colors.accent : theme.colors.warning,
            }}
          >
            {govVote === 'for' ? 'FOR' : 'AGAINST'} — {Math.floor(govVotePts).toLocaleString()} pts
          </Text>
        )}

        {/* Content */}
        {cast.text.trim().length > 0 && (
          <Translatable
            text={cast.text}
            theme={theme}
            renderText={(t) => (
              <CastText
                text={t}
                style={{ color: theme.colors.textMain, fontSize: Skin.font(15), lineHeight: Skin.font(20) }}
                theme={theme}
                onMentionPress={handleMentionPress}
                onChannelPress={onOpenChannel}
                onLinkPress={onOpenMiniApp}
              />
            )}
          />
        )}

        {/* Images - edge to edge */}
        {hasImages && (
          <View style={{ marginHorizontal: Skin.space(-12) - borderWidth }}>
            {imageUrls.length === 1 ? (
              <AutoHeightImage
                uri={imageUrls[0]}
                maxHeight={Infinity}
                style={{ backgroundColor: theme.colors.surface3 }}
                onPress={() => setViewerState({ images: imageUrls, index: 0 })}
              />
            ) : (
              <ImageCarousel
                urls={imageUrls}
                maxHeight={Infinity}
                theme={theme}
                onImagePress={(_, index) => setViewerState({ images: imageUrls, index })}
              />
            )}
          </View>
        )}

        {/* Videos - edge to edge */}
        {hasVideos && (
          <View style={{ marginHorizontal: Skin.space(-12) - borderWidth }}>
            {videos.map((video, index) => (
              <VideoPlayer
                key={index}
                url={video.url!}
                downloadUrl={(video as { sourceUrl?: string }).sourceUrl}
                thumbnailUrl={video.thumbnailUrl!}
                width={video.width}
                height={video.height}
                theme={theme}
              />
            ))}
          </View>
        )}

        {/* Frame embeds (mini apps) */}
        {frameEmbeds.length > 0 && (
          <View style={{ marginHorizontal: Skin.space(-12) - borderWidth, gap: Skin.space(8) }}>
            {frameEmbeds.map((frame, index) => (
              <FrameEmbed
                key={index}
                imageUrl={frame.imageUrl}
                buttonTitle={frame.buttonTitle}
                actionUrl={frame.actionUrl}
                theme={theme}
                onPress={() => onOpenMiniApp(frame.actionUrl)}
              />
            ))}
          </View>
        )}

        {/* URL previews (non-frame) — snap-aware */}
        {urlPreviews.length > 0 && (
          <View style={{ gap: Skin.space(8) }}>
            {urlPreviews.map((urlEmbed, index) => {
              const linkUrl = urlEmbed.openGraph?.url || urlEmbed.openGraph?.sourceUrl;
              const isQuorumInvite = linkUrl && containsInviteLink(linkUrl);
              if (isQuorumInvite) {
                return (
                  <InviteLinkCard
                    key={index}
                    inviteLink={linkUrl}
                  />
                );
              }
              const spaceRef = parseFarcasterSpaceUrl(linkUrl);
              if (spaceRef) {
                return (
                  <AudioSpaceEmbed
                    key={index}
                    spaceId={spaceRef.id}
                    castHash={cast.hash}
                    onFallbackOpen={() => linkUrl && onOpenMiniApp(linkUrl)}
                  />
                );
              }
              const tokenRef = parseFarcasterTokenUrl(linkUrl);
              if (tokenRef) {
                return (
                  <FarcasterTokenEmbed
                    key={index}
                    chain={tokenRef.chain}
                    contractAddress={tokenRef.contractAddress}
                    theme={theme}
                  />
                );
              }
              const parsedFc = linkUrl && linkUrl.includes('farcaster.xyz/')
                ? parseFarcasterUrl(linkUrl)
                : null;
              if (parsedFc) {
                return (
                  <FarcasterCastUrlEmbed
                    key={index}
                    username={parsedFc.username}
                    castHashPrefix={parsedFc.castHashPrefix}
                    fallbackTitle={urlEmbed.openGraph?.title}
                    fallbackDescription={urlEmbed.openGraph?.description}
                    theme={theme}
                    onPress={() => onOpenThread(parsedFc.username, parsedFc.castHashPrefix)}
                  />
                );
              }
              return (
                <SnapAwareUrlPreview
                  key={index}
                  url={linkUrl}
                  snapUrl={urlEmbed.openGraph?.frameEmbedNext?.frameUrl}
                  frameImageUrl={urlEmbed.openGraph?.frameEmbedNext?.frameEmbed?.imageUrl}
                  frameButtonTitle={urlEmbed.openGraph?.frameEmbedNext?.frameEmbed?.button?.title}
                  frameActionUrl={urlEmbed.openGraph?.frameEmbedNext?.frameEmbed?.button?.action?.url ?? linkUrl}
                  title={urlEmbed.openGraph?.title}
                  description={urlEmbed.openGraph?.description}
                  domain={urlEmbed.openGraph?.domain}
                  image={urlEmbed.openGraph?.image}
                  useLargeImage={urlEmbed.openGraph?.useLargeImage}
                  theme={theme}
                  onPress={linkUrl ? () => onOpenMiniApp(linkUrl) : undefined}
                  userFid={currentUserFid}
                  token={token}
                  onOpenUrl={(u) => onOpenMiniApp(u)}
                  onOpenProfile={(fid) => onOpenProfile(fid)}
                  onOpenMiniApp={(u) => onOpenMiniApp(u)}
                />
              );
            })}
          </View>
        )}

        {/* Inline YouTube URLs in cast text (deduped against explicit embeds) */}
        <InlineYouTubeFromText
          text={cast.text}
          excludeUrls={(cast.embeds?.urls ?? []).map((u: any) => u.openGraph?.url ?? u.openGraph?.sourceUrl)}
          theme={theme}
        />

        {/* Embedded casts (quote casts) */}
        {cast.embeds?.casts && cast.embeds.casts.length > 0 && (
          <View style={{ gap: Skin.space(8) }}>
            {cast.embeds.casts.map((embeddedCast, index) => (
              <QuoteCast
                key={index}
                cast={embeddedCast as EmbeddedCast}
                theme={theme}
                onPress={() => onOpenThread(embeddedCast.author.username, embeddedCast.hash, embeddedCast)}
              />
            ))}
          </View>
        )}

        {/* Stats row */}
        {(() => {
          const optimistic = likeStates.get(cast.hash);
          const isLiked = optimistic?.liked ?? cast.viewerContext?.reacted ?? false;
          const likeCount = optimistic?.count ?? (cast.reactions?.count ?? 0);
          const recastOptimistic = recastStates.get(cast.hash);
          const isRecasted = recastOptimistic?.recasted ?? cast.viewerContext?.recast ?? false;
          const recastCount = recastOptimistic?.count ?? (cast.recasts?.count ?? 0);
          return (
            <View style={{ flexDirection: 'row', gap: Skin.space(16), marginTop: Skin.space(4) }}>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6) }}
                onPress={() => onLikeToggle(cast.hash, isLiked, likeCount)}
                hitSlop={12}
              >
                <LikeIcon
                  type={getLikeIconType(cast.text)}
                  isLiked={isLiked}
                  color={theme.colors.textMuted}
                  activeColor={theme.colors.danger}
                  size={20}
                />
                {likeCount > 0 && (
                  <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13) }}>{likeCount}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6), paddingVertical: Skin.space(4), paddingHorizontal: Skin.space(2) }}
                onPress={() => onOpenThread(cast.author.username, cast.hash.slice(0, 10), cast)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <IconSymbol name="bubble.left" color={theme.colors.textMuted} size={20} />
                {(cast.replies?.count ?? 0) > 0 && (
                  <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13) }}>{cast.replies?.count}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6), paddingVertical: Skin.space(4), paddingHorizontal: Skin.space(2) }}
                onPress={() => {
                  setShareSheetCast({
                    hash: cast.hash,
                    author: cast.author.username,
                    authorFid: cast.author.fid,
                    text: cast.text || '',
                    isRecasted,
                    recastCount,
                  });
                }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <IconSymbol
                  name="arrow.triangle.2.circlepath"
                  color={isRecasted ? theme.colors.success : theme.colors.textMuted}
                  size={20}
                />
                {recastCount > 0 && (
                  <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13) }}>{recastCount}</Text>
                )}
              </TouchableOpacity>
              {onTipPress && cast.author.fid > 0 && cast.author.fid !== currentUserFid && (
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6), paddingVertical: Skin.space(4), paddingHorizontal: Skin.space(2) }}
                  onPress={() => onTipPress({
                    castHash: cast.hash,
                    castText: cast.text ?? '',
                    authorFid: cast.author.fid,
                    authorUsername: cast.author.username,
                    authorDisplayName: cast.author.displayName,
                  })}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <SnapIcon color={theme.colors.textMuted} size={24} />
                </TouchableOpacity>
              )}
            </View>
          );
        })()}
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      // Android Modal contexts ignore `adjustResize` from the
      // manifest and default to `adjustNothing`, so `behavior:
      // undefined` left the reply composer hidden behind the
      // keyboard. `height` is the correct Android counterpart to
      // iOS `padding` for this layout — both keep the bottom of the
      // KAV pinned to the keyboard top edge.
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? (8 + 32 + Math.max(8, bottomInset)) : 0}
    >
    <View style={{ flex: 1, backgroundColor: theme.colors.surface1 }}>
      {error && (
        <View style={{ padding: Skin.space(20) }}>
          <Text style={{ color: theme.colors.danger }}>{error}</Text>
        </View>
      )}

      {mainCast && (
        <ScrollView
          ref={scrollViewRef}
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingBottom: Skin.space(16),
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onScroll={(e) => {
            const editorY = editorYRef.current;
            if (editorY == null) return;
            const { contentOffset, layoutMeasurement } = e.nativeEvent;
            const visible = contentOffset.y + layoutMeasurement.height >= editorY;
            setIsEditorVisible((prev) => (prev === visible ? prev : visible));
          }}
          scrollEventThrottle={32}
        >
          {/* Parent chain — when entering from a reply notification we
              land on the reply itself; the parent casts above give the
              conversation context. The back arrow goes on the topmost
              visible cast (parentCasts[0] when present, otherwise
              mainCast) so it sits at the top of the screen rather than
              mid-content. */}
          {/* Cumulative-depth indent: each cast's left-border thickness
              reflects its distance from the topmost cast in view, so a
              reply-to-a-reply visually steps inward regardless of which
              cast in the chain the user focused on. organizeReplies
              returns reply depths relative to mainCast (0 = direct
              child); we shift by `parentCasts.length + 1` so the
              indent runs continuously through parents → mainCast →
              replies. */}
          {parentCasts.length > 0 && (
            <View>
              {parentCasts.map((parent, idx) =>
                renderCast({ ...parent, depth: idx }, false, idx === 0),
              )}
            </View>
          )}
          {renderCast(
            { ...mainCast, depth: parentCasts.length },
            true,
            parentCasts.length === 0,
          )}

          {/* Governance: weighted FOR/AGAINST tally + voting, only when this
              thread's root cast is a /hegemony proposal. */}
          {govProposal && mainCast && (
            <ProposalVoteBlock
              hash={(mainCast as { hash: string }).hash}
              votesFor={govProposal.votesFor}
              votesAgainst={govProposal.votesAgainst}
              token={token}
              theme={theme}
              onVoted={onGovernanceVoted}
            />
          )}

          {/* Replies-loading spinner — sits between the root cast and
              the replies area so the root cast (placeholder or real)
              stays at the top of the view, exactly where the user
              tapped. Previously the full-screen spinner above split
              the layout in half. */}
          {isLoading && replies.length === 0 && (
            <View style={{ paddingVertical: Skin.space(24), alignItems: 'center' }}>
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          )}

          {replies.length > 0 && (
            <View>
              {replies.map((reply) =>
                renderCast({ ...reply, depth: reply.depth + parentCasts.length + 1 }),
              )}
            </View>
          )}

          {/* Inline reply editor - styled like a cast card */}
          {token && (
            <View
              onLayout={(e) => {
                editorYRef.current = e.nativeEvent.layout.y;
              }}
              style={{
                borderTopWidth: Skin.border(1),
                borderTopColor: theme.colors.surface3,
                paddingTop: Skin.space(12),
                paddingBottom: Skin.space(14),
                paddingLeft: Skin.space(12),
                paddingRight: Skin.space(12),
                gap: Skin.space(10),
              }}
            >
              {/* Mention autocomplete - positioned above the editor */}
              {replyMentionInfo && (
                <View style={{ zIndex: 10, marginBottom: Skin.space(-2) }}>
                  <MentionAutocomplete
                    mentionInfo={replyMentionInfo}
                    token={token}
                    onSelectUser={handleReplySelectUser}
                    onSelectChannel={handleReplySelectChannel}
                    theme={theme}
                    maxHeight={160}
                  />
                </View>
              )}

              {/* Header row - avatar + name, matching cast layout */}
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ marginRight: Skin.space(12) }}>
                  <CachedAvatar
                    source={replyAvatarUri ? { uri: replyAvatarUri } : null}
                    fallbackName={currentUser?.displayName || currentUser?.farcaster?.username}
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: Skin.radius(22),
                      backgroundColor: theme.colors.surface3,
                    }}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.colors.textStrong, fontWeight: '600', fontSize: Skin.font(15) }}>
                    {currentUser?.displayName || currentUser?.farcaster?.username || 'You'}
                  </Text>
                  {currentUser?.farcaster?.username && (
                    <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13), marginTop: Skin.space(2) }}>
                      @{currentUser.farcaster.username}
                    </Text>
                  )}
                </View>
              </View>

              {/* Text input - styled like cast body text, no border/background */}
              <View style={{ marginLeft: Skin.space(56) }}>
                <TextInput
                  ref={replyInputRef}
                  onBlur={() => setIsEditorFocused(false)}
                  style={{
                    minHeight: 40,
                    color: theme.colors.textMain,
                    fontSize: Skin.font(15),
                    lineHeight: Skin.font(20),
                    padding: 0,
                    textAlignVertical: 'top',
                  }}
                  placeholder={`Reply to @${username}...`}
                  placeholderTextColor={theme.colors.textMuted}
                  value={replyText}
                  onChangeText={(text) => {
                    setReplyText(text.slice(0, maxCastLength));
                  }}
                  onSelectionChange={(e) => {
                    setReplyCursorPosition(e.nativeEvent.selection.end);
                  }}
                  onFocus={() => {
                    setIsEditorFocused(true);
                    // Scroll to bottom when input is focused so the editor is visible
                    setTimeout(() => {
                      scrollViewRef.current?.scrollToEnd({ animated: true });
                    }, 300);
                  }}
                  multiline
                />

                {/* Image previews */}
                {replyImages.length > 0 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={{ marginTop: Skin.space(10) }}
                    contentContainerStyle={{ gap: Skin.space(8) }}
                  >
                    {replyImages.map((image, index) => (
                      <View key={index} style={{ position: 'relative' }}>
                        <Image
                          source={{ uri: image.thumbnailLocalUri ?? image.localUri }}
                          style={{
                            width: 80,
                            height: 80,
                            borderRadius: Skin.radius(8),
                            backgroundColor: theme.colors.surface3,
                          }}
                          resizeMode="cover"
                        />
                        {image.kind === 'video' && (
                          <View style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: 0,
                            right: 0,
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}>
                            <IconSymbol name="play.fill" size={20} color="#fff" />
                          </View>
                        )}
                        <TouchableOpacity
                          onPress={() => handleRemoveReplyImage(index)}
                          style={{
                            position: 'absolute',
                            top: 4,
                            right: 4,
                            width: 22,
                            height: 22,
                            borderRadius: Skin.radius(11),
                            backgroundColor: 'rgba(0,0,0,0.6)',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <IconSymbol name="xmark" size={12} color="#fff" />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </ScrollView>
                )}

                {/* Error message */}
                {replyError && (
                  <Text style={{ color: theme.colors.danger, fontSize: Skin.font(13), marginTop: Skin.space(6) }}>
                    {replyError}
                  </Text>
                )}

                {/* Bottom row: photo button, post button, character count */}
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginTop: Skin.space(10),
                  }}
                >
                  <TouchableOpacity
                    onPress={handlePickReplyImage}
                    disabled={isPosting || replyImages.length >= 2}
                    style={{
                      opacity: replyImages.length >= 2 ? 0.4 : 1,
                      padding: Skin.space(4),
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <IconSymbol name="photo" size={20} color={theme.colors.textMuted} />
                  </TouchableOpacity>

                  <View style={{ flex: 1 }} />

                  {replyText.length > 0 && (
                    <Text style={{
                      fontSize: Skin.font(12),
                      marginRight: Skin.space(10),
                      color: replyText.length > regularCastByteLimit && replyText.length <= maxCastLength
                        ? (theme.colors.warning || '#FFA500')
                        : theme.colors.textMuted,
                    }}>
                      {replyText.length}/{maxCastLength}
                    </Text>
                  )}

                  <TouchableOpacity
                    onPress={handleSubmitReply}
                    disabled={!canReply}
                    style={{
                      paddingHorizontal: Skin.space(16),
                      paddingVertical: Skin.space(8),
                      borderRadius: Skin.radius(16),
                      backgroundColor: canReply ? theme.colors.accent : theme.colors.surface3,
                    }}
                  >
                    {isPosting ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={{
                        color: canReply ? '#fff' : theme.colors.textMuted,
                        fontSize: Skin.font(14),
                        fontWeight: '600',
                      }}>
                        Post
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}
        </ScrollView>
      )}

      {/* Floating reply FAB — hidden when the editor is in viewport (the
          user can already see/tap the composer directly). */}
      {token && mainCast && !isEditorVisible && !isEditorFocused && (
        <TouchableOpacity
          onPress={scrollToReplyAndFocus}
          style={{
            position: 'absolute',
            right: 16,
            bottom: bottomInset + 16,
            width: 48,
            height: 48,
            borderRadius: Skin.radius(24),
            backgroundColor: theme.colors.accent,
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.25,
            shadowRadius: 4,
            elevation: 5,
          }}
        >
          <IconSymbol name="arrowshape.turn.up.left.fill" size={22} color="#fff" />
        </TouchableOpacity>
      )}

      {/* Thread Image Viewer */}
      <ImageViewer
        visible={viewerState !== null}
        images={viewerState?.images}
        initialIndex={viewerState?.index}
        onClose={() => setViewerState(null)}
      />

      {/* Share Action Sheet */}
      <ShareActionSheet
        visible={shareSheetCast !== null}
        castHash={shareSheetCast?.hash ?? ''}
        castAuthor={shareSheetCast?.author ?? ''}
        isRecasted={shareSheetCast?.isRecasted ?? false}
        recastCount={shareSheetCast?.recastCount ?? 0}
        token={token}
        onClose={() => setShareSheetCast(null)}
        onRecast={() => {
          if (shareSheetCast) {
            const { hash, isRecasted, recastCount } = shareSheetCast;
            setShareSheetCast(null); // Close the share sheet first
            onRecastToggle(hash, isRecasted, recastCount);
          }
        }}
        onQuote={() => {
          if (shareSheetCast) {
            const { hash, author, text } = shareSheetCast;
            setShareSheetCast(null); // Close the share sheet first
            onQuoteCast(hash, author, text);
          }
        }}
        onShareToChat={() => {
          if (shareSheetCast) {
            const castUrl = `https://warpcast.com/${shareSheetCast.author}/${shareSheetCast.hash.slice(0, 10)}`;
            setShareSheetCast(null); // Close the share sheet
            onShareToChat(castUrl);
          }
        }}
        onNativeShare={async () => {
          if (shareSheetCast) {
            const castUrl = `https://warpcast.com/${shareSheetCast.author}/${shareSheetCast.hash.slice(0, 10)}`;
            try {
              await Share.share({
                message: castUrl,
                url: castUrl,
              });
            } catch {
              // User cancelled share — no action needed
            }
          }
        }}
      />

      <ReportModal
        visible={!!reportCastTarget}
        onClose={() => setReportCastTarget(null)}
        target={reportCastTarget ? { type: 'cast', ...reportCastTarget } : null}
      />
    </View>
    </KeyboardAvoidingView>
  );
}

export function ProfileView({
  fid,
  token,
  theme,
  onClose,
  onOpenThread,
  onOpenMiniApp,
  onOpenProfile,
  onOpenChannel,
  likeStates,
  onLikeToggle,
  bottomInset = 0,
  currentUserFid,
  onTipPress,
  hideBackButton = false,
}: {
  fid: number;
  token?: string;
  theme: AppTheme;
  currentUserFid?: number;
  onClose: () => void;
  onOpenThread: (username: string, hashPrefix: string, placeholderCast?: unknown) => void;
  onOpenMiniApp: (url: string) => void;
  onOpenProfile: (fid: number, username?: string) => void;
  onOpenChannel: (channelKey: string) => void;
  likeStates: Map<string, { liked: boolean; count: number }>;
  onLikeToggle: (castHash: string, currentlyLiked: boolean, currentCount: number) => void;
  bottomInset?: number;
  /** Opens the tip flow for a cast. Tip button hidden when omitted. */
  onTipPress?: (target: TipTarget) => void;
  hideBackButton?: boolean;
}) {
  const {
    author,
    casts,
    isLoading,
    isFetchingNextPage,
    error,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useFarcasterProfile({ fid, token });

  // Apex gold ring — the profile owner plus any cast authors that appear
  // in the list (recasts can carry other authors).
  const profileAuthorFids = React.useMemo(() => {
    const fids = new Set<number>([fid]);
    for (const c of casts ?? []) {
      if (c.author?.fid) fids.add(c.author.fid);
    }
    return Array.from(fids);
  }, [fid, casts]);
  const apexFids = useApexStatusForFids(profileAuthorFids);

  // Image viewer state
  const [viewerState, setViewerState] = useState<{ images: string[]; index: number } | null>(null);

  const renderProfileHeader = () => {
    if (!author) return null;

    return (
      <View style={{ backgroundColor: theme.colors.surface1 }}>
        {/* Banner */}
        <TouchableOpacity
          activeOpacity={author.profile?.bannerImageUrl ? 0.8 : 1}
          onPress={() => author.profile?.bannerImageUrl && setViewerState({ images: [author.profile.bannerImageUrl], index: 0 })}
          style={{ width: SCREEN_WIDTH, height: 120 }}
        >
          {author.profile?.bannerImageUrl ? (
            <Image
              source={{ uri: author.profile.bannerImageUrl }}
              style={{
                width: '100%',
                height: '100%',
                backgroundColor: theme.colors.surface3,
              }}
              resizeMode="cover"
            />
          ) : (
            <View
              style={{
                width: '100%',
                height: '100%',
                backgroundColor: theme.colors.accent,
                opacity: 0.3,
              }}
            />
          )}
        </TouchableOpacity>

        {/* Avatar */}
        <View style={{ paddingHorizontal: Skin.space(16), marginTop: Skin.space(-40) }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => author.pfp?.url && setViewerState({ images: [author.pfp.url], index: 0 })}
            >
              <ApexAvatarRing active={apexFids.has(fid)} size={80}>
                <CachedAvatar
                  source={author.pfp?.url ? { uri: author.pfp.url } : null}
                  fallbackName={author.displayName || author.username}
                  style={{
                    width: 80,
                    height: 80,
                    borderRadius: Skin.radius(40),
                    borderWidth: Skin.border(4),
                    borderColor: theme.colors.background,
                    backgroundColor: theme.colors.surface3,
                  }}
                />
              </ApexAvatarRing>
            </TouchableOpacity>
            <ProfileOverflowButton targetFid={fid} username={author.username} theme={theme} />
          </View>

          {/* Name and username */}
          <View style={{ marginTop: Skin.space(12) }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6) }}>
              <Text style={{ color: theme.colors.textStrong, fontSize: Skin.font(22), fontWeight: '700' }}>
                {author.displayName}
              </Text>
              {author.profile?.accountLevel === 'pro' && (
                <IconSymbol name="star.fill" color={theme.colors.warning} size={16} />
              )}
            </View>
            <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(15), marginTop: Skin.space(2) }}>
              @{author.username}
            </Text>
          </View>

          {/* Bio */}
          {author.profile?.bio?.text && (
            <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(15), lineHeight: Skin.font(21), marginTop: Skin.space(12) }}>
              {author.profile.bio.text}
            </Text>
          )}

          {/* Location */}
          {author.profile?.location?.description && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(4), marginTop: Skin.space(8) }}>
              <IconSymbol name="mappin" color={theme.colors.textMuted} size={14} />
              <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13) }}>
                {author.profile.location.description}
              </Text>
            </View>
          )}

          {/* Follower/Following counts */}
          <View style={{ flexDirection: 'row', gap: Skin.space(16), marginTop: Skin.space(12) }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(4) }}>
              <Text style={{ color: theme.colors.textStrong, fontWeight: '600', fontSize: Skin.font(15) }}>
                {(author.followingCount ?? 0).toLocaleString()}
              </Text>
              <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(14) }}>Following</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(4) }}>
              <Text style={{ color: theme.colors.textStrong, fontWeight: '600', fontSize: Skin.font(15) }}>
                {(author.followerCount ?? 0).toLocaleString()}
              </Text>
              <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(14) }}>Followers</Text>
            </View>
          </View>

          <ProfileActionButtons
            fid={fid}
            username={author.username}
            displayName={author.displayName}
            pfpUrl={author.pfp?.url}
            isFollowing={author.viewerContext?.following}
            theme={theme}
          />
        </View>

        {/* Separator */}
        <View style={{ height: 1, backgroundColor: theme.colors.surface3, marginTop: Skin.space(16) }} />
      </View>
    );
  };

  const handleMentionPress = async (username: string) => {
    try {
      const response = await fetch(`https://farcaster.xyz/~api/v2/user-by-username?username=${username}`, {
        headers: {
          accept: '*/*',
          origin: 'https://farcaster.xyz',
          referer: 'https://farcaster.xyz/',
        },
      });
      if (response.ok) {
        const json = await response.json();
        if (json.result?.fid) {
          onOpenProfile(json.result.fid, username);
        }
      }
    } catch {
      // Profile lookup failed — no action needed
    }
  };

  const renderCast = (cast: ProfileCast) => {
    const imageUrls = (cast.embeds?.images ?? [])
      .map((img) => img.url)
      .filter((url): url is string => Boolean(url));
    const hasImages = imageUrls.length > 0;
    // Some sources (hypersnap-bare URLs, m3u8 streams) ship a video
    // URL with no thumbnail. VideoPlayer renders a black poster +
    // play-icon overlay in that case, which is better than dropping
    // the embed entirely.
    const videos = (cast.embeds?.videos ?? []).filter((v) => Boolean(v.url));
    const hasVideos = videos.length > 0;

    // Each URL embed renders exactly once — SnapAwareUrlPreview decides between
    // snap UI, frame card, or plain link preview (no duplicates).
    const frameEmbeds: { imageUrl: string; buttonTitle: string; actionUrl: string }[] = [];
    const embeddedCasts = cast.embeds?.casts ?? [];
    const urlPreviews = (cast.embeds?.urls ?? [])
      .filter((u) => {
        if (u.openGraph?.frameEmbedNext?.frameUrl || u.openGraph?.frameEmbedNext?.frameEmbed?.imageUrl) return true;
        const url = u.openGraph?.url || u.openGraph?.sourceUrl || '';
        // Drop farcaster.xyz cast links that are already shown as a quote cast
        if (url.includes('farcaster.xyz/')) {
          const parsed = parseFarcasterUrl(url);
          if (parsed) {
            const alreadyEmbedded = embeddedCasts.some((c: any) =>
              c?.hash?.toLowerCase().startsWith(parsed.castHashPrefix.toLowerCase())
            );
            if (alreadyEmbedded) return false;
          }
        }
        if (containsInviteLink(url)) return true;
        // Keep bare URLs — hypersnap doesn't enrich with OG, but
        // SnapAwareUrlPreview can still render the link.
        return Boolean(url);
      });

    // Quote casts
    const quoteCasts = cast.embeds?.casts ?? [];

    const navigateToThread = () => {
      if (cast.author.username && cast.hash) {
        onOpenThread(cast.author.username, cast.hash.slice(0, 10), cast);
      }
    };

    return (
      <View
        key={cast.hash}
        style={{
          borderBottomWidth: Skin.border(1),
          borderBottomColor: theme.colors.surface3,
          paddingTop: Skin.space(12),
          paddingBottom: Skin.space(14),
          paddingHorizontal: Skin.space(12),
          gap: Skin.space(10),
        }}
      >
        <Pressable onPress={navigateToThread}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TouchableOpacity
              onPress={() => onOpenProfile(cast.author.fid, cast.author.username)}
            >
              <ApexAvatarRing
                active={apexFids.has(cast.author.fid)}
                size={44}
                style={{ marginRight: Skin.space(12) }}
              >
                <CachedAvatar
                  source={cast.author.pfp?.url ? { uri: cast.author.pfp.url } : null}
                  fallbackName={cast.author.displayName || cast.author.username}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: Skin.radius(22),
                    backgroundColor: theme.colors.surface3,
                  }}
                />
              </ApexAvatarRing>
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6) }}>
                <TouchableOpacity onPress={() => onOpenProfile(cast.author.fid, cast.author.username)}>
                  <Text style={{ color: theme.colors.textStrong, fontWeight: '600', fontSize: Skin.font(15) }}>
                    {cast.author.displayName}
                  </Text>
                </TouchableOpacity>
                {(() => {
                  const chip = resolveChannelChip(cast.channel?.key, cast.channel?.name);
                  if (!chip) return null;
                  return (
                    <TouchableOpacity onPress={() => onOpenChannel(chip.key)}>
                      <Text style={{ color: theme.colors.accent, fontSize: Skin.font(13) }} numberOfLines={1}>
                        /{chip.display}
                      </Text>
                    </TouchableOpacity>
                  );
                })()}
              </View>
              <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13), marginTop: Skin.space(2) }}>
                @{cast.author.username} • {formatTimestamp(cast.timestamp)}
              </Text>
            </View>
          </View>
        </Pressable>

        {cast.text.trim().length > 0 && (
          <Pressable onPress={navigateToThread}>
            <Translatable
              text={cast.text}
              theme={theme}
              renderText={(t) => (
                <CastText
                  text={t}
                  style={{ color: theme.colors.textMain, fontSize: Skin.font(15), lineHeight: Skin.font(20) }}
                  theme={theme}
                  onMentionPress={handleMentionPress}
                  onChannelPress={onOpenChannel}
                  onLinkPress={onOpenMiniApp}
                />
              )}
            />
          </Pressable>
        )}

        {/* Images */}
        {hasImages && (
          <View style={{ marginHorizontal: Skin.space(-12) }}>
            {imageUrls.length === 1 ? (
              <AutoHeightImage
                uri={imageUrls[0]}
                maxHeight={Infinity}
                style={{ backgroundColor: theme.colors.surface3 }}
                onPress={() => setViewerState({ images: imageUrls, index: 0 })}
              />
            ) : (
              <ImageCarousel
                urls={imageUrls}
                maxHeight={Infinity}
                theme={theme}
                onImagePress={(_, index) => setViewerState({ images: imageUrls, index })}
              />
            )}
          </View>
        )}

        {/* Videos */}
        {hasVideos && (
          <View style={{ marginHorizontal: Skin.space(-12) }}>
            {videos.map((video, index) => (
              <VideoPlayer
                key={index}
                url={video.url!}
                downloadUrl={(video as { sourceUrl?: string }).sourceUrl}
                thumbnailUrl={video.thumbnailUrl!}
                width={video.width}
                height={video.height}
                duration={video.duration}
                theme={theme}
              />
            ))}
          </View>
        )}

        {/* Frame embeds (mini apps) */}
        {frameEmbeds.length > 0 && (
          <View style={{ marginHorizontal: Skin.space(-12), gap: Skin.space(8) }}>
            {frameEmbeds.map((frame, index) => (
              <FrameEmbed
                key={index}
                imageUrl={frame.imageUrl}
                buttonTitle={frame.buttonTitle}
                actionUrl={frame.actionUrl}
                theme={theme}
                onPress={() => onOpenMiniApp(frame.actionUrl)}
              />
            ))}
          </View>
        )}

        {/* URL previews — snap-aware */}
        {urlPreviews.length > 0 && (
          <View style={{ gap: Skin.space(8) }}>
            {urlPreviews.map((urlEmbed, index) => {
              const linkUrl = urlEmbed.openGraph?.url || urlEmbed.openGraph?.sourceUrl;
              const isQuorumInvite = linkUrl && containsInviteLink(linkUrl);
              if (isQuorumInvite) {
                return (
                  <InviteLinkCard
                    key={index}
                    inviteLink={linkUrl}
                  />
                );
              }
              const spaceRef = parseFarcasterSpaceUrl(linkUrl);
              if (spaceRef) {
                return (
                  <AudioSpaceEmbed
                    key={index}
                    spaceId={spaceRef.id}
                    castHash={cast.hash}
                    onFallbackOpen={() => linkUrl && onOpenMiniApp(linkUrl)}
                  />
                );
              }
              const tokenRef = parseFarcasterTokenUrl(linkUrl);
              if (tokenRef) {
                return (
                  <FarcasterTokenEmbed
                    key={index}
                    chain={tokenRef.chain}
                    contractAddress={tokenRef.contractAddress}
                    theme={theme}
                  />
                );
              }
              const parsedFc = linkUrl && linkUrl.includes('farcaster.xyz/')
                ? parseFarcasterUrl(linkUrl)
                : null;
              if (parsedFc) {
                return (
                  <FarcasterCastUrlEmbed
                    key={index}
                    username={parsedFc.username}
                    castHashPrefix={parsedFc.castHashPrefix}
                    fallbackTitle={urlEmbed.openGraph?.title}
                    fallbackDescription={urlEmbed.openGraph?.description}
                    theme={theme}
                    onPress={() => onOpenThread(parsedFc.username, parsedFc.castHashPrefix)}
                  />
                );
              }
              return (
                <SnapAwareUrlPreview
                  key={index}
                  url={linkUrl}
                  snapUrl={urlEmbed.openGraph?.frameEmbedNext?.frameUrl}
                  frameImageUrl={urlEmbed.openGraph?.frameEmbedNext?.frameEmbed?.imageUrl}
                  frameButtonTitle={urlEmbed.openGraph?.frameEmbedNext?.frameEmbed?.button?.title}
                  frameActionUrl={urlEmbed.openGraph?.frameEmbedNext?.frameEmbed?.button?.action?.url ?? linkUrl}
                  title={urlEmbed.openGraph?.title}
                  description={urlEmbed.openGraph?.description}
                  domain={urlEmbed.openGraph?.domain}
                  image={urlEmbed.openGraph?.image}
                  useLargeImage={urlEmbed.openGraph?.useLargeImage}
                  theme={theme}
                  userFid={currentUserFid}
                  token={token}
                  onPress={linkUrl ? () => onOpenMiniApp(linkUrl) : undefined}
                  onOpenUrl={(u) => onOpenMiniApp(u)}
                  onOpenProfile={(profileFid) => onOpenProfile(profileFid)}
                  onOpenMiniApp={(u) => onOpenMiniApp(u)}
                />
              );
            })}
          </View>
        )}

        {/* Inline YouTube URLs in cast text (deduped against explicit embeds) */}
        <InlineYouTubeFromText
          text={cast.text}
          excludeUrls={(cast.embeds?.urls ?? []).map((u: any) => u.openGraph?.url ?? u.openGraph?.sourceUrl)}
          theme={theme}
        />

        {/* Quote casts */}
        {quoteCasts.length > 0 && (
          <View style={{ gap: Skin.space(8) }}>
            {quoteCasts.map((embeddedCast, index) => (
              <QuoteCast
                key={index}
                cast={embeddedCast as EmbeddedCast}
                theme={theme}
                onPress={() => onOpenThread(embeddedCast.author.username, embeddedCast.hash, embeddedCast)}
              />
            ))}
          </View>
        )}

        {/* Stats row */}
        {(() => {
          const optimistic = likeStates.get(cast.hash);
          const isLiked = optimistic?.liked ?? cast.viewerContext?.reacted ?? false;
          const likeCount = optimistic?.count ?? (cast.reactions?.count ?? 0);
          return (
            <View style={{ flexDirection: 'row', gap: Skin.space(16), marginTop: Skin.space(4) }}>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6) }}
                onPress={() => onLikeToggle(cast.hash, isLiked, likeCount)}
                hitSlop={12}
              >
                <LikeIcon
                  type={getLikeIconType(cast.text)}
                  isLiked={isLiked}
                  color={theme.colors.textMuted}
                  activeColor={theme.colors.danger}
                  size={20}
                />
                {likeCount > 0 && (
                  <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13) }}>{likeCount}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6) }}
                onPress={navigateToThread}
              >
                <IconSymbol name="bubble.left" color={theme.colors.textMuted} size={20} />
                {(cast.replies?.count ?? 0) > 0 && (
                  <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13) }}>{cast.replies?.count}</Text>
                )}
              </TouchableOpacity>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6) }}>
                <IconSymbol
                  name="arrow.triangle.2.circlepath"
                  color={cast.viewerContext?.recast ? theme.colors.success : theme.colors.textMuted}
                  size={20}
                />
                {(cast.recasts?.count ?? 0) > 0 && (
                  <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13) }}>{cast.recasts?.count}</Text>
                )}
              </View>
              {onTipPress && cast.author.fid > 0 && cast.author.fid !== currentUserFid && (
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6) }}
                  onPress={() => onTipPress({
                    castHash: cast.hash,
                    castText: cast.text ?? '',
                    authorFid: cast.author.fid,
                    authorUsername: cast.author.username,
                    authorDisplayName: cast.author.displayName,
                  })}
                  hitSlop={12}
                >
                  <SnapIcon color={theme.colors.textMuted} size={24} />
                </TouchableOpacity>
              )}
            </View>
          );
        })()}
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface1 }}>
      {isLoading && casts.length === 0 && (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      )}

      {error && (
        <View style={{ padding: Skin.space(20) }}>
          <Text style={{ color: theme.colors.danger }}>{error}</Text>
        </View>
      )}

      <FlashList
        data={casts}
        extraData={likeStates}
        keyExtractor={(item) => item.hash}
        ListHeaderComponent={renderProfileHeader}
        renderItem={({ item }) => renderCast(item)}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: Skin.space(32) + bottomInset }}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) {
            fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={{ paddingVertical: Skin.space(20), alignItems: 'center' }}>
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          ) : null
        }
      />

      {/* Back button - positioned absolutely at top for consistency */}
      {!hideBackButton && (
        <TouchableOpacity
          onPress={onClose}
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            backgroundColor: 'rgba(0,0,0,0.5)',
            borderRadius: Skin.radius(20),
            padding: Skin.space(8),
            zIndex: 10,
          }}
        >
          <IconSymbol name="chevron.left" color="#fff" size={20} />
        </TouchableOpacity>
      )}

      {/* Image Viewer */}
      <ImageViewer
        visible={viewerState !== null}
        images={viewerState?.images}
        initialIndex={viewerState?.index}
        onClose={() => setViewerState(null)}
      />
    </View>
  );
}

function ChannelView({
  channelKey,
  token,
  theme,
  onClose,
  onOpenThread,
  onOpenMiniApp,
  onOpenProfile,
  onOpenChannel,
  likeStates,
  onLikeToggle,
  bottomInset = 0,
  currentUserFid,
  onTipPress,
}: {
  channelKey: string;
  token?: string;
  theme: AppTheme;
  currentUserFid?: number;
  onClose: () => void;
  onOpenThread: (username: string, hashPrefix: string, placeholderCast?: unknown) => void;
  onOpenMiniApp: (url: string) => void;
  onOpenProfile: (fid: number, username?: string) => void;
  onOpenChannel: (channelKey: string) => void;
  likeStates: Map<string, { liked: boolean; count: number }>;
  onLikeToggle: (castHash: string, currentlyLiked: boolean, currentCount: number) => void;
  bottomInset?: number;
  /** Opens the tip flow for a cast. Tip button hidden when omitted. */
  onTipPress?: (target: TipTarget) => void;
}) {
  const {
    channel,
    casts,
    isLoading,
    isFetchingNextPage,
    error,
    hasNextPage,
    fetchNextPage,
  } = useFarcasterChannel({ channelKey, token });

  // Apex gold ring for channel cast authors (batched, silent fallback).
  const channelAuthorFids = React.useMemo(() => {
    const fids = new Set<number>();
    for (const c of casts ?? []) {
      if (c.author?.fid) fids.add(c.author.fid);
    }
    return Array.from(fids);
  }, [casts]);
  const apexFids = useApexStatusForFids(channelAuthorFids);

  const renderChannelHeader = () => {
    const frameEmbed = channel?.headerActionMetadata?.frameEmbedNext?.frameEmbed;
    const miniAppUrl = frameEmbed?.button?.action?.url;
    const miniAppTitle = frameEmbed?.button?.title || channel?.headerAction?.title;

    return (
      <View style={{ backgroundColor: theme.colors.surface1 }}>
        {/* Header Image */}
        {channel?.headerImageUrl && (
          <Image
            source={{ uri: channel.headerImageUrl }}
            style={{
              width: SCREEN_WIDTH,
              height: 100,
              backgroundColor: theme.colors.surface3,
            }}
            resizeMode="cover"
          />
        )}

        {/* Back button overlay on header */}
        <TouchableOpacity
          onPress={onClose}
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            backgroundColor: 'rgba(0,0,0,0.5)',
            borderRadius: Skin.radius(20),
            padding: Skin.space(8),
            zIndex: 10,
          }}
        >
          <IconSymbol name="chevron.left" color="#fff" size={20} />
        </TouchableOpacity>

        {/* Channel Info */}
        <View style={{ padding: Skin.space(16), marginTop: channel?.headerImageUrl ? -24 : 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
            {channel?.imageUrl ? (
              <Image
                source={{ uri: channel.imageUrl }}
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: Skin.radius(12),
                  marginRight: Skin.space(12),
                  backgroundColor: theme.colors.surface3,
                  borderWidth: channel?.headerImageUrl ? 3 : 0,
                  borderColor: theme.colors.surface1,
                }}
              />
            ) : (
              <View style={{
                width: 64,
                height: 64,
                borderRadius: Skin.radius(12),
                marginRight: Skin.space(12),
                backgroundColor: theme.colors.accent,
                justifyContent: 'center',
                alignItems: 'center',
              }}>
                <Text style={{ color: '#fff', fontSize: Skin.font(24), fontWeight: '700' }}>
                  /{channelKey.charAt(0).toUpperCase()}
                </Text>
              </View>
            )}
            <View style={{ flex: 1, paddingBottom: Skin.space(4) }}>
              <Text style={{ color: theme.colors.textStrong, fontSize: Skin.font(22), fontWeight: '700' }}>
                /{channel?.name || channelKey}
              </Text>
            </View>
          </View>

          {/* Description */}
          {channel?.description && (
            <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(15), lineHeight: Skin.font(21), marginTop: Skin.space(12) }}>
              {channel.description}
            </Text>
          )}

          {/* Channel stats */}
          <View style={{ flexDirection: 'row', gap: Skin.space(16), marginTop: Skin.space(12) }}>
            {channel?.followerCount !== undefined && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(4) }}>
                <Text style={{ color: theme.colors.textStrong, fontWeight: '600', fontSize: Skin.font(15) }}>
                  {channel.followerCount.toLocaleString()}
                </Text>
                <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(14) }}>Followers</Text>
              </View>
            )}
            {channel?.memberCount !== undefined && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(4) }}>
                <Text style={{ color: theme.colors.textStrong, fontWeight: '600', fontSize: Skin.font(15) }}>
                  {channel.memberCount.toLocaleString()}
                </Text>
                <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(14) }}>Members</Text>
              </View>
            )}
          </View>

          {/* Mini App Button */}
          {miniAppUrl && miniAppTitle && (
            <TouchableOpacity
              onPress={() => onOpenMiniApp(miniAppUrl)}
              style={{
                backgroundColor: theme.colors.accent,
                borderRadius: Skin.radius(20),
                paddingVertical: Skin.space(10),
                paddingHorizontal: Skin.space(20),
                marginTop: Skin.space(16),
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: Skin.space(8),
              }}
            >
              <IconSymbol name="play.fill" color="#fff" size={16} />
              <Text style={{ color: '#fff', fontSize: Skin.font(15), fontWeight: '600' }}>
                {miniAppTitle}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Separator */}
        <View style={{ height: 1, backgroundColor: theme.colors.surface3 }} />
      </View>
    );
  };

  const handleMentionPress = async (username: string) => {
    // Need to look up fid from username - for now just use a search API
    // This is a simplified version - ideally we'd have a username->fid lookup
    try {
      const response = await fetch(`https://farcaster.xyz/~api/v2/user-by-username?username=${username}`, {
        headers: {
          accept: '*/*',
          origin: 'https://farcaster.xyz',
          referer: 'https://farcaster.xyz/',
        },
      });
      if (response.ok) {
        const json = await response.json();
        if (json.result?.fid) {
          onOpenProfile(json.result.fid, username);
        }
      }
    } catch {
      // Profile lookup failed — no action needed
    }
  };

  // Image viewer state
  const [viewerState, setViewerState] = useState<{ images: string[]; index: number } | null>(null);

  const renderCast = (cast: ChannelCast) => {
    const imageUrls = (cast.embeds?.images ?? [])
      .map((img) => img.url)
      .filter((url): url is string => Boolean(url));
    const hasImages = imageUrls.length > 0;
    // Some sources (hypersnap-bare URLs, m3u8 streams) ship a video
    // URL with no thumbnail. VideoPlayer renders a black poster +
    // play-icon overlay in that case, which is better than dropping
    // the embed entirely.
    const videos = (cast.embeds?.videos ?? []).filter((v) => Boolean(v.url));
    const hasVideos = videos.length > 0;

    // Each URL embed renders exactly once — SnapAwareUrlPreview decides between
    // snap UI, frame card, or plain link preview (no duplicates).
    const frameEmbeds: { imageUrl: string; buttonTitle: string; actionUrl: string }[] = [];
    const embeddedCasts = cast.embeds?.casts ?? [];
    const urlPreviews = (cast.embeds?.urls ?? [])
      .filter((u) => {
        if (u.openGraph?.frameEmbedNext?.frameUrl || u.openGraph?.frameEmbedNext?.frameEmbed?.imageUrl) return true;
        const url = u.openGraph?.url || u.openGraph?.sourceUrl || '';
        // Drop farcaster.xyz cast links that are already shown as a quote cast
        if (url.includes('farcaster.xyz/')) {
          const parsed = parseFarcasterUrl(url);
          if (parsed) {
            const alreadyEmbedded = embeddedCasts.some((c: any) =>
              c?.hash?.toLowerCase().startsWith(parsed.castHashPrefix.toLowerCase())
            );
            if (alreadyEmbedded) return false;
          }
        }
        if (containsInviteLink(url)) return true;
        // Keep bare URLs — hypersnap doesn't enrich with OG, but
        // SnapAwareUrlPreview can still render the link.
        return Boolean(url);
      });

    // Quote casts
    const quoteCasts = cast.embeds?.casts ?? [];

    const navigateToThread = () => {
      if (cast.author.username && cast.hash) {
        onOpenThread(cast.author.username, cast.hash.slice(0, 10), cast);
      }
    };

    return (
      <View
        key={cast.hash}
        style={{
          borderBottomWidth: Skin.border(1),
          borderBottomColor: theme.colors.surface3,
          paddingTop: Skin.space(12),
          paddingBottom: Skin.space(14),
          paddingHorizontal: Skin.space(12),
          gap: Skin.space(10),
        }}
      >
        <Pressable onPress={navigateToThread}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TouchableOpacity
              onPress={() => onOpenProfile(cast.author.fid, cast.author.username)}
            >
              <ApexAvatarRing
                active={apexFids.has(cast.author.fid)}
                size={44}
                style={{ marginRight: Skin.space(12) }}
              >
                <CachedAvatar
                  source={cast.author.pfp?.url ? { uri: cast.author.pfp.url } : null}
                  fallbackName={cast.author.displayName || cast.author.username}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: Skin.radius(22),
                    backgroundColor: theme.colors.surface3,
                  }}
                />
              </ApexAvatarRing>
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6) }}>
                <TouchableOpacity onPress={() => onOpenProfile(cast.author.fid, cast.author.username)}>
                  <Text style={{ color: theme.colors.textStrong, fontWeight: '600', fontSize: Skin.font(15) }}>
                    {cast.author.displayName}
                  </Text>
                </TouchableOpacity>
              </View>
              <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13), marginTop: Skin.space(2) }}>
                @{cast.author.username} • {formatTimestamp(cast.timestamp)}
              </Text>
            </View>
          </View>
        </Pressable>

        {cast.text.trim().length > 0 && (
          <Pressable onPress={navigateToThread}>
            <Translatable
              text={cast.text}
              theme={theme}
              renderText={(t) => (
                <CastText
                  text={t}
                  style={{ color: theme.colors.textMain, fontSize: Skin.font(15), lineHeight: Skin.font(20) }}
                  theme={theme}
                  onMentionPress={handleMentionPress}
                  onChannelPress={onOpenChannel}
                  onLinkPress={onOpenMiniApp}
                />
              )}
            />
          </Pressable>
        )}

        {/* Images */}
        {hasImages && (
          <View style={{ marginHorizontal: Skin.space(-12) }}>
            {imageUrls.length === 1 ? (
              <AutoHeightImage
                uri={imageUrls[0]}
                maxHeight={Infinity}
                style={{ backgroundColor: theme.colors.surface3 }}
                onPress={() => setViewerState({ images: imageUrls, index: 0 })}
              />
            ) : (
              <ImageCarousel
                urls={imageUrls}
                maxHeight={Infinity}
                theme={theme}
                onImagePress={(_, index) => setViewerState({ images: imageUrls, index })}
              />
            )}
          </View>
        )}

        {/* Videos */}
        {hasVideos && (
          <View style={{ marginHorizontal: Skin.space(-12) }}>
            {videos.map((video, index) => (
              <VideoPlayer
                key={index}
                url={video.url!}
                downloadUrl={(video as { sourceUrl?: string }).sourceUrl}
                thumbnailUrl={video.thumbnailUrl!}
                width={video.width}
                height={video.height}
                duration={video.duration}
                theme={theme}
              />
            ))}
          </View>
        )}

        {/* Frame embeds (mini apps) */}
        {frameEmbeds.length > 0 && (
          <View style={{ marginHorizontal: Skin.space(-12), gap: Skin.space(8) }}>
            {frameEmbeds.map((frame, index) => (
              <FrameEmbed
                key={index}
                imageUrl={frame.imageUrl}
                buttonTitle={frame.buttonTitle}
                actionUrl={frame.actionUrl}
                theme={theme}
                onPress={() => onOpenMiniApp(frame.actionUrl)}
              />
            ))}
          </View>
        )}

        {/* URL previews — snap-aware */}
        {urlPreviews.length > 0 && (
          <View style={{ gap: Skin.space(8) }}>
            {urlPreviews.map((urlEmbed, index) => {
              const linkUrl = urlEmbed.openGraph?.url || urlEmbed.openGraph?.sourceUrl;
              const isQuorumInvite = linkUrl && containsInviteLink(linkUrl);
              if (isQuorumInvite) {
                return (
                  <InviteLinkCard
                    key={index}
                    inviteLink={linkUrl}
                  />
                );
              }
              const spaceRef = parseFarcasterSpaceUrl(linkUrl);
              if (spaceRef) {
                return (
                  <AudioSpaceEmbed
                    key={index}
                    spaceId={spaceRef.id}
                    castHash={cast.hash}
                    onFallbackOpen={() => linkUrl && onOpenMiniApp(linkUrl)}
                  />
                );
              }
              const tokenRef = parseFarcasterTokenUrl(linkUrl);
              if (tokenRef) {
                return (
                  <FarcasterTokenEmbed
                    key={index}
                    chain={tokenRef.chain}
                    contractAddress={tokenRef.contractAddress}
                    theme={theme}
                  />
                );
              }
              const parsedFc = linkUrl && linkUrl.includes('farcaster.xyz/')
                ? parseFarcasterUrl(linkUrl)
                : null;
              if (parsedFc) {
                return (
                  <FarcasterCastUrlEmbed
                    key={index}
                    username={parsedFc.username}
                    castHashPrefix={parsedFc.castHashPrefix}
                    fallbackTitle={urlEmbed.openGraph?.title}
                    fallbackDescription={urlEmbed.openGraph?.description}
                    theme={theme}
                    onPress={() => onOpenThread(parsedFc.username, parsedFc.castHashPrefix)}
                  />
                );
              }
              return (
                <SnapAwareUrlPreview
                  key={index}
                  url={linkUrl}
                  snapUrl={urlEmbed.openGraph?.frameEmbedNext?.frameUrl}
                  frameImageUrl={urlEmbed.openGraph?.frameEmbedNext?.frameEmbed?.imageUrl}
                  frameButtonTitle={urlEmbed.openGraph?.frameEmbedNext?.frameEmbed?.button?.title}
                  frameActionUrl={urlEmbed.openGraph?.frameEmbedNext?.frameEmbed?.button?.action?.url ?? linkUrl}
                  title={urlEmbed.openGraph?.title}
                  description={urlEmbed.openGraph?.description}
                  domain={urlEmbed.openGraph?.domain}
                  image={urlEmbed.openGraph?.image}
                  useLargeImage={urlEmbed.openGraph?.useLargeImage}
                  theme={theme}
                  userFid={currentUserFid}
                  token={token}
                  onPress={linkUrl ? () => onOpenMiniApp(linkUrl) : undefined}
                  onOpenUrl={(u) => onOpenMiniApp(u)}
                  onOpenProfile={(profileFid) => onOpenProfile(profileFid)}
                  onOpenMiniApp={(u) => onOpenMiniApp(u)}
                />
              );
            })}
          </View>
        )}

        {/* Inline YouTube URLs in cast text (deduped against explicit embeds) */}
        <InlineYouTubeFromText
          text={cast.text}
          excludeUrls={(cast.embeds?.urls ?? []).map((u: any) => u.openGraph?.url ?? u.openGraph?.sourceUrl)}
          theme={theme}
        />

        {/* Quote casts */}
        {quoteCasts.length > 0 && (
          <View style={{ gap: Skin.space(8) }}>
            {quoteCasts.map((embeddedCast, index) => (
              <QuoteCast
                key={index}
                cast={embeddedCast as EmbeddedCast}
                theme={theme}
                onPress={() => onOpenThread(embeddedCast.author.username, embeddedCast.hash, embeddedCast)}
              />
            ))}
          </View>
        )}

        {/* Stats row */}
        {(() => {
          const optimistic = likeStates.get(cast.hash);
          const isLiked = optimistic?.liked ?? cast.viewerContext?.reacted ?? false;
          const likeCount = optimistic?.count ?? (cast.reactions?.count ?? 0);
          return (
            <View style={{ flexDirection: 'row', gap: Skin.space(16), marginTop: Skin.space(4) }}>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6) }}
                onPress={() => onLikeToggle(cast.hash, isLiked, likeCount)}
                hitSlop={12}
              >
                <LikeIcon
                  type={getLikeIconType(cast.text)}
                  isLiked={isLiked}
                  color={theme.colors.textMuted}
                  activeColor={theme.colors.danger}
                  size={20}
                />
                {likeCount > 0 && (
                  <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13) }}>{likeCount}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6) }}
                onPress={navigateToThread}
              >
                <IconSymbol name="bubble.left" color={theme.colors.textMuted} size={20} />
                {(cast.replies?.count ?? 0) > 0 && (
                  <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13) }}>{cast.replies?.count}</Text>
                )}
              </TouchableOpacity>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6) }}>
                <IconSymbol
                  name="arrow.triangle.2.circlepath"
                  color={cast.viewerContext?.recast ? theme.colors.success : theme.colors.textMuted}
                  size={20}
                />
                {(cast.recasts?.count ?? 0) > 0 && (
                  <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13) }}>{cast.recasts?.count}</Text>
                )}
              </View>
              {onTipPress && cast.author.fid > 0 && cast.author.fid !== currentUserFid && (
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6) }}
                  onPress={() => onTipPress({
                    castHash: cast.hash,
                    castText: cast.text ?? '',
                    authorFid: cast.author.fid,
                    authorUsername: cast.author.username,
                    authorDisplayName: cast.author.displayName,
                  })}
                  hitSlop={12}
                >
                  <SnapIcon color={theme.colors.textMuted} size={24} />
                </TouchableOpacity>
              )}
            </View>
          );
        })()}
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface1 }}>
      {error && (
        <View style={{ padding: Skin.space(20) }}>
          <Text style={{ color: theme.colors.danger }}>{error}</Text>
        </View>
      )}

      <FlashList
        data={casts}
        extraData={likeStates}
        keyExtractor={(item) => item.hash}
        ListHeaderComponent={renderChannelHeader}
        // Loader lives inside the list (as the empty-state slot) so it
        // appears BELOW the channel header instead of above it. The
        // previous sibling-of-FlashList layout was claiming half the
        // screen and pushing the header down to fill the rest.
        ListEmptyComponent={
          isLoading ? (
            <View style={{ paddingVertical: Skin.space(32), alignItems: 'center' }}>
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          ) : null
        }
        renderItem={({ item }) => renderCast(item)}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: Skin.space(32) + bottomInset }}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) {
            fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={{ paddingVertical: Skin.space(20), alignItems: 'center' }}>
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          ) : null
        }
      />

      {/* Channel Image Viewer */}
      <ImageViewer
        visible={viewerState !== null}
        images={viewerState?.images}
        initialIndex={viewerState?.index}
        onClose={() => setViewerState(null)}
      />
    </View>
  );
}

interface SocialFeedModalProps {
  visible: boolean;
  onClose: () => void;
  token?: string;
  /** Initial thread to open when modal becomes visible */
  initialThread?: {
    username: string;
    castHashPrefix: string;
  };
  /** Initial channel to open (e.g. when navigated from a space binding chip) */
  initialChannel?: {
    channelKey: string;
  };
  /** Initial profile to open (e.g. when tapped from UserProfileModal's
   *  linked-Farcaster row). Pushes a profile screen on first mount. */
  initialProfile?: {
    fid: number;
    username?: string;
  };
  /** When true, renders as a full screen without modal animation (for route-based navigation) */
  isRouteMode?: boolean;
}

import type {
  FeedFilter,
  FeedPost,
  FrameEmbedInfo,
  QuoteCastEmbed,
  UrlEmbed,
  VideoEmbed,
} from '@/components/SocialFeed/types';

type SearchTab = 'top' | 'users' | 'channels' | 'casts';

// Search result item types for FlatList
type SearchResultItem =
  | { type: 'section-header'; title: string; key: string }
  | { type: 'user'; data: SearchUser; key: string }
  | { type: 'channel'; data: SearchChannel; key: string }
  | { type: 'cast'; data: SearchCast; key: string };

const AVATAR_FALLBACK = require('../assets/images/quorum-symbol-bg-blue.png');
// Default cast length for non-Pro users (Pro limits fetched dynamically)
const DEFAULT_CAST_LENGTH = 320;

// Memoized feed post card for better FlatList performance
interface FeedPostCardProps {
  post: FeedPost;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
  likeState?: { liked: boolean; count: number };
  recastState?: { recasted: boolean; count: number };
  followState?: boolean;
  token?: string;
  currentUserFid?: number;
  onNavigateToThread: (username: string, hash: string, focusReply?: boolean, placeholderCast?: unknown) => void;
  onNavigateToProfile: (fid: number, username?: string) => void;
  onOpenChannel: (channelKey: string) => void;
  onMentionPress: (username: string) => void;
  onLinkPress: (url: string) => void;
  onImagePress: (images: string[], index: number) => void;
  onLikeToggle: (hash: string, isLiked: boolean, count: number) => void;
  onOpenShareSheet: (hash: string, author: string, text: string, isRecasted: boolean, recastCount: number, authorFid?: number) => void;
  onFollow: (fid: number) => void;
  onReport: (castHash: string, authorFid?: number) => void;
  onDelete: (castHash: string) => void;
  /** Opens the tip flow for this cast. Tip button hidden when omitted. */
  onTipPress?: (target: TipTarget) => void;
  /** Gold Apex ring on the author avatar. Computed once at the list level
   *  (useApexStatusForFids) and passed down as a boolean so memoized rows
   *  don't churn. */
  authorIsApex?: boolean;
}

// Square media-grid cell — used by the "Media" filter to render the
// feed as a 3-wide Instagram-style grid. Edge-to-edge tiles (no gap)
// matches the Instagram aesthetic and keeps the row width exactly
// equal to SCREEN_WIDTH, which avoids FlashList layout thrash that
// produces the jittery scrolling we saw with the earlier marginRight-
// based layout (row width exceeded container width by 3*gap).
const GRID_TILE_SIZE = Math.floor(SCREEN_WIDTH / 3);

function pickGridThumb(post: FeedPost): { uri: string; isVideo: boolean } | null {
  if (post.mediaUrls.length > 0) return { uri: post.mediaUrls[0], isVideo: false };
  for (const v of post.videos) {
    if (v.thumbnailUrl) return { uri: v.thumbnailUrl, isVideo: true };
  }
  return null;
}

/**
 * Map a NormalizedCast (from quorum-shared's cast lookup) to the thread-API
 * cast shape that the thread renderer expects. Used to build an
 * optimistic placeholder for a parent cast when navigating into its
 * thread, so the parent renders immediately rather than the reply that
 * the user tapped.
 */
/** Minimal placeholder for the parent cast when the user taps a reply in
 *  the feed but the parent hasn't been resolved yet. Carries just the
 *  hash + parent author FID — enough for the thread view to render the
 *  back arrow against the parent (not the reply) while the real cast
 *  loads. Once the network response lands, this is replaced by the full
 *  fetched cast. */
function minimalParentStub(parentHash: string, parentAuthorFid: number | undefined): unknown {
  return {
    hash: parentHash,
    threadHash: parentHash,
    author: {
      fid: parentAuthorFid ?? 0,
      username: '',
      displayName: '',
    },
    text: '',
    timestamp: Date.now(),
    embeds: { images: [], videos: [] },
    replies: { count: 0 },
    reactions: { count: 0 },
    recasts: { count: 0 },
  };
}

function normalizedCastToPlaceholder(cast: NormalizedCast): unknown {
  return {
    hash: cast.hash,
    threadHash: cast.threadHash ?? cast.hash,
    author: {
      fid: cast.author.fid,
      username: cast.author.username,
      displayName: cast.author.displayName,
      pfp: cast.author.pfpUrl ? { url: cast.author.pfpUrl } : undefined,
    },
    text: cast.text,
    timestamp: cast.timestamp || Date.now(),
    embeds: {
      images: cast.embeds
        .filter((e) => e.image?.url)
        .map((e) => ({ url: e.image!.url!, alt: e.image!.alt })),
      videos: cast.embeds
        .filter((e) => e.video?.url || e.video?.sourceUrl)
        .map((e) => ({
          url: e.video!.url,
          sourceUrl: e.video!.sourceUrl,
          thumbnailUrl: e.video!.thumbnailUrl,
          width: e.video!.width,
          height: e.video!.height,
        })),
    },
    replies: { count: cast.reactions.repliesCount },
    reactions: { count: cast.reactions.likesCount },
    recasts: { count: cast.reactions.recastsCount },
    viewerContext: {
      reacted: cast.reactions.viewerLiked,
      recast: cast.reactions.viewerRecasted,
    },
    channel: cast.channel ? { key: cast.channel.key, name: cast.channel.name } : undefined,
    parentHash: cast.parentHash,
    parentUrl: cast.parentUrl,
  };
}

/**
 * Map a FeedPost (flat shape produced by useFarcasterFeed) to the
 * thread-API cast shape that the thread renderer expects. Used as an
 * optimistic placeholder when tapping a cell in the media grid so the
 * thread view shows the cast immediately while replies load in the
 * background. Anything we can't materialize (precise timestamp,
 * channel.key) is left undefined; the renderer's defensive fallbacks
 * handle the missing fields, and the real cast replaces this within
 * a few hundred ms when the thread fetch resolves.
 */
function feedPostToCastPlaceholder(post: FeedPost): unknown {
  return {
    hash: post.hash,
    threadHash: post.hash,
    author: {
      fid: post.authorFid,
      username: post.username,
      displayName: post.authorName,
      pfp: post.authorAvatar ? { url: post.authorAvatar } : undefined,
    },
    text: post.content,
    // No exact ms timestamp on FeedPost (it stores a relative string
    // already formatted for display). Date.now() puts the cast at
    // "just now" — slightly inaccurate but only visible for the
    // network round-trip.
    timestamp: Date.now(),
    embeds: {
      images: post.mediaUrls.map((url) => ({ url })),
      videos: post.videos,
    },
    replies: { count: parseInt(post.stats.replies, 10) || 0 },
    reactions: { count: parseInt(post.stats.likes, 10) || 0 },
    recasts: { count: parseInt(post.stats.shares, 10) || 0 },
    viewerContext: {
      reacted: post.viewerHasLiked,
      recast: post.viewerHasRecast,
    },
    channel: post.channel ? { key: post.channel } : undefined,
  };
}

const MediaGridCell = React.memo(function MediaGridCell({
  post,
  theme,
  onPress,
}: {
  post: FeedPost;
  theme: AppTheme;
  onPress: () => void;
}) {
  const thumb = pickGridThumb(post);
  if (!thumb) return null;
  const mediaCount = post.mediaUrls.length + post.videos.length;
  const showStack = mediaCount > 1;
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={{ width: GRID_TILE_SIZE, height: GRID_TILE_SIZE, backgroundColor: theme.colors.surface3 }}
    >
      {/* expo-image: GPU-accelerated decode + memory/disk cache.
          Decoding 60+ thumbnails with React Native's stock Image
          stalls the JS thread on the first scroll past each tile;
          expo-image hands decoding off to native so scrolling
          stays smooth. */}
      <ExpoImage
        source={{ uri: thumb.uri }}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={0}
        style={{ width: GRID_TILE_SIZE, height: GRID_TILE_SIZE }}
      />
      {thumb.isVideo && (
        <View style={{ position: 'absolute', top: 6, right: 6 }}>
          <IconSymbol name="play.rectangle.fill" size={16} color="#fff" />
        </View>
      )}
      {showStack && !thumb.isVideo && (
        <View style={{ position: 'absolute', top: 6, right: 6 }}>
          <IconSymbol name="square.stack" size={16} color="#fff" />
        </View>
      )}
    </TouchableOpacity>
  );
});

const FeedPostCard = React.memo(function FeedPostCard({
  post,
  theme,
  styles,
  likeState,
  recastState,
  followState,
  token,
  currentUserFid,
  onNavigateToThread,
  onNavigateToProfile,
  onOpenChannel,
  onMentionPress,
  onLinkPress,
  onImagePress,
  onLikeToggle,
  onOpenShareSheet,
  onFollow,
  onReport,
  onDelete,
  onTipPress,
  authorIsApex = false,
}: FeedPostCardProps) {
  const queryClient = useQueryClient();
  const navigateToThread = useCallback(() => {
    if (post.parentHash) {
      const parentNormalized =
        post.parentAuthorFid
          ? queryClient.getQueryData<NormalizedCast | null>(
              ['farcaster', 'cast', { hash: post.parentHash, fid: post.parentAuthorFid }] as const,
            )
          : null;
      // Always pass a placeholder for the parent so the back arrow renders
      // on the parent from the first frame. Cache hit gives full content
      // (text, author, embeds). Cache miss falls back to a hash-only stub
      // so the renderer has a non-undefined mainCast keyed to the parent
      // — without this, the loading window leaves mainCast undefined and
      // any later partial fetch (or a stray placeholder upstream) can
      // land on the reply instead.
      const parentPlaceholder = parentNormalized
        ? normalizedCastToPlaceholder(parentNormalized)
        : minimalParentStub(post.parentHash, post.parentAuthorFid);
      onNavigateToThread('', post.parentHash, false, parentPlaceholder);
      return;
    }
    if (post.username && post.hash) {
      onNavigateToThread(post.username, post.hash, false, feedPostToCastPlaceholder(post));
    }
  }, [post, onNavigateToThread, queryClient]);

  const navigateToReply = useCallback(() => {
    // Reply-compose target — always the cast itself (you're replying to
    // *this* cast, not its parent).
    if (post.username && post.hash) {
      onNavigateToThread(post.username, post.hash, true, feedPostToCastPlaceholder(post));
    }
  }, [post, onNavigateToThread]);

  const navigateToProfile = useCallback(() => {
    if (post.authorFid > 0) {
      onNavigateToProfile(post.authorFid, post.username);
    }
  }, [post.authorFid, post.username, onNavigateToProfile]);

  const isLiked = likeState?.liked ?? post.viewerHasLiked ?? false;
  const likeCount = likeState?.count ?? (parseInt(post.stats.likes, 10) || 0);
  const isRecasted = recastState?.recasted ?? post.viewerHasRecast ?? false;
  const recastCount = recastState?.count ?? (parseInt(post.stats.shares, 10) || 0);
  // Show follow button only when we explicitly know the user is not following
  // If viewerIsFollowing is undefined, we don't know the state, so default to hiding button
  // But if viewerIsFollowing is explicitly false, show the button
  const isFollowing = followState ?? (post.viewerIsFollowing === false ? false : true);

  // Skin "cast" surface — its own background (color or image).
  const castSurface = useSurface('cast');
  const castColor = castSurface.background && !castSurface.backgroundIsImage ? castSurface.background : undefined;
  const castImage = castSurface.backgroundIsImage ? castSurface.background : undefined;

  return (
    <View
      style={[
        styles.postCard,
        castColor ? { backgroundColor: castColor } : null,
        castImage ? { backgroundColor: 'transparent', overflow: 'hidden' } : null,
      ]}
    >
      {castImage && (
        <ExpoImage
          source={{ uri: castImage }}
          style={[StyleSheet.absoluteFill, { opacity: castSurface.opacity }]}
          contentFit={castSurface.fit === 'contain' ? 'contain' : 'cover'}
          cachePolicy="memory-disk"
        />
      )}
      <Pressable onPress={navigateToThread} style={styles.postHeader}>
        <TouchableOpacity onPress={navigateToProfile} style={styles.avatarContainer}>
          <ApexAvatarRing active={authorIsApex} size={44}>
            <Image
              source={post.authorAvatar ? { uri: post.authorAvatar } : AVATAR_FALLBACK}
              style={styles.avatar}
            />
          </ApexAvatarRing>
          {!isFollowing && post.authorFid > 0 && (
            <TouchableOpacity
              style={[styles.followButton, { backgroundColor: theme.colors.primary }]}
              onPress={() => onFollow(post.authorFid)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <IconSymbol name="plus" size={10} color="#fff" />
            </TouchableOpacity>
          )}
        </TouchableOpacity>
        <View style={styles.postAuthor}>
          <View style={styles.authorRow}>
            <TouchableOpacity onPress={navigateToProfile}>
              <Text style={styles.authorName}>{post.authorName}</Text>
            </TouchableOpacity>
            {post.isPro && (
              <IconSymbol name="star.fill" color={theme.colors.warning} size={14} />
            )}
            <ChannelBadge
              channelSlug={post.channel}
              parentUrl={post.parentUrl}
              theme={theme}
              onOpenChannel={onOpenChannel}
            />
          </View>
          <Text style={styles.authorHandle}>
            {post.authorHandle} • {post.time}
          </Text>
        </View>
        <CastOverflowButton
          castHash={post.hash}
          authorFid={post.authorFid}
          authorUsername={post.username}
          castText={post.content}
          onReport={onReport}
          onDelete={onDelete}
          theme={theme}
        />
      </Pressable>

      <ParentContextLine
        cast={{
          parentUrl: post.parentUrl,
          parentHash: post.parentHash,
          parentAuthor: post.parentAuthorFid ? { fid: post.parentAuthorFid } : undefined,
        }}
        theme={theme}
        onNavigateToThread={onNavigateToThread}
      />

      {post.content.trim().length > 0 && (
        <Pressable onPress={navigateToThread}>
          <Translatable
            text={post.content}
            theme={theme}
            renderText={(t) => (
              <CastText
                text={t}
                style={styles.postContent}
                theme={theme}
                onMentionPress={onMentionPress}
                onChannelPress={onOpenChannel}
                onLinkPress={onLinkPress}
              />
            )}
          />
        </Pressable>
      )}

      {post.mediaUrls.length > 0 && (
        <View style={styles.mediaContainer}>
          {post.mediaUrls.length === 1 ? (
            <AutoHeightImage
              uri={post.mediaUrls[0]}
              maxHeight={Infinity}
              style={styles.postMedia}
              onPress={() => onImagePress(post.mediaUrls, 0)}
            />
          ) : (
            <ImageCarousel
              urls={post.mediaUrls}
              maxHeight={Infinity}
              theme={theme}
              onImagePress={(_, index) => onImagePress(post.mediaUrls, index)}
            />
          )}
        </View>
      )}

      {post.videos.length > 0 && (
        <View style={styles.mediaContainer}>
          {post.videos.map((video, index) => (
            video.url && (
              <VideoPlayer
                key={index}
                url={video.url}
                thumbnailUrl={video.thumbnailUrl}
                width={video.width}
                height={video.height}
                duration={video.duration}
                theme={theme}
              />
            )
          ))}
        </View>
      )}

      {post.frameEmbeds.length > 0 && (
        <View style={styles.mediaContainer}>
          {post.frameEmbeds.map((frame, index) => (
            <FrameEmbed
              key={index}
              imageUrl={frame.imageUrl}
              buttonTitle={frame.buttonTitle}
              actionUrl={frame.actionUrl}
              theme={theme}
              onPress={() => onLinkPress(frame.actionUrl)}
            />
          ))}
        </View>
      )}

      {post.quoteCasts.length > 0 && (
        <View style={{ gap: Skin.space(8) }}>
          {post.quoteCasts.map((qc, index) => (
            <QuoteCast
              key={index}
              cast={qc.cast}
              theme={theme}
              onPress={() => onNavigateToThread(qc.username, qc.cast.hash, false, qc.cast)}
            />
          ))}
        </View>
      )}

      {post.urlPreviews.length > 0 && (
        <View style={{ gap: Skin.space(8), paddingHorizontal: Skin.space(12) }}>
          {post.urlPreviews.map((preview, index) => {
            if (preview.isQuorumInvite && preview.url) {
              return <InviteLinkCard key={index} inviteLink={preview.url} />;
            }
            const spaceRef = parseFarcasterSpaceUrl(preview.url);
            if (spaceRef) {
              return (
                <AudioSpaceEmbed
                  key={index}
                  spaceId={spaceRef.id}
                  castHash={post.hash}
                  onFallbackOpen={() => preview.url && onLinkPress(preview.url)}
                />
              );
            }
            const tokenRef = parseFarcasterTokenUrl(preview.url);
            if (tokenRef) {
              return (
                <FarcasterTokenEmbed
                  key={index}
                  chain={tokenRef.chain}
                  contractAddress={tokenRef.contractAddress}
                  theme={theme}
                />
              );
            }
            if (preview.isFarcasterLink && preview.farcasterUsername && preview.farcasterCastHash) {
              return (
                <FarcasterCastUrlEmbed
                  key={index}
                  username={preview.farcasterUsername}
                  castHashPrefix={preview.farcasterCastHash}
                  fallbackTitle={preview.title}
                  fallbackDescription={preview.description}
                  theme={theme}
                  onPress={() => onNavigateToThread(preview.farcasterUsername!, preview.farcasterCastHash!)}
                />
              );
            }
            return (
              <SnapAwareUrlPreview
                key={index}
                url={preview.url}
                snapUrl={preview.snapUrl}
                title={preview.title}
                description={preview.description}
                domain={preview.domain}
                image={preview.image}
                useLargeImage={preview.useLargeImage}
                frameImageUrl={preview.frameImageUrl}
                frameButtonTitle={preview.frameButtonTitle}
                frameActionUrl={preview.frameActionUrl}
                theme={theme}
                userFid={currentUserFid}
                token={token}
                onPress={preview.url ? () => onLinkPress(preview.url!) : undefined}
                onOpenUrl={(u) => onLinkPress(u)}
                onOpenProfile={(fid) => onNavigateToProfile(fid)}
                onOpenMiniApp={(u) => onLinkPress(u)}
              />
            );
          })}
        </View>
      )}

      {/* Inline YouTube URLs in cast text (deduped against existing embeds) */}
      <InlineYouTubeFromText
        text={post.content}
        excludeUrls={post.urlPreviews.map((p) => p.url)}
        theme={theme}
      />

      {/* Channel / topic tag pills used to render here. They duplicated
          the /channel link in the cast header (rendered above next to
          the author name) — same channel, two visual treatments. Kept
          just the header link. */}

      <View style={styles.postStats}>
        <TouchableOpacity
          style={styles.statButton}
          onPress={() => onLikeToggle(post.hash, isLiked, likeCount)}
          hitSlop={12}
        >
          <LikeIcon
            type={getLikeIconType(post.content)}
            isLiked={isLiked}
            color={theme.colors.textMuted}
            activeColor={theme.colors.danger}
            size={20}
          />
          {likeCount > 0 && (
            <Text style={styles.statText}>{likeCount}</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.statButton}
          onPress={navigateToReply}
          hitSlop={12}
        >
          <IconSymbol name="bubble.left" color={theme.colors.textMuted} size={20} />
          {post.stats.replies !== '0' && (
            <Text style={styles.statText}>{post.stats.replies}</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.statButton}
          hitSlop={12}
          onPress={() => onOpenShareSheet(post.hash, post.username ?? '', post.content ?? '', isRecasted, recastCount, post.authorFid)}
        >
          <IconSymbol
            name="arrow.triangle.2.circlepath"
            color={isRecasted ? theme.colors.success : theme.colors.textMuted}
            size={20}
          />
          {recastCount > 0 && (
            <Text style={styles.statText}>{recastCount}</Text>
          )}
        </TouchableOpacity>
        {onTipPress && post.authorFid > 0 && post.authorFid !== currentUserFid && (
          <TouchableOpacity
            style={styles.statButton}
            hitSlop={12}
            onPress={() => onTipPress({
              castHash: post.hash,
              castText: post.content,
              authorFid: post.authorFid,
              authorUsername: post.username,
              authorDisplayName: post.authorName,
            })}
          >
            <SnapIcon color={theme.colors.textMuted} size={24} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
});

// Navigation stack types
type NavScreen =
  | { type: 'feed' }
  | {
      type: 'thread';
      username: string;
      castHashPrefix: string;
      focusReply?: boolean;
      // Optional cast snapshot from the surface that pushed this
      // screen. Used as an optimistic placeholder so the thread view
      // shows real content immediately instead of just a spinner
      // while the network request resolves. Shape kept loose because
      // different sources (feed item, channel cast, embedded preview,
      // thread reply) carry different field subsets.
      placeholderCast?: unknown;
    }
  | { type: 'profile'; fid: number; username?: string }
  | { type: 'channel'; channelKey: string }
  | { type: 'proposal'; proposalId: string };

export interface SocialFeedModalHandle {
  /** Apply the "tab icon pressed while already on feed" behavior:
   *   - if a thread/profile/channel is on the internal nav stack → pop to root feed;
   *   - else if the feed list is scrolled down → scroll to top;
   *   - else → refresh. */
  handleActiveTabTap: () => void;
}

const SocialFeedModal = React.forwardRef<SocialFeedModalHandle, SocialFeedModalProps>(
function SocialFeedModal({ visible, token, onClose: _onClose, initialThread, initialChannel, initialProfile, isRouteMode = false }, externalRef) {
  const slideAnim = useRef(new Animated.Value(isRouteMode ? 0 : SCREEN_HEIGHT)).current;
  const backdropAnim = useRef(new Animated.Value(isRouteMode ? 1 : 0)).current;
  const { theme, isDark } = useTheme();
  const { user } = useAuth();
  const currentUserFid = user?.farcaster?.fid;
  const insets = useSafeAreaInsets();
  const { submitCast: submitMainCast } = useFarcasterSubmitCast({ token });

  // Farcaster Pro status and cast limits
  const { regularCastByteLimit, longCastByteLimit, isPro } = useFarcasterCastLimits();
  const maxCastLength = isPro ? longCastByteLimit : regularCastByteLimit;
  const [activeFilter, setActiveFilter] = useState<FeedFilter>('all');
  const [rendered, setRendered] = useState(visible);
  const [castText, setCastText] = useState('');
  const [castCursorPosition, setCastCursorPosition] = useState(0);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [selectedImages, setSelectedImages] = useState<ProcessedAttachment[]>([]);

  // Mention autocomplete state for compose
  const composeMentionInfo = useMemo(
    () => getMentionInfo(castText, castCursorPosition),
    [castText, castCursorPosition]
  );

  // Handle selecting a user mention in compose
  const handleComposeSelectUser = useCallback((user: SearchUser) => {
    if (!composeMentionInfo) return;
    const newText = replaceMention(castText, composeMentionInfo, user.username);
    setCastText(newText.slice(0, maxCastLength));
    setCastCursorPosition(composeMentionInfo.replaceStart + user.username.length + 1);
  }, [castText, composeMentionInfo, maxCastLength]);

  // Handle selecting a channel mention in compose
  const handleComposeSelectChannel = useCallback((channel: SearchChannel) => {
    if (!composeMentionInfo) return;
    const newText = replaceMention(castText, composeMentionInfo, channel.key);
    setCastText(newText.slice(0, maxCastLength));
    setCastCursorPosition(composeMentionInfo.replaceStart + channel.key.length + 1);
  }, [castText, composeMentionInfo, maxCastLength]);

  // Navigation stack - starts with feed, can push thread/profile/channel views
  const [navStack, setNavStack] = useState<NavScreen[]>(() => {
    if (initialThread) {
      return [{ type: 'feed' }, { type: 'thread', username: initialThread.username, castHashPrefix: initialThread.castHashPrefix }];
    }
    if (initialChannel) {
      return [{ type: 'feed' }, { type: 'channel', channelKey: initialChannel.channelKey }];
    }
    if (initialProfile) {
      return [{ type: 'feed' }, { type: 'profile', fid: initialProfile.fid, username: initialProfile.username }];
    }
    return [{ type: 'feed' }];
  });

  const { openMiniapp } = useMiniappOverlay();
  // Tip flow — one TipModal mounted at this level serves every surface
  // (feed rows, thread detail, profile, channel); surfaces pass the cast
  // info up via onTipPress.
  const [tipTarget, setTipTarget] = useState<TipTarget | null>(null);
  const handleOpenTip = useCallback((target: TipTarget) => setTipTarget(target), []);
  const [composeVisible, setComposeVisible] = useState(false);
  const [composeChannelKey, setComposeChannelKey] = useState<string | undefined>(undefined);
  const [composeChannelPickerVisible, setComposeChannelPickerVisible] = useState(false);
  // Governance proposal compose: blank /hegemony cast that gets a `PROPOSAL: `
  // prefix on submit (the user never types it). Locks the channel to hegemony.
  const [composeProposalMode, setComposeProposalMode] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Mini app compose state
  const [miniAppEmbeds, setMiniAppEmbeds] = useState<string[]>([]);
  const miniAppComposeResolverRef = useRef<((result: ComposeCastResult) => void) | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActive, setSearchActive] = useState(false);
  const [searchTab, setSearchTab] = useState<SearchTab>('top');
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 300);
  const searchInputRef = useRef<TextInput>(null);
  // Track when the main feed has scrolled past its inline search bar so
  // the floating magnifying-glass shortcut can appear top-right.
  const feedListRef = useRef<FlashListRef<FeedPost> | null>(null);
  const searchBarHeightRef = useRef(0);
  const [searchBarOutOfView, setSearchBarOutOfView] = useState(false);
  // Detached floating-search overlay state — independent of the inline
  // search bar's focus. The overlay renders its own TextInput bound to
  // the same `searchQuery`, so search results behave identically whether
  // the inline or floating input was used.
  const [floatingSearchVisible, setFloatingSearchVisible] = useState(false);
  const floatingSearchInputRef = useRef<TextInput>(null);

  // Navigation helpers
  const pushScreen = useCallback((screen: NavScreen) => {
    setNavStack(prev => [...prev, screen]);
  }, []);

  const popScreen = useCallback(() => {
    setNavStack(prev => prev.length > 1 ? prev.slice(0, -1) : prev);
  }, []);

  // Android hardware back button. When we're inside a sub-screen
  // (thread / profile / channel / governance), pop the nav stack
  // instead of letting the system close the modal or exit the tab —
  // that matches the on-screen back chevron and the swipe-back
  // gesture's behavior. Outside a sub-screen (we're on the feed
  // root) we return false so the OS handles it normally.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const onBack = () => {
      if (navStack.length > 1) {
        popScreen();
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [navStack.length, popScreen]);

  const currentScreen = navStack[navStack.length - 1];

  // Swipe-back gesture for navigation stack
  const SWIPE_EDGE_WIDTH = 80;
  const swipeTranslateX = useSharedValue(0);
  const isSwipeActive = useSharedValue(false);

  const swipeBackGesture = useMemo(() => Gesture.Pan()
    // Activate quickly on rightward motion. Y-fail bounds used to be
    // ±10 which is tighter than most real edge-swipes (thumbs drift
    // vertically). Loosened so the gesture actually fires.
    .activeOffsetX(10)
    .failOffsetX(-25)
    .failOffsetY([-30, 30])
    .onStart((event) => {
      // Only allow swipe-back when there's something to go back to
      const canGoBack = navStack.length > 1;
      const isNearLeftEdge = event.absoluteX < SWIPE_EDGE_WIDTH;
      isSwipeActive.value = canGoBack && isNearLeftEdge;
    })
    .onUpdate((event) => {
      if (isSwipeActive.value && event.translationX > 0) {
        swipeTranslateX.value = Math.min(event.translationX, SCREEN_WIDTH);
      }
    })
    .onEnd((event) => {
      if (isSwipeActive.value) {
        const threshold = SCREEN_WIDTH / 3;
        if (event.translationX > threshold || event.velocityX > 400) {
          // Complete the swipe - animate out then pop
          swipeTranslateX.value = withSpring(SCREEN_WIDTH, { damping: 28, stiffness: 300 }, () => {
            runOnJS(popScreen)();
            swipeTranslateX.value = 0;
          });
        } else {
          // Cancel - spring back
          swipeTranslateX.value = withSpring(0, { damping: 28, stiffness: 300 });
        }
      }
      isSwipeActive.value = false;
    }), [navStack.length, popScreen]);

  const swipeAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: swipeTranslateX.value }],
  }));

  // Legacy compatibility - derive selected* from navStack for components that still use them
  const selectedThread = currentScreen.type === 'thread' ? { username: currentScreen.username, castHashPrefix: currentScreen.castHashPrefix } : null;
  const selectedProfile = currentScreen.type === 'profile' ? { fid: currentScreen.fid, username: currentScreen.username } : null;
  const selectedChannel = currentScreen.type === 'channel' ? { channelKey: currentScreen.channelKey } : null;

  // Update navStack when initialThread/initialChannel changes (e.g., opening from chat or a space binding chip)
  useEffect(() => {
    if (!visible) return;
    if (initialThread) {
      setNavStack([{ type: 'feed' }, { type: 'thread', username: initialThread.username, castHashPrefix: initialThread.castHashPrefix }]);
    } else if (initialChannel) {
      setNavStack([{ type: 'feed' }, { type: 'channel', channelKey: initialChannel.channelKey }]);
    }
  }, [visible, initialThread, initialChannel]);

  // Track keyboard height for compose modal positioning
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSubscription = Keyboard.addListener(showEvent, (e: KeyboardEvent) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  const openMiniApp = useCallback((url: string) => {
    openMiniapp({ url, isQNative: false });
  }, [openMiniapp]);

  const handleMentionPress = useCallback(async (username: string) => {
    try {
      const response = await fetch(`https://farcaster.xyz/~api/v2/user-by-username?username=${username}`, {
        headers: {
          accept: '*/*',
          origin: 'https://farcaster.xyz',
          referer: 'https://farcaster.xyz/',
        },
      });
      if (response.ok) {
        const json = await response.json();
        const fid = json.result?.fid || json.result?.user?.fid;
        if (fid) {
          pushScreen({ type: 'profile', fid, username });
        }
      }
    } catch {
      // Profile lookup failed — no action needed
    }
  }, [pushScreen]);

  const openChannel = useCallback((channelKey: string) => {
    pushScreen({ type: 'channel', channelKey });
  }, [pushScreen]);

  // Optimistic like/recast/follow now live in the persistent feed-optimistic
  // store (survive remounts, shared across every view). Reading its live
  // immutable maps preserves the existing `likeStates`/`recastStates`/
  // `followStates` prop + FlashList `extraData` contract unchanged.
  // Mounting the hook here also keeps the background pending-cast submit
  // queue running feed-wide.
  const optimistic = useFeedOptimistic();
  const { toggleLike, toggleRecast, toggleFollow } = optimistic;
  const likeStates = optimistic.getLikes();

  // Image viewer state for feed images
  const [feedViewerState, setFeedViewerState] = useState<{ images: string[]; index: number } | null>(null);

  // Share action sheet state for main feed
  const [feedShareSheet, setFeedShareSheet] = useState<{
    hash: string;
    author: string;
    authorFid?: number;
    text: string;
    isRecasted: boolean;
    recastCount: number;
  } | null>(null);
  // Report target for the main feed (mirrors the thread view's flow).
  const [feedReportTarget, setFeedReportTarget] = useState<{
    castHash: string;
    castAuthorFid?: number;
  } | null>(null);

  const handleLikeToggle = useCallback(
    (castHash: string, currentlyLiked: boolean, currentCount: number) => {
      void toggleLike(castHash, currentlyLiked, currentCount);
    },
    [toggleLike],
  );

  // Optimistic recast states now read from the store (see `optimistic` above).
  const recastStates = optimistic.getRecasts();

  const handleRecastToggle = useCallback(
    (castHash: string, currentlyRecasted: boolean, currentCount: number) => {
      void toggleRecast(castHash, currentlyRecasted, currentCount);
    },
    [toggleRecast],
  );

  // Optimistic follow states now read from the store.
  const followStates = optimistic.getFollows();

  const handleFollow = useCallback(
    (fid: number) => {
      // The follow button only renders when not already following.
      void toggleFollow(fid, false);
    },
    [toggleFollow],
  );

  // Quote cast handler - opens compose modal with quote embed
  const [quoteCastEmbed, setQuoteCastEmbed] = useState<{ hash: string; author: string; text: string } | null>(null);

  const handleQuoteCast = useCallback((castHash: string, castAuthor: string, castText: string) => {
    setQuoteCastEmbed({ hash: castHash, author: castAuthor, text: castText });
    setComposeVisible(true);
  }, []);

  // Mini app compose handler - called when mini app requests to compose a cast
  // Note: BrowserModal now handles compose internally as an overlay, so this is only
  // used if compose is triggered from within SocialFeedModal's own content
  const handleMiniAppCompose = useCallback((options: ComposeCastOptions): Promise<ComposeCastResult> => {
    return new Promise((resolve) => {
      // Store the resolver to call when compose is complete
      miniAppComposeResolverRef.current = resolve;

      // Pre-fill compose modal with mini app options
      setCastText(options.text ?? '');
      setMiniAppEmbeds(options.embeds ?? []);
      setQuoteCastEmbed(null); // Clear any quote embed

      // Show compose modal
      setComposeVisible(true);
    });
  }, []);

  // Cancel compose handler - cleans up state and rejects mini app promise if active
  const handleCancelCompose = useCallback(() => {
    setComposeVisible(false);
    setQuoteCastEmbed(null);
    setSelectedImages([]);
    setCastText('');
    setComposeChannelKey(undefined);
    setComposeProposalMode(false);

    // Reject mini app promise if compose was triggered by mini app
    if (miniAppComposeResolverRef.current) {
      miniAppComposeResolverRef.current({ error: { type: 'rejected_by_user', message: 'User cancelled' } });
      miniAppComposeResolverRef.current = null;
    }
    setMiniAppEmbeds([]);
  }, []);

  // Share to chat state
  const [shareToChatUrl, setShareToChatUrl] = useState<string | null>(null);

  // Share to chat handler - opens the share to chat modal
  const handleShareToChat = useCallback((castUrl: string) => {
    setFeedShareSheet(null); // Close the share action sheet
    setShareToChatUrl(castUrl);
  }, []);

  // Memoized callbacks for FeedPostCard
  const handleNavigateToThread = useCallback(
    (username: string, hashPrefix: string, focusReply?: boolean, placeholderCast?: unknown) => {
      pushScreen({
        type: 'thread',
        username,
        castHashPrefix: hashPrefix,
        focusReply,
        placeholderCast,
      });
    },
    [pushScreen],
  );

  const handleNavigateToProfile = useCallback((fid: number, username?: string) => {
    pushScreen({ type: 'profile', fid, username });
  }, [pushScreen]);

  const handleOpenShareSheet = useCallback((hash: string, author: string, text: string, isRecasted: boolean, recastCount: number, authorFid?: number) => {
    setFeedShareSheet({ hash, author, authorFid, text, isRecasted, recastCount });
  }, []);

  const handleReportCast = useCallback((castHash: string, castAuthorFid?: number) => {
    setFeedReportTarget({ castHash, castAuthorFid });
  }, []);

  const handleDeleteCast = useCallback((castHash: string) => {
    void optimistic.deleteCast(castHash);
  }, [optimistic.deleteCast]);

  const {
    data: farcasterItems,
    isLoading,
    isFetchingNextPage,
    error,
    hasNextPage,
    fetchNextPage,
    refetch,
    isRefetching,
  } = useFarcasterFeed({
    token,
    enabled: visible,
  });

  // Warm the viewer's block + mute lists as soon as the social feed opens
  // (rather than waiting until a thread is opened). Persisted to MMKV +
  // refreshed in the background by the hooks; thread views read the same
  // cached sets to collapse blocked/muted replies behind a tap-to-show
  // placeholder.
  useBlockedFids();
  useMutedFids();

  // Skin "feed" surface — a background for the whole social area.
  const feedSurface = useSurface('feed');
  const feedColor = feedSurface.background && !feedSurface.backgroundIsImage ? feedSurface.background : undefined;
  const feedImage = feedSurface.backgroundIsImage ? feedSurface.background : undefined;

  // Live scroll position of the home feed list — used to decide
  // whether tapping the active feed tab should scroll-to-top or
  // refresh. Ref instead of state since we don't need re-renders.
  const feedScrollYRef = useRef(0);

  // Exposed via forwardRef. Drives the "tap feed tab while on feed"
  // behavior: pop a thread/profile/channel back to the feed; else
  // scroll to top if scrolled; else refresh.
  React.useImperativeHandle(externalRef, () => ({
    handleActiveTabTap: () => {
      if (navStack.length > 1) {
        // Pop ALL inner screens — most natural interpretation of
        // "take me back to the feed" when the user might be deep in
        // thread → profile → thread.
        setNavStack([{ type: 'feed' }]);
        return;
      }
      if (feedScrollYRef.current > 64) {
        feedListRef.current?.scrollToOffset({ offset: 0, animated: true });
        return;
      }
      // At top already — pull-to-refresh equivalent.
      void refetch();
    },
  }), [navStack.length, refetch]);

  // Search hooks
  const { data: searchSummary, isLoading: isSearchLoading } = useSearchSummary({
    q: debouncedSearchQuery,
    token,
    enabled: visible && searchActive && debouncedSearchQuery.length > 0,
  });

  const { users: searchUsers, onEndReached: onUsersEndReached, isFetchingNextPage: isFetchingMoreUsers } = useSearchUsers({
    q: debouncedSearchQuery,
    token,
    enabled: visible && searchActive && searchTab === 'users' && debouncedSearchQuery.length > 0,
  });

  const { channels: searchChannels, onEndReached: onChannelsEndReached, isFetchingNextPage: isFetchingMoreChannels } = useSearchChannels({
    q: debouncedSearchQuery,
    token,
    enabled: visible && searchActive && searchTab === 'channels' && debouncedSearchQuery.length > 0,
  });

  const { casts: searchCasts, onEndReached: onCastsEndReached, isFetchingNextPage: isFetchingMoreCasts } = useSearchCasts({
    q: debouncedSearchQuery,
    token,
    enabled: visible && searchActive && searchTab === 'casts' && debouncedSearchQuery.length > 0,
  });

  // User's followed channels for tabs
  const { data: followedChannels } = useUserFollowedChannels({
    fid: currentUserFid,
    token,
    enabled: visible && !!currentUserFid,
  });

  useEffect(() => {
    // In route mode, always stay visible
    if (isRouteMode) {
      setRendered(true);
      slideAnim.setValue(0);
      backdropAnim.setValue(1);
      return;
    }

    if (visible) {
      setRendered(true);
      // Instantly show - no animation
      slideAnim.setValue(0);
      backdropAnim.setValue(1);
    } else {
      // Instantly hide - no animation
      slideAnim.setValue(SCREEN_HEIGHT);
      backdropAnim.setValue(0);
      setRendered(false);
    }
  }, [backdropAnim, slideAnim, visible, isRouteMode]);

  const styles = useMemo(() => createStyles(theme, isDark, insets), [theme, isDark, insets]);

  const posts = useMemo<FeedPost[]>(() => {
    return farcasterItems.map((item) => {
      const cast = item.cast;
      const mediaUrls = (cast.embeds?.images ?? [])
        .map((img) => img.url)
        .filter((url): url is string => Boolean(url));

      // FeedPost only needs a URL — thumbnails are nice-to-have and
      // missing for hypersnap-bare HLS streams.
      const videos: VideoEmbed[] = (cast.embeds?.videos ?? [])
        .filter((v) => Boolean(v.url))
        .map((v) => ({
          url: v.url,
          thumbnailUrl: v.thumbnailUrl,
          width: v.width,
          height: v.height,
          duration: v.duration,
        }));

      // Extract embedded casts (quote casts). Hypersnap delivers cast_id
      // embeds as `{hash, fid}` stubs with no username inline —
      // QuoteCast lazy-resolves the real cast via useFarcasterCast at
      // render time, so we only need hash + author.fid here. Previously
      // we required `c.author?.username`, which dropped every stub.
      const quoteCasts: QuoteCastEmbed[] = (cast.embeds?.casts ?? [])
        .filter((c) => Boolean(c.hash) && c.author && Number.isFinite(c.author.fid) && c.author.fid > 0)
        .map((c) => ({
          cast: c,
          username: c.author.username || '',
          hashPrefix: c.hash.slice(0, 10), // e.g., "0x2cba399b"
        }));

      // Extract URL embeds. Each `cast.embeds.urls` entry becomes EXACTLY ONE
      // `urlPreviews` item — `SnapAwareUrlPreview` decides at render time whether
      // to show a snap, a frame/miniapp card, or a plain link preview, so we
      // don't render duplicates. (`frameEmbeds` stays empty for new posts.)
      const allUrls = cast.embeds?.urls ?? [];
      const frameEmbeds: FrameEmbedInfo[] = [];

      const urlPreviews: UrlEmbed[] = allUrls
        .filter((u) => {
          const frameUrl = u.openGraph?.frameEmbedNext?.frameUrl;
          const frameEmbed = u.openGraph?.frameEmbedNext?.frameEmbed;
          // Always keep frame/snap embeds — the renderer picks the right UI
          if (frameUrl || frameEmbed?.imageUrl) return true;
          // Skip farcaster.xyz links if we already have the cast embedded
          const url = u.openGraph?.url || u.openGraph?.sourceUrl || '';
          if (url.includes('farcaster.xyz/')) {
            const parsed = parseFarcasterUrl(url);
            if (parsed) {
              const alreadyEmbedded = quoteCasts.some(
                (qc) => qc.hashPrefix.toLowerCase().startsWith(parsed.castHashPrefix.toLowerCase())
              );
              return !alreadyEmbedded;
            }
          }
          if (containsInviteLink(url)) return true;
          // Keep any URL we know about, OG-enriched or not. Hypersnap
          // returns bare URLs without OG, and SnapAwareUrlPreview can
          // still render a minimal "open link" card from just the URL.
          return Boolean(url);
        })
        .map((u) => {
          const url = u.openGraph?.url || u.openGraph?.sourceUrl || '';
          const parsed = url.includes('farcaster.xyz/') ? parseFarcasterUrl(url) : null;
          const isQuorumInvite = containsInviteLink(url);
          const frameEmbed = u.openGraph?.frameEmbedNext?.frameEmbed;
          const frameImageUrl = frameEmbed?.imageUrl;
          const frameAction = frameEmbed?.button?.action?.url;
          return {
            url,
            title: u.openGraph?.title,
            description: u.openGraph?.description,
            domain: u.openGraph?.domain,
            image: u.openGraph?.image,
            useLargeImage: u.openGraph?.useLargeImage,
            isFarcasterLink: Boolean(parsed),
            farcasterUsername: parsed?.username,
            farcasterCastHash: parsed?.castHashPrefix,
            isQuorumInvite,
            snapUrl: u.openGraph?.frameEmbedNext?.frameUrl,
            frameImageUrl,
            frameButtonTitle: frameEmbed?.button?.title ?? 'Open',
            frameActionUrl: frameAction ?? u.openGraph?.url ?? undefined,
          };
        });

      const tags =
        cast.tags
          ?.filter((tag) => tag.id || tag.name)
          .map((tag) => `#${(tag.id || tag.name || '').toLowerCase()}`)
          .slice(0, 3) ?? [];

      const hasMedia = mediaUrls.length > 0 || videos.length > 0;
      const filter = deriveFilter(cast, hasMedia);

      const accountLevel = cast.author?.profile?.accountLevel?.toLowerCase();
      return {
        id: item.id,
        hash: cast.hash,
        username: cast.author?.username ?? '',
        authorFid: cast.author?.fid ?? 0,
        authorName: cast.author?.displayName || `fid:${cast.author?.fid}`,
        authorHandle: cast.author?.username ? `@${cast.author.username}` : '',
        authorAvatar: cast.author?.pfp?.url,
        channel: cast.channel?.name,
        parentHash: cast.parentHash,
        parentUrl: cast.parentUrl,
        parentAuthorFid: cast.parentAuthor?.fid,
        isPro: accountLevel === 'pro' || accountLevel === 'premium',
        time: formatTimestamp(cast.timestamp),
        content: cast.text,
        stats: {
          likes: formatCount(cast.reactions?.count),
          replies: formatCount(cast.replies?.count),
          shares: formatCount(cast.recasts?.count),
        },
        tags,
        mediaUrls,
        videos,
        urlPreviews,
        quoteCasts,
        frameEmbeds,
        filter,
        viewerHasLiked: cast.viewerContext?.reacted,
        viewerHasRecast: cast.viewerContext?.recast,
        viewerIsFollowing: cast.author?.viewerContext?.following,
      };
    });
  }, [farcasterItems]);

  const filteredPosts = useMemo(() => {
    if (activeFilter === 'all') {
      return posts;
    }
    return posts.filter((post) => post.filter === activeFilter);
  }, [activeFilter, posts]);

  // Bulk-resolve parent author handles for the visible feed page so
  // ParentContextLine renders @handle immediately instead of fid:N → @handle.
  useFarcasterUsersPrefetch(
    useMemo(() => filteredPosts.map((p) => p.parentAuthorFid), [filteredPosts]),
  );

  // Apex gold ring — one batched status lookup for all feed authors;
  // FeedPostCard rows get a stable boolean so memoization holds.
  const feedApexFids = useApexStatusForFids(
    useMemo(() => filteredPosts.map((p) => p.authorFid), [filteredPosts]),
  );

  // Build search results list based on current tab
  const searchResultItems = useMemo<SearchResultItem[]>(() => {
    if (!searchActive || !debouncedSearchQuery) return [];

    if (searchTab === 'top' && searchSummary) {
      // Top view shows preview of all categories
      const items: SearchResultItem[] = [];

      if (searchSummary.users.length > 0) {
        items.push({ type: 'section-header', title: 'Users', key: 'section-users' });
        searchSummary.users.forEach((user) => {
          items.push({ type: 'user', data: user, key: `user-${user.fid}` });
        });
      }

      if (searchSummary.channels.length > 0) {
        items.push({ type: 'section-header', title: 'Channels', key: 'section-channels' });
        searchSummary.channels.forEach((channel) => {
          items.push({ type: 'channel', data: channel, key: `channel-${channel.key}` });
        });
      }

      if (searchSummary.casts.length > 0) {
        items.push({ type: 'section-header', title: 'Casts', key: 'section-casts' });
        searchSummary.casts.forEach((cast) => {
          items.push({ type: 'cast', data: cast, key: `cast-${cast.hash}` });
        });
      }

      return items;
    }

    if (searchTab === 'users') {
      return searchUsers.map((user) => ({ type: 'user' as const, data: user, key: `user-${user.fid}` }));
    }

    if (searchTab === 'channels') {
      return searchChannels.map((channel) => ({ type: 'channel' as const, data: channel, key: `channel-${channel.key}` }));
    }

    if (searchTab === 'casts') {
      return searchCasts.map((cast) => ({ type: 'cast' as const, data: cast, key: `cast-${cast.hash}` }));
    }

    return [];
  }, [searchActive, debouncedSearchQuery, searchTab, searchSummary, searchUsers, searchChannels, searchCasts]);

  // Handlers for search result item presses
  const handleSearchUserPress = useCallback((user: SearchUser) => {
    setSearchActive(false);
    setSearchQuery('');
    Keyboard.dismiss();
    pushScreen({ type: 'profile', fid: user.fid, username: user.username });
  }, [pushScreen]);

  const handleSearchChannelPress = useCallback((channel: SearchChannel) => {
    setSearchActive(false);
    setSearchQuery('');
    Keyboard.dismiss();
    pushScreen({ type: 'channel', channelKey: channel.key });
  }, [pushScreen]);

  const handleSearchCastPress = useCallback((cast: SearchCast) => {
    setSearchActive(false);
    setSearchQuery('');
    Keyboard.dismiss();
    // Pass the cast as a placeholder so the thread shows real content
    // immediately while the full thread loads.
    pushScreen({
      type: 'thread',
      username: cast.author.username,
      castHashPrefix: cast.hash.slice(0, 10),
      placeholderCast: cast,
    });
  }, [pushScreen]);

  // Render function for search results
  const renderSearchResultItem = useCallback(({ item }: { item: SearchResultItem }) => {
    if (item.type === 'section-header') {
      return (
        <View style={styles.searchSectionHeader}>
          <Text style={styles.searchSectionTitle}>{item.title}</Text>
        </View>
      );
    }

    if (item.type === 'user') {
      const user = item.data;
      return (
        <TouchableOpacity style={styles.searchResultItem} onPress={() => handleSearchUserPress(user)}>
          <CachedAvatar
            source={user.pfp?.url ? { uri: user.pfp.url } : null}
            fallbackName={user.displayName || user.username}
            style={styles.searchResultAvatar}
          />
          <View style={styles.searchResultInfo}>
            <Text style={styles.searchResultName}>{user.displayName}</Text>
            <Text style={styles.searchResultUsername}>@{user.username}</Text>
            {user.profile?.bio?.text && (
              <Text style={styles.searchResultBio} numberOfLines={2}>{user.profile.bio.text}</Text>
            )}
            {user.followerCount !== undefined && (
              <Text style={styles.searchResultFollowers}>
                {user.followerCount.toLocaleString()} followers
              </Text>
            )}
          </View>
        </TouchableOpacity>
      );
    }

    if (item.type === 'channel') {
      const channel = item.data;
      return (
        <TouchableOpacity style={styles.searchResultItem} onPress={() => handleSearchChannelPress(channel)}>
          {channel.imageUrl ? (
            <Image source={{ uri: channel.imageUrl }} style={styles.channelImage} />
          ) : (
            <View style={styles.channelImage} />
          )}
          <View style={styles.searchResultInfo}>
            <Text style={styles.searchResultName}>{channel.name}</Text>
            <Text style={styles.searchResultUsername}>/{channel.key}</Text>
            {channel.description && (
              <Text style={styles.searchResultBio} numberOfLines={2}>{channel.description}</Text>
            )}
            {channel.followerCount !== undefined && (
              <Text style={styles.searchResultFollowers}>
                {channel.followerCount.toLocaleString()} followers
              </Text>
            )}
          </View>
        </TouchableOpacity>
      );
    }

    if (item.type === 'cast') {
      const cast = item.data;
      return (
        <TouchableOpacity style={styles.searchResultItem} onPress={() => handleSearchCastPress(cast)}>
          <CachedAvatar
            source={cast.author.pfp?.url ? { uri: cast.author.pfp.url } : null}
            fallbackName={cast.author.displayName || cast.author.username}
            style={styles.searchResultAvatar}
          />
          <View style={styles.searchResultInfo}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(4) }}>
              <Text style={styles.searchResultName}>{cast.author.displayName}</Text>
              <Text style={styles.searchResultUsername}>@{cast.author.username}</Text>
            </View>
            <Text style={styles.searchResultBio} numberOfLines={3}>{cast.text}</Text>
            <View style={{ flexDirection: 'row', gap: Skin.space(12), marginTop: Skin.space(4) }}>
              <Text style={styles.searchResultFollowers}>
                {cast.replies?.count ?? 0} replies
              </Text>
              <Text style={styles.searchResultFollowers}>
                {cast.reactions?.count ?? 0} likes
              </Text>
            </View>
          </View>
        </TouchableOpacity>
      );
    }

    return null;
  }, [styles, handleSearchUserPress, handleSearchChannelPress, handleSearchCastPress]);

  const trendingTopics = useMemo(() => {
    const counts = new Map<string, number>();
    farcasterItems.forEach((item) => {
      item.cast.tags
        ?.filter((tag) => tag.type === 'channel' && tag.id)
        .forEach((tag) => {
          const key = `#${tag.id!.toLowerCase()}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        });
    });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label, count]) => ({ id: label, label, delta: `+${count}` }));
  }, [farcasterItems]);

  const filters: { id: FeedFilter; label: string; icon: IconSymbolName }[] = [
    { id: 'all', label: 'All', icon: 'rectangle.stack.fill' },
    { id: 'media', label: 'Media', icon: 'play.rectangle.fill' },
    { id: 'governance', label: 'Governance', icon: 'building.columns' },
    // { id: 'events', label: 'Events', icon: 'calendar' },
  ];

  // /hegemony governance: render proposals as regular feed casts (only on the
  // Governance tab). A proposal is a `PROPOSAL:` cast; non-proposals are
  // omitted. Vote tallies ride along on the FeedPost for the vote block.
  const { casts: governanceCasts, refetch: refetchGovernance } = useHegemonyGovernance({
    enabled: activeFilter === 'governance',
  });
  const channelCastToFeedPost = React.useCallback((c: GovernanceChannelCast): FeedPost => {
    // The governance API returns BARE hashes (no 0x); the Farcaster
    // like/recast/reply (/v2/casts) endpoints — and thread fetch — expect the
    // 0x-prefixed form, so normalize here (else votes 400).
    const lower = c.hash.toLowerCase();
    const hash = lower.startsWith('0x') ? lower : `0x${lower}`;
    return {
    id: hash,
    hash,
    username: c.authorUsername,
    authorFid: c.authorFid,
    authorName: c.authorDisplayName || c.authorUsername,
    authorHandle: `@${c.authorUsername}`,
    authorAvatar: c.authorPfpUrl || undefined,
    channel: 'hegemony',
    time: formatTimestamp(Date.parse(c.timestamp) || undefined),
    content: c.text,
    stats: { likes: String(c.likes), replies: String(c.replies), shares: String(c.recasts) },
    tags: [],
    mediaUrls: [],
    videos: [],
    urlPreviews: [],
    quoteCasts: [],
    frameEmbeds: [],
    filter: 'governance',
    viewerHasLiked: false,
    viewerHasRecast: false,
    viewerIsFollowing: true,
    isProposal: c.isProposal,
    votesFor: c.votesFor,
    votesAgainst: c.votesAgainst,
    };
  }, []);
  const governanceProposals = React.useMemo(
    () => governanceCasts.filter((c) => c.isProposal).map(channelCastToFeedPost),
    [governanceCasts, channelCastToFeedPost],
  );
  // 0x-keyed lookup so the thread view can overlay vote tallies + per-voter
  // points onto a proposal's thread (governance API hashes are bare).
  const governanceByHash = React.useMemo(() => {
    const m = new Map<string, GovernanceChannelCast>();
    for (const c of governanceCasts) {
      const h = c.hash.toLowerCase();
      m.set(h.startsWith('0x') ? h : `0x${h}`, c);
    }
    return m;
  }, [governanceCasts]);

  if (!rendered) {
    return null;
  }

  const showEmpty =
    activeFilter === 'governance'
      ? governanceProposals.length === 0
      : !isLoading && !error && filteredPosts.length === 0;
  // Allow posting if there's text, images, or mini app embeds (not requiring all)
  const canPost = Boolean(token && (castText.trim().length > 0 || selectedImages.length > 0 || miniAppEmbeds.length > 0) && !posting);

  const handleChangeText = (value: string) => {
    setCastText(value.slice(0, maxCastLength));
  };

  const handlePickImage = async () => {
    if (selectedImages.length >= 2) {
      setPostError('Maximum 2 images per cast');
      return;
    }
    const result = await pickMedia('library');
    if (result.success && result.attachment) {
      setSelectedImages(prev => [...prev, result.attachment!]);
      setPostError(null);
    } else if (result.error) {
      setPostError(result.error);
    }
  };

  const handleRemoveImage = (index: number) => {
    setSelectedImages(prev => prev.filter((_, i) => i !== index));
  };

  // Drop optimistic pending top-level casts once the server feed includes
  // them (matched by the confirmed hash set after the background submit).
  useEffect(() => {
    if (posts && posts.length) optimistic.reconcilePendingByHash(posts.map((p) => p.hash));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts, optimistic.reconcilePendingByHash]);

  const handleSubmitCast = async () => {
    if (!canPost) {
      if (!token) {
        setPostError('Missing Farcaster token.');
      }
      return;
    }
    try {
      setPosting(true);
      setPostError(null);

      // Build embeds array as simple URL strings (API expects string[])
      const embeds: string[] = [];
      if (quoteCastEmbed) {
        // Farcaster expects a cast URL for quote casts
        const quoteUrl = `https://warpcast.com/${quoteCastEmbed.author}/${quoteCastEmbed.hash.slice(0, 10)}`;
        embeds.push(quoteUrl);
      }

      // Add mini app embeds
      for (const embedUrl of miniAppEmbeds) {
        embeds.push(embedUrl);
      }

      // Upload attachments — videos through TUS, images direct.
      for (const a of selectedImages) {
        try {
          if (a.kind === 'video') {
            const v = await uploadVideoForCast(token as string, a.localUri);
            embeds.push(v.url);
          } else {
            const uploaded = await uploadImageForCast(token as string, a.localUri, a.mimeType);
            embeds.push(uploaded.url);
          }
        } catch (uploadErr: any) {
          setPostError(`Failed to upload attachment: ${uploadErr?.message ?? 'Unknown error'}`);
          setPosting(false);
          return;
        }
      }

      // A /hegemony proposal must start with `PROPOSAL:` — prepend it here so
      // the user never has to type it.
      const trimmedText = castText.trim();
      const finalText =
        composeProposalMode && !/^PROPOSAL:/i.test(trimmedText)
          ? `PROPOSAL: ${trimmedText}`
          : trimmedText;

      // Optimistic path for plain casts / quotes — submit in the
      // background (with retry) and show the cast instantly at the top of
      // the feed. Mini-app compose needs the real hash synchronously, and
      // proposals refetch governance, so those keep the awaited path.
      const isMiniApp = !!miniAppComposeResolverRef.current;
      if (!isMiniApp && !composeProposalMode) {
        if (quoteCastEmbed) {
          optimistic.postQuote({
            quotedHash: quoteCastEmbed.hash,
            embedUrls: embeds,
            text: finalText,
            channelKey: composeChannelKey,
          });
        } else {
          optimistic.postTop({ text: finalText, embedUrls: embeds, channelKey: composeChannelKey });
        }
        setCastText('');
        setSelectedImages([]);
        setMiniAppEmbeds([]);
        setQuoteCastEmbed(null);
        setComposeChannelKey(undefined);
        setComposeProposalMode(false);
        setComposeVisible(false);
        // Pull the real cast in (and reconcile the pending stub) shortly.
        setTimeout(() => { void refetch(); }, 3000);
        return;
      }

      const result = await submitMainCast({
        text: finalText,
        embedUrls: embeds,
        channelKey: composeChannelKey,
      });

      // Resolve mini app promise if this was a mini app compose request
      if (miniAppComposeResolverRef.current) {
        miniAppComposeResolverRef.current({ hash: result.hash });
        miniAppComposeResolverRef.current = null;
      }

      const wasProposal = composeProposalMode;
      setCastText('');
      setSelectedImages([]); // Clear images after posting
      setMiniAppEmbeds([]); // Clear mini app embeds after posting
      setQuoteCastEmbed(null); // Clear quote embed after posting
      setComposeChannelKey(undefined); // Clear channel target after posting
      setComposeProposalMode(false);
      setComposeVisible(false); // Close compose modal
      if (wasProposal) {
        refetchGovernance();
      } else {
        await refetch();
      }
    } catch (err: unknown) {
      logger.warn(
        '[SocialFeedModal] main cast submit threw:',
        err instanceof Error ? err.message : String(err),
      );
      setPostError(err instanceof Error ? err.message : 'Failed to publish cast.');
    } finally {
      setPosting(false);
    }
  };

  const handleRefresh = () => {
    if (activeFilter === 'governance') {
      refetchGovernance();
      return;
    }
    refetch();
  };

  // Calculate userPanel height to match index.tsx: paddingTop(8) + content(~32) + paddingBottom(max(8, insets.bottom))
  const userPanelHeight = 8 + 32 + Math.max(8, insets.bottom);

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <Animated.View
        pointerEvents="none"
        style={[
          styles.backdrop,
          {
            opacity: backdropAnim,
          },
        ]}
      />
      <View
        style={[
          styles.container,
          feedColor ? { backgroundColor: feedColor } : null,
          feedImage ? { backgroundColor: 'transparent' } : null,
        ]}
        pointerEvents="box-none"
      >
        {feedImage && (
          <ExpoImage
            source={{ uri: feedImage }}
            style={StyleSheet.absoluteFill}
            contentFit={feedSurface.fit === 'contain' ? 'contain' : 'cover'}
            pointerEvents="none"
            cachePolicy="memory-disk"
          />
        )}
        <Animated.View
          style={[
            styles.modalContent,
            // Let the feed surface show through behind the cast cards: a color
            // replaces the panel bg; an image makes the panel transparent so
            // the image rendered on the container shows through.
            feedColor ? { backgroundColor: feedColor } : null,
            feedImage ? { backgroundColor: 'transparent' } : null,
            {
              transform: [{ translateY: slideAnim }],
            },
          ]}
        >
          {/* Search Results FlatList */}
          {searchActive && debouncedSearchQuery.length > 0 ? (
            <FlashList
              data={searchResultItems}
              keyExtractor={(item) => item.key}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.contentContainer}
              onEndReached={() => {
                if (searchTab === 'users') onUsersEndReached();
                else if (searchTab === 'channels') onChannelsEndReached();
                else if (searchTab === 'casts') onCastsEndReached();
              }}
              onEndReachedThreshold={0.5}
              keyboardShouldPersistTaps="handled"
              ListHeaderComponent={
              <>
                {/* Search Input */}
                <View style={styles.searchContainer}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(12) }}>
                    {/* Avatar (top-left) — only in route mode, the modal
                        presentation has its own dismiss affordance. */}
                    {isRouteMode && <HeaderAvatar />}
                    <View style={[styles.searchInputContainer, { flex: 1 }]}>
                      <IconSymbol name="magnifyingglass" size={18} color={theme.colors.textMuted} />
                      <TextInput
                        ref={searchInputRef}
                        style={styles.searchInput}
                        placeholder="Search users, channels, casts..."
                        placeholderTextColor={theme.colors.textMuted}
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        onFocus={() => setSearchActive(true)}
                        returnKeyType="search"
                      />
                      {searchQuery.length > 0 && (
                        <TouchableOpacity onPress={() => setSearchQuery('')}>
                          <IconSymbol name="xmark.circle.fill" size={18} color={theme.colors.textMuted} />
                        </TouchableOpacity>
                      )}
                    </View>
                    {searchActive && (
                      <TouchableOpacity
                        style={styles.searchCancelButton}
                        onPress={() => {
                          setSearchActive(false);
                          setSearchQuery('');
                          setSearchTab('top');
                          Keyboard.dismiss();
                        }}
                      >
                        <Text style={styles.searchCancelText}>Cancel</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>

                {/* Search Tabs - only show when searching */}
                {searchActive && debouncedSearchQuery.length > 0 && (
                  <View style={styles.searchTabsContainer}>
                    {(['top', 'users', 'channels', 'casts'] as SearchTab[]).map((tab) => (
                      <TouchableOpacity
                        key={tab}
                        style={[styles.searchTab, searchTab === tab && styles.searchTabActive]}
                        onPress={() => setSearchTab(tab)}
                      >
                        <Text style={[styles.searchTabText, searchTab === tab && styles.searchTabTextActive]}>
                          {tab.charAt(0).toUpperCase() + tab.slice(1)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {/* Filters Row with Channel Tabs - only show when not searching */}
                {!searchActive && (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filtersRow}>
                    <View style={{width:16}}/>
                    {filters.map((filter) => {
                      const isActive = activeFilter === filter.id;
                      return (
                        <TouchableOpacity
                          key={filter.id}
                          style={[styles.filterChip, isActive && styles.filterChipActive]}
                          onPress={() => setActiveFilter(filter.id)}
                        >
                          <IconSymbol
                            name={filter.icon}
                            color={isActive ? theme.colors.surface0 : theme.colors.accent}
                            size={14}
                          />
                          <Text
                            style={[
                              styles.filterChipText,
                              { color: isActive ? theme.colors.surface0 : theme.colors.accent },
                            ]}
                          >
                            {filter.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                    {/* User's followed channels as round image chips.
                        Channel image fills the circle; no text. Falls
                        back to a tinted placeholder when the channel
                        has no image set. */}
                    {followedChannels && followedChannels.slice(0, 10).map((channel) => (
                      <TouchableOpacity
                        key={channel.key}
                        accessibilityLabel={channel.name}
                        style={styles.filterChip}
                        onPress={() => pushScreen({ type: 'channel', channelKey: channel.key })}
                      >
                        {channel.imageUrl ? (
                          <ExpoImage
                            source={{ uri: channel.imageUrl }}
                            contentFit="cover"
                            cachePolicy="memory-disk"
                            style={styles.channelChipImage}
                          />
                        ) : (
                          <View style={styles.channelChipPlaceholder}>
                            <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13), fontWeight: '600' }}>
                              /{channel.key.charAt(0).toUpperCase()}
                            </Text>
                          </View>
                        )}
                      </TouchableOpacity>
                    ))}
                    <View style={{width:16}}/>
                  </ScrollView>
                )}

                {!searchActive && <LiveSpacesStrip />}

                {/* Loading state intentionally renders nothing. Stale
                    casts (if any) stay visible while the refresh runs;
                    when the refresh resolves, the list updates in
                    place. Avoids the flash of an empty/loading panel
                    on every tab visit. */}

                {!searchActive && error && (
                  <TouchableOpacity style={styles.errorCard} onPress={() => refetch()}>
                    <Text style={styles.errorText}>{error}</Text>
                    <Text style={styles.errorHint}>Tap to retry</Text>
                  </TouchableOpacity>
                )}

                {!searchActive && showEmpty && (
                  <View style={styles.stateCard}>
                    <Text style={styles.stateText}>
                      {activeFilter === 'governance'
                        ? 'No proposals yet.'
                        : 'No casts match this filter yet.'}
                    </Text>
                  </View>
                )}

                {/* Search Loading */}
                {searchActive && isSearchLoading && (
                  <View style={styles.stateCard}>
                    <ActivityIndicator color={theme.colors.accent} />
                    <Text style={styles.stateText}>Searching...</Text>
                  </View>
                )}
              </>
            }
            ListFooterComponent={
              (isFetchingMoreUsers || isFetchingMoreChannels || isFetchingMoreCasts) ? (
                <View style={styles.loadingMore}>
                  <ActivityIndicator color={theme.colors.accent} />
                </View>
              ) : null
            }
            renderItem={renderSearchResultItem}
          />
          ) : (
            /* Regular Feed FlashList — also serves the Governance tab
               (proposals rendered as normal casts) and the Media grid.
               Flips to a 3-wide Instagram-
               style grid when the user selects the "Media" filter.
               Same underlying data + pagination + refresh control;
               only the cell renderer and column count change. */
            <FlashList
              ref={feedListRef}
              key={activeFilter === 'media' ? 'media-grid' : 'list'}
              data={
                activeFilter === 'governance'
                  ? governanceProposals
                  : activeFilter === 'media'
                    ? filteredPosts.filter((p) => p.mediaUrls.length > 0 || p.videos.some((v) => v.thumbnailUrl))
                    : filteredPosts
              }
              numColumns={activeFilter === 'media' ? 3 : 1}
              // Hint FlashList with the row size so recycling computes
              // accurate slot positions without measuring during scroll.
              extraData={likeStates}
              keyExtractor={(item) => item.id}
              showsVerticalScrollIndicator={false}
              // Let taps reach buttons (e.g. the proposal "Post vote") while a
              // text input's keyboard is open, instead of being swallowed to
              // dismiss it.
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.contentContainer}
              onEndReached={() => {
                // Governance is a single non-paginated fetch.
                if (activeFilter !== 'governance' && hasNextPage && !isFetchingNextPage) {
                  fetchNextPage();
                }
              }}
              onEndReachedThreshold={0.5}
              onScroll={(e) => {
                const y = e.nativeEvent.contentOffset.y;
                feedScrollYRef.current = y;
                const h = searchBarHeightRef.current;
                if (h <= 0) return;
                const out = y > h - 8;
                setSearchBarOutOfView((prev) => (prev === out ? prev : out));
              }}
              scrollEventThrottle={64}
              refreshControl={
                <RefreshControl
                  refreshing={isRefetching}
                  onRefresh={handleRefresh}
                  tintColor={theme.colors.textMain}
                />
              }
              ListHeaderComponent={
                <>
                  {/* Search Input */}
                  <View
                    style={styles.searchContainer}
                    onLayout={(e) => {
                      searchBarHeightRef.current = e.nativeEvent.layout.height;
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(12) }}>
                      {/* Avatar (top-left) — only in route mode. The
                          modal presentation has its own dismiss
                          affordance and doesn't need a header avatar. */}
                      {isRouteMode && <HeaderAvatar />}
                      <View style={[styles.searchInputContainer, { flex: 1 }]}>
                        <IconSymbol name="magnifyingglass" size={18} color={theme.colors.textMuted} />
                        <TextInput
                          style={styles.searchInput}
                          placeholder="Search users, channels, casts..."
                          placeholderTextColor={theme.colors.textMuted}
                          value={searchQuery}
                          onChangeText={setSearchQuery}
                          onFocus={() => setSearchActive(true)}
                          returnKeyType="search"
                        />
                        {searchQuery.length > 0 && (
                          <TouchableOpacity onPress={() => setSearchQuery('')}>
                            <IconSymbol name="xmark.circle.fill" size={18} color={theme.colors.textMuted} />
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  </View>

                  {/* Filter selector — round icon buttons, no text.
                      The icon alone carries the meaning ("All" =
                      rectangle stack, "Media" = play.rectangle, etc.),
                      and the active state is shown by filled background. */}
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filtersRow}>
                    <View style={{width:16}}/>
                    {filters.map((filter) => {
                      const isActive = activeFilter === filter.id;
                      return (
                        <TouchableOpacity
                          key={filter.id}
                          accessibilityLabel={filter.label}
                          style={[styles.filterChip, isActive && styles.filterChipActive]}
                          onPress={() => setActiveFilter(filter.id)}
                        >
                          <IconSymbol
                            name={filter.icon}
                            color={isActive ? theme.colors.surface0 : theme.colors.accent}
                            size={18}
                          />
                        </TouchableOpacity>
                      );
                    })}
                    {/* User's followed channels as round image chips.
                        Channel image fills the circle; no text. Falls
                        back to a tinted placeholder when the channel
                        has no image set. */}
                    {followedChannels && followedChannels.slice(0, 10).map((channel) => (
                      <TouchableOpacity
                        key={channel.key}
                        accessibilityLabel={channel.name}
                        style={styles.filterChip}
                        onPress={() => pushScreen({ type: 'channel', channelKey: channel.key })}
                      >
                        {channel.imageUrl ? (
                          <ExpoImage
                            source={{ uri: channel.imageUrl }}
                            contentFit="cover"
                            cachePolicy="memory-disk"
                            style={styles.channelChipImage}
                          />
                        ) : (
                          <View style={styles.channelChipPlaceholder}>
                            <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13), fontWeight: '600' }}>
                              /{channel.key.charAt(0).toUpperCase()}
                            </Text>
                          </View>
                        )}
                      </TouchableOpacity>
                    ))}
                    <View style={{width:16}}/>
                  </ScrollView>

                  <LiveSpacesStrip />

                  {isLoading && posts.length === 0 && (
                    <View style={styles.stateSpinner}>
                      <ActivityIndicator color={theme.colors.textMuted} />
                    </View>
                  )}

                  {error && (
                    <TouchableOpacity style={styles.errorCard} onPress={() => refetch()}>
                      <Text style={styles.errorText}>{error}</Text>
                      <Text style={styles.errorHint}>Tap to retry</Text>
                    </TouchableOpacity>
                  )}

                  {showEmpty && (
                    <View style={styles.stateCard}>
                      <Text style={styles.stateText}>No casts match this filter yet.</Text>
                    </View>
                  )}

                  {/* Optimistic pending top-level casts / quotes — shown at
                      the top of the feed while they submit in the
                      background, with a Retry/Discard reprompt on failure. */}
                  {activeFilter !== 'media' && activeFilter !== 'governance' &&
                    optimistic.pendingTopLevel().map((p) => {
                      const failed = p.status === 'failed';
                      // 'sent' = landed; waiting for the server to index it so
                      // the real cast replaces this stub (never a stuck "Sending…").
                      const sent = p.status === 'sent';
                      // Current user's own pfp captured at post time.
                      const avatarUri = p.author.pfpUrl;
                      const handle = p.author.username ? `@${p.author.username}` : '';
                      const statusText = failed ? 'Failed to send' : sent ? 'Posted' : 'Sending…';
                      return (
                        <View
                          key={p.localId}
                          style={{
                            flexDirection: 'row',
                            paddingHorizontal: 16,
                            paddingVertical: 12,
                            borderBottomWidth: StyleSheet.hairlineWidth,
                            borderBottomColor: theme.colors.border,
                            opacity: failed || sent ? 1 : 0.7,
                          }}
                        >
                          {/* Avatar — mirrors a real feed cast */}
                          <CachedAvatar
                            source={avatarUri ? { uri: avatarUri } : null}
                            fallbackName={p.author.displayName || p.author.username}
                            style={{
                              width: 44,
                              height: 44,
                              borderRadius: Skin.radius(22),
                              backgroundColor: theme.colors.surface3,
                              marginRight: Skin.space(12),
                            }}
                          />
                          <View style={{ flex: 1 }}>
                            <Text
                              style={{ color: theme.colors.textStrong, fontWeight: '600', fontSize: Skin.font(15) }}
                              numberOfLines={1}
                            >
                              {p.author.displayName || p.author.username || 'You'}
                            </Text>
                            {/* Handle • status (status sits where the timestamp would) */}
                            <Text style={{ fontSize: Skin.font(13), marginTop: Skin.space(2) }} numberOfLines={1}>
                              <Text style={{ color: theme.colors.textMuted }}>{handle ? `${handle} • ` : ''}</Text>
                              <Text style={{ color: failed ? theme.colors.danger : theme.colors.textMuted }}>
                                {statusText}
                              </Text>
                            </Text>
                            <Text
                              style={{
                                color: theme.colors.textMain,
                                fontSize: Skin.font(15),
                                lineHeight: Skin.font(21),
                                marginTop: Skin.space(6),
                              }}
                            >
                              {p.text}
                            </Text>
                            {failed && (
                              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: Skin.space(8), gap: Skin.space(16) }}>
                                <TouchableOpacity onPress={() => optimistic.retryPending(p.localId)} hitSlop={8}>
                                  <Text style={{ color: theme.colors.primary, fontSize: Skin.font(13), fontWeight: '600' }}>Retry</Text>
                                </TouchableOpacity>
                                <TouchableOpacity onPress={() => optimistic.discardPending(p.localId)} hitSlop={8}>
                                  <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13) }}>Discard</Text>
                                </TouchableOpacity>
                              </View>
                            )}
                          </View>
                        </View>
                      );
                    })}
                </>
              }
              ListFooterComponent={
                isFetchingNextPage ? (
                  <View style={styles.loadingMore}>
                    <ActivityIndicator color={theme.colors.accent} />
                  </View>
                ) : null
              }
              renderItem={({ item: post }) =>
                optimistic.isDeleted(post.hash) ? null :
                activeFilter === 'media' ? (
                  <MediaGridCell
                    post={post}
                    theme={theme}
                    onPress={() =>
                      handleNavigateToThread(
                        post.username,
                        post.hash.slice(0, 10),
                        false,
                        feedPostToCastPlaceholder(post),
                      )
                    }
                  />
                ) : (
                  <>
                    <FeedPostCard
                      post={post}
                      theme={theme}
                      styles={styles}
                      likeState={likeStates.get(post.hash)}
                      recastState={recastStates.get(post.hash)}
                      followState={followStates.get(post.authorFid)}
                      token={token}
                      currentUserFid={currentUserFid}
                      onNavigateToThread={handleNavigateToThread}
                      onNavigateToProfile={handleNavigateToProfile}
                      onOpenChannel={openChannel}
                      onMentionPress={handleMentionPress}
                      onLinkPress={openMiniApp}
                      onImagePress={(images, index) => setFeedViewerState({ images, index })}
                      onLikeToggle={handleLikeToggle}
                      onOpenShareSheet={handleOpenShareSheet}
                      onFollow={handleFollow}
                      onReport={handleReportCast}
                      onDelete={handleDeleteCast}
                      onTipPress={handleOpenTip}
                      authorIsApex={feedApexFids.has(post.authorFid)}
                    />
                    {post.isProposal && (
                      <ProposalVoteBlock
                        hash={post.hash}
                        votesFor={post.votesFor ?? 0}
                        votesAgainst={post.votesAgainst ?? 0}
                        token={token}
                        theme={theme}
                        onVoted={refetchGovernance}
                      />
                    )}
                  </>
                )
              }
            />
          )}

          {/* Farcaster Account Required Overlay */}
          {!token && (
            <View style={styles.farcasterRequiredOverlay}>
              <View style={styles.farcasterRequiredContent}>
                <IconSymbol name="person.crop.circle.badge.exclamationmark" size={48} color={theme.colors.warning} />
                <Text style={styles.farcasterRequiredTitle}>Farcaster Account Required</Text>
                <Text style={styles.farcasterRequiredMessage}>
                  The social feed requires a Farcaster account. You can import your Farcaster account in Settings to view and interact with the feed.
                </Text>
              </View>
            </View>
          )}

          {/* Floating Action Button */}
          {token && (
            <TouchableOpacity
              style={styles.fab}
              onPress={() => {
                if (activeFilter === 'governance') {
                  // New proposal: blank /hegemony cast; `PROPOSAL:` is prepended
                  // on submit so the user never has to type it.
                  setComposeProposalMode(true);
                  setCastText('');
                  setComposeChannelKey('hegemony');
                  setComposeVisible(true);
                } else {
                  // Pre-fill the channel target if the user opened compose from a channel screen
                  setComposeProposalMode(false);
                  setComposeChannelKey(selectedChannel?.channelKey);
                  setComposeVisible(true);
                }
              }}
              activeOpacity={0.8}
            >
              <IconSymbol
                name={activeFilter === 'governance' ? 'building.columns' : 'plus'}
                color={theme.colors.surface0}
                size={20}
              />
            </TouchableOpacity>
          )}

          {/* Floating search shortcut — appears top-right once the inline
              search bar has scrolled out of view. Tapping opens a detached
              floating search box (NO scroll back to the inline bar). */}
          {searchBarOutOfView && !floatingSearchVisible && (
            <TouchableOpacity
              onPress={() => {
                setFloatingSearchVisible(true);
                // Focus on next frame so the input is mounted.
                setTimeout(() => floatingSearchInputRef.current?.focus(), 50);
              }}
              activeOpacity={0.8}
              style={{
                position: 'absolute',
                top: 8,
                right: 16,
                width: 40,
                height: 40,
                borderRadius: Skin.radius(20),
                backgroundColor: theme.colors.surface2,
                borderWidth: Skin.border(1),
                borderColor: theme.colors.surface3,
                alignItems: 'center',
                justifyContent: 'center',
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.2,
                shadowRadius: 4,
                elevation: 4,
              }}
            >
              <IconSymbol name="magnifyingglass" size={18} color={theme.colors.textMain} />
            </TouchableOpacity>
          )}

          {/* Detached floating search overlay — replaces the icon when
              active. Bound to the same `searchQuery` as the inline input
              so search results behave identically. Closing the overlay
              clears the query and the search-active flag so the user
              returns cleanly to the feed. */}
          {floatingSearchVisible && (
            <View
              style={{
                position: 'absolute',
                top: 8,
                left: 16,
                right: 16,
                flexDirection: 'row',
                alignItems: 'center',
                gap: Skin.space(8),
                backgroundColor: theme.colors.surface2,
                borderWidth: Skin.border(1),
                borderColor: theme.colors.surface3,
                borderRadius: Skin.radius(20),
                paddingHorizontal: Skin.space(12),
                paddingVertical: Skin.space(8),
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.25,
                shadowRadius: 6,
                elevation: 6,
              }}
            >
              <IconSymbol name="magnifyingglass" size={18} color={theme.colors.textMuted} />
              <TextInput
                ref={floatingSearchInputRef}
                style={{ flex: 1, fontSize: Skin.font(15), color: theme.colors.textMain, paddingVertical: 0, minHeight: 24 }}
                placeholder="Search users, channels, casts..."
                placeholderTextColor={theme.colors.textMuted}
                value={searchQuery}
                onChangeText={(t) => {
                  setSearchQuery(t);
                  if (t.length > 0) setSearchActive(true);
                }}
                onFocus={() => setSearchActive(true)}
                returnKeyType="search"
                autoFocus
              />
              <TouchableOpacity
                onPress={() => {
                  setFloatingSearchVisible(false);
                  setSearchQuery('');
                  setSearchActive(false);
                }}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              >
                <IconSymbol name="xmark.circle.fill" size={20} color={theme.colors.textMuted} />
              </TouchableOpacity>
            </View>
          )}

          {/* Navigation Stack - render screens above feed */}
          {navStack.slice(1).map((screen, index) => {
            const stackIndex = index + 1;
            const isTopScreen = stackIndex === navStack.length - 1;

            // Wrap content with gesture detector for swipe-back on top screen
            const wrapWithGesture = (content: React.ReactNode, key: string) => {
              if (isTopScreen) {
                return (
                  <GestureDetector key={key} gesture={swipeBackGesture}>
                    <ReanimatedView style={[styles.stackScreen, { zIndex: 10 + stackIndex }, swipeAnimatedStyle]}>
                      {content}
                    </ReanimatedView>
                  </GestureDetector>
                );
              }
              return (
                <View key={key} style={[styles.stackScreen, { zIndex: 10 + stackIndex }]}>
                  {content}
                </View>
              );
            };

            if (screen.type === 'thread') {
              return wrapWithGesture(
                <ThreadDetailView
                  username={screen.username}
                  castHashPrefix={screen.castHashPrefix}
                  focusReply={screen.focusReply}
                  placeholderCast={screen.placeholderCast}
                  token={token}
                  theme={theme}
                  onClose={popScreen}
                  onOpenMiniApp={openMiniApp}
                  onOpenProfile={(fid, username) => pushScreen({ type: 'profile', fid, username })}
                  onOpenChannel={(channelKey) => pushScreen({ type: 'channel', channelKey })}
                  onOpenThread={(username, hashPrefix, placeholderCast) => pushScreen({ type: 'thread', username, castHashPrefix: hashPrefix, placeholderCast })}
                  likeStates={likeStates}
                  onLikeToggle={handleLikeToggle}
                  recastStates={recastStates}
                  onRecastToggle={handleRecastToggle}
                  onQuoteCast={handleQuoteCast}
                  onShareToChat={handleShareToChat}
                  followStates={followStates}
                  onFollow={handleFollow}
                  bottomInset={insets.bottom}
                  currentUserFid={currentUserFid}
                  onTipPress={handleOpenTip}
                  maxCastLength={maxCastLength}
                  regularCastByteLimit={regularCastByteLimit}
                  governanceByHash={governanceByHash}
                  onGovernanceVoted={refetchGovernance}
                />,
                `thread-${screen.castHashPrefix}-${stackIndex}`
              );
            }

            if (screen.type === 'profile') {
              return wrapWithGesture(
                <ProfileView
                  fid={screen.fid}
                  token={token}
                  theme={theme}
                  currentUserFid={currentUserFid}
                  onClose={popScreen}
                  onOpenThread={(username, hashPrefix, placeholderCast) => pushScreen({ type: 'thread', username, castHashPrefix: hashPrefix, placeholderCast })}
                  onOpenMiniApp={openMiniApp}
                  onOpenProfile={(fid, username) => pushScreen({ type: 'profile', fid, username })}
                  onOpenChannel={(channelKey) => pushScreen({ type: 'channel', channelKey })}
                  likeStates={likeStates}
                  onLikeToggle={handleLikeToggle}
                  bottomInset={insets.bottom}
                  onTipPress={handleOpenTip}
                />,
                `profile-${screen.fid}-${stackIndex}`
              );
            }

            if (screen.type === 'channel') {
              return wrapWithGesture(
                <ChannelView
                  channelKey={screen.channelKey}
                  token={token}
                  theme={theme}
                  currentUserFid={currentUserFid}
                  onClose={popScreen}
                  onOpenThread={(username, hashPrefix, placeholderCast) => pushScreen({ type: 'thread', username, castHashPrefix: hashPrefix, placeholderCast })}
                  onOpenMiniApp={openMiniApp}
                  onOpenProfile={(fid, username) => pushScreen({ type: 'profile', fid, username })}
                  onOpenChannel={(channelKey) => pushScreen({ type: 'channel', channelKey })}
                  likeStates={likeStates}
                  onLikeToggle={handleLikeToggle}
                  bottomInset={insets.bottom}
                  onTipPress={handleOpenTip}
                />,
                `channel-${screen.channelKey}-${stackIndex}`
              );
            }

            if (screen.type === 'proposal') {
              return wrapWithGesture(
                <ProposalDetailView
                  proposalId={screen.proposalId}
                  theme={theme}
                  onClose={popScreen}
                  keyboardHeight={keyboardHeight}
                  userPanelHeight={userPanelHeight}
                />,
                `proposal-${screen.proposalId}-${stackIndex}`
              );
            }

            return null;
          })}
          
          {/* Compose Modal */}
          {composeVisible && (
            <KeyboardAvoidingView
              style={styles.composeOverlay}
              behavior="padding"
              keyboardVerticalOffset={insets.top}
            >
              <Pressable style={styles.composeBackdrop} onPress={handleCancelCompose} />
              <View style={[styles.composeModal, keyboardHeight > 0 && { paddingBottom: insets.bottom }]}>
                <View style={styles.composeHeader}>
                  <TouchableOpacity onPress={handleCancelCompose}>
                    <Text style={styles.composeCancel}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={async () => {
                      await handleSubmitCast();
                      if (!postError) {
                        setComposeVisible(false);
                      }
                    }}
                    disabled={!canPost}
                    style={[styles.composePostButton, !canPost && styles.composePostButtonDisabled]}
                  >
                    {posting ? (
                      <ActivityIndicator color={theme.colors.surface0} size="small" />
                    ) : (
                      <Text style={[styles.composePostText, !canPost && styles.composePostTextDisabled]}>Post</Text>
                    )}
                  </TouchableOpacity>
                </View>
                <View style={{ position: 'relative' }}>
                  {/* Mention autocomplete for compose */}
                  {composeMentionInfo && (
                    <View style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: Skin.space(4), zIndex: 10 }}>
                      <MentionAutocomplete
                        mentionInfo={composeMentionInfo}
                        token={token}
                        onSelectUser={handleComposeSelectUser}
                        onSelectChannel={handleComposeSelectChannel}
                        theme={theme}
                        maxHeight={180}
                      />
                    </View>
                  )}
                  <TextInput
                    multiline
                    autoFocus
                    placeholder={composeProposalMode ? 'Write your proposal…' : composeChannelKey ? `Cast in /${composeChannelKey}…` : "What's happening?"}
                    placeholderTextColor={theme.colors.textMuted}
                    style={styles.composeInput}
                    value={castText}
                    editable={!posting}
                    onChangeText={handleChangeText}
                    onSelectionChange={(e) => {
                      setCastCursorPosition(e.nativeEvent.selection.end);
                    }}
                  />
                </View>
                {/* Channel target chip — tap to open picker; long-press clears. */}
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: Skin.space(8) }}>
                  <TouchableOpacity
                    disabled={composeProposalMode}
                    onPress={() => setComposeChannelPickerVisible(true)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: Skin.space(4),
                      paddingHorizontal: Skin.space(10),
                      paddingVertical: Skin.space(5),
                      borderRadius: Skin.radius(14),
                      borderWidth: Skin.border(1),
                      borderColor: theme.colors.surface3,
                      backgroundColor: composeChannelKey ? theme.colors.surface2 : 'transparent',
                    }}
                  >
                    <IconSymbol
                      name={composeChannelKey ? 'number' : 'house.fill'}
                      size={11}
                      color={composeChannelKey ? theme.colors.accent : theme.colors.textMuted}
                    />
                    <Text style={{ fontSize: Skin.font(12), color: composeChannelKey ? theme.colors.textMain : theme.colors.textMuted, fontWeight: '500' }}>
                      {composeChannelKey ? `/${composeChannelKey}` : 'Home feed'}
                      {composeProposalMode ? ' · Proposal' : ''}
                    </Text>
                    {!composeProposalMode && (
                      <IconSymbol name="chevron.down" size={10} color={theme.colors.textMuted} />
                    )}
                  </TouchableOpacity>
                </View>
                {quoteCastEmbed && (
                  <View style={styles.quotePreview}>
                    <View style={styles.quotePreviewContent}>
                      <Text style={styles.quotePreviewAuthor}>@{quoteCastEmbed.author}</Text>
                      <Text style={styles.quotePreviewText} numberOfLines={2}>
                        {quoteCastEmbed.text}
                      </Text>
                    </View>
                    <TouchableOpacity onPress={() => setQuoteCastEmbed(null)} style={styles.quotePreviewRemove}>
                      <IconSymbol name="xmark.circle.fill" size={20} color={theme.colors.textMuted} />
                    </TouchableOpacity>
                  </View>
                )}
                {/* Image previews */}
                {selectedImages.length > 0 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={{ marginBottom: Skin.space(12) }}
                    contentContainerStyle={{ gap: Skin.space(8) }}
                  >
                    {selectedImages.map((image, index) => (
                      <View key={index} style={{ position: 'relative' }}>
                        <Image
                          source={{ uri: image.thumbnailLocalUri ?? image.localUri }}
                          style={{
                            width: 100,
                            height: 100,
                            borderRadius: Skin.radius(8),
                            backgroundColor: theme.colors.surface3,
                          }}
                          resizeMode="cover"
                        />
                        {image.kind === 'video' && (
                          <View style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: 0,
                            right: 0,
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}>
                            <IconSymbol name="play.fill" size={24} color="#fff" />
                          </View>
                        )}
                        <TouchableOpacity
                          onPress={() => handleRemoveImage(index)}
                          style={{
                            position: 'absolute',
                            top: 4,
                            right: 4,
                            width: 24,
                            height: 24,
                            borderRadius: Skin.radius(12),
                            backgroundColor: 'rgba(0,0,0,0.6)',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <IconSymbol name="xmark" size={14} color="#fff" />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </ScrollView>
                )}
                {/* Mini app embed previews */}
                {miniAppEmbeds.length > 0 && (
                  <View style={{ marginBottom: Skin.space(12), gap: Skin.space(8) }}>
                    {miniAppEmbeds.map((embedUrl, index) => (
                      <View
                        key={index}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          backgroundColor: theme.colors.surface2,
                          borderRadius: Skin.radius(8),
                          padding: Skin.space(10),
                        }}
                      >
                        <IconSymbol name="link" size={16} color={theme.colors.textMuted} />
                        <Text
                          style={{
                            flex: 1,
                            marginLeft: Skin.space(8),
                            color: theme.colors.text,
                            fontSize: Skin.font(13),
                          }}
                          numberOfLines={1}
                        >
                          {embedUrl}
                        </Text>
                        <TouchableOpacity
                          onPress={() => setMiniAppEmbeds(prev => prev.filter((_, i) => i !== index))}
                          style={{ marginLeft: Skin.space(8) }}
                        >
                          <IconSymbol name="xmark.circle.fill" size={20} color={theme.colors.textMuted} />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                )}
                <View style={styles.composeFooter}>
                  <TouchableOpacity
                    onPress={handlePickImage}
                    disabled={posting || selectedImages.length >= 2}
                    style={{ opacity: selectedImages.length >= 2 ? 0.5 : 1 }}
                  >
                    <IconSymbol
                      name="photo"
                      size={24}
                      color={theme.colors.accent}
                    />
                  </TouchableOpacity>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[
                      styles.composeCharCount,
                      castText.length > regularCastByteLimit && castText.length <= maxCastLength && { color: theme.colors.warning || '#FFA500' }
                    ]}>
                      {castText.length}/{maxCastLength}
                    </Text>
                    {castText.length > regularCastByteLimit && castText.length <= maxCastLength && (
                      <Text style={{ fontSize: Skin.font(11), color: theme.colors.warning || '#FFA500', marginTop: Skin.space(2) }}>
                        Only first {regularCastByteLimit} chars visible on timeline
                      </Text>
                    )}
                  </View>
                </View>
                {postError && (
                  <Text style={styles.composeError}>{postError}</Text>
                )}
              </View>
            </KeyboardAvoidingView>
          )}

          {/* Compose target channel picker */}
          <ComposeChannelPickerModal
            visible={composeChannelPickerVisible}
            onClose={() => setComposeChannelPickerVisible(false)}
            value={composeChannelKey}
            onPick={(key) => setComposeChannelKey(key)}
          />



          {/* Feed Image Viewer */}
          <ImageViewer
            visible={feedViewerState !== null}
            images={feedViewerState?.images}
            initialIndex={feedViewerState?.index ?? 0}
            onClose={() => setFeedViewerState(null)}
          />

          {/* Feed Share Action Sheet */}
          <ShareActionSheet
            visible={feedShareSheet !== null}
            castHash={feedShareSheet?.hash ?? ''}
            castAuthor={feedShareSheet?.author ?? ''}
            isRecasted={feedShareSheet?.isRecasted ?? false}
            recastCount={feedShareSheet?.recastCount ?? 0}
            token={token}
            onClose={() => setFeedShareSheet(null)}
            onRecast={() => {
              if (feedShareSheet) {
                const { hash, isRecasted, recastCount } = feedShareSheet;
                setFeedShareSheet(null); // Close the share sheet first
                handleRecastToggle(hash, isRecasted, recastCount);
              }
            }}
            onQuote={() => {
              if (feedShareSheet) {
                const { hash, author, text } = feedShareSheet;
                setFeedShareSheet(null); // Close the share sheet first
                handleQuoteCast(hash, author, text);
              }
            }}
            onShareToChat={() => {
              if (feedShareSheet) {
                const castUrl = `https://warpcast.com/${feedShareSheet.author}/${feedShareSheet.hash.slice(0, 10)}`;
                handleShareToChat(castUrl);
              }
            }}
            onNativeShare={async () => {
              if (feedShareSheet) {
                const castUrl = `https://warpcast.com/${feedShareSheet.author}/${feedShareSheet.hash.slice(0, 10)}`;
                try {
                  await Share.share({
                    message: castUrl,
                    url: castUrl,
                  });
                } catch {
                  // User cancelled share — no action needed
                }
              }
            }}
          />

          {/* Feed report modal — same flow as the thread view. */}
          <ReportModal
            visible={!!feedReportTarget}
            onClose={() => setFeedReportTarget(null)}
            target={feedReportTarget ? { type: 'cast', ...feedReportTarget } : null}
            onSubmitted={() => setFeedReportTarget(null)}
          />

          {/* Share to Chat Modal */}
          <ShareToChatModal
            visible={shareToChatUrl !== null}
            castUrl={shareToChatUrl ?? ''}
            theme={theme}
            bottomInset={insets.bottom}
            onClose={() => setShareToChatUrl(null)}
            onSent={() => {
              setShareToChatUrl(null);
              setFeedShareSheet(null);
            }}
          />

          {/* Tip Modal — shared by feed rows, thread detail, profile and channel views */}
          <TipModal
            visible={tipTarget !== null}
            onClose={() => setTipTarget(null)}
            castHash={tipTarget?.castHash ?? ''}
            castText={tipTarget?.castText ?? ''}
            authorFid={tipTarget?.authorFid ?? 0}
            authorUsername={tipTarget?.authorUsername ?? ''}
            authorDisplayName={tipTarget?.authorDisplayName}
          />

        </Animated.View>
        {/* Bottom spacer to align with userPanel - uses layout constraint instead of padding */}
        <View style={{ height: userPanelHeight }} />
      </View>
    </View>
  );
});

export default SocialFeedModal;

const createStyles = (theme: AppTheme, isDark: boolean, insets: EdgeInsets) =>
  StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFillObject,
    },
    container: {
      flex: 1,
      paddingTop: insets.top,
      backgroundColor: theme.colors.surface1,
    },
    backdrop: {
      ...StyleSheet.absoluteFillObject,
    },
    modalContent: {
      flex: 1,
      backgroundColor: theme.colors.surface1,
    },
    contentContainer: {
      flexGrow: 1,
      paddingBottom: Skin.space(32),
    },
    loadingMore: {
      paddingVertical: Skin.space(20),
      alignItems: 'center',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    title: {
      color: theme.colors.textStrong,
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
    },
    subtitle: {
      color: theme.colors.textMuted,
      marginTop: Skin.space(2),
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
    },
    refreshButton: {
      padding: Skin.space(10),
      borderRadius: Skin.radius(999),
      backgroundColor: theme.colors.surface3,
    },
    trendingCard: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(18),
      padding: Skin.space(16),
    },
    trendingHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: Skin.space(12),
      gap: Skin.space(8),
    },
    trendingTitle: {
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    trendingList: {
      gap: Skin.space(10),
    },
    trendingRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    trendingLabel: {
      color: theme.colors.textMain,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    trendingDelta: {
      color: theme.colors.success,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    filtersRow: {
      marginTop: Skin.space(4),
      // Bottom padding so the filter pills don't butt directly against
      // the content below — particularly the media grid, which would
      // otherwise touch the active filter chip without any breathing
      // room. Card-list mode has the post card's own padding, but the
      // grid cells run edge-to-edge so the row needs its own gap.
      marginBottom: Skin.space(8),
    },
    filterChip: {
      // Round icon-only button. Width = height for a perfect circle.
      // Active state filled with primary, inactive uses surface3.
      // overflow: hidden so the channel image clips to the circle.
      width: 36,
      height: 36,
      borderRadius: Skin.radius(18),
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      marginRight: Skin.space(10),
    },
    channelChipImage: {
      width: 36,
      height: 36,
    },
    channelChipPlaceholder: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    filterChipActive: {
      backgroundColor: theme.colors.primary,
    },
    filterChipText: {
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      fontSize: Skin.font(13),
    },
    stateCard: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(16),
      padding: Skin.space(20),
      marginHorizontal: Skin.space(20),
      alignItems: 'center',
      justifyContent: 'center',
      gap: Skin.space(8),
    },
    /** Lightweight loading indicator — bare spinner, no card/text.
     *  Replaces the "Loading Farcaster feed…" panel that was visually
     *  too heavy for what's a transient state. */
    stateSpinner: {
      paddingVertical: Skin.space(32),
      alignItems: 'center',
      justifyContent: 'center',
    },
    stateText: {
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
    },
    errorCard: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(16),
      padding: Skin.space(16),
      marginHorizontal: Skin.space(20),
      borderWidth: Skin.border(1),
      borderColor: theme.colors.danger,
      gap: Skin.space(4),
    },
    errorText: {
      color: theme.colors.danger,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    errorHint: {
      color: theme.colors.textMuted,
      fontSize: Skin.font(12),
    },
    postCard: {
      backgroundColor: 'transparent',
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.surface3,
      paddingTop: Skin.space(12),
      paddingBottom: Skin.space(14),
      paddingHorizontal: Skin.space(12),
      gap: Skin.space(10),
    },
    postHeader: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    avatarContainer: {
      position: 'relative',
      marginRight: Skin.space(12),
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: Skin.radius(22),
      backgroundColor: theme.colors.surface4,
    },
    followButton: {
      position: 'absolute',
      bottom: -2,
      right: -2,
      width: 18,
      height: 18,
      borderRadius: Skin.radius(9),
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: Skin.border(2),
      borderColor: theme.colors.background,
    },
    postAuthor: {
      flex: 1,
    },
    authorRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
    },
    authorName: {
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      fontSize: Skin.font(15),
    },
    channelLabel: {
      color: theme.colors.textMuted,
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      opacity: 0.7,
    },
    authorHandle: {
      color: theme.colors.textMuted,
      fontSize: Skin.font(13),
      marginTop: Skin.space(2),
    },
    postContent: {
      color: theme.colors.textMain,
      fontSize: Skin.font(15),
      lineHeight: Skin.font(20),
      fontFamily: theme.fonts.regular.fontFamily,
    },
    mediaContainer: {
      marginHorizontal: Skin.space(-16),
    },
    postMedia: {
      backgroundColor: theme.colors.surface3,
    },
    mediaCarousel: {
      // height is set dynamically by AutoHeightImage
    },
    carouselImage: {
      backgroundColor: theme.colors.surface3,
    },
    tagsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: Skin.space(8),
    },
    tagPill: {
      backgroundColor: theme.colors.surface3,
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(6),
      borderRadius: Skin.radius(999),
    },
    tagText: {
      color: theme.colors.textMuted,
      fontSize: Skin.font(12),
    },
    postStats: {
      flexDirection: 'row',
      justifyContent: 'flex-start',
      gap: Skin.space(16),
      marginTop: Skin.space(4),
    },
    statButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
    },
    statText: {
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    fab: {
      position: 'absolute',
      bottom: 16,
      right: 16,
      width: 48,
      height: 48,
      borderRadius: Skin.radius(24),
      backgroundColor: theme.colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
    },
    composeOverlay: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 1000,
      justifyContent: 'flex-end',
    },
    composeBackdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.5)',
    },
    composeModal: {
      backgroundColor: theme.colors.surface1,
      borderTopLeftRadius: Skin.radius(20),
      borderTopRightRadius: Skin.radius(20),
      paddingHorizontal: Skin.space(20),
      paddingBottom: insets.bottom + 20,
      minHeight: 200,
    },
    composeHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: Skin.space(16),
    },
    composeCancel: {
      color: theme.colors.textMuted,
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.regular.fontFamily,
    },
    composePostButton: {
      backgroundColor: theme.colors.accent,
      paddingHorizontal: Skin.space(20),
      paddingVertical: Skin.space(8),
      borderRadius: Skin.radius(999),
    },
    composePostButtonDisabled: {
      backgroundColor: theme.colors.surface4,
    },
    composePostText: {
      color: theme.colors.surface0,
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    composePostTextDisabled: {
      color: theme.colors.textMuted,
    },
    composeInput: {
      color: theme.colors.textMain,
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.regular.fontFamily,
      lineHeight: Skin.font(24),
      minHeight: 100,
      maxHeight: 200,
      textAlignVertical: 'top',
    },
    composeFooter: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingTop: Skin.space(12),
      borderTopWidth: Skin.border(1),
      borderTopColor: theme.colors.surface3,
    },
    composeCharCount: {
      color: theme.colors.textMuted,
      fontSize: Skin.font(13),
    },
    composeError: {
      color: theme.colors.danger,
      fontSize: Skin.font(13),
      marginTop: Skin.space(8),
    },
    quotePreview: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(8),
      borderLeftWidth: Skin.border(3),
      borderLeftColor: theme.colors.primary,
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(10),
      marginBottom: Skin.space(8),
    },
    quotePreviewContent: {
      flex: 1,
    },
    quotePreviewAuthor: {
      color: theme.colors.primary,
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      marginBottom: Skin.space(4),
    },
    quotePreviewText: {
      color: theme.colors.textMain,
      fontSize: Skin.font(13),
      lineHeight: Skin.font(18),
    },
    quotePreviewRemove: {
      marginLeft: Skin.space(8),
      padding: Skin.space(4),
    },
    threadOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.colors.surface1,
      zIndex: 10,
    },
    profileOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.colors.surface1,
      zIndex: 20,
    },
    channelOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.colors.surface1,
      zIndex: 15,
    },
    stackScreen: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.colors.surface1,
    },
    farcasterRequiredOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0, 0, 0, 0.85)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: Skin.space(24),
      zIndex: 100,
    },
    farcasterRequiredContent: {
      backgroundColor: theme.colors.surface1,
      borderRadius: Skin.radius(16),
      padding: Skin.space(24),
      width: '100%',
      maxWidth: 340,
      alignItems: 'center',
    },
    farcasterRequiredTitle: {
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
      textAlign: 'center',
      marginTop: Skin.space(16),
      marginBottom: Skin.space(12),
    },
    farcasterRequiredMessage: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: Skin.font(20),
    },
    // Search styles
    searchContainer: {
      paddingHorizontal: Skin.space(16),
      paddingTop: Skin.space(8),
      paddingBottom: Skin.space(4),
    },
    searchInputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      paddingHorizontal: Skin.space(12),
      height: 40,
    },
    searchInput: {
      flex: 1,
      fontSize: Skin.font(15),
      color: theme.colors.textMain,
      marginLeft: Skin.space(8),
      paddingVertical: 0,
    },
    searchCancelButton: {
      paddingLeft: Skin.space(12),
      paddingVertical: Skin.space(8),
    },
    searchCancelText: {
      color: theme.colors.accent,
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
    },
    searchTabsContainer: {
      flexDirection: 'row',
      paddingHorizontal: Skin.space(16),
      paddingTop: Skin.space(12),
      paddingBottom: Skin.space(8),
      gap: Skin.space(8),
    },
    searchTab: {
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(8),
      borderRadius: Skin.radius(20),
      backgroundColor: theme.colors.surface3,
    },
    searchTabActive: {
      backgroundColor: theme.colors.primary,
    },
    searchTabText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.medium.fontFamily,
    },
    searchTabTextActive: {
      color: theme.colors.surface0,
    },
    searchResultItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(12),
      gap: Skin.space(12),
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.surface3,
    },
    searchResultAvatar: {
      width: 44,
      height: 44,
      borderRadius: Skin.radius(22),
      backgroundColor: theme.colors.surface4,
    },
    searchResultInfo: {
      flex: 1,
    },
    searchResultName: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      color: theme.colors.textMain,
    },
    searchResultUsername: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      marginTop: Skin.space(2),
    },
    searchResultBio: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      marginTop: Skin.space(4),
      lineHeight: Skin.font(18),
    },
    searchResultFollowers: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginTop: Skin.space(4),
    },
    searchSectionHeader: {
      paddingHorizontal: Skin.space(16),
      paddingTop: Skin.space(16),
      paddingBottom: Skin.space(8),
    },
    searchSectionTitle: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    channelImage: {
      width: 44,
      height: 44,
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.surface4,
    },
    channelTabImage: {
      width: 24,
      height: 24,
      borderRadius: Skin.radius(4),
      backgroundColor: theme.colors.surface4,
    },
  });

function formatTimestamp(timestamp?: number) {
  if (!timestamp) {
    return '';
  }
  const diff = Math.max(Date.now() - timestamp, 0);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) {
    return `${Math.max(1, Math.floor(diff / 1000))}s`;
  }
  if (diff < hour) {
    return `${Math.floor(diff / minute)}m`;
  }
  if (diff < day) {
    return `${Math.floor(diff / hour)}h`;
  }
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatCount(value?: number) {
  if (!value) {
    return '0';
  }
  return value.toLocaleString();
}

function deriveFilter(cast: any, hasMedia: boolean): FeedFilter {
  if (hasMedia) {
    return 'media';
  }
  const channelTags = cast.tags?.map((tag: any) => (tag.id || tag.name || '').toLowerCase()) ?? [];
  if (channelTags.some((tag: string) => tag.includes('node'))) {
    return 'node-ops';
  }
  if (channelTags.some((tag: string) => tag.includes('event'))) {
    return 'events';
  }
  return 'all';
}
