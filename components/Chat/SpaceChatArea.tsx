/**
 * SpaceChatArea - Extracted space chat component
 *
 * Owns all space-chat-specific state (messageText, pendingAttachment, etc.)
 * so that keystrokes in the message input only re-render this subtree,
 * not the entire HomeScreen/sidebars.
 */

import type { AppTheme } from '@/theme';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, View } from 'react-native';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useHeaderHeight } from '@react-navigation/elements';

import {
  ChannelHeader,
  MessageInput,
  MessagesList,
  PinnedMessagesPanel,
  BookmarksPanel,
  SearchBar,
  toDisplayMessage,
  castToDisplayMessage,
} from '@/components/Chat';
import type {
  DisplayChannel,
  DisplayMessage,
  MemberMap,
  MessageInputHandle,
  MessagesListHandle,
  EditingMessage,
  MessageUserInfo,
} from '@/components/Chat';

import { useAuth } from '@/context';
import { useFarcasterChannel } from '@/hooks/useFarcasterChannel';
import { useFarcasterSubmitCast } from '@/hooks/useFarcasterSubmitCast';
import { useEffectiveBindings } from '@/services/space/channelBindings';
import { flattenMessages, useMessages } from '@/hooks/chat/useMessages';
import { useMembersWithPublicProfileFallback } from '@/hooks/useMembersWithPublicProfileFallback';
import { useSendSpaceMessage } from '@/hooks/chat/useSendSpaceMessage';
import { useSendEmbedMessage } from '@/hooks/chat/useSendEmbedMessage';
import { useAddSpaceReaction, useRemoveSpaceReaction } from '@/hooks/chat/useSpaceReactions';
import { useDeleteSpaceMessage } from '@/hooks/chat/useDeleteSpaceMessage';
import { useSendStickerMessage } from '@/hooks/chat/useSendStickerMessage';
import { useEditSpaceMessage, canEditMessage } from '@/hooks/chat/useEditSpaceMessage';
import { usePinMessage, useUnpinMessage, usePinnedMessages, getPinnedMessageIds } from '@/hooks/chat/usePinnedMessages';
import { useMessageSearch } from '@/hooks/chat/useMessageSearch';
import { useUserMuting } from '@/hooks/chat/useUserMuting';
import { pickImage, type ProcessedAttachment } from '@/services/media/imageAttachment';
import { haptics } from '@/utils/haptics';
import { ReportModal } from '@/components/ReportModal';
import type { Channel, Emoji, Message, Space, SpaceMember, Sticker } from '@quilibrium/quorum-shared';
import { logger } from '@quilibrium/quorum-shared';import type { Bookmark } from '@quilibrium/quorum-shared';
import * as Skin from '@/theme/skins/geometry';

interface SpaceChatAreaProps {
  spaceId: string | undefined;
  channelId: string | undefined;
  spaceData: Space | null | undefined;
  channelsData: Channel[] | undefined;
  membersData: SpaceMember[] | undefined;
  memberMap: MemberMap;
  isSpaceOwner: boolean;
  hasPinPermission: boolean;
  hasDeletePermission: boolean;
  /** Whether the current user may post in this channel (false = read-only and not a manager). */
  canPost?: boolean;
  /** Whether this channel is read-only (drives the locked-composer banner copy). */
  isReadOnlyChannel?: boolean;
  onShowSidebars: () => void;
  onUserPress: (userInfo: MessageUserInfo) => void;
  onLinkPress: (url: string) => void;
  onOpenFarcasterCast: (username: string, castHashPrefix: string) => void;
  onJoinSpaceFromLink: (spaceId: string, channelId: string) => void;
  onOpenInviteModal: () => void;
  onOpenSpaceSettings: () => void;
  bookmarks: Bookmark[];
  isBookmarked: (messageId: string) => boolean;
  addBookmark: (bookmark: Bookmark) => void;
  removeBookmark: (bookmarkId: string) => void;
  tabBarHeight?: number;
  theme: AppTheme;
  draftsRef: React.MutableRefObject<Map<string, string>>;
  onChannelLinkPress: (channelId: string) => void;
  selectedConversationId?: string;
  isDMsSelected: boolean;
}

