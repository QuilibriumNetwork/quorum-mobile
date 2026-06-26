/**
 * PinnedMessagesPanel - Modal showing pinned messages for a channel
 */

import type { AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { BaseModal } from '@/components/shared/BaseModal';
import { formatTime } from './types';
import type { DisplayMessage } from './types';
import * as Skin from '@/theme/skins/geometry';

interface PinnedMessagesPanelProps {
  visible: boolean;
  onClose: () => void;
  pinnedMessages: DisplayMessage[];
  onUnpin?: (messageId: string) => void;
  onNavigateToMessage?: (messageId: string) => void;
  canUnpin?: boolean;
  theme: AppTheme;
}

export const PinnedMessagesPanel = React.memo(function PinnedMessagesPanel({
  visible,
  onClose,
  pinnedMessages,
  onUnpin,
  onNavigateToMessage,
  canUnpin = false,
  theme,
}: PinnedMessagesPanelProps) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.65} fillHeight>
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <IconSymbol name="pin.fill" size={18} color={theme.colors.primary} />
            <Text style={styles.headerTitle}>
              Pinned Messages ({pinnedMessages.length})
            </Text>
          </View>
        </View>

        {pinnedMessages.length === 0 ? (
        <View style={styles.emptyState}>
          <IconSymbol name="pin" size={36} color={theme.colors.textMuted} />
          <Text style={styles.emptyText}>No pinned messages</Text>
          <Text style={styles.emptySubtext}>
            Pin important messages so they're easy to find
          </Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {pinnedMessages.map((msg) => (
            <TouchableOpacity
              key={msg.id}
              style={styles.pinnedMessage}
              onPress={() => {
                onNavigateToMessage?.(msg.id);
                onClose();
              }}
              activeOpacity={0.7}
            >
              <View style={styles.messageHeader}>
                <Text style={styles.messageSender} numberOfLines={1}>
                  {msg.userName}
                </Text>
                <Text style={styles.messageTime}>
                  {formatTime(msg.timestamp)}
                </Text>
              </View>
              <Text style={styles.messageContent} numberOfLines={3}>
                {msg.content}
              </Text>
              {canUnpin && onUnpin && (
                <TouchableOpacity
                  style={styles.unpinButton}
                  onPress={(e) => {
                    e.stopPropagation();
                    onUnpin(msg.id);
                  }}
                  hitSlop={8}
                >
                  <IconSymbol name="pin.slash" size={14} color={theme.colors.textMuted} />
                  <Text style={styles.unpinText}>Unpin</Text>
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
      </View>
    </BaseModal>
  );
});

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Skin.space(20),
      paddingVertical: Skin.space(12),
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.border ?? theme.colors.surface3,
    },
    headerLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
    },
    headerTitle: {
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textStrong,
    },
    emptyState: {
      alignItems: 'center',
      paddingVertical: Skin.space(40),
      paddingHorizontal: Skin.space(32),
    },
    emptyText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
      marginTop: Skin.space(12),
    },
    emptySubtext: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textSubtle,
      textAlign: 'center',
      marginTop: Skin.space(4),
    },
    scrollView: {
      flex: 1,
    },
    scrollContent: {
      padding: Skin.space(12),
    },
    pinnedMessage: {
      backgroundColor: theme.colors.surface3 ?? theme.colors.surface2,
      borderRadius: Skin.radius(10),
      padding: Skin.space(12),
      marginBottom: Skin.space(8),
    },
    messageHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: Skin.space(4),
    },
    messageSender: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textStrong,
      flex: 1,
    },
    messageTime: {
      fontSize: Skin.font(11),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textSubtle,
      marginLeft: Skin.space(8),
    },
    messageContent: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
      lineHeight: Skin.font(20),
    },
    unpinButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(4),
      marginTop: Skin.space(8),
      paddingTop: Skin.space(8),
      borderTopWidth: Skin.border(1),
      borderTopColor: theme.colors.border ?? theme.colors.surface5,
    },
    unpinText: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textSubtle,
    },
  });

export default PinnedMessagesPanel;
