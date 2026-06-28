/**
 * MuteUserModal - Modal for MODERATION mute/unmute of a user in a space.
 *
 * A moderator with the `user:mute` role silences a user for everyone (broadcasts
 * a MuteMessage; every client validates + drops the user's messages and disables
 * their composer). NOT the personal "block" (viewer-side hide). Mirrors desktop's
 * MuteUserModal: a numeric duration (0 = forever, 1-365 days) for mute; unmute
 * mode skips the duration field.
 *
 * Modeled on KickUserModal (reaching this modal IS the deliberate confirmation).
 */

import { truncateAddress } from '@/utils/formatAddress';
import React, { useEffect, useCallback, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Image, TextInput } from 'react-native';
import { BaseModal } from '@/components/shared/BaseModal';
import { Button } from '@/components/ui/Button';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { useTheme, type AppTheme } from '@/theme';
import { useModMuteUser } from '@/hooks/chat/useModMuteUser';
import * as Skin from '@/theme/skins/geometry';

interface MuteUserModalProps {
  visible: boolean;
  onClose: () => void;
  spaceId: string;
  channelId: string;
  userName: string;
  userIcon?: string;
  userAddress: string;
  /** True = unmute flow (no duration); false/undefined = mute flow. */
  isUnmuting?: boolean;
}

const MAX_DAYS = 365;

export function MuteUserModal({
  visible,
  onClose,
  spaceId,
  channelId,
  userName,
  userIcon,
  userAddress,
  isUnmuting = false,
}: MuteUserModalProps) {
  const { theme } = useTheme();
  const [isSaving, setIsSaving] = useState(false);
  // Days as a string for the input; '' and '0' both mean "forever".
  const [daysText, setDaysText] = useState('1');

  const { muteUser, unmuteUser } = useModMuteUser();

  useEffect(() => {
    if (!visible) {
      setIsSaving(false);
      setDaysText('1');
    }
  }, [visible]);

  // Clamp to 0-365, digits only (silent — never error on input).
  const handleDaysChange = useCallback((text: string) => {
    const digits = text.replace(/[^0-9]/g, '');
    if (digits === '') {
      setDaysText('');
      return;
    }
    const n = Math.min(parseInt(digits, 10), MAX_DAYS);
    setDaysText(String(n));
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!userAddress) return;
    setIsSaving(true);
    try {
      if (isUnmuting) {
        await unmuteUser({ spaceId, channelId, targetUserId: userAddress });
      } else {
        const days = daysText === '' ? 0 : parseInt(daysText, 10);
        await muteUser({ spaceId, channelId, targetUserId: userAddress, days });
      }
      onClose();
    } catch {
      setIsSaving(false);
    }
  }, [isUnmuting, unmuteUser, muteUser, spaceId, channelId, userAddress, daysText, onClose]);

  const styles = createStyles(theme);
  const days = daysText === '' ? 0 : parseInt(daysText, 10);
  const durationLabel = days === 0 ? 'forever' : `${days} ${days === 1 ? 'day' : 'days'}`;

  return (
    <BaseModal
      visible={visible}
      onClose={isSaving ? () => {} : onClose}
      height={isUnmuting ? 0.42 : 0.55}
      testID="mute-user-modal"
    >
      <View style={styles.container}>
        {isSaving && (
          <View style={styles.overlay}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.overlayText}>{isUnmuting ? 'Unmuting...' : 'Muting...'}</Text>
          </View>
        )}

        <Text style={styles.title}>{isUnmuting ? 'Unmute User' : 'Mute User'}</Text>

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
            <Text style={styles.userAddress}>{truncateAddress(userAddress)}</Text>
          </View>
        </View>

        {!isUnmuting && (
          <View style={styles.durationRow}>
            <Text style={styles.durationLabel}>Duration (days)</Text>
            <TextInput
              style={styles.durationInput}
              value={daysText}
              onChangeText={handleDaysChange}
              keyboardType="number-pad"
              placeholder="0"
              placeholderTextColor={theme.colors.textMuted}
              maxLength={3}
              accessibilityLabel="Mute duration in days, 0 for forever"
            />
          </View>
        )}

        <Text style={styles.description}>
          {isUnmuting
            ? 'This user will be able to post in this space again.'
            : `This user will be muted ${durationLabel} and unable to post in this space. 0 = forever.`}
        </Text>

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
            variant="primary"
            size="lg"
            onPress={handleConfirm}
            disabled={isSaving}
            style={styles.button}
          >
            {isUnmuting ? 'Unmute' : 'Mute'}
          </Button>
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
      // the description/duration field grew. BaseModal's paddingBottom:
      // insets.bottom then keeps the buttons clear of the system bar.
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
    durationRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: theme.colors.bgButtonSubtle,
      borderRadius: Skin.radius(12),
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(10),
      marginBottom: Skin.space(16),
    },
    durationLabel: {
      fontSize: Skin.font(15),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
    },
    durationInput: {
      minWidth: 64,
      textAlign: 'center',
      fontSize: Skin.font(16),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      backgroundColor: theme.colors.surface1,
      borderRadius: Skin.radius(8),
      paddingHorizontal: Skin.space(10),
      paddingVertical: Skin.space(6),
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

export default MuteUserModal;
