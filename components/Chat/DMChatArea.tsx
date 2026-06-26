/**
 * DMChatArea - Extracted DM chat component
 *
 * Owns all DM-chat-specific state (messageText, pendingAttachment, etc.)
 * so that keystrokes in the message input only re-render this subtree,
 * not the entire HomeScreen/sidebars.
 */

import type { AppTheme } from '@/theme';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useHeaderHeight } from '@react-navigation/elements';
import { ChatBottomChrome, useChatListBottomInset } from './ChatBottomChrome';

import {
  DMChatHeader,
  MessageInput,
  MessagesList,
  BookmarksPanel,
  SearchBar,
  toDisplayMessage,
} from '@/components/Chat';
import type {
  DisplayMessage,
  MemberMap,
  MessageInputHandle,
  MessagesListHandle,
  EditingMessage,
  MessageUserInfo,
} from '@/components/Chat';

import { useAuth } from '@/context';
import { useToast } from '@/context/ToastContext';
import { flattenMessages, useMessages } from '@/hooks/chat/useMessages';
import { useMembersWithPublicProfileFallback } from '@/hooks/useMembersWithPublicProfileFallback';
import { useSendDirectMessage } from '@/hooks/chat/useSendDirectMessage';
import { useSendDirectEmbedMessage } from '@/hooks/chat/useSendDirectEmbedMessage';
import { useSendDirectReaction, useRemoveDirectReaction } from '@/hooks/chat/useSendDirectReaction';
import { useEditDirectMessage } from '@/hooks/chat/useEditDirectMessage';
import { useDeleteDirectMessage } from '@/hooks/chat/useDeleteDirectMessage';
import { canEditMessage } from '@/hooks/chat/useEditSpaceMessage';
import { toRecipientInfo, useHasEncryptionSession, useRecipientRegistration } from '@/hooks/chat/useRecipientRegistration';
import { useMessageSearch } from '@/hooks/chat/useMessageSearch';
import { pickImage, type ProcessedAttachment } from '@/services/media/imageAttachment';
import { haptics } from '@/utils/haptics';
import { ReportModal } from '@/components/ReportModal';
import type { Conversation } from '@/hooks/chat/useConversations';
import type { Message } from '@quilibrium/quorum-shared';
import type { Bookmark } from '@quilibrium/quorum-shared';

interface DMChatAreaProps {
  conversationId: string;
  conversationData: Conversation;
  isFarcasterConversation: boolean;
  recipientAddress: string | undefined;
  onShowSidebars: () => void;
  onUserPress: (userInfo: MessageUserInfo) => void;
  onLinkPress: (url: string) => void;
  onOpenFarcasterCast: (username: string, castHashPrefix: string) => void;
  onJoinSpaceFromLink: (spaceId: string, channelId: string) => void;
  onOpenDmSettings: () => void;
  onCallPress?: () => void;
  onVideoCallPress?: () => void;
  bookmarks: Bookmark[];
  isBookmarked: (messageId: string) => boolean;
  addBookmark: (bookmark: Bookmark) => void;
  removeBookmark: (bookmarkId: string) => void;
  /** Effective tab-bar height (0 while the emoji panel is open) — sizes the
   *  bottom fade and the list content inset. */
  tabBarHeight?: number;
  /** Raw, stable tab-bar height (NOT zeroed on panel open) — the resting
   *  clearance the composer's spacer holds so the pill floats above the bar. */
  restingChromeHeight?: number;
  theme: AppTheme;
  draftsRef: React.MutableRefObject<Map<string, string>>;
}

