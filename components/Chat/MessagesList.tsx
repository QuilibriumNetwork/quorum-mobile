import type { AppTheme } from '@/theme';
import React, { useCallback, useState, useRef, useMemo, forwardRef, useImperativeHandle, useEffect } from 'react';
import { Image, Text, View, StyleSheet, ImageSourcePropType, ActivityIndicator, Pressable, useWindowDimensions, type ImageStyle, type StyleProp, type ScrollViewProps } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, withDelay, withSequence } from 'react-native-reanimated';
import { ChatKeyboardScrollView } from './ChatKeyboardScrollView';
import BrowserLink from '@/components/BrowserLink';
import { haptics } from '@/utils/haptics';
import { useToast } from '@/context/ToastContext';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { ApexAvatarRing } from '@/components/ui/ApexAvatarRing';
import { useApexStatusForAddresses } from '@/hooks/useApex';
import { AutoHeightImage } from '@/components/SocialFeed/media/AutoHeightImage';
import { ImageViewer } from '@/components/SocialFeed/media/ImageViewer';
import { InviteLinkCard, containsInviteLink, extractInviteLink, stripInviteLink } from './InviteLinkCard';
import { FarcasterCastCard, containsFarcasterLink, extractFarcasterLink, stripFarcasterLink } from './FarcasterCastCard';
import { EmojiPicker } from './EmojiPicker';
import { MessageActionSheet } from './MessageActionSheet';
import { MessageRenderer } from './MessageRenderer';
import { EditHistoryModal } from './EditHistoryModal';
import { ReactionDetailsModal } from './ReactionDetailsModal';
import { SpaceCallBubble } from './SpaceCallBubble';
import type { DisplayMessage, DisplayReaction } from './types';
import { hasPermission, logger, type Emoji, type Sticker, type SpaceMember, type Channel, type Role, type Space } from '@quilibrium/quorum-shared';
import * as Skin from '@/theme/skins/geometry';
// MESSAGE_IMAGE_MAX_WIDTH computed inside the component via useWindowDimensions

// User info for profile display
export interface MessageUserInfo {
  userId: string;
  userName: string;
  userAvatar?: string;
  bio?: string;
  /** Optional Farcaster linkage carried on the SpaceMember when the
   *  user advertised it in their per-space profile broadcast. The
   *  channel screen passes these straight through to UserProfileModal
   *  so the linked-Farcaster row can render. */
  farcasterFid?: number;
  farcasterUsername?: string;
}

interface MessagesListProps {
  messages: DisplayMessage[];
  theme: AppTheme;
  isLoading?: boolean;
  isRefreshing?: boolean;
  isLoadingMore?: boolean;
  error?: Error | null;
  onRefresh?: () => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  onRetryMessage?: (messageId: string) => void;
  onJoinSpace?: (spaceId: string, channelId: string) => void;
  onReaction?: (messageId: string, emoji: string) => void;
  onRemoveReaction?: (messageId: string, emoji: string) => void;
  customEmojis?: Emoji[]; // Space-specific custom emojis
  stickers?: Sticker[]; // Space-specific stickers
  onOpenFarcasterCast?: (username: string, castHashPrefix: string) => void;
  onUserPress?: (user: MessageUserInfo) => void;
  onReply?: (message: DisplayMessage) => void;
  onScrollToMessage?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  canDeleteMessage?: (message: DisplayMessage) => boolean;
  /** Members for @mention rendering */
  members?: SpaceMember[];
  /** Channels for #channel links */
  channels?: Channel[];
  /** Space roles, for resolving @role mention pills in the markdown renderer */
  roles?: Role[];
  /** Current user ID for highlighting self-mentions */
  currentUserId?: string;
  /** Callback when user taps a #channel link */
  onChannelLinkPress?: (channelId: string) => void;
  /** Callback when user taps a URL link */
  onLinkPress?: (url: string) => void;
  /** Callback to edit a message */
  onEdit?: (message: DisplayMessage) => void;
  /** Check if user can edit a message (own message within 15-min window) */
  canEditMessage?: (message: DisplayMessage) => boolean;
  /** Callback to pin a message */
  onPin?: (messageId: string) => void;
  /** Callback to unpin a message */
  onUnpin?: (messageId: string) => void;
  /** Check if user can pin/unpin messages */
  canPinMessage?: boolean;
  /** Callback to toggle bookmark */
  onBookmark?: (message: DisplayMessage) => void;
  /** Check if a message is bookmarked */
  isBookmarked?: (messageId: string) => boolean;
  /** Callback to report a message or cast. Caller decides whether to show
   *  Report (e.g. don't offer it for own messages). When undefined the
   *  action is hidden. */
  onReport?: (message: DisplayMessage) => void;
  /** Space ID for space call join (passed to SpaceCallBubble) */
  spaceId?: string;
  /** Channel ID for space call join (passed to SpaceCallBubble) */
  channelId?: string;
  /** Padding to apply at the top of the list, used to clear a translucent
   *  navigation header on iOS. Without this, the topmost messages sit
   *  *under* the header and the user can't scroll-to-top — which both
   *  hides content and prevents `onStartReached` from firing. */
  topInset?: number;
  /** Padding to apply at the bottom of the list content so the newest
   *  message rests above the floating composer + tab bar instead of being
   *  hidden behind them. Older messages still scroll behind the composer. */
  bottomInset?: number;
  /** True for a 1:1 direct-message conversation. Used to hide the redundant
   *  reaction count of "1" — in a 2-person chat a single reaction count adds
   *  no information (issue #29). In spaces the count is always shown. */
  isDM?: boolean;
}

export interface MessagesListHandle {
  scrollToEnd: (animated?: boolean) => void;
  scrollToMessage: (messageId: string, animated?: boolean) => void;
}

// Get avatar source from message, returns undefined if no avatar
// Accepts data URIs and HTTP(S) URLs for remote avatars (e.g., Farcaster profile pictures)
function getAvatarSource(msg: DisplayMessage): ImageSourcePropType | undefined {
  if (!msg.userAvatar) return undefined;
  if (typeof msg.userAvatar === 'string') {
    // Accept data URIs (base64 encoded images)
    if (msg.userAvatar.startsWith('data:')) {
      return { uri: msg.userAvatar };
    }
    // Accept HTTP/HTTPS URLs (for Farcaster profile pictures)
    if (msg.userAvatar.startsWith('http://') || msg.userAvatar.startsWith('https://')) {
      return { uri: msg.userAvatar };
    }
    // Reject local paths (file://) and other formats
    return undefined;
  }
  return msg.userAvatar;
}

type MessageStyles = ReturnType<typeof createStyles>;

