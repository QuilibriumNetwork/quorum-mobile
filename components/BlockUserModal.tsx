/**
 * BlockUserModal — confirmation sheet for the personal "Block user" action.
 *
 * Block is per-space and viewer-side only: it hides ALL of the target's messages
 * (past and new) from YOUR own stream, only for you, only in this space. It has
 * no moderation effect and needs no permission — distinct from the role-gated
 * "Mute in Space". The action itself is a local config write (no broadcast), so
 * this is a plain confirm/cancel with no saving overlay. Unblock is offered as a
 * lighter one-press confirm with a primary button.
 */

import { truncateAddress } from '@/utils/formatAddress';
import React, { useCallback } from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { BaseModal } from '@/components/shared/BaseModal';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { useTheme, type AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

interface BlockUserModalProps {
  visible: boolean;
  onClose: () => void;
  /** Performs the block/unblock toggle. Synchronous local config write. */
  onConfirm: () => void;
  userName: string;
  userIcon?: string;
  userAddress: string;
  /** When true the sheet confirms an UNblock instead of a block. */
  isUnblocking?: boolean;
}

export function BlockUserModal({
  visible,
  onClose,
  onConfirm,
  userName,
  userIcon,
  userAddress,
  isUnblocking = false,
}: BlockUserModalProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const handleConfirm = useCallback(() => {
    onConfirm();
    onClose();
  }, [onConfirm, onClose]);

  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      height={0.55}
      testID="block-user-modal"
    >
      <View style={styles.container}>
        <Text style={styles.title}>{isUnblocking ? 'Unblock User' : 'Block User'}</Text>

        <View style={styles.userRow}>
          {userIcon ? (
            <Image source={{ uri: userIcon }} style={styles.avatar} />
          ) : (
            <DefaultAvatar displayName={userName} address={userAddress} size={40} />
          )}
          <View style={styles.userInfo}>
            <Text style={styles.userName} numberOfLines={1}>
              {userName}
            </Text>
            <Text style={styles.userAddress}>
              {truncateAddress(userAddress)}
            </Text>
          </View>
        </View>

        <Text style={styles.description}>
          {isUnblocking
            ? `You'll start seeing ${userName}'s messages in this space again.`
            : `You won't see any of ${userName}'s messages in this space. This only affects your view, and only in this space. You can unblock anytime.`}
        </Text>

        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.button, styles.cancelButton]}
            onPress={onClose}
          >
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.button, styles.primaryButton]}
            onPress={handleConfirm}
          >
            <Text style={styles.primaryButtonText}>
              {isUnblocking ? 'Unblock' : 'Block'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      // Hug content instead of flex:1 stretching to the sheet's maxHeight, which
      // pushed the button row off the bottom edge (under the Android nav bar) when
      // the description wrapped to several lines. BaseModal's paddingBottom:
      // insets.bottom then keeps the buttons clear of the system bar.
      padding: Skin.space(20),
    },
    title: {
      fontSize: Skin.font(20),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      marginBottom: Skin.space(20),
      textAlign: 'center',
    },
    userRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.bgButtonSubtle,
      borderRadius: Skin.radius(12),
      padding: Skin.space(12),
      marginBottom: Skin.space(16),
    },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: Skin.radius(20),
      marginRight: Skin.space(12),
    },
    userInfo: {
      flex: 1,
      minWidth: 0,
    },
    userName: {
      fontSize: Skin.font(16),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
    },
    userAddress: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.regular.fontFamily,
      marginTop: Skin.space(2),
    },
    description: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
      marginBottom: Skin.space(24),
      lineHeight: Skin.font(20),
    },
    buttonRow: {
      flexDirection: 'row',
      gap: Skin.space(12),
    },
    button: {
      flex: 1,
      paddingVertical: Skin.space(14),
      borderRadius: Skin.radius(8),
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelButton: {
      backgroundColor: theme.colors.bgButtonSubtle,
    },
    cancelButtonText: {
      color: theme.colors.textMain,
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
    },
    primaryButton: {
      backgroundColor: theme.colors.primary,
    },
    primaryButtonText: {
      color: '#fff',
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
    },
  });

export default BlockUserModal;