export const DMChatArea = React.memo(function DMChatArea({
  conversationId,
  conversationData,
  isFarcasterConversation,
  recipientAddress,
  onShowSidebars,
  onUserPress,
  onLinkPress,
  onOpenFarcasterCast,
  onJoinSpaceFromLink,
  onOpenDmSettings,
  onCallPress,
  onVideoCallPress,
  bookmarks,
  isBookmarked,
  addBookmark,
  removeBookmark,
  tabBarHeight = 0,
  restingChromeHeight = 0,
  theme,
  draftsRef,
}: DMChatAreaProps) {
  const { user } = useAuth();
  const { showToast } = useToast();

  // Local state
  const [messageText, setMessageText] = useState('');
  const [pendingAttachment, setPendingAttachment] = useState<ProcessedAttachment | null>(null);
  const [replyToMessage, setReplyToMessage] = useState<{ messageId: string; senderName: string; text: string; authorId: string } | null>(null);
  const [editingMessage, setEditingMessage] = useState<EditingMessage | null>(null);
  const [bookmarksPanelVisible, setBookmarksPanelVisible] = useState(false);
  // Per-message signing lock; only meaningful when the conversation is repudiable.
  const [skipSigning, setSkipSigning] = useState(false);

  const dmMessagesListRef = useRef<MessagesListHandle>(null);
  const dmMessageInputRef = useRef<MessageInputHandle>(null);
  const headerHeight = useHeaderHeight();

  // Data hooks
  const {
    data: dmMessagesPages,
    isLoading: dmMessagesLoading,
    isRefetching: dmMessagesRefetching,
    isFetchingNextPage: dmMessagesFetchingMore,
    error: dmMessagesError,
    refetch: refetchDmMessages,
    fetchNextPage: fetchMoreDmMessages,
    hasNextPage: hasMoreDmMessages,
  } = useMessages({
    spaceId: recipientAddress,
    channelId: recipientAddress,
    enabled: !!recipientAddress,
  });

  // Mutations
  const sendDirectMessageMutation = useSendDirectMessage();
  const sendDirectEmbedMutation = useSendDirectEmbedMessage();
  const addDirectReactionMutation = useSendDirectReaction();
  const removeDirectReactionMutation = useRemoveDirectReaction();
  const editDirectMessageMutation = useEditDirectMessage();
  const deleteDirectMessageMutation = useDeleteDirectMessage();

  // Encryption
  const { data: recipientRegistration } = useRecipientRegistration(recipientAddress);
  const hasExistingSession = useHasEncryptionSession(conversationId);

  // Build the local member map (just the two participants in a DM).
  const dmMemberMap = useMemo<MemberMap>(() => {
    const map: MemberMap = {};
    if (conversationData) {
      map[conversationData.address ?? ''] = {
        address: conversationData.address ?? '',
        display_name: conversationData.displayName,
        profile_image: conversationData.icon,
      } as MemberMap[string];
    }
    if (user?.address) {
      map[user.address] = {
        address: user.address,
        display_name: user.displayName || user.username,
        profile_image: user.profileImage,
      } as MemberMap[string];
    }
    return map;
  }, [conversationData, user]);

  // Back-fill empty entries (e.g. recipient hasn't been observed yet)
  // from the public-profile endpoint.
  const dmVisibleAddresses = useMemo(
    () => Object.keys(dmMemberMap),
    [dmMemberMap],
  );
  const effectiveDmMemberMap = useMembersWithPublicProfileFallback(dmMemberMap, dmVisibleAddresses);

  // Messages
  const dmMessages = useMemo(() => {
    if (!dmMessagesPages) return [];
    const allMessages = flattenMessages(dmMessagesPages.pages);
    // Drop 'unsupported' rows (no render branch) so they never reach the list.
    return allMessages
      .map((msg: Message) => toDisplayMessage(msg, effectiveDmMemberMap, user?.address))
      .filter((m) => m.renderType !== 'unsupported');
  }, [dmMessagesPages, effectiveDmMemberMap, user?.address]);

  const dmSearch = useMessageSearch(dmMessages);

  // Draft management
  const prevConversationIdRef = useRef(conversationId);
  useEffect(() => {
    if (prevConversationIdRef.current !== conversationId) {
      // Save draft for previous conversation
      const prevKey = `dm:${prevConversationIdRef.current}`;
      if (messageText.trim()) {
        draftsRef.current.set(prevKey, messageText);
      } else {
        draftsRef.current.delete(prevKey);
      }

      // Restore draft for new conversation
      const newKey = `dm:${conversationId}`;
      const draft = draftsRef.current.get(newKey) || '';
      setMessageText(draft);
      setReplyToMessage(null);
      setEditingMessage(null);
      prevConversationIdRef.current = conversationId;
    }
  }, [conversationId, draftsRef, messageText]);

  // Save draft on unmount
  useEffect(() => {
    return () => {
      const key = `dm:${conversationId}`;
      if (messageText.trim()) {
        draftsRef.current.set(key, messageText);
      } else {
        draftsRef.current.delete(key);
      }
    };
    // Unmount-only: messageText/conversationId read from closure at teardown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const key = `dm:${conversationId}`;
    const draft = draftsRef.current.get(key) || '';
    setMessageText(draft);
    // Mount-only draft restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Callbacks
  const handleRefreshDmMessages = useCallback(() => {
    refetchDmMessages();
  }, [refetchDmMessages]);

  const handleLoadMoreDmMessages = useCallback(() => {
    if (hasMoreDmMessages) {
      fetchMoreDmMessages();
    }
  }, [hasMoreDmMessages, fetchMoreDmMessages]);

  const handleSendDirectMessage = useCallback(() => {
    if (sendDirectMessageMutation.isPending || sendDirectEmbedMutation.isPending) return;
    if (!conversationId || !recipientAddress) return;

    if (editingMessage && messageText.trim()) {
      const allDmMsgs = dmMessagesPages ? flattenMessages(dmMessagesPages.pages) : [];
      const originalMsg = allDmMsgs.find(m => m.messageId === editingMessage.messageId);
      haptics.light();
      editDirectMessageMutation.mutate({
        conversationId,
        recipientAddress,
        messageId: editingMessage.messageId,
        newText: messageText.trim(),
        originalCreatedDate: originalMsg?.createdDate ?? Date.now(),
      });
      setMessageText('');
      setEditingMessage(null);
      return;
    }

    if (!messageText.trim() && !pendingAttachment) return;

    haptics.light();

    const recipientInfo = !hasExistingSession && recipientRegistration
      ? toRecipientInfo(recipientRegistration) ?? undefined
      : undefined;

    const refocusInput = () => {
      dmMessagesListRef.current?.scrollToEnd(true);
      dmMessageInputRef.current?.focus();
    };

    // Clear draft on send
    const draftKey = `dm:${conversationId}`;
    draftsRef.current.delete(draftKey);

    if (pendingAttachment) {
      sendDirectEmbedMutation.mutate({
        conversationId,
        recipientAddress,
        imageUrl: pendingAttachment.imageUrl,
        thumbnailUrl: pendingAttachment.thumbnailUrl,
        width: pendingAttachment.width,
        height: pendingAttachment.height,
        text: messageText.trim() || undefined,
        recipientInfo,
        isRepudiable: conversationData.isRepudiable,
        skipSigning,
      }, {
        onSettled: refocusInput,
      });
      setPendingAttachment(null);
      setMessageText('');
      setReplyToMessage(null);
    } else if (messageText.trim()) {
      sendDirectMessageMutation.mutate({
        conversationId,
        recipientAddress,
        text: messageText.trim(),
        repliesToMessageId: replyToMessage?.messageId,
        replyToAuthorAddress: replyToMessage?.authorId,
        recipientInfo,
        isRepudiable: conversationData.isRepudiable,
        skipSigning,
      }, {
        onSettled: refocusInput,
      });
      setMessageText('');
      setReplyToMessage(null);
    }
  }, [conversationId, recipientAddress, sendDirectMessageMutation, sendDirectEmbedMutation, hasExistingSession, recipientRegistration, messageText, pendingAttachment, replyToMessage, editingMessage, editDirectMessageMutation, dmMessagesPages, draftsRef, conversationData.isRepudiable, skipSigning]);

  const handleAttachmentPress = useCallback(async () => {
    const result = await pickImage('library');
    if (result.cancelled) return;
    if (!result.success) {
      if (result.error) {
        showToast({ type: 'error', title: 'Attachment Failed', message: result.error });
      }
      return;
    }
    if (result.attachment) setPendingAttachment(result.attachment);
  }, [showToast]);

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
    dmMessageInputRef.current?.focus();
  }, []);

  const handleDismissReply = useCallback(() => {
    setReplyToMessage(null);
  }, []);

  const handleEditMessage = useCallback((message: DisplayMessage) => {
    setEditingMessage({
      messageId: message.id,
      originalText: message.content,
    });
    setMessageText(message.content);
    dmMessageInputRef.current?.focus();
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingMessage(null);
    setMessageText('');
  }, []);

  const checkCanEditMessage = useCallback((message: DisplayMessage) => {
    return canEditMessage(message, user?.address);
  }, [user?.address]);

  // DM messages are E2E-encrypted, so deletion is local-only and you can only
  // remove your own messages. The confirm dialog lives in MessageActionSheet.
  const checkCanDeleteMessage = useCallback((message: DisplayMessage) => {
    return !!user?.address && message.userId === user.address;
  }, [user?.address]);

  const handleDeleteMessage = useCallback((messageId: string) => {
    if (!conversationId || !recipientAddress) return;
    deleteDirectMessageMutation.mutate({ conversationId, recipientAddress, messageId });
  }, [conversationId, recipientAddress, deleteDirectMessageMutation]);

  const handleAddReaction = useCallback((messageId: string, emoji: string) => {
    if (!conversationId || !recipientAddress) return;
    haptics.selection();
    addDirectReactionMutation.mutate({
      conversationId,
      recipientAddress,
      targetMessageId: messageId,
      reaction: emoji,
    });
  }, [conversationId, recipientAddress, addDirectReactionMutation]);

  const handleRemoveReaction = useCallback((messageId: string, emoji: string) => {
    if (!conversationId || !recipientAddress) return;
    haptics.selection();
    removeDirectReactionMutation.mutate({
      conversationId,
      recipientAddress,
      targetMessageId: messageId,
      reaction: emoji,
    });
  }, [conversationId, recipientAddress, removeDirectReactionMutation]);

  // Report flow — see SpaceChatArea for details. DMs report as 'message'
  // type with conversationId set; cast embeds in DMs report as 'cast'.
  const [reportTarget, setReportTarget] = useState<
    | { type: 'cast'; castHash: string; castAuthorFid?: number }
    | { type: 'message'; plaintext: string; messageId: string; conversationId?: string; senderAddress?: string }
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
        conversationId,
        senderAddress: message.userId,
      });
    }
  }, [conversationId]);

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
        conversationId,
        sourceType: 'dm',
        createdAt: Date.now(),
        cachedPreview: {
          senderAddress: message.userId,
          senderName: message.userName,
          textSnippet: message.content.slice(0, 100),
          messageDate: message.timestamp,
          sourceName: conversationData?.displayName || 'DM',
          contentType: message.renderType === 'embed' ? 'image' : message.renderType === 'sticker' ? 'sticker' : 'text',
          imageUrl: message.imageUrl,
          stickerId: message.stickerId,
        },
      });
    }
  }, [isBookmarked, bookmarks, addBookmark, removeBookmark, conversationId, conversationData]);

  const styles = useMemo(() => createStyles(theme), [theme]);

  // Bottom content padding so the newest message rests above the floating
  // composer; the composer + fade layout itself lives in ChatBottomChrome.
  const listBottomInset = useChatListBottomInset(tabBarHeight);

  // Keyboard avoidance is owned by the composer itself (it grows an animated
  // spacer that follows the keyboard). The composer floats over the bottom of
  // the list so messages scroll behind it (Telegram-style); the list pads its
  // content to clear the composer's resting footprint.
  return (
    <View style={styles.chatArea}>
      {dmSearch.isSearchOpen && (
        <SearchBar
          query={dmSearch.query}
          onChangeQuery={dmSearch.setQuery}
          onClose={dmSearch.closeSearch}
          resultCount={dmSearch.resultCount}
          theme={theme}
        />
      )}

      <MessagesList
        ref={dmMessagesListRef}
        messages={dmSearch.isSearchOpen && dmSearch.query.trim().length > 0 ? dmSearch.results.map(r => r.message) : dmMessages}
        currentUserId={user?.address}
        topInset={Platform.OS === 'ios' ? headerHeight : 0}
        bottomInset={listBottomInset}
        theme={theme}
        isLoading={dmMessagesLoading}
        isRefreshing={dmMessagesRefetching}
        isLoadingMore={dmMessagesFetchingMore}
        error={dmMessagesError}
        onRefresh={handleRefreshDmMessages}
        onLoadMore={handleLoadMoreDmMessages}
        hasMore={!!hasMoreDmMessages}
        onJoinSpace={onJoinSpaceFromLink}
        onReaction={handleAddReaction}
        onRemoveReaction={handleRemoveReaction}
        onOpenFarcasterCast={onOpenFarcasterCast}
        onUserPress={onUserPress}
        onReply={handleReplyToMessage}
        onLinkPress={onLinkPress}
        onEdit={handleEditMessage}
        canEditMessage={checkCanEditMessage}
        onDelete={handleDeleteMessage}
        canDeleteMessage={checkCanDeleteMessage}
        onBookmark={handleBookmarkMessage}
        isBookmarked={isBookmarked}
        onReport={handleReportMessage}
        isDM
      />

      <ChatBottomChrome tabBarHeight={tabBarHeight} surfaceColor={theme.colors.surface1} isDark={theme.dark}>
        <MessageInput
          ref={dmMessageInputRef}
          value={messageText}
          onChangeText={setMessageText}
          onSend={handleSendDirectMessage}
          channelName={conversationData.displayName || conversationData.address?.slice(0, 8) || 'DM'}
          isDM
          theme={theme}
          isSending={sendDirectMessageMutation.isPending || sendDirectEmbedMutation.isPending}
          onAttachmentPress={handleAttachmentPress}
          pendingAttachment={pendingAttachment}
          onClearAttachment={handleClearAttachment}
          bottomInset={0}
          restingChromeHeight={restingChromeHeight}
          replyTo={replyToMessage}
          onDismissReply={handleDismissReply}
          editingMessage={editingMessage}
          onCancelEdit={handleCancelEdit}
          signingOptional={!!conversationData.isRepudiable}
          skipSigning={skipSigning}
          onToggleSkipSigning={() => setSkipSigning((s) => !s)}
        />
      </ChatBottomChrome>

      {bookmarksPanelVisible && (
        <BookmarksPanel
          visible={bookmarksPanelVisible}
          onClose={() => setBookmarksPanelVisible(false)}
          bookmarks={bookmarks}
          onRemoveBookmark={removeBookmark}
          onNavigateToBookmark={(bookmark) => {
            dmMessagesListRef.current?.scrollToMessage(bookmark.messageId, true);
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
});
