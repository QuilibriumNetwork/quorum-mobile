/**
 * DMSettingsSheet - Shows settings/actions for a DM conversation
 */

import type { AppTheme } from '@/theme';
import React, { useState } from 'react';
import { View, Text, StyleSheet, Alert, Switch, Image } from 'react-native';
import { BaseModal, ActionRow, ActionRowGroup } from '@/components/shared';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { resetDMSession } from '@/hooks/chat/useSendDirectMessage';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { isValidAvatarUri } from '@/utils/validation';
import { truncateAddress } from '@/utils/formatAddress';
import * as Skin from '@/theme/skins/geometry';

interface DMSettingsSheetProps {
  visible: boolean;
  onClose: () => void;
  conversationId: string;
  displayName: string;
  theme: AppTheme;
  /** When provided, the sheet shows the recipient's pfp + name above the title.
   *  Used when opening the sheet from the messages list (long-press), where the
   *  user has no other on-screen confirmation of which conversation they hit. */
  avatarUri?: string;
  address?: string;
  onDeleteConversation?: () => void;
  /** The "Always sign messages" (repudiability) control is NOT surfaced yet —
   *  making it functional needs the send-path signing gate + per-message
   *  composer lock button ported from desktop. Tracked separately; until then
   *  these props stay optional/unused so a future wire-up is a one-liner. */
  isRepudiable?: boolean;
  onToggleRepudiable?: (isRepudiable: boolean) => void;
  saveEditHistory?: boolean;
  onToggleEditHistory?: (value: boolean) => void;
  isMuted?: boolean;
  onToggleMute?: (value: boolean) => void;
}

export function DMSettingsSheet({
  visible,
  onClose,
  conversationId,
  displayName,
  theme,
  avatarUri,
  address,
  onDeleteConversation,
  isRepudiable,
  onToggleRepudiable,
  saveEditHistory,
  onToggleEditHistory,
  isMuted,
  onToggleMute,
}: DMSettingsSheetProps) {
  const styles = createStyles(theme);
  const { confirm, confirmDialog } = useConfirmDialog();
  // While a confirm dialog is open on top of this sheet, swallow the sheet's own
  // back/backdrop dismissal so an Android back cancels the confirm rather than
  // tearing down this sheet (which is conditionally mounted by the parent).
  const [isConfirming, setIsConfirming] = useState(false);

  if (!visible) return null;

  const guardedClose = () => {
    if (isConfirming) return;
    onClose();
  };

  const handleDeleteConversation = async () => {
    setIsConfirming(true);
    const ok = await confirm({
      title: 'Delete Conversation',
      message: `This will delete the conversation with ${displayName} from your device only. The other person will still have the conversation on their device.`,
      confirmLabel: 'Delete',
    });
    setIsConfirming(false);
    if (!ok) return;
    onDeleteConversation?.();
    onClose();
  };

  const handleFixEncryption = async () => {
    setIsConfirming(true);
    const ok = await confirm({
      title: 'Fix Encryption',
      message: `This will reset the encryption session with ${displayName}. The next message will establish a fresh secure connection.\n\nUse this if messages are failing to send or decrypt.`,
      confirmLabel: 'Reset Session',
    });
    setIsConfirming(false);
    if (!ok) return;
    resetDMSession(conversationId);
    onClose();
    Alert.alert(
      'Session Reset',
      'The encryption session has been reset. Your next message will establish a fresh secure connection.'
    );
  };

  return (
    <BaseModal visible={visible} onClose={guardedClose} showHandle>
      <View style={styles.container}>
        <View style={styles.header}>
          {address != null && (
            isValidAvatarUri(avatarUri) ? (
              <Image source={{ uri: avatarUri }} style={styles.headerAvatar} />
            ) : (
              <DefaultAvatar displayName={displayName} address={address} size={56} style={styles.headerAvatar} />
            )
          )}
          {address != null && (
            <Text style={styles.headerName} numberOfLines={1}>{displayName}</Text>
          )}
          {address != null && (
            <Text style={styles.headerAddress} numberOfLines={1}>
              {truncateAddress(address, 'long')}
            </Text>
          )}
          <Text style={address != null ? styles.headerSubtitle : styles.headerText}>
            Conversation Settings
          </Text>
        </View>

        {/* One card, flat list of rows — the canonical ActionRowGroup pattern
            (see MessageActionSheet and the modal-row audit). The group handles
            dividers between rows and drops the last one; no arbitrary
            sub-grouping. */}
        <ActionRowGroup style={styles.group}>
          {onToggleMute && (
            <ActionRow
              icon="bell.slash"
              label="Mute Conversation"
              trailing={
                <Switch
                  value={isMuted ?? false}
                  onValueChange={onToggleMute}
                  trackColor={{ false: theme.colors.surface5, true: theme.colors.primary }}
                />
              }
            />
          )}
          {onToggleEditHistory && (
            <ActionRow
              icon="clock.arrow.circlepath"
              label="Save Edit History"
              sublabel="Keep previous versions of edits"
              trailing={
                <Switch
                  // Default OFF, matching desktop (keeping history is opt-in).
                  value={saveEditHistory ?? false}
                  onValueChange={onToggleEditHistory}
                  trackColor={{ false: theme.colors.surface5, true: theme.colors.primary }}
                />
              }
            />
          )}
          <ActionRow
            icon="arrow.triangle.2.circlepath"
            label="Fix Encryption"
            sublabel="Reset if messages fail to send/decrypt"
            onPress={handleFixEncryption}
          />
          <ActionRow
            icon="trash"
            label="Delete Conversation"
            sublabel="Only deletes from your device"
            destructive
            onPress={handleDeleteConversation}
          />
        </ActionRowGroup>
      </View>
      {confirmDialog}
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      paddingHorizontal: Skin.space(12),
      paddingTop: Skin.space(12),
      paddingBottom: Skin.space(8),
    },
    header: {
      alignItems: 'center',
      paddingTop: Skin.space(16),
      paddingBottom: Skin.space(14),
    },
    headerText: {
      ...theme.textStyles.headline,
      color: theme.colors.textStrong,
      textAlign: 'center',
    },
    headerAvatar: {
      width: 56,
      height: 56,
      borderRadius: Skin.radius(28),
      marginBottom: Skin.space(8),
    },
    headerName: {
      ...theme.textStyles.headline,
      color: theme.colors.textStrong,
      textAlign: 'center',
      marginBottom: Skin.space(2),
    },
    headerAddress: {
      ...theme.textStyles.footnote,
      color: theme.colors.textSubtle,
      textAlign: 'center',
    },
    headerSubtitle: {
      ...theme.textStyles.subheadline,
      color: theme.colors.textSubtle,
      textAlign: 'center',
      marginTop: Skin.space(12),
    },
    group: {
      marginBottom: Skin.space(12),
    },
  });

export default DMSettingsSheet;
