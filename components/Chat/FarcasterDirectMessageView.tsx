/**
 * FarcasterDirectMessageView - Shows Farcaster direct cast messages
 * Matches the structure of the regular DM view in index.tsx
 */

import type { AppTheme } from '@/theme';
import React, { useCallback, useMemo, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  Dimensions,
  Alert,
} from 'react-native';
import { DMChatHeader } from './DMChatHeader';
import { MessagesList } from './MessagesList';
import { MessageInput, type MessageInputHandle, type ReplyToMessage } from './MessageInput';
import { directCastToDisplayMessage, type DisplayMessage } from './types';
import type { Conversation } from '@quilibrium/quorum-shared';
import {
  useFarcasterDirectCastMessages,
  useSendFarcasterDirectCast,
  useMarkFarcasterConversationRead,
  useAddFarcasterDirectCastReaction,
  useRemoveFarcasterDirectCastReaction,
} from '@/hooks/chat';
import { useAuth } from '@/context/AuthContext';
import { pickImage, type ProcessedAttachment } from '@/services/media/imageAttachment';
import { uploadFarcasterImage, type DirectCastMessageMetadata, type DirectCastMessage } from '@/services/farcasterClient';
import * as Skin from '@/theme/skins/geometry';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Farcaster logo
const FarcasterLogo = require('@/assets/images/farcaster.png');

interface FarcasterDirectMessageViewProps {
  conversation: Conversation;
  onBack: () => void;
  theme: AppTheme;
  onOpenFarcasterCast?: (username: string, castHashPrefix: string) => void;
  onLinkPress?: (url: string) => void;
  bottomInset?: number;
  tabBarHeight?: number;
}