export const SpaceChatArea = React.memo(function SpaceChatArea({
  spaceId,
  channelId,
  spaceData,
  channelsData,
  membersData,
  memberMap,
  isSpaceOwner,
  hasPinPermission,
  hasDeletePermission,
  canPost = true,
  isReadOnlyChannel = false,
  onShowSidebars,
  onUserPress,
  onLinkPress,
  onOpenFarcasterCast,
  onJoinSpaceFromLink,
  onOpenInviteModal,
  onOpenSpaceSettings,
  bookmarks,
  isBookmarked,
  addBookmark,
  removeBookmark,
  tabBarHeight = 0,
  theme,
  draftsRef,
  onChannelLinkPress,
  selectedConversationId,
  isDMsSelected,
}: SpaceChatAreaProps) {
  const { user, farcasterAuthToken } = useAuth();

  // Local state — this is the whole point: messageText changes
  // only re-render SpaceChatArea, not the parent HomeScreen
  const [messageText, setMessageText] = useState('');
  const [pendingAttachment, setPendingAttachment] = useState<ProcessedAttachment | null>(null);
  const [replyToMessage, setReplyToMessage] = useState<{ messageId: string; senderName: string; text: string; authorId: string } | null>(null);
  // Opt-in per-send. Reset whenever the reply target changes; user must
  // explicitly check the box again for each cast reply.
  const [alsoReplyOnFarcaster, setAlsoReplyOnFarcaster] = useState(false);
  const isCastReply = Boolean(replyToMessage?.messageId.startsWith('cast:'));
  // The cast hash needed to attach the Farcaster reply. Stored separately so
  // we can post even if the cast is no longer in the merged stream when send
  // fires.
  const replyCastHashRef = useRef<string | null>(null);
  // Author fid of the cast we're replying to — required for the
  // hypersnap publish path (the protocol-level reply target is
  // `castId: { fid, hash }`). Falls back to undefined → submit hook
  // routes through the legacy path which accepts hash-only.
  const replyParentFidRef = useRef<number | null>(null);
  const [editingMessage, setEditingMessage] = useState<EditingMessage | null>(null);
  const [pinnedMessagesPanelVisible, setPinnedMessagesPanelVisible] = useState(false);
  const [bookmarksPanelVisible, setBookmarksPanelVisible] = useState(false);

  const spaceMessagesListRef = useRef<MessagesListHandle>(null);
  const spaceMessageInputRef = useRef<MessageInputHandle>(null);

  // Data hooks
  const {
    data: messagesPages,
    isLoading: messagesLoading,
    isRefetching: messagesRefetching,
    isFetchingNextPage: messagesFetchingMore,
    error: messagesError,
    refetch: refetchMessages,
    fetchNextPage: fetchMoreMessages,
    hasNextPage: hasMoreMessages,
  } = useMessages({
    spaceId,
    channelId,
    enabled: !!spaceId && !!channelId,
  });

  // Mutations
  const sendMessageMutation = useSendSpaceMessage();
  const sendEmbedMutation = useSendEmbedMessage();
  const addReactionMutation = useAddSpaceReaction();
  const removeReactionMutation = useRemoveSpaceReaction();
  const deleteMessageMutation = useDeleteSpaceMessage();
  const sendStickerMutation = useSendStickerMessage();
  const editSpaceMessageMutation = useEditSpaceMessage();
  const pinMessageMutation = usePinMessage();
  const unpinMessageMutation = useUnpinMessage();

  const { data: pinnedMessages } = usePinnedMessages(spaceId, channelId);
  // Chat → Farcaster cast: hypersnap-first with the user's signer, legacy
  // fallback on absence. Mention extraction is OFF — chat handles may
  // collide with Farcaster usernames and we don't want to false-tag.
  const { submitCast: submitFarcasterCast } = useFarcasterSubmitCast({
    token: farcasterAuthToken ?? undefined,
  });
  const { filteredMessages: filterMutedMessages } = useUserMuting(spaceId);

  // Linked Farcaster channels for this space-channel (local user pref).
  // For now we surface casts from the FIRST linked channel only; supporting
  // multiple is a follow-up that needs a flat-list aggregator.
  const linkedChannels = useEffectiveBindings(spaceId ?? '', channelId ?? '');
  const primaryLinkedChannel = linkedChannels[0];
  const { casts: farcasterCasts } = useFarcasterChannel({
    channelKey: primaryLinkedChannel ?? '',
    token: farcasterAuthToken ?? undefined,
    // Only fetch when we actually have an auth token — the Farcaster feed
    // endpoint rejects unauthenticated requests, so fetching without one
    // just burns retries and produces error logs.
    enabled: Boolean(primaryLinkedChannel) && Boolean(farcasterAuthToken),
  });
  // Members without a Farcaster account can't see casts (the upstream feed
  // API requires auth). Surface a banner so they know why the linked
  // channel produces nothing in chat instead of showing an empty void.
  const showFarcasterRequiredBanner = Boolean(primaryLinkedChannel) && !farcasterAuthToken;
  // The Spaces stack uses a translucent header on iOS — pad the banner
  // by the header height so it sits below the chrome instead of underneath.
  const headerHeight = useHeaderHeight();

  // Pre-compute the unique sender addresses we're about to render so
  // the public-profile fallback hook can fetch missing entries.
  const senderAddresses = useMemo(() => {
    if (!messagesPages) return [] as string[];
    const set = new Set<string>();
    for (const msg of flattenMessages(messagesPages.pages)) {
      const sid = (msg.content as { senderId?: string })?.senderId;
      if (sid) set.add(sid);
    }
    return Array.from(set);
  }, [messagesPages]);
  const effectiveMemberMap = useMembersWithPublicProfileFallback(memberMap, senderAddresses);

  // Message search
  //
  // Perf note: `toDisplayMessage` runs per message and isn't free
  // (member lookup, mention parsing, edit-history reduction, etc.). On
  // a busy channel every WS message arrival used to recompute *every*
  // DisplayMessage in the list, scaling O(messages) per inbound
  // message. We cache by Message reference + the member map / current
  // user identity so unchanged messages return the same DisplayMessage
  // instance — only the new/changed ones do actual work. The cache is
  // invalidated wholesale when effectiveMemberMap or user.address
  // changes ref (rare; effectiveMemberMap is stabilized in
  // useMembersWithPublicProfileFallback to only change when a query
  // result actually arrives).
  const displayCacheRef = useRef<{
    members: typeof effectiveMemberMap | null;
    user: string | undefined;
    byId: Map<string, { msg: Message; display: DisplayMessage }>;
  }>({ members: null, user: undefined, byId: new Map() });

  const messages = useMemo(() => {
    const cache = displayCacheRef.current;
    // Wholesale invalidate when member-map or user identity changes —
    // the rendered message text/avatar/displayName depend on these
    // and we can't tell from a single message id whether they shifted.
    if (cache.members !== effectiveMemberMap || cache.user !== user?.address) {
      cache.byId = new Map();
      cache.members = effectiveMemberMap;
      cache.user = user?.address;
    }

    const out: DisplayMessage[] = [];
    if (messagesPages) {
      const allMessages = flattenMessages(messagesPages.pages);
      if (spaceId && channelId) {
        const pinnedIds = getPinnedMessageIds(spaceId, channelId);
        if (pinnedIds.size > 0) {
          for (const msg of allMessages) {
            if (pinnedIds.has(msg.messageId)) {
              (msg as Message & { isPinned?: boolean }).isPinned = true;
            }
          }
        }
      }
      const seenIds = new Set<string>();
      for (const msg of allMessages) {
        seenIds.add(msg.messageId);
        const cached = cache.byId.get(msg.messageId);
        if (cached && cached.msg === msg) {
          // Same Message reference + same member/user context →
          // DisplayMessage is byte-identical. Reuse to keep
          // FlashList row identity stable.
          out.push(cached.display);
          continue;
        }
        const display = toDisplayMessage(msg, effectiveMemberMap, user?.address);
        cache.byId.set(msg.messageId, { msg, display });
        out.push(display);
      }
      // Drop entries for messages that have rolled off the cache so
      // the Map doesn't grow unboundedly during long sessions.
      if (cache.byId.size > seenIds.size + 32) {
        for (const id of cache.byId.keys()) {
          if (!seenIds.has(id)) cache.byId.delete(id);
        }
      }
    }
    // Inject linked-channel casts as DisplayMessages, sorted alongside chat
    // messages by timestamp so the stream is one continuous surface.
    if (primaryLinkedChannel && farcasterCasts.length > 0) {
      for (const cast of farcasterCasts) {
        out.push(castToDisplayMessage(cast, primaryLinkedChannel));
      }
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    // Drop 'unsupported' rows (no render branch) so they never reach the list.
    const supported = out.filter((m) => m.renderType !== 'unsupported');
    return filterMutedMessages(supported);
  }, [
    messagesPages,
    effectiveMemberMap,
    user?.address,
    filterMutedMessages,
    spaceId,
    channelId,
    pinnedMessages,
    primaryLinkedChannel,
    farcasterCasts,
  ]);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const spaceSearch = useMessageSearch(messages);

  // Find channel data
  const channels = useMemo((): DisplayChannel[] => {
    if (!spaceData) return [];
    return spaceData.groups.flatMap(g => g.channels.map(c => ({
      id: c.channelId,
      name: c.channelName,
      unread: false,
    })));
  }, [spaceData]);

  const channelsRef = useRef(channels);
  channelsRef.current = channels;

  const selectedChannelData = channels.find(c => c.id === channelId);

  // Draft management: save draft when channelId changes or unmount
  const prevChannelIdRef = useRef(channelId);
  useEffect(() => {
    if (prevChannelIdRef.current !== channelId) {
      // Save draft for previous channel
      const prevKey = spaceId && prevChannelIdRef.current
        ? `space:${spaceId}:${prevChannelIdRef.current}`
        : null;
      if (prevKey && messageText.trim()) {
        draftsRef.current.set(prevKey, messageText);
      } else if (prevKey) {
        draftsRef.current.delete(prevKey);
      }

      // Restore draft for new channel
      const newKey = spaceId && channelId ? `space:${spaceId}:${channelId}` : null;
      const draft = newKey ? (draftsRef.current.get(newKey) || '') : '';
      setMessageText(draft);
      setReplyToMessage(null);
      setEditingMessage(null);
      prevChannelIdRef.current = channelId;
    }
  }, [channelId, spaceId, draftsRef, messageText]);

  useEffect(() => {
    return () => {
      const key = spaceId && channelId ? `space:${spaceId}:${channelId}` : null;
      if (key && messageText.trim()) {
        draftsRef.current.set(key, messageText);
      } else if (key) {
        draftsRef.current.delete(key);
      }
    };
    // Unmount-only: messageText/spaceId/channelId read from closure at teardown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const key = spaceId && channelId ? `space:${spaceId}:${channelId}` : null;
    if (key) {
      const draft = draftsRef.current.get(key) || '';
      setMessageText(draft);
    }
    // Mount-only draft restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Callbacks
  const handleRefreshMessages = useCallback(() => {
    refetchMessages();
  }, [refetchMessages]);

  const handleLoadMoreMessages = useCallback(() => {
    if (hasMoreMessages) {
      fetchMoreMessages();
    }
  }, [fetchMoreMessages, hasMoreMessages]);

  const handleSendMessage = useCallback(() => {
    if (sendMessageMutation.isPending || sendEmbedMutation.isPending) return;
    if (!spaceId || !channelId) return;

    if (editingMessage && messageText.trim()) {
      const originalMessage = messagesRef.current.find(m => m.id === editingMessage.messageId);
      haptics.light();
      editSpaceMessageMutation.mutate({
        spaceId,
        channelId,
        messageId: editingMessage.messageId,
        newText: messageText.trim(),
        originalCreatedDate: originalMessage?.timestamp ?? Date.now(),
      });
      setMessageText('');
      setEditingMessage(null);
      return;
    }

    if (!messageText.trim() && !pendingAttachment) return;

    haptics.light();

    const refocusInput = () => {
      spaceMessagesListRef.current?.scrollToEnd(true);
      spaceMessageInputRef.current?.focus();
    };

    // Clear draft on send
    const draftKey = `space:${spaceId}:${channelId}`;
    draftsRef.current.delete(draftKey);

    if (pendingAttachment) {
      sendEmbedMutation.mutate({
        spaceId,
        channelId,
        imageUrl: pendingAttachment.imageUrl,
        thumbnailUrl: pendingAttachment.thumbnailUrl,
        width: pendingAttachment.width,
        height: pendingAttachment.height,
        isLargeGif: pendingAttachment.isLargeGif,
        text: messageText.trim() || undefined,
      }, {
        onSettled: refocusInput,
      });
      setPendingAttachment(null);
      setMessageText('');
      setReplyToMessage(null);
    } else if (messageText.trim()) {
      const text = messageText.trim();
      sendMessageMutation.mutate({
        spaceId,
        channelId,
        text,
        repliesToMessageId: replyToMessage?.messageId,
        replyToAuthorAddress: replyToMessage?.authorId,
        spaceChannels: channelsData?.map((c) => ({ channelId: c.channelId, channelName: c.channelName })),
      }, {
        onSettled: refocusInput,
      });

      // Optionally also post a Farcaster reply when the user opted in for
      // this specific send (toggle resets per reply target).
      if (alsoReplyOnFarcaster && isCastReply && replyCastHashRef.current && farcasterAuthToken) {
        const parentHash = replyCastHashRef.current;
        // No parent fid here — chat surfaces don't track the cast's
        // author. submitCast falls through to the legacy path which
        // accepts just the hash. The hypersnap path requires fid so
        // it'll be skipped, which is the safer behavior anyway for
        // chat-originated replies (no signed key consent at compose).
        const parentFid = replyParentFidRef.current;
        submitFarcasterCast({
          text,
          parent: parentFid != null
            ? { castHashHex: parentHash, fid: parentFid }
            : undefined,
          extractMentions: false,
        }).catch((err) => {
          logger.debug('[SpaceChatArea] Farcaster reply failed:', err);
        });
      }

      setMessageText('');
      setReplyToMessage(null);
      setAlsoReplyOnFarcaster(false);
      replyCastHashRef.current = null;
    }
  }, [messageText, spaceId, channelId, sendMessageMutation, sendEmbedMutation, pendingAttachment, replyToMessage, editingMessage, editSpaceMessageMutation, draftsRef, alsoReplyOnFarcaster, isCastReply, farcasterAuthToken]);

  const handleAttachmentPress = useCallback(async () => {
    const result = await pickImage('library');
    if (result.cancelled) return;
    if (!result.success) {
      if (result.error) Alert.alert('Error', result.error);
      return;
    }
    if (result.attachment) setPendingAttachment(result.attachment);
  }, []);

  const handleClearAttachment = useCallback(() => {
    setPendingAttachment(null);
  }, []);

  const handleReplyToMessage = useCallback((message: DisplayMessage) => {
    setReplyToMessage({
      messageId: message.id,
      senderName: message.userName,
      text: message.content,
      authorId: message.userId,
    });
    // Reset the cast-reply opt-in for each new reply target.
    setAlsoReplyOnFarcaster(false);
    // Capture the Farcaster cast hash + author fid if the user is
    // replying to an inline cast. Both are needed for the hypersnap
    // publish path; the legacy fallback uses hash only.
    replyCastHashRef.current = message.renderType === 'cast' && message.cast?.hash
      ? message.cast.hash
      : null;
    replyParentFidRef.current = message.renderType === 'cast' && message.cast?.author?.fid
      ? message.cast.author.fid
      : null;
    spaceMessageInputRef.current?.focus();
  }, []);

  const handleDismissReply = useCallback(() => {
    setReplyToMessage(null);
    setAlsoReplyOnFarcaster(false);
    replyCastHashRef.current = null;
    replyParentFidRef.current = null;
  }, []);

  const handleEditMessage = useCallback((message: DisplayMessage) => {
    setEditingMessage({
      messageId: message.id,
      originalText: message.content,
    });
    setMessageText(message.content);
    spaceMessageInputRef.current?.focus();
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingMessage(null);
    setMessageText('');
  }, []);

  const checkCanEditMessage = useCallback((message: DisplayMessage) => {
    return canEditMessage(message, user?.address);
  }, [user?.address]);

  const handleAddReaction = useCallback((messageId: string, emoji: string) => {
    if (!spaceId || !channelId) return;
    haptics.selection();
    addReactionMutation.mutate({ spaceId, channelId, messageId, emoji });
  }, [spaceId, channelId, addReactionMutation]);

  const handleRemoveReaction = useCallback((messageId: string, emoji: string) => {
    if (!spaceId || !channelId) return;
    haptics.selection();
    removeReactionMutation.mutate({ spaceId, channelId, messageId, emoji });
  }, [spaceId, channelId, removeReactionMutation]);

  const handleDeleteMessage = useCallback((messageId: string) => {
    if (!spaceId || !channelId) return;
    haptics.medium();
    deleteMessageMutation.mutate({ spaceId, channelId, messageId });
  }, [spaceId, channelId, deleteMessageMutation]);

  const handlePinMessage = useCallback((messageId: string) => {
    if (!spaceId || !channelId) return;
    haptics.light();
    pinMessageMutation.mutate({ spaceId, channelId, messageId });
  }, [spaceId, channelId, pinMessageMutation]);

  const handleUnpinMessage = useCallback((messageId: string) => {
    if (!spaceId || !channelId) return;
    haptics.light();
    unpinMessageMutation.mutate({ spaceId, channelId, messageId });
  }, [spaceId, channelId, unpinMessageMutation]);

  const handleSendSticker = useCallback((stickerId: string) => {
    if (!spaceId || !channelId) return;
    sendStickerMutation.mutate({ spaceId, channelId, stickerId });
  }, [spaceId, channelId, sendStickerMutation]);

  const canDeleteMessage = useCallback((message: DisplayMessage) => {
    if (!user?.address) return false;
    if (message.userId === user.address) return true;
    return hasDeletePermission;
  }, [user?.address, hasDeletePermission]);

  // Report flow. The action sheet item invokes this with the long-pressed
  // DisplayMessage; we stash the target shape and open the shared modal.
  // Casts in the chat stream report as 'cast' (they're public Farcaster
  // content); regular Quorum messages report as 'message' and the modal
  // re-encrypts the plaintext under a per-report key before submission.
  const [reportTarget, setReportTarget] = useState<
    | { type: 'cast'; castHash: string; castAuthorFid?: number }
    | { type: 'message'; plaintext: string; messageId: string; spaceId?: string; channelId?: string; senderAddress?: string }
    | null
  >(null);
  const handleReportMessage = useCallback((message: DisplayMessage) => {
    if (message.renderType === 'cast') {
      const cast = (message as DisplayMessage & { cast?: { hash?: string; author?: { fid?: number } } }).cast;
      if (!cast?.hash) return;
      setReportTarget({ type: 'cast', castHash: cast.hash, castAuthorFid: cast.author?.fid });
    } else {
      setReportTarget({
        type: 'message',
        plaintext: message.content,
        messageId: message.id,
        spaceId,
        channelId,
        senderAddress: message.userId,
      });
    }
  }, [spaceId, channelId]);

  const handleBookmarkMessage = useCallback((message: DisplayMessage) => {
    if (isBookmarked(message.id)) {
      const bookmark = bookmarks.find(b => b.messageId === message.id);
      if (bookmark) {
        removeBookmark(bookmark.bookmarkId);
      }
    } else {
      addBookmark({
        bookmarkId: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        messageId: message.id,
        spaceId,
        channelId,
        conversationId: selectedConversationId,
        sourceType: isDMsSelected ? 'dm' : 'channel',
        createdAt: Date.now(),
        cachedPreview: {
          senderAddress: message.userId,
          senderName: message.userName,
          textSnippet: message.content.slice(0, 100),
          messageDate: message.timestamp,
          sourceName: channelsRef.current.find(c => c.id === channelId)?.name || 'Channel',
          contentType: message.renderType === 'embed' ? 'image' : message.renderType === 'sticker' ? 'sticker' : 'text',
          imageUrl: message.imageUrl,
          stickerId: message.stickerId,
        },
      });
    }
  }, [isBookmarked, bookmarks, addBookmark, removeBookmark, spaceId, channelId, selectedConversationId, isDMsSelected]);

  const styles = useMemo(() => createStyles(theme), [theme]);

  // Keyboard avoidance is owned by the composer itself (it grows an animated
  // spacer that follows the keyboard), so the chat area is a plain flex column.
  return (
    <View style={styles.chatArea}>
      <View style={styles.chatAreaInner}>
        {spaceSearch.isSearchOpen && (
          <SearchBar
            query={spaceSearch.query}
            onChangeQuery={spaceSearch.setQuery}
            onClose={spaceSearch.closeSearch}
            resultCount={spaceSearch.resultCount}
            theme={theme}
          />
        )}

        {showFarcasterRequiredBanner && (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: Skin.space(8),
              paddingTop: Skin.space(10) + (Platform.OS === 'ios' ? headerHeight : 0),
              paddingBottom: Skin.space(10),
              paddingHorizontal: Skin.space(14),
              backgroundColor: theme.colors.surface2,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.colors.border ?? theme.colors.surface3,
            }}
          >
            <IconSymbol name="link" size={14} color={theme.colors.textMuted} />
            <Text
              style={{
                flex: 1,
                fontSize: Skin.font(13),
                color: theme.colors.textMuted,
                lineHeight: Skin.font(18),
              }}
            >
              {`Linked to /${primaryLinkedChannel}. Connect Farcaster in your profile to see casts here.`}
            </Text>
          </View>
        )}

        <MessagesList
          ref={spaceMessagesListRef}
          messages={spaceSearch.isSearchOpen && spaceSearch.query.trim().length > 0 ? spaceSearch.results.map(r => r.message) : messages}
          spaceId={spaceId}
          channelId={channelId}
          topInset={Platform.OS === 'ios' ? headerHeight : 0}
          theme={theme}
          isLoading={messagesLoading}
          isRefreshing={messagesRefetching}
          isLoadingMore={messagesFetchingMore}
          error={messagesError}
          onRefresh={handleRefreshMessages}
          onLoadMore={handleLoadMoreMessages}
          hasMore={!!hasMoreMessages}
          onJoinSpace={onJoinSpaceFromLink}
          onReaction={handleAddReaction}
          onRemoveReaction={handleRemoveReaction}
          customEmojis={spaceData?.emojis}
          stickers={spaceData?.stickers}
          onOpenFarcasterCast={onOpenFarcasterCast}
          onUserPress={onUserPress}
          onReply={handleReplyToMessage}
          onDelete={handleDeleteMessage}
          canDeleteMessage={canDeleteMessage}
          members={membersData}
          channels={channelsData}
          currentUserId={user?.address}
          onChannelLinkPress={onChannelLinkPress}
          onLinkPress={onLinkPress}
          onEdit={handleEditMessage}
          canEditMessage={checkCanEditMessage}
          onPin={handlePinMessage}
          onUnpin={handleUnpinMessage}
          canPinMessage={hasPinPermission}
          onBookmark={handleBookmarkMessage}
          isBookmarked={isBookmarked}
          onReport={handleReportMessage}
        />

        {!canPost && isReadOnlyChannel ? (
          <View style={styles.readOnlyBanner}>
            <IconSymbol name="lock.fill" size={16} color={theme.colors.textMuted} />
            <Text style={styles.readOnlyBannerText}>You cannot post in this channel</Text>
          </View>
        ) : (
          <MessageInput
            ref={spaceMessageInputRef}
            value={messageText}
            onChangeText={setMessageText}
            onSend={handleSendMessage}
            channelName={selectedChannelData?.name || 'general'}
            theme={theme}
            isSending={sendMessageMutation.isPending || sendEmbedMutation.isPending}
            onAttachmentPress={handleAttachmentPress}
            pendingAttachment={pendingAttachment}
            onClearAttachment={handleClearAttachment}
            bottomInset={0}
            bottomChromeHeight={tabBarHeight}
            replyTo={replyToMessage}
            onDismissReply={handleDismissReply}
            castReplyAvailable={isCastReply && Boolean(farcasterAuthToken)}
            alsoReplyOnFarcaster={alsoReplyOnFarcaster}
            onToggleAlsoReplyOnFarcaster={setAlsoReplyOnFarcaster}
            customEmojis={spaceData?.emojis}
            stickers={spaceData?.stickers}
            onSendSticker={handleSendSticker}
            members={membersData}
            channels={channelsData}
            editingMessage={editingMessage}
            onCancelEdit={handleCancelEdit}
            disabled={!canPost}
          />
        )}
      </View>

      {pinnedMessagesPanelVisible && (
        <PinnedMessagesPanel
          visible={pinnedMessagesPanelVisible}
          onClose={() => setPinnedMessagesPanelVisible(false)}
          pinnedMessages={(pinnedMessages ?? [])
            .map((msg: Message) => toDisplayMessage(msg, effectiveMemberMap, user?.address))
            .filter((m) => m.renderType !== 'unsupported')}
          onUnpin={hasPinPermission ? handleUnpinMessage : undefined}
          onNavigateToMessage={(messageId: string) => {
            spaceMessagesListRef.current?.scrollToMessage(messageId, true);
          }}
          canUnpin={hasPinPermission}
          theme={theme}
        />
      )}

      {bookmarksPanelVisible && (
        <BookmarksPanel
          visible={bookmarksPanelVisible}
          onClose={() => setBookmarksPanelVisible(false)}
          bookmarks={bookmarks}
          onRemoveBookmark={removeBookmark}
          onNavigateToBookmark={(bookmark) => {
            spaceMessagesListRef.current?.scrollToMessage(bookmark.messageId, true);
          }}
          theme={theme}
        />
      )}

      <ReportModal
        visible={!!reportTarget}
        onClose={() => setReportTarget(null)}
        target={reportTarget}
      />
    </View>
  );
});

const createStyles = (theme: AppTheme) => StyleSheet.create({
  chatArea: {
    flex: 1,
    flexDirection: 'column',
    backgroundColor: theme.colors.surface1,
  },
  chatAreaInner: {
    flex: 1,
    flexDirection: 'column',
    backgroundColor: theme.colors.surface1,
  },
  readOnlyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: theme.colors.surface2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  readOnlyBannerText: {
    fontSize: 14,
    color: theme.colors.textMuted,
  },
});
