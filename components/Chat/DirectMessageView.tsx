/**
 * DirectMessageView - Shows messages and input for a DM conversation
 */

import type { AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { MessagesList } from './MessagesList';
import { MessageInput } from './MessageInput';
import type { DisplayMessage } from './types';
import type { Conversation } from '@/hooks/chat/useConversations';
import * as Skin from '@/theme/skins/geometry';

interface DirectMessageViewProps {
  conversation: Conversation;
  messages: DisplayMessage[];
  onBack: () => void;
  onSendMessage: (text: string) => void;
  theme: AppTheme;
  isLoading?: boolean;
  isRefreshing?: boolean;
  isLoadingMore?: boolean;
  isSending?: boolean;
  error?: Error | null;
  onRefresh?: () => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  onRetryMessage?: (messageId: string) => void;
}

export function DirectMessageView({
  conversation,
  messages,
  onBack,
  onSendMessage,
  theme,
  isLoading = false,
  isRefreshing = false,
  isLoadingMore = false,
  isSending = false,
  error = null,
  onRefresh,
  onLoadMore,
  hasMore = false,
  onRetryMessage,
}: DirectMessageViewProps) {
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme, insets);
  const [messageText, setMessageText] = useState('');

  // Format display name - use displayName, or truncate address appropriately
  const displayName = useMemo(() => {
    if (conversation.displayName) return conversation.displayName;
    const addr = conversation.address;
    if (!addr) return 'Unknown';
    // Username format (@user)
    if (addr.startsWith('@')) return addr;
    // Base58 multihash - show first 8 and last 4 chars
    if (addr.length > 16) return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
    return addr;
  }, [conversation.displayName, conversation.address]);

  const handleSend = useCallback(() => {
    if (!messageText.trim()) return;
    onSendMessage(messageText.trim());
    setMessageText('');
  }, [messageText, onSendMessage]);

  // Keyboard avoidance is owned by the composer itself (it grows an animated
  // spacer that follows the keyboard), so the container is a plain flex column.
  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={onBack}>
          <IconSymbol name="chevron.left" size={24} color={theme.colors.textMain} />
        </TouchableOpacity>
        {conversation.icon ? (
          <Image source={{ uri: conversation.icon }} style={styles.headerAvatar} />
        ) : (
          <DefaultAvatar displayName={displayName} address={conversation.address || ''} size={40} />
        )}
        <View style={styles.headerInfo}>
          <Text style={styles.headerName} numberOfLines={1}>
            {displayName}
          </Text>
          {conversation.address && !conversation.address.startsWith('@') && (
            <Text style={styles.headerAddress} numberOfLines={1}>
              {conversation.address.length > 20
                ? `${conversation.address.slice(0, 12)}...${conversation.address.slice(-6)}`
                : conversation.address}
            </Text>
          )}
        </View>
      </View>

      {/* Messages */}
      <View style={styles.messagesContainer}>
        <MessagesList
          messages={messages}
          theme={theme}
          isLoading={isLoading}
          isRefreshing={isRefreshing}
          isLoadingMore={isLoadingMore}
          error={error}
          onRefresh={onRefresh}
          onLoadMore={onLoadMore}
          hasMore={hasMore}
          onRetryMessage={onRetryMessage}
        />
      </View>

      {/* Input */}
      <View style={styles.inputContainer}>
        <MessageInput
          value={messageText}
          onChangeText={setMessageText}
          onSend={handleSend}
          channelName={displayName}
          theme={theme}
          isSending={isSending}
        />
      </View>
    </View>
  );
}

const createStyles = (theme: AppTheme, insets: EdgeInsets) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.surface1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: insets.top + 8,
      paddingHorizontal: Skin.space(12),
      paddingBottom: Skin.space(12),
      backgroundColor: theme.colors.surface2,
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.surface3,
    },
    backButton: {
      padding: Skin.space(8),
      marginRight: Skin.space(8),
    },
    headerAvatar: {
      width: 40,
      height: 40,
      borderRadius: Skin.radius(20),
      backgroundColor: theme.colors.surface3,
    },
    headerInfo: {
      flex: 1,
      marginLeft: Skin.space(12),
    },
    headerName: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textStrong,
    },
    headerAddress: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      marginTop: Skin.space(2),
    },
    messagesContainer: {
      flex: 1,
    },
    inputContainer: {
      paddingBottom: insets.bottom,
    },
  });

export default DirectMessageView;