export function FarcasterDirectMessageView({
  conversation,
  onBack,
  theme,
  onOpenFarcasterCast,
  onLinkPress,
  bottomInset = 0,
  tabBarHeight = 0,
}: FarcasterDirectMessageViewProps) {
  const { user, farcasterAuthToken } = useAuth();
  const currentUserFid = user?.farcaster?.fid;
  const [messageText, setMessageText] = useState('');
  const [replyTo, setReplyTo] = useState<ReplyToMessage | null>(null);
  const [pendingAttachment, setPendingAttachment] = useState<ProcessedAttachment | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const messageInputRef = useRef<MessageInputHandle>(null);

  // Fetch messages for this Farcaster conversation
  const messagesQuery = useFarcasterDirectCastMessages(conversation.conversationId);
  const sendMutation = useSendFarcasterDirectCast();
  const markReadMutation = useMarkFarcasterConversationRead();
  const addReactionMutation = useAddFarcasterDirectCastReaction();
  const removeReactionMutation = useRemoveFarcasterDirectCastReaction();

  // Convert DirectCastMessages to DisplayMessages.
  // The query polls every few seconds and React Query's structural sharing
  // keeps *unchanged* message objects referentially stable. We exploit that:
  //  - reuse the prior DisplayMessage for any source message whose ref is
  //    unchanged (per-message cache), and
  //  - if NONE changed, return the exact same array reference,
  // so an idle poll produces no new objects and downstream memoized
  // consumers (MessagesList) skip re-rendering — which is what was churning
  // render memory every 3s on large/long conversations.
  const dmCacheRef = useRef(new Map<DirectCastMessage, DisplayMessage>());
  const prevResultRef = useRef<DisplayMessage[]>([]);
  const prevSourceRef = useRef<DirectCastMessage[]>([]);
  const displayMessages = useMemo(() => {
    const allMessages = messagesQuery.data?.pages.flatMap((page) => page.messages) ?? [];
    const unchanged =
      allMessages.length === prevSourceRef.current.length &&
      allMessages.every((m, i) => m === prevSourceRef.current[i]);
    if (unchanged && prevResultRef.current.length) return prevResultRef.current;

    const nextCache = new Map<DirectCastMessage, DisplayMessage>();
    // Farcaster returns messages newest first; we need oldest first for chat.
    const reversed = [...allMessages].reverse();
    const result = reversed.map((msg) => {
      const cached = dmCacheRef.current.get(msg);
      const dm = cached ?? directCastToDisplayMessage(msg, currentUserFid);
      nextCache.set(msg, dm);
      return dm;
    });
    dmCacheRef.current = nextCache; // drop entries for messages no longer present
    prevSourceRef.current = allMessages;
    prevResultRef.current = result;
    return result;
  }, [messagesQuery.data, currentUserFid]);

  // Mark as read when viewing
  React.useEffect(() => {
    if (conversation.unreadCount && conversation.unreadCount > 0) {
      markReadMutation.mutate(conversation.conversationId);
    }
  }, [conversation.conversationId, conversation.unreadCount]);

  const handleAttachmentPress = useCallback(async () => {
    const result = await pickImage('library');

    if (result.cancelled) {
      return;
    }

    if (!result.success || !result.attachment) {
      if (result.error) {
        Alert.alert('Error', result.error);
      }
      return;
    }

    setPendingAttachment(result.attachment);
  }, []);

  const handleClearAttachment = useCallback(() => {
    setPendingAttachment(null);
  }, []);

  const handleSendMessage = useCallback(async () => {
    // Prevent double-tap while sending
    if (sendMutation.isPending || isUploading) return;

    // Use farcasterParticipantFids for group chats, fall back to single fid for 1:1
    const recipientFids = conversation.farcasterParticipantFids?.length
      ? conversation.farcasterParticipantFids
      : conversation.farcasterFid
        ? [conversation.farcasterFid]
        : [];

    const hasText = messageText.trim().length > 0;
    const hasAttachment = !!pendingAttachment;

    if ((!hasText && !hasAttachment) || recipientFids.length === 0) return;

    try {
      let finalMessage = messageText.trim();
      let metadata: DirectCastMessageMetadata | undefined;

      // If we have an attachment, upload it first
      if (pendingAttachment && farcasterAuthToken) {
        setIsUploading(true);

        try {
          const imageUrl = await uploadFarcasterImage({
            token: farcasterAuthToken,
            uri: pendingAttachment.localUri,
            name: 'direct-cast-image',
            mimeType: pendingAttachment.mimeType,
          });

          if (!imageUrl) {
            throw new Error('Failed to upload image');
          }

          // Build message with image URL (matching Farcaster format)
          finalMessage = hasText ? `${imageUrl} ${finalMessage}` : imageUrl;

          // Build metadata
          metadata = {
            medias: [{
              height: pendingAttachment.height,
              width: pendingAttachment.width,
              staticRaster: imageUrl,
              version: '2',
            }],
          };
        } catch (uploadError) {
          Alert.alert('Upload Failed', 'Failed to upload image. Please try again.');
          setIsUploading(false);
          return;
        }
      }

      sendMutation.mutate({
        conversationId: conversation.conversationId,
        recipientFids,
        message: finalMessage,
        inReplyToId: replyTo?.messageId,
        metadata,
      });

      setMessageText('');
      setReplyTo(null);
      setPendingAttachment(null);
    } finally {
      setIsUploading(false);
    }
  }, [conversation, messageText, sendMutation, replyTo, pendingAttachment, farcasterAuthToken, isUploading]);

  const handleReply = useCallback((message: DisplayMessage) => {
    setReplyTo({
      messageId: message.id,
      senderName: message.userName,
      text: message.content,
    });
    // Focus the input when replying
    messageInputRef.current?.focus();
  }, []);

  const handleDismissReply = useCallback(() => {
    setReplyTo(null);
  }, []);

  const handleRefresh = useCallback(async () => {
    await messagesQuery.refetch();
  }, [messagesQuery]);

  const handleLoadMore = useCallback(() => {
    if (messagesQuery.hasNextPage) {
      messagesQuery.fetchNextPage();
    }
  }, [messagesQuery]);

  const handleAddReaction = useCallback((messageId: string, emoji: string) => {
    addReactionMutation.mutate({
      conversationId: conversation.conversationId,
      messageId,
      reaction: emoji,
    });
  }, [conversation.conversationId, addReactionMutation]);

  const handleRemoveReaction = useCallback((messageId: string, emoji: string) => {
    removeReactionMutation.mutate({
      conversationId: conversation.conversationId,
      messageId,
      reaction: emoji,
    });
  }, [conversation.conversationId, removeReactionMutation]);

  const styles = createStyles(theme);

  const displayName = conversation.displayName ||
    (conversation.farcasterUsername ? `@${conversation.farcasterUsername}` : 'Unknown');

  // Keyboard avoidance is owned by the composer itself (it grows an animated
  // spacer that follows the keyboard), so the container is a plain flex column.
  return (
    <View style={styles.container}>
      {/* Security warning banner */}
      <View style={styles.warningBanner}>
        <Image source={FarcasterLogo} style={styles.warningIcon} />
        <Text style={styles.warningText}>
          Farcaster messages are not end-to-end encrypted
        </Text>
      </View>

      <MessagesList
        messages={displayMessages}
        theme={theme}
        isLoading={messagesQuery.isLoading}
        isRefreshing={messagesQuery.isRefetching}
        isLoadingMore={messagesQuery.isFetchingNextPage}
        error={messagesQuery.error}
        onRefresh={handleRefresh}
        onLoadMore={handleLoadMore}
        hasMore={!!messagesQuery.hasNextPage}
        onReaction={handleAddReaction}
        onRemoveReaction={handleRemoveReaction}
        onReply={handleReply}
        onOpenFarcasterCast={onOpenFarcasterCast}
        onLinkPress={onLinkPress}
      />

      <MessageInput
        ref={messageInputRef}
        value={messageText}
        onChangeText={setMessageText}
        onSend={handleSendMessage}
        channelName={displayName}
        theme={theme}
        isSending={sendMutation.isPending || isUploading}
        replyTo={replyTo}
        onDismissReply={handleDismissReply}
        onAttachmentPress={handleAttachmentPress}
        pendingAttachment={pendingAttachment}
        onClearAttachment={handleClearAttachment}
        bottomInset={bottomInset}
      />
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      flexDirection: 'column',
    },
    warningBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#8B5CF6' + '20', // Farcaster purple with opacity
      paddingVertical: Skin.space(6),
      paddingHorizontal: Skin.space(12),
      gap: Skin.space(8),
      width: SCREEN_WIDTH,
    },
    warningIcon: {
      width: 14,
      height: 14,
      tintColor: '#8B5CF6',
    },
    warningText: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.regular.fontFamily,
      color: '#8B5CF6',
    },
  });

export default FarcasterDirectMessageView;