// Memoized reaction badge — gives each badge stable press handlers so the
// reactions row doesn't recreate closures for every badge on each cell render.
const ReactionBadge = React.memo(function ReactionBadge({
  reaction,
  messageId,
  customEmoji,
  styles,
  onToggle,
  onShowDetails,
  hideCountWhenSingle = false,
}: {
  reaction: DisplayReaction;
  messageId: string;
  customEmoji?: Emoji;
  styles: MessageStyles;
  onToggle: (messageId: string, emoji: string, hasReacted: boolean) => void;
  onShowDetails: (messageId: string) => void;
  /** In a 1:1 DM, a reaction count of 1 is redundant (only one other person
   *  could have reacted), so hide the number and show just the emoji (#29). */
  hideCountWhenSingle?: boolean;
}) {
  const showCount = !(hideCountWhenSingle && reaction.count <= 1);
  const handlePress = useCallback(() => {
    onToggle(messageId, reaction.emoji, reaction.hasReacted);
  }, [onToggle, messageId, reaction.emoji, reaction.hasReacted]);

  // Long-press any badge opens the reactor-detail modal.
  // We don't preselect the touched emoji per the spec — the
  // modal opens with no pill selected so the user sees the
  // full reactor list, then can drill down via the pills.
  const handleLongPress = useCallback(() => {
    onShowDetails(messageId);
  }, [onShowDetails, messageId]);

  return (
    <TouchableOpacity
      style={[
        styles.reactionBadge,
        reaction.hasReacted && styles.reactionBadgeActive,
      ]}
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={300}
    >
      {customEmoji ? (
        <Image
          source={{ uri: customEmoji.imgUrl }}
          style={styles.reactionCustomEmoji}
          resizeMode="contain"
        />
      ) : (
        <Text style={styles.reactionEmoji}>{reaction.emoji}</Text>
      )}
      {showCount && (
        <Text
          style={[
            styles.reactionCount,
            reaction.hasReacted && styles.reactionCountActive,
          ]}
        >
          {reaction.count}
        </Text>
      )}
    </TouchableOpacity>
  );
});

// Memoized embed image — gives AutoHeightImage stable press handlers so the
// embed row doesn't mint a new closure per cell render.
const EmbedMessageImage = React.memo(function EmbedMessageImage({
  uri,
  maxWidth,
  style,
  messageId,
  onImagePress,
  onMessageLongPress,
}: {
  uri: string;
  maxWidth: number;
  style: StyleProp<ImageStyle>;
  messageId: string;
  onImagePress: (url: string) => void;
  onMessageLongPress: (messageId: string) => void;
}) {
  const handlePress = useCallback(() => onImagePress(uri), [onImagePress, uri]);
  const handleLongPress = useCallback(() => onMessageLongPress(messageId), [onMessageLongPress, messageId]);
  return (
    <AutoHeightImage
      uri={uri}
      maxHeight={400}
      maxWidth={maxWidth}
      style={style}
      onPress={handlePress}
      onLongPress={handleLongPress}
    />
  );
});

// Memoized reply indicator — tap scrolls to the original message.
const ReplyIndicator = React.memo(function ReplyIndicator({
  replyToMessageId,
  replyToAuthor,
  replyPreview,
  styles,
  mutedColor,
  onPress,
}: {
  replyToMessageId: string;
  replyToAuthor: string;
  replyPreview?: string;
  styles: MessageStyles;
  mutedColor: string;
  onPress: (messageId: string) => void;
}) {
  const handlePress = useCallback(() => {
    onPress(replyToMessageId);
  }, [onPress, replyToMessageId]);
  return (
    <TouchableOpacity
      style={styles.replyIndicator}
      onPress={handlePress}
      activeOpacity={0.7}
    >
      <IconSymbol
        name="arrowshape.turn.up.left.fill"
        size={12}
        color={mutedColor}
      />
      <Text style={styles.replyIndicatorText} numberOfLines={1}>
        {replyToAuthor}: {replyPreview || '...'}
      </Text>
    </TouchableOpacity>
  );
});

// Memoized retry button for failed sends.
const RetryButton = React.memo(function RetryButton({
  messageId,
  styles,
  onRetry,
}: {
  messageId: string;
  styles: MessageStyles;
  onRetry: (messageId: string) => void;
}) {
  const handlePress = useCallback(() => onRetry(messageId), [onRetry, messageId]);
  return (
    <TouchableOpacity onPress={handlePress} style={styles.retryButton}>
      <Text style={styles.retryText}>Retry</Text>
    </TouchableOpacity>
  );
});

