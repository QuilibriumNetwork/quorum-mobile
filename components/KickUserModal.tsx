/**
 * KickUserModal - Modal for kicking a user from a space
 *
 * Features:
 * - Single-press kick (reaching this modal IS the deliberate confirmation)
 * - Shows user avatar and truncated address
 * - Minimum 3-second overlay display during operation
 * - Modal locked during operation (can't close)
 */

import { truncateAddress } from '@/utils/formatAddress';
import React, { useEffect, useCallback, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Image } from 'react-native';
import { BaseModal } from '@/components/shared/BaseModal';
import { Button } from '@/components/ui/Button';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { useTheme, type AppTheme } from '@/theme';
import { useUserKicking } from '@/hooks/chat/useUserKicking';
import * as Skin from '@/theme/skins/geometry';

interface KickUserModalProps {
  visible: boolean;
  onClose: () => void;
  spaceId: string;
  userName: string;
  userIcon?: string;
  userAddress: string;
}

export function KickUserModal({
  visible,
  onClose,
  spaceId,
  userName,
  userIcon,
  userAddress,
}: KickUserModalProps) {
  const { theme } = useTheme();
  const [isSaving, setIsSaving] = useState(false);

  const {
    kicking,
    kickUserFromSpace,
  } = useUserKicking({ spaceId });

  // Reset the saving overlay when the modal closes.
  useEffect(() => {
    if (!visible) {
      setIsSaving(false);
    }
  }, [visible]);

  // Single press kicks — reaching this modal (via a member's Kick button) is
  // already the deliberate confirmation step, so no in-modal double-tap.
  const handleKickWithOverlay = useCallback(async () => {
    if (!userAddress) return;

    setIsSaving(true);

    // Ensure minimum 3 second overlay display time
    const startTime = Date.now();
    const minDisplayTime = 3000;

    try {
      await kickUserFromSpace(userAddress);

      // If operation completed too quickly, wait for minimum display time
      const elapsed = Date.now() - startTime;
      if (elapsed < minDisplayTime) {
        await new Promise(resolve => setTimeout(resolve, minDisplayTime - elapsed));
      }

      onClose();
    } catch (error) {
      setIsSaving(false);
    }
  }, [kickUserFromSpace, userAddress, onClose]);

  const styles = createStyles(theme);

  return (
    <BaseModal
      visible={visible}
      onClose={isSaving ? () => {} : onClose}
      height={0.35}
      testID="kick-user-modal"
    >
      <View style={styles.container}>
        {/* Saving overlay */}
        {isSaving && (
          <View style={styles.overlay}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.overlayText}>Kicking...</Text>
          </View>
        )}

        {/* Title */}
        <Text style={styles.title}>Kick User</Text>

        {/* User info */}
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

        {/* Description */}
        <Text style={styles.description}>
          This user will be removed from the Space.
        </Text>

        {/* Buttons */}
        <View style={styles.buttonRow}>
          <Button
            variant="secondary"
            size="lg"
            onPress={onClose}
            disabled={isSaving}
            style={styles.button}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="lg"
            onPress={handleKickWithOverlay}
            disabled={isSaving || kicking}
            style={styles.button}
          >
            Kick
          </Button>
        </View>
      </View>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      padding: Skin.space(20),
    },
    overlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0, 0, 0, 0.7)',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 10,
      borderTopLeftRadius: Skin.radius(20),
      borderTopRightRadius: Skin.radius(20),
    },
    overlayText: {
      color: '#fff',
      fontSize: Skin.font(16),
      marginTop: Skin.space(12),
      fontFamily: theme.fonts.medium.fontFamily,
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
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      marginTop: Skin.space(2),
    },
    description: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
      marginBottom: Skin.space(24),
    },
    buttonRow: {
      flexDirection: 'row',
      gap: Skin.space(12),
    },
    button: {
      flex: 1,
    },
  });

export default KickUserModal;
