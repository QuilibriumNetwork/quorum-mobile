/**
 * ShareInviteSheet — intermediary overlay that lets the user send an
 * invite link directly to an existing DM conversation, with a "More
 * options" fallback to the native share sheet.
 *
 * Renders as an absolute-positioned overlay (NOT a native Modal) so it
 * can layer correctly inside another open BaseModal — RN's Modal
 * component doesn't reliably stack, so a second Modal silently fails
 * to surface above the first.
 *
 * Replaces the previous flow where the share button immediately opened
 * the OS share sheet; that path is now one tap deeper.
 */

import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useToast } from '@/context/ToastContext';
import { useConversations } from '@/hooks/chat/useConversations';
import { useShareInvite } from '@/hooks/chat/useInviteManagement';
import { useSendDirectMessage } from '@/hooks/chat/useSendDirectMessage';
import { useTheme, type AppTheme } from '@/theme';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

interface ShareInviteSheetProps {
  visible: boolean;
  onClose: () => void;
  inviteLink: string;
  spaceName: string;
}

export default function ShareInviteSheet({
  visible,
  onClose,
  inviteLink,
  spaceName,
}: ShareInviteSheetProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme, insets), [theme, insets]);
  const { showToast } = useToast();
  const { data: conversationsData, isLoading } = useConversations({ type: 'direct' });
  const sendDirectMessage = useSendDirectMessage();
  const shareInvite = useShareInvite();
  const [sendingTo, setSendingTo] = useState<string | null>(null);

  // Slide-up animation. Mirrors what BaseModal does internally, but as
  // a plain View overlay so we can sit on top of an already-open Modal.
  const slideAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(slideAnim, {
      toValue: visible ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [visible, slideAnim]);

  // Flatten paginated conversations and keep only Quorum-native DMs (we
  // can't reliably round-trip a Farcaster DM send through this hook;
  // those go via a separate path). Sort by most recent first.
  const directConversations = useMemo(() => {
    if (!conversationsData) return [];
    const flat = conversationsData.pages.flatMap((p) => p.conversations);
    return flat
      .filter((c) => c.type === 'direct' && (c.source === 'quorum' || !c.source))
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [conversationsData]);

  const handleSendToDM = async (conversationId: string, recipientAddress: string, displayName: string) => {
    if (sendingTo) return; // guard against double-taps
    setSendingTo(conversationId);
    try {
      const message = `Join "${spaceName}" on Quorum!\n\n${inviteLink}`;
      await sendDirectMessage.mutateAsync({
        conversationId,
        recipientAddress,
        text: message,
      });
      showToast({
        type: 'success',
        title: 'Invite sent',
        message: `Sent to ${displayName || 'recipient'}`,
      });
      onClose();
    } catch (e) {
      showToast({
        type: 'error',
        title: 'Failed to send',
        message: e instanceof Error ? e.message : 'Could not send invite',
      });
    } finally {
      setSendingTo(null);
    }
  };

  const handleNativeShare = async () => {
    try {
      await shareInvite.mutateAsync({ inviteLink, spaceName });
    } catch {
      // Share mutation surfaces its own error state; no toast for cancel.
    }
    onClose();
  };

  if (!visible) return null;

  const translateY = slideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [600, 0],
  });
  const backdropOpacity = slideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.5],
  });

  return (
    <View style={styles.root} pointerEvents="box-none">
      <Animated.View
        style={[styles.backdrop, { opacity: backdropOpacity }]}
        pointerEvents={visible ? 'auto' : 'none'}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[styles.sheet, { transform: [{ translateY }] }]}
      >
        <TouchableOpacity style={styles.handleContainer} onPress={onClose} activeOpacity={0.8}>
          <View style={styles.handle} />
        </TouchableOpacity>
        <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Share invite</Text>
          <Text style={styles.subtitle}>Send to a contact or use another app.</Text>
        </View>

        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        >
          {isLoading && directConversations.length === 0 && (
            <View style={styles.empty}>
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          )}

          {!isLoading && directConversations.length === 0 && (
            <View style={styles.empty}>
              <IconSymbol name="bubble.left" size={28} color={theme.colors.textMuted} />
              <Text style={styles.emptyText}>No direct messages yet.</Text>
              <Text style={styles.emptyHint}>Use "More options" below to share via another app.</Text>
            </View>
          )}

          {directConversations.map((conv) => {
            const sending = sendingTo === conv.conversationId;
            return (
              <TouchableOpacity
                key={conv.conversationId}
                style={styles.row}
                onPress={() => handleSendToDM(conv.conversationId, conv.address, conv.displayName)}
                disabled={!!sendingTo}
                activeOpacity={0.7}
              >
                <CachedAvatar
                  source={conv.icon ? { uri: conv.icon } : null}
                  style={styles.avatar}
                />
                <View style={styles.rowText}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {conv.displayName || conv.address.slice(0, 12)}
                  </Text>
                  <Text style={styles.rowAddress} numberOfLines={1}>
                    {conv.address.slice(0, 16)}…
                  </Text>
                </View>
                {sending ? (
                  <ActivityIndicator size="small" color={theme.colors.accent} />
                ) : (
                  <IconSymbol name="paperplane.fill" size={16} color={theme.colors.accent} />
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity
            style={styles.moreButton}
            onPress={handleNativeShare}
            activeOpacity={0.8}
          >
            <IconSymbol name="square.and.arrow.up" size={16} color={theme.colors.textMain} />
            <Text style={styles.moreButtonText}>More options</Text>
          </TouchableOpacity>
        </View>
        </View>
      </Animated.View>
    </View>
  );
}

const createStyles = (theme: AppTheme, insets: { top: number; bottom: number; left: number; right: number }) =>
  StyleSheet.create({
    // Fills the parent surface so the sheet can sit on top of it.
    root: {
      ...StyleSheet.absoluteFillObject,
      // Extend above the modal-content rounded top so the backdrop
      // covers the parent fully, not just the inner content area.
      top: -insets.top - 100,
      zIndex: 1000,
      elevation: 1000,
    },
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: '#000',
    },
    sheet: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      // Roughly 60% of the parent modal — the parent BaseModal is
      // already constrained, so we just claim a sane chunk of it.
      height: 460,
      backgroundColor: theme.colors.background,
      borderTopLeftRadius: Skin.radius(20),
      borderTopRightRadius: Skin.radius(20),
      paddingBottom: insets.bottom,
    },
    handleContainer: {
      alignItems: 'center',
      paddingVertical: Skin.space(8),
    },
    handle: {
      width: 40,
      height: 4,
      backgroundColor: theme.colors.surface5 ?? theme.colors.surface3,
      borderRadius: Skin.radius(2),
    },
    container: {
      flex: 1,
      paddingHorizontal: Skin.space(20),
    },
    header: {
      paddingVertical: Skin.space(16),
      alignItems: 'center',
    },
    title: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textStrong,
    },
    subtitle: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      marginTop: Skin.space(4),
    },
    list: {
      flex: 1,
    },
    listContent: {
      paddingBottom: Skin.space(12),
    },
    empty: {
      paddingVertical: Skin.space(40),
      alignItems: 'center',
      gap: Skin.space(8),
    },
    emptyText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      marginTop: Skin.space(8),
    },
    emptyHint: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
      paddingVertical: Skin.space(10),
      paddingHorizontal: Skin.space(4),
    },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: Skin.radius(20),
      backgroundColor: theme.colors.surface3,
    },
    rowText: {
      flex: 1,
      minWidth: 0,
    },
    rowName: {
      fontSize: Skin.font(15),
      fontWeight: '600',
      color: theme.colors.textStrong,
    },
    rowAddress: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginTop: Skin.space(2),
    },
    footer: {
      paddingVertical: Skin.space(12),
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.surface3,
    },
    moreButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Skin.space(8),
      paddingVertical: Skin.space(12),
      borderRadius: Skin.radius(10),
      backgroundColor: theme.colors.surface2,
    },
    moreButtonText: {
      fontSize: Skin.font(15),
      fontWeight: '600',
      color: theme.colors.textMain,
    },
  });