export const MessagesList = forwardRef<MessagesListHandle, MessagesListProps>(function MessagesList({
  messages,
  theme,
  isLoading = false,
  isRefreshing = false,
  isLoadingMore = false,
  error = null,
  onRefresh,
  onLoadMore,
  hasMore = false,
  onRetryMessage,
  onJoinSpace,
  onReaction,
  onRemoveReaction,
  customEmojis = [],
  stickers = [],
  onOpenFarcasterCast,
  onUserPress,
  onReply,
  onDelete,
  canDeleteMessage,
  members = [],
  channels = [],
  roles = [],
  currentUserId,
  onChannelLinkPress,
  onLinkPress,
  onEdit,
  canEditMessage,
  onPin,
  onUnpin,
  canPinMessage = false,
  onBookmark,
  isBookmarked,
  onReport,
  spaceId,
  channelId,
  topInset = 0,
  bottomInset = 0,
  isDM = false,
}, ref) {
  const { width: screenWidth } = useWindowDimensions();
  const MESSAGE_IMAGE_MAX_WIDTH = screenWidth - 84;

  // @everyone is only rendered as a styled pill when the SENDER actually held
  // mention:everyone (role-based, no owner bypass) AND the wire flag is set —
  // the same trust rule the notification path enforces. Otherwise it's plain
  // text, so a spoofed/unauthorized @everyone can't fake an all-call pill.
  const everyoneSpaceShim = useMemo(() => ({ roles } as unknown as Space), [roles]);
  const isEveryoneAuthorized = useCallback(
    (msg: DisplayMessage): boolean => {
      const everyoneFlag = !!msg.originalMessage?.mentions?.everyone;
      if (!everyoneFlag) return false;
      const senderId = msg.originalMessage?.content?.senderId ?? msg.userId;
      return hasPermission(senderId, 'mention:everyone', everyoneSpaceShim);
    },
    [everyoneSpaceShim]
  );
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { showToast } = useToast();
  const [viewerImage, setViewerImage] = useState<string | null>(null);
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState<string | null>(null);
  const [actionSheetMessageId, setActionSheetMessageId] = useState<string | null>(null);
  const [editHistoryMessage, setEditHistoryMessage] = useState<DisplayMessage | null>(null);
  // Long-press on a reaction badge opens this modal with pill-filterable
  // reactor list. Holding the messageId rather than the reactions array
  // lets the modal pick up reactions added/removed while it's open
  // (since it reads from the same messagesRef snapshot).
  const [reactionDetailsMessageId, setReactionDetailsMessageId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightOpacity = useSharedValue(0);
  const flatListRef = useRef<FlashListRef<DisplayMessage>>(null);

  // Resting bottom clearance (composer + tab bar) as a shared value, fed to
  // ChatKeyboardScrollView's `blankSpace`. The keyboard "absorbs into" this
  // floor (total inset = max(blankSpace, keyboard + extra)), so opening the
  // keyboard lifts the list by only the EXCESS over the resting clearance — no
  // over-lift, and at rest the newest message still clears the composer. Kept on
  // the UI thread (a SharedValue) so the lift never depends on a React re-render.
  const blankSpace = useSharedValue(bottomInset);
  useEffect(() => {
    blankSpace.value = bottomInset;
  }, [bottomInset, blankSpace]);

  // A stable component (not an inline render fn) for FlashList's
  // renderScrollComponent, closing over the chat-specific keyboard props. Memo'd
  // so FlashList doesn't see a new scroll component type every render (which
  // would remount the scroll view).
  const ScrollComponent = useMemo(
    () =>
      forwardRef<any, ScrollViewProps>((scrollProps, scrollRef) => (
        <ChatKeyboardScrollView
          ref={scrollRef}
          {...scrollProps}
          blankSpace={blankSpace}
        />
      )),
    [blankSpace],
  );

  // Ref to hold latest messages — used inside callbacks to avoid re-creating them when messages change
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Messages are ordered oldest-first; FlashList's startRenderingFromBottom
  // renders from the bottom without needing an inverted array.
  const orderedMessages = messages;

  // Stable identities for FlashList's object/style props. FlashList re-initialises
  // its scroll anchor when these change identity, so passing fresh inline literals
  // on every render makes ANY re-render of this component (e.g. a parent opening a
  // modal) snap the list to the top (y=0 / first message). Memoising them keeps
  // the scroll position stable across re-renders. The FlashList docs explicitly
  // warn "Make sure FlashList's props are memoized."
  const maintainVisibleContentPosition = useMemo(
    () => ({ startRenderingFromBottom: true }),
    [],
  );
  const flashListContentContainerStyle = useMemo(
    () => (topInset > 0 ? { paddingTop: topInset } : undefined),
    [topInset],
  );

  // FlashList's `maintainVisibleContentPosition.autoscrollToBottomThreshold`
  // also fires when an existing cell GROWS at the bottom (e.g. adding a
  // reaction adds a reactions row). That scrolled the user to the bottom on
  // every reaction tap. We replace it with explicit "scroll on new bottom
  // message id" logic so only genuine new messages trigger autoscroll.
  const lastMessageIdRef = useRef<string | null>(null);
  const distanceFromBottomRef = useRef<number>(0);
  useEffect(() => {
    const newLastMsg = orderedMessages.length > 0 ? orderedMessages[orderedMessages.length - 1] : null;
    const newLast = newLastMsg?.id ?? null;
    const prevLast = lastMessageIdRef.current;
    lastMessageIdRef.current = newLast;
    if (prevLast === null || newLast === prevLast) return;
    // When the NEW bottom message is the current user's own (they just hit
    // send), always scroll to it — sending is an explicit action and the user
    // expects to see their message regardless of where they were scrolled. For
    // messages from OTHERS, keep the near-bottom gate so an incoming message
    // never yanks the user away from history they're reading.
    const isOwnMessage = !!currentUserId && newLastMsg?.userId === currentUserId;
    if (isOwnMessage || distanceFromBottomRef.current <= 80) {
      flatListRef.current?.scrollToEnd({ animated: true });
    }
  }, [orderedMessages, currentUserId]);

  // Animate highlight when message is highlighted (runs on UI thread via Reanimated)
  useEffect(() => {
    if (highlightedMessageId) {
      highlightOpacity.value = withSequence(
        withTiming(1, { duration: 0 }),
        withDelay(200, withTiming(0, { duration: 1500 })),
      );
      // Clear highlight state after animation completes
      const timer = setTimeout(() => setHighlightedMessageId(null), 1700);
      return () => clearTimeout(timer);
    }
  }, [highlightedMessageId]);

  // Reanimated animated style for highlight background
  const highlightAnimStyle = useAnimatedStyle(() => ({
    backgroundColor: `rgba(88, 101, 242, ${highlightOpacity.value * 0.19})`,
  }));

  // Helper to scroll to message with highlight
  const scrollToMessageWithHighlight = useCallback((messageId: string) => {
    const index = messagesRef.current.findIndex((m) => m.id === messageId);
    if (index !== -1) {
      flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
      // Set highlight after a brief delay for scroll to complete
      setTimeout(() => {
        setHighlightedMessageId(messageId);
      }, 300);
    }
  }, []);

  // Expose scroll methods to parent
  useImperativeHandle(ref, () => ({
    scrollToEnd: (animated = true) => {
      flatListRef.current?.scrollToEnd({ animated });
    },
    scrollToMessage: (messageId: string, animated = true) => {
      // Scroll to message with highlight effect
      scrollToMessageWithHighlight(messageId);
    },
  }), [scrollToMessageWithHighlight]);

  // Create a lookup map for custom emojis by ID
  const customEmojiMap = React.useMemo(() => {
    const map: Record<string, Emoji> = {};
    customEmojis.forEach((e) => {
      map[e.id] = e;
    });
    return map;
  }, [customEmojis]);

  // Create a lookup map for stickers by ID
  const stickerMap = React.useMemo(() => {
    const map: Record<string, Sticker> = {};
    stickers.forEach((s) => {
      map[s.id] = s;
    });
    return map;
  }, [stickers]);

  // Create a lookup map for members by address for fast mention lookups
  const memberMap = useMemo(() => {
    const map: Record<string, SpaceMember> = {};
    members.forEach((m) => {
      map[m.address] = m;
    });
    return map;
  }, [members]);

  // Memoized callback for mention press to avoid inline function creation
  const handleMentionPress = useCallback((userId: string) => {
    if (!onUserPress) return;
    const member = memberMap[userId] as (typeof memberMap[string] & {
      farcasterFid?: number;
      farcasterUsername?: string;
    }) | undefined;
    if (member) {
      onUserPress({
        userId,
        userName: member.display_name || member.name || userId,
        userAvatar: member.profile_image,
        bio: member.bio,
        farcasterFid: member.farcasterFid,
        farcasterUsername: member.farcasterUsername,
      });
    }
  }, [memberMap, onUserPress]);

  // Apex gold ring — batched "is this sender Apex-active?" lookup over the
  // distinct sender addresses of the loaded messages. Degrades silently to
  // an empty set when the server endpoint isn't live.
  const senderAddresses = useMemo(
    () => Array.from(new Set(messages.map((m) => m.userId))),
    [messages]
  );
  const apexAddresses = useApexStatusForAddresses(senderAddresses);

  // Helper to render tappable avatar
  const renderAvatar = useCallback(
    (item: DisplayMessage) => {
      const avatarSource = getAvatarSource(item);
      const handlePress = onUserPress
        ? () => {
            // Enrich with whatever extra fields the SpaceMember record
            // carries (bio, farcasterFid/Username) — DisplayMessage
            // only has the basics. Type assertion handles fields the
            // shared SpaceMember type doesn't declare.
            const member = memberMap[item.userId] as (typeof memberMap[string] & {
              farcasterFid?: number;
              farcasterUsername?: string;
            }) | undefined;
            onUserPress({
              userId: item.userId,
              userName: item.userName,
              userAvatar: typeof item.userAvatar === 'string' ? item.userAvatar : undefined,
              bio: member?.bio,
              farcasterFid: member?.farcasterFid,
              farcasterUsername: member?.farcasterUsername,
            });
          }
        : undefined;

      const avatarContent = (
        <ApexAvatarRing
          active={apexAddresses.has(item.userId)}
          size={40}
          style={styles.messageAvatarRing}
        >
          {avatarSource ? (
            <CachedAvatar source={avatarSource} style={styles.messageAvatar} />
          ) : (
            <DefaultAvatar displayName={item.userName} address={item.userId} size={40} style={styles.messageAvatar} />
          )}
        </ApexAvatarRing>
      );

      if (handlePress) {
        return (
          <TouchableOpacity onPress={handlePress} activeOpacity={0.7}>
            {avatarContent}
          </TouchableOpacity>
        );
      }

      return avatarContent;
    },
    [styles.messageAvatar, styles.messageAvatarRing, onUserPress, memberMap, apexAddresses]
  );

  // onStartReached fires when scrolling toward the top (older messages)
  const handleEndReached = useCallback(() => {
    if (hasMore && !isLoadingMore && onLoadMore) {
      onLoadMore();
    }
  }, [hasMore, isLoadingMore, onLoadMore]);

  const handleSelectReaction = useCallback(
    (emoji: string) => {
      if (reactionPickerMessageId && onReaction) {
        onReaction(reactionPickerMessageId, emoji);
      }
      setReactionPickerMessageId(null);
    },
    [reactionPickerMessageId, onReaction]
  );

  // Stable handlers passed to memoized row sub-components (ReactionBadge,
  // EmbedMessageImage, ReplyIndicator, RetryButton) — the children call
  // these with their own data so no per-row closures are needed.
  const handleImagePress = useCallback((url: string) => {
    setViewerImage(url);
  }, []);

  const handleMessageLongPress = useCallback((messageId: string) => {
    haptics.medium();
    if (onReply || onDelete) {
      setActionSheetMessageId(messageId);
    } else {
      setReactionPickerMessageId(messageId);
    }
  }, [onReply, onDelete]);

  const handleToggleReaction = useCallback((messageId: string, emoji: string, hasReacted: boolean) => {
    if (hasReacted) {
      onRemoveReaction?.(messageId, emoji);
    } else {
      onReaction?.(messageId, emoji);
    }
  }, [onReaction, onRemoveReaction]);

  const handleShowReactionDetails = useCallback((messageId: string) => {
    haptics.selection();
    setReactionDetailsMessageId(messageId);
  }, []);

  // Get the message being acted on for reply
  const actionSheetMessage = useMemo(() => {
    if (!actionSheetMessageId) return null;
    return messagesRef.current.find((m) => m.id === actionSheetMessageId) ?? null;
  }, [actionSheetMessageId]);

  const handleReplyFromActionSheet = useCallback(() => {
    if (actionSheetMessage && onReply) {
      onReply(actionSheetMessage);
    }
    setActionSheetMessageId(null);
  }, [actionSheetMessage, onReply]);

  const handleReactFromActionSheet = useCallback(() => {
    // Move the message ID to the reaction picker
    setReactionPickerMessageId(actionSheetMessageId);
    setActionSheetMessageId(null);
  }, [actionSheetMessageId]);

  const handleQuickReactFromActionSheet = useCallback((emoji: string) => {
    if (actionSheetMessageId && onReaction) {
      onReaction(actionSheetMessageId, emoji);
    }
    setActionSheetMessageId(null);
  }, [actionSheetMessageId, onReaction]);

  const handleEditFromActionSheet = useCallback(() => {
    if (actionSheetMessage && onEdit) {
      onEdit(actionSheetMessage);
    }
    setActionSheetMessageId(null);
  }, [actionSheetMessage, onEdit]);

  const handlePinFromActionSheet = useCallback(() => {
    if (actionSheetMessageId && onPin) {
      onPin(actionSheetMessageId);
    }
    setActionSheetMessageId(null);
  }, [actionSheetMessageId, onPin]);

  const handleUnpinFromActionSheet = useCallback(() => {
    if (actionSheetMessageId && onUnpin) {
      onUnpin(actionSheetMessageId);
    }
    setActionSheetMessageId(null);
  }, [actionSheetMessageId, onUnpin]);

  const handleBookmarkFromActionSheet = useCallback(() => {
    if (actionSheetMessage && onBookmark) {
      onBookmark(actionSheetMessage);
    }
    setActionSheetMessageId(null);
  }, [actionSheetMessage, onBookmark]);

  const handleReportFromActionSheet = useCallback(() => {
    if (actionSheetMessage && onReport) {
      onReport(actionSheetMessage);
    }
    setActionSheetMessageId(null);
  }, [actionSheetMessage, onReport]);

  const handleViewEditHistory = useCallback(() => {
    if (actionSheetMessage) {
      setEditHistoryMessage(actionSheetMessage);
    }
    setActionSheetMessageId(null);
  }, [actionSheetMessage]);

  // Render reactions row
  // Warning shown on any unsigned message (matches desktop). Tap reveals the
  // explanation via a toast — the mobile equivalent of desktop's touch-tooltip.
  // Its own onPress consumes the tap so it doesn't fight the row's long-press.
  const renderUnsignedWarning = useCallback(
    (item: DisplayMessage) => {
      if (item.renderType === 'system' || item.renderType === 'error') return null;
      if (item.originalMessage?.signature) return null;
      if (item.sendStatus === 'sending' || item.sendStatus === 'failed') return null;
      return (
        <TouchableOpacity
          onPress={() =>
            showToast({
              type: 'info',
              title: 'Unsigned message',
              message: 'Message does not have a valid signature, this may not be from the sender.',
            })
          }
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Unsigned message"
          style={styles.unsignedWarning}
        >
          <IconSymbol
            name="exclamationmark.triangle.fill"
            size={12}
            color={theme.colors.warning ?? '#f59e0b'}
          />
        </TouchableOpacity>
      );
    },
    [showToast, styles, theme]
  );

  const renderReactions = useCallback(
    (reactions: DisplayReaction[], messageId: string) => {
      if (!reactions || reactions.length === 0) return null;
      return (
        <View style={styles.reactionsRow}>
          {reactions.map((reaction) => (
            <ReactionBadge
              key={reaction.emoji}
              reaction={reaction}
              messageId={messageId}
              // Check if this is a custom emoji (ID matches a custom emoji)
              customEmoji={customEmojiMap[reaction.emoji]}
              styles={styles}
              onToggle={handleToggleReaction}
              onShowDetails={handleShowReactionDetails}
              hideCountWhenSingle={isDM}
            />
          ))}
        </View>
      );
    },
    [styles, handleToggleReaction, handleShowReactionDetails, customEmojiMap, isDM]
  );

  // Render system message (join/leave/kick)
  const renderSystemMessage = useCallback(
    (item: DisplayMessage) => {
      const iconName =
        item.systemEventType === 'join'
          ? 'arrow.right.circle.fill'
          : item.systemEventType === 'leave'
          ? 'arrow.left.circle.fill'
          : 'xmark.circle.fill';
      const iconColor =
        item.systemEventType === 'join'
          ? theme.colors.success ?? '#22c55e'
          : item.systemEventType === 'kick'
          ? theme.colors.danger ?? '#ef4444'
          : theme.colors.textMuted;

      return (
        <View style={styles.systemMessage}>
          <IconSymbol name={iconName} size={16} color={iconColor} />
          <Text style={styles.systemMessageText}>{item.content}</Text>
          <Text style={styles.systemMessageTime}>{item.timeString}</Text>
        </View>
      );
    },
    [styles, theme]
  );

  // Render call event (voice/video call summary)
  const renderCallEvent = useCallback(
    (item: DisplayMessage) => {
      const c = item.originalMessage?.content as any;
      const isMissed = c?.event === 'missed';
      const iconName = c?.mediaType === 'video' ? 'video.fill' : 'phone.fill';
      const iconColor = isMissed
        ? (theme.colors.danger ?? '#ff3b30')
        : (theme.colors.success ?? '#34c759');

      return (
        <View style={styles.systemMessage}>
          <IconSymbol name={iconName} size={16} color={iconColor} />
          <Text style={styles.systemMessageText}>{item.content}</Text>
          <Text style={styles.systemMessageTime}>{item.timeString}</Text>
        </View>
      );
    },
    [styles, theme]
  );

  // Build a lookup of ended space call IDs: callId -> endedAt timestamp
  const endedSpaceCalls = useMemo(() => {
    const map = new Map<string, number>();
    for (const msg of messages) {
      if (msg.originalMessage?.content.type === 'space-call-end') {
        const c = msg.originalMessage.content;
        map.set(c.callId, msg.timestamp);
      }
    }
    return map;
  }, [messages]);

  // Render space call bubble (joinable inline element)
  const renderSpaceCall = useCallback(
    (item: DisplayMessage) => {
      logger.debug('[SpaceCall] rendering bubble:', item.renderType, item.spaceCallId);
      // For space-call-end messages, don't render a separate bubble — the
      // corresponding space-call-start bubble already reflects the ended state.
      if (item.originalMessage?.content.type === 'space-call-end') {
        return <View />;
      }

      const callId = item.spaceCallId;
      const isEnded = callId ? endedSpaceCalls.has(callId) : false;
      const endedAt = callId ? endedSpaceCalls.get(callId) : undefined;

      return (
        <SpaceCallBubble
          message={item}
          isEnded={isEnded}
          endedAt={endedAt}
          spaceId={spaceId}
          channelId={channelId}
          theme={theme}
        />
      );
    },
    [endedSpaceCalls, spaceId, channelId, theme]
  );

  // Render deleted message placeholder
  const renderDeletedMessage = useCallback(
    (item: DisplayMessage) => {
      return (
        <View style={styles.deletedMessage}>
          <IconSymbol
            name="trash.fill"
            size={14}
            color={theme.colors.textMuted}
          />
          <Text style={styles.deletedMessageText}>{item.content}</Text>
        </View>
      );
    },
    [styles, theme]
  );

  // Render malformed-message placeholder. Surfaces the error inline so
  // production users can screenshot it; we don't have logs to fall back
  // on. Tap-to-copy isn't wired but the text is `selectable` so a long
  // press lets the user grab it for support.
  const renderErrorMessage = useCallback(
    (item: DisplayMessage) => {
      return (
        <View style={styles.deletedMessage}>
          <IconSymbol
            name="exclamationmark.triangle.fill"
            size={14}
            color={theme.colors.warning ?? '#f59e0b'}
          />
          <Text style={styles.deletedMessageText} selectable>
            {item.errorDetail ?? 'Could not render message'}
          </Text>
        </View>
      );
    },
    [styles, theme]
  );

  // Render embed/media message
  const renderEmbedMessage = useCallback(
    (item: DisplayMessage) => {
      const imageUrl = item.imageUrl || item.thumbnailUrl;

      const handleLongPress = () => handleMessageLongPress(item.id);

      const isHighlighted = highlightedMessageId === item.id;

      return (
        <Pressable onLongPress={handleLongPress} delayLongPress={300}>
          <Animated.View style={[styles.message, isHighlighted && highlightAnimStyle]}>
            {renderAvatar(item)}
            <View style={styles.messageContent}>
              <View style={styles.messageHeader}>
                <Text style={styles.messageUser} numberOfLines={1}>{item.userName}</Text>
                <Text style={styles.messageTime}>{item.timeString}</Text>
                {renderUnsignedWarning(item)}
              </View>
              {imageUrl && (
                <View style={styles.embedImageContainer}>
                  <EmbedMessageImage
                    uri={imageUrl}
                    maxWidth={MESSAGE_IMAGE_MAX_WIDTH}
                    style={styles.embedImage}
                    messageId={item.id}
                    onImagePress={handleImagePress}
                    onMessageLongPress={handleMessageLongPress}
                  />
                </View>
              )}
              {item.videoUrl && (
                <View style={styles.videoPlaceholder}>
                  <IconSymbol name="play.circle.fill" size={40} color="#fff" />
                  <Text style={styles.videoPlaceholderText}>Video</Text>
                </View>
              )}
              {/* Caption — embeds can carry text alongside the image.
                  Rendered after the media so the visual order is the same
                  as desktop. */}
              {item.content ? (
                <MessageRenderer
                  text={item.content}
                  enableTranslate
                  customEmojis={customEmojis}
                  members={members}
                  channels={channels}
                  roles={roles}
                  everyoneAuthorized={isEveryoneAuthorized(item)}
                  currentUserId={currentUserId}
                  style={styles.messageText}
                  theme={theme}
                  onMentionPress={onUserPress ? handleMentionPress : undefined}
                  onChannelPress={onChannelLinkPress}
                  onLinkPress={onLinkPress}
                />
              ) : null}
              {renderReactions(item.reactions || [], item.id)}
            </View>
          </Animated.View>
        </Pressable>
      );
    },
    [styles, renderReactions, renderAvatar, renderUnsignedWarning, handleMessageLongPress, handleImagePress, MESSAGE_IMAGE_MAX_WIDTH, highlightedMessageId, highlightAnimStyle, customEmojis, members, channels, roles, isEveryoneAuthorized, currentUserId, theme, onUserPress, handleMentionPress, onChannelLinkPress, onLinkPress]
  );

  // Render sticker message
  const renderStickerMessage = useCallback(
    (item: DisplayMessage) => {
      const sticker = item.stickerId ? stickerMap[item.stickerId] : null;

      const handleLongPress = () => handleMessageLongPress(item.id);

      const isHighlighted = highlightedMessageId === item.id;

      return (
        <Pressable onLongPress={handleLongPress} delayLongPress={300}>
          <Animated.View style={[styles.message, isHighlighted && highlightAnimStyle]}>
            {renderAvatar(item)}
            <View style={styles.messageContent}>
              <View style={styles.messageHeader}>
                <Text style={styles.messageUser} numberOfLines={1}>{item.userName}</Text>
                <Text style={styles.messageTime}>{item.timeString}</Text>
                {renderUnsignedWarning(item)}
              </View>
              {sticker ? (
                <View style={styles.stickerContainer}>
                  <Image
                    source={{ uri: sticker.imgUrl }}
                    style={styles.stickerImage}
                    resizeMode="contain"
                  />
                </View>
              ) : (
                <View style={styles.stickerPlaceholder}>
                  <Text style={styles.stickerPlaceholderText}>[Sticker]</Text>
                </View>
              )}
              {renderReactions(item.reactions || [], item.id)}
            </View>
          </Animated.View>
        </Pressable>
      );
    },
    [styles, renderReactions, stickerMap, renderAvatar, renderUnsignedWarning, handleMessageLongPress, highlightedMessageId, highlightAnimStyle]
  );

  // Helper to get reply preview from parent message
  const getReplyPreview = useCallback((replyToMessageId: string | undefined): string | undefined => {
    if (!replyToMessageId) return undefined;
    const parentMessage = messagesRef.current.find((m) => m.id === replyToMessageId);
    if (!parentMessage) return undefined;
    const preview = parentMessage.content || '';
    // Truncate to ~50 chars
    return preview.length > 50 ? preview.slice(0, 50) + '...' : preview;
  }, []);

  // Render regular post message
  const renderPostMessage = useCallback(
    (item: DisplayMessage) => {
      const isSending = item.sendStatus === 'sending';
      const isFailed = item.sendStatus === 'failed';

      // Check if message contains an invite link
      const hasInviteLink = containsInviteLink(item.content);
      const inviteLink = hasInviteLink ? extractInviteLink(item.content) : null;

      // Check if message contains a Farcaster link
      const hasFarcasterLink = containsFarcasterLink(item.content);
      const farcasterLink = hasFarcasterLink ? extractFarcasterLink(item.content) : null;

      // Strip special links from message text for display
      let messageTextWithoutLink: string | null = item.content;
      if (hasInviteLink) {
        messageTextWithoutLink = stripInviteLink(messageTextWithoutLink) ?? '';
      }
      if (hasFarcasterLink && messageTextWithoutLink) {
        messageTextWithoutLink = stripFarcasterLink(messageTextWithoutLink) ?? '';
      }
      // Convert empty string to null for cleaner conditional rendering
      if (messageTextWithoutLink === '') {
        messageTextWithoutLink = null;
      }

      // Show action sheet if reply is available, otherwise go straight to emoji picker
      const handleLongPress = () => handleMessageLongPress(item.id);

      const isHighlighted = highlightedMessageId === item.id;

      // Get reply preview
      const replyPreview = item.replyToPreview || getReplyPreview(item.replyToMessageId);

      return (
        <Pressable
          onLongPress={handleLongPress}
          delayLongPress={300}
        >
          <Animated.View style={[styles.message, isSending && styles.messageSending, isHighlighted && highlightAnimStyle]}>
            {renderAvatar(item)}
            <View style={styles.messageContent}>
              <View style={styles.messageHeader}>
                <Text style={styles.messageUser} numberOfLines={1}>{item.userName}</Text>
                <Text style={styles.messageTime}>{item.timeString}</Text>
                {item.originalMessage?.isPinned && (
                  <IconSymbol name="pin.fill" size={10} color={theme.colors.textMuted} style={{ marginLeft: Skin.space(4) }} />
                )}
                {item.isEdited && (
                  <Text style={styles.editedIndicator}>(edited)</Text>
                )}
                {renderUnsignedWarning(item)}
                {isSending && (
                  <ActivityIndicator
                    size="small"
                    color={theme.colors.textMuted}
                    style={styles.sendingIndicator}
                  />
                )}
              </View>
              {/* Reply indicator - tap to scroll to original message */}
              {item.isReply && item.replyToAuthor && item.replyToMessageId && (
                <ReplyIndicator
                  replyToMessageId={item.replyToMessageId}
                  replyToAuthor={item.replyToAuthor}
                  replyPreview={replyPreview}
                  styles={styles}
                  mutedColor={theme.colors.textMuted}
                  onPress={scrollToMessageWithHighlight}
                />
              )}
              {item.hasLink && item.link ? (
                <View style={styles.messageWithLink}>
                  <MessageRenderer
                    text={item.content}
                    enableTranslate
                    customEmojis={customEmojis}
                    members={members}
                    channels={channels}
                    roles={roles}
                    everyoneAuthorized={isEveryoneAuthorized(item)}
                    currentUserId={currentUserId}
                    style={styles.messageText}
                    theme={theme}
                    onMentionPress={onUserPress ? handleMentionPress : undefined}
                    onChannelPress={onChannelLinkPress}
                    onLinkPress={onLinkPress}
                  />
                  <BrowserLink url={item.link} textStyle={styles.linkText}>
                    {item.linkText}
                  </BrowserLink>
                </View>
              ) : messageTextWithoutLink ? (
                <MessageRenderer
                  text={messageTextWithoutLink}
                  enableTranslate
                  customEmojis={customEmojis}
                  members={members}
                  channels={channels}
                  roles={roles}
                  everyoneAuthorized={isEveryoneAuthorized(item)}
                  currentUserId={currentUserId}
                  style={styles.messageText}
                  theme={theme}
                  onMentionPress={onUserPress ? handleMentionPress : undefined}
                  onChannelPress={onChannelLinkPress}
                  onLinkPress={onLinkPress}
                />
              ) : null}
              {/* Render invite link card if detected */}
              {inviteLink && (
                <InviteLinkCard
                  inviteLink={inviteLink}
                  messageSenderId={item.userId}
                  onJoinSuccess={onJoinSpace}
                />
              )}
              {/* Render Farcaster cast card if detected */}
              {farcasterLink && (
                <FarcasterCastCard url={farcasterLink} onPress={onOpenFarcasterCast} />
              )}
              {/* Render reactions */}
              {renderReactions(item.reactions || [], item.id)}
              {isFailed && (
                <View style={styles.failedRow}>
                  <IconSymbol
                    name="exclamationmark.circle.fill"
                    size={14}
                    color={theme.colors.danger ?? '#ef4444'}
                  />
                  <Text style={styles.failedText}>
                    {item.sendError || 'Failed to send'}
                  </Text>
                  {onRetryMessage && (
                    <RetryButton
                      messageId={item.id}
                      styles={styles}
                      onRetry={onRetryMessage}
                    />
                  )}
                </View>
              )}
            </View>
          </Animated.View>
        </Pressable>
      );
    },
    [styles, theme, onRetryMessage, onJoinSpace, onOpenFarcasterCast, renderReactions, renderAvatar, renderUnsignedWarning, scrollToMessageWithHighlight, customEmojis, members, channels, roles, isEveryoneAuthorized, currentUserId, onUserPress, handleMentionPress, onChannelLinkPress, onLinkPress, highlightedMessageId, highlightAnimStyle, getReplyPreview, handleMessageLongPress]
  );

  const renderCast = useCallback(
    (item: DisplayMessage) => {
      if (!item.cast) return null;
      const handleLongPress = () => {
        haptics.medium();
        setActionSheetMessageId(item.id);
      };
      return (
        <View style={{ paddingHorizontal: Skin.contentRowPaddingH(), paddingVertical: Skin.space(4) }}>
          <FarcasterCastCard
            cast={item.cast}
            channelKey={item.castChannelKey}
            fullWidth
            onPress={onOpenFarcasterCast}
            onLongPress={handleLongPress}
          />
        </View>
      );
    },
    [onOpenFarcasterCast],
  );

  const renderItem = useCallback(
    ({ item }: { item: DisplayMessage }) => {
      // Route to appropriate renderer based on message type
      switch (item.renderType) {
        case 'system':
          return renderSystemMessage(item);
        case 'call-event':
          return renderCallEvent(item);
        case 'space-call':
          return renderSpaceCall(item);
        case 'deleted':
          return renderDeletedMessage(item);
        case 'embed':
          return renderEmbedMessage(item);
        case 'sticker':
          return renderStickerMessage(item);
        case 'cast':
          return renderCast(item);
        case 'error':
          return renderErrorMessage(item);
        case 'unsupported':
          // Defense-in-depth: filtered out upstream, so unreachable in practice.
          // If one slips through, render nothing rather than a phantom 'post' bubble.
          return null;
        case 'post':
        default:
          return renderPostMessage(item);
      }
    },
    [renderSystemMessage, renderCallEvent, renderSpaceCall, renderDeletedMessage, renderEmbedMessage, renderStickerMessage, renderCast, renderErrorMessage, renderPostMessage]
  );

  // Loading state
  if (isLoading && messages.length === 0) {
    return (
      <View style={[styles.container, styles.centerContent]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
        <Text style={styles.loadingText}>Loading messages...</Text>
      </View>
    );
  }

  // Error state
  if (error && messages.length === 0) {
    return (
      <View style={[styles.container, styles.centerContent]}>
        <Text style={styles.errorText}>Failed to load messages</Text>
        <Text style={styles.errorDetail}>{error.message}</Text>
      </View>
    );
  }

  // Empty state
  if (!isLoading && messages.length === 0) {
    return (
      <View style={[styles.container, styles.centerContent]}>
        <Text style={styles.emptyText}>No messages yet</Text>
        <Text style={styles.emptySubtext}>Be the first to say something!</Text>
      </View>
    );
  }

  return (
    <>
    <View style={styles.container}>
      <FlashList
        ref={flatListRef}
        data={orderedMessages}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        getItemType={(item) => item.renderType}
        // The scroll container is ChatKeyboardScrollView (keyboard library),
        // which owns the BOTTOM inset: at rest it holds `blankSpace` (the
        // composer + tab-bar clearance, so the newest message rests above the
        // composer) and on keyboard-open it lifts the content in lockstep with
        // the keyboard on the UI thread. So we only pad the TOP here (to clear a
        // translucent header on iOS); the bottom is no longer a static
        // paddingBottom (that would double-count with blankSpace).
        renderScrollComponent={ScrollComponent}
        contentContainerStyle={flashListContentContainerStyle}
        // Memoised (see above) — a fresh literal here re-anchors the list to the
        // top on any re-render. autoscrollToBottomThreshold deliberately omitted:
        // it also fired on cell growth (e.g. a reaction added to the last
        // message), yanking the user to the bottom; the lastMessageId effect
        // handles genuine new-message autoscroll instead.
        maintainVisibleContentPosition={maintainVisibleContentPosition}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          distanceFromBottomRef.current = Math.max(
            0,
            contentSize.height - (contentOffset.y + layoutMeasurement.height),
          );
        }}
        scrollEventThrottle={64}
        onStartReached={handleEndReached}
        onStartReachedThreshold={0.5}
        // Keep a larger window of rendered cells alive so that scrolling back
        // toward the top doesn't briefly render empty space before the older
        // cells remount.
        drawDistance={1000}
        ListHeaderComponent={
          isLoadingMore ? (
            <View style={styles.loadingMore}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
            </View>
          ) : null
        }
      />
    </View>
    <ImageViewer
      visible={!!viewerImage}
      imageUrl={viewerImage}
      onClose={() => setViewerImage(null)}
    />
    <EmojiPicker
      visible={!!reactionPickerMessageId}
      onClose={() => setReactionPickerMessageId(null)}
      onSelectEmoji={handleSelectReaction}
      theme={theme}
      customEmojis={customEmojis}
    />
    <MessageActionSheet
      visible={!!actionSheetMessageId}
      onClose={() => setActionSheetMessageId(null)}
      onReply={onReply ? handleReplyFromActionSheet : undefined}
      // Reactions, edits, pins, deletes, bookmarks all act on Quorum messages.
      // Casts in the stream only support Reply (which writes to the local chat
      // and may optionally also post a Farcaster reply via the composer toggle).
      onReact={actionSheetMessage?.renderType === 'cast' ? () => {} : handleReactFromActionSheet}
      onQuickReact={actionSheetMessage?.renderType === 'cast' ? undefined : (onReaction ? handleQuickReactFromActionSheet : undefined)}
      onDelete={actionSheetMessage && onDelete && actionSheetMessage.renderType !== 'cast' ? () => onDelete(actionSheetMessage.id) : undefined}
      canDelete={actionSheetMessage && actionSheetMessage.renderType !== 'cast' && canDeleteMessage ? canDeleteMessage(actionSheetMessage) : false}
      onEdit={actionSheetMessage?.renderType === 'cast' ? undefined : (onEdit ? handleEditFromActionSheet : undefined)}
      canEdit={actionSheetMessage && actionSheetMessage.renderType !== 'cast' && canEditMessage ? canEditMessage(actionSheetMessage) : false}
      onPin={actionSheetMessage?.renderType === 'cast' ? undefined : (onPin ? handlePinFromActionSheet : undefined)}
      onUnpin={actionSheetMessage?.renderType === 'cast' ? undefined : (onUnpin ? handleUnpinFromActionSheet : undefined)}
      isPinned={actionSheetMessage?.originalMessage?.isPinned ?? false}
      canPin={actionSheetMessage?.renderType === 'cast' ? false : canPinMessage}
      onBookmark={actionSheetMessage?.renderType === 'cast' ? undefined : (onBookmark ? handleBookmarkFromActionSheet : undefined)}
      isBookmarked={actionSheetMessage && actionSheetMessage.renderType !== 'cast' && isBookmarked ? isBookmarked(actionSheetMessage.id) : false}
      onViewEditHistory={actionSheetMessage?.renderType === 'cast' ? undefined : handleViewEditHistory}
      hasEditHistory={actionSheetMessage?.renderType !== 'cast' && (actionSheetMessage?.hasEditHistory ?? false)}
      messageText={actionSheetMessage?.content}
      onReport={onReport ? handleReportFromActionSheet : undefined}
      theme={theme}
    />
    <EditHistoryModal
      visible={!!editHistoryMessage}
      onClose={() => setEditHistoryMessage(null)}
      originalText={editHistoryMessage?.content ?? ''}
      originalDate={editHistoryMessage?.timestamp ?? 0}
      edits={editHistoryMessage?.originalMessage?.edits ?? []}
      theme={theme}
    />
    <ReactionDetailsModal
      visible={!!reactionDetailsMessageId}
      onClose={() => setReactionDetailsMessageId(null)}
      reactions={
        (reactionDetailsMessageId
          ? messagesRef.current.find((m) => m.id === reactionDetailsMessageId)?.reactions
          : null) ?? []
      }
      members={members}
      customEmojis={customEmojis}
      onUserPress={
        onUserPress
          ? (address) => {
              const member = memberMap[address] as
                | (typeof memberMap[string] & {
                    farcasterFid?: number;
                    farcasterUsername?: string;
                  })
                | undefined;
              if (member) {
                onUserPress({
                  userId: address,
                  userName: member.display_name || member.name || address,
                  userAvatar: member.profile_image,
                  bio: member.bio,
                  farcasterFid: member.farcasterFid,
                  farcasterUsername: member.farcasterUsername,
                });
                setReactionDetailsMessageId(null);
              }
            }
          : undefined
      }
    />
    </>
  );
});

const createStyles = (theme: AppTheme) => StyleSheet.create({
  container: {
    flex: 1,
    width: '100%',
  },
  centerContent: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Skin.space(32),
  },
  message: {
    flexDirection: 'row',
    paddingVertical: Skin.space(16),
    // Shared content-row width (matches the Farcaster feed cards).
    paddingHorizontal: Skin.contentRowPaddingH(),
    width: '100%',
  },
  messageAvatar: {
    width: 40,
    height: 40,
    borderRadius: Skin.radius(20),
  },
  // The avatar's right margin lives on the ApexAvatarRing wrapper so the
  // gold ring hugs the image instead of enclosing the margin.
  messageAvatarRing: {
    marginRight: Skin.space(12),
  },
  messageContent: {
    flex: 1,
  },
  messageHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  messageUser: {
    color: theme.colors.textStrong,
    fontFamily: theme.fonts.medium.fontFamily,
    fontWeight: theme.fonts.medium.fontWeight,
    marginRight: Skin.space(8),
    flexShrink: 1,
  },
  messageTime: {
    color: theme.colors.textSubtle,
    fontSize: Skin.font(12),
  },
  messageText: {
    color: theme.colors.textMain,
    marginTop: Skin.space(4),
    fontFamily: theme.fonts.regular.fontFamily,
  },
  messageWithLink: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginTop: Skin.space(4),
    flexWrap: 'wrap',
  },
  linkText: {
    color: theme.colors.primary,
    textDecorationLine: 'underline',
    fontFamily: theme.fonts.regular.fontFamily,
  },
  loadingText: {
    marginTop: Skin.space(12),
    color: theme.colors.textSubtle,
    fontSize: Skin.font(14),
    fontFamily: theme.fonts.regular.fontFamily,
  },
  errorText: {
    color: theme.colors.danger ?? theme.colors.accent,
    fontSize: Skin.font(16),
    fontFamily: theme.fonts.medium.fontFamily,
    fontWeight: theme.fonts.medium.fontWeight,
    textAlign: 'center',
  },
  errorDetail: {
    marginTop: Skin.space(8),
    color: theme.colors.textSubtle,
    fontSize: Skin.font(14),
    fontFamily: theme.fonts.regular.fontFamily,
    textAlign: 'center',
  },
  emptyText: {
    color: theme.colors.textMain,
    fontSize: Skin.font(18),
    fontFamily: theme.fonts.medium.fontFamily,
    fontWeight: theme.fonts.medium.fontWeight,
    textAlign: 'center',
  },
  emptySubtext: {
    marginTop: Skin.space(8),
    color: theme.colors.textSubtle,
    fontSize: Skin.font(14),
    fontFamily: theme.fonts.regular.fontFamily,
    textAlign: 'center',
  },
  loadingMore: {
    paddingVertical: Skin.space(16),
    alignItems: 'center',
  },
  messageSending: {
    opacity: 0.6,
  },
  sendingIndicator: {
    marginLeft: Skin.space(8),
  },
  failedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: Skin.space(6),
  },
  failedText: {
    color: theme.colors.danger ?? '#ef4444',
    fontSize: Skin.font(12),
    fontFamily: theme.fonts.regular.fontFamily,
    marginLeft: Skin.space(4),
  },
  retryButton: {
    marginLeft: Skin.space(8),
    paddingHorizontal: Skin.space(8),
    paddingVertical: Skin.space(2),
    backgroundColor: theme.colors.surface5 ?? theme.colors.surface3,
    borderRadius: Skin.radius(4),
  },
  retryText: {
    color: theme.colors.primary,
    fontSize: Skin.font(12),
    fontFamily: theme.fonts.medium.fontFamily,
  },
  // System message styles
  systemMessage: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Skin.space(8),
    paddingHorizontal: Skin.space(16),
  },
  systemMessageText: {
    color: theme.colors.textSubtle,
    fontSize: Skin.font(13),
    fontFamily: theme.fonts.regular.fontFamily,
    marginHorizontal: Skin.space(8),
    fontStyle: 'italic',
  },
  systemMessageTime: {
    color: theme.colors.textSubtle,
    fontSize: Skin.font(11),
    fontFamily: theme.fonts.regular.fontFamily,
  },
  // Deleted message styles
  deletedMessage: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Skin.space(16),
    opacity: 0.6,
  },
  deletedMessageText: {
    color: theme.colors.textSubtle,
    fontSize: Skin.font(14),
    fontFamily: theme.fonts.regular.fontFamily,
    fontStyle: 'italic',
    marginLeft: Skin.space(8),
  },
  // Edited indicator
  editedIndicator: {
    color: theme.colors.textSubtle,
    fontSize: Skin.font(11),
    fontFamily: theme.fonts.regular.fontFamily,
    marginLeft: Skin.space(6),
  },
  unsignedWarning: {
    marginLeft: Skin.space(6),
    alignSelf: 'center',
  },
  // Reply indicator
  replyIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Skin.space(4),
  },
  replyIndicatorText: {
    color: theme.colors.textSubtle,
    fontSize: Skin.font(12),
    fontFamily: theme.fonts.regular.fontFamily,
    marginLeft: Skin.space(4),
  },
  // Reactions styles
  reactionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: Skin.space(6),
    gap: Skin.space(6),
  },
  reactionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface3 ?? theme.colors.surface2,
    paddingHorizontal: Skin.space(8),
    paddingVertical: Skin.space(4),
    borderRadius: Skin.radius(12),
    borderWidth: Skin.border(1),
    borderColor: 'transparent',
  },
  reactionBadgeActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface4 ?? theme.colors.surface3,
  },
  reactionEmoji: {
    fontSize: Skin.font(14),
  },
  reactionCustomEmoji: {
    width: 16,
    height: 16,
    borderRadius: Skin.radius(2),
  },
  reactionCount: {
    color: theme.colors.textSubtle,
    fontSize: Skin.font(12),
    fontFamily: theme.fonts.medium.fontFamily,
    marginLeft: Skin.space(4),
  },
  reactionCountActive: {
    color: theme.colors.primary,
  },
  // Embed/media styles
  embedImageContainer: {
    marginTop: Skin.space(8),
    borderRadius: Skin.radius(8),
    overflow: 'hidden',
  },
  embedImage: {
    borderRadius: Skin.radius(8),
  },
  videoPlaceholder: {
    width: '100%',
    maxWidth: 300,
    height: 180,
    borderRadius: Skin.radius(8),
    marginTop: Skin.space(8),
    backgroundColor: theme.colors.surface3 ?? '#1a1a1a',
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoPlaceholderText: {
    color: '#fff',
    fontSize: Skin.font(12),
    fontFamily: theme.fonts.regular.fontFamily,
    marginTop: Skin.space(8),
  },
  // Sticker styles
  stickerContainer: {
    marginTop: Skin.space(8),
  },
  stickerImage: {
    width: 128,
    height: 128,
    borderRadius: Skin.radius(8),
  },
  stickerPlaceholder: {
    width: 128,
    height: 128,
    marginTop: Skin.space(8),
    borderRadius: Skin.radius(8),
    backgroundColor: theme.colors.surface3 ?? '#1a1a1a',
    justifyContent: 'center',
    alignItems: 'center',
  },
  stickerPlaceholderText: {
    color: theme.colors.textSubtle,
    fontSize: Skin.font(14),
    fontFamily: theme.fonts.regular.fontFamily,
  },
});

export default MessagesList;
