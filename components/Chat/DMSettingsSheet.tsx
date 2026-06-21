/**
 * DMSettingsSheet - Shows settings/actions for a DM conversation
 */

import type { AppTheme } from '@/theme';
import React, { useState } from 'react';
import { View, Text, StyleSheet, Alert, Switch } from 'react-native';
import { BaseModal, ActionRow, ActionRowGroup } from '@/components/shared';
import { resetDMSession } from '@/hooks/chat/useSendDirectMessage';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import * as Skin from '@/theme/skins/geometry';

interface DMSettingsSheetProps {
  visible: boolean;
  onClose: () => void;
  conversationId: string;
  displayName: string;
  theme: AppTheme;
  onDeleteConversation?: () => void;
  isRepudiable?: boolean;
  onToggleRepudiable?: (value: boolean) => void;
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
          <Text style={styles.headerText}>Conversation Settings</Text>
        </View>

        {onToggleMute && (
          <ActionRowGroup style={styles.group}>
            <ActionRow
              label="Mute Conversation"
              sublabel="No notifications or unread badges"
              trailing={
                <Switch
                  value={isMuted ?? false}
                  onValueChange={onToggleMute}
                  trackColor={{ false: theme.colors.surface5, true: theme.colors.primary }}
                />
              }
            />
          </ActionRowGroup>
        )}

        {(onToggleRepudiable || onToggleEditHistory) && (
          <ActionRowGroup style={styles.group}>
            {onToggleRepudiable && (
              <ActionRow
                label="Repudiable Messages"
                sublabel="Messages can't be proven as yours"
                trailing={
                  <Switch
                    value={isRepudiable ?? false}
                    onValueChange={onToggleRepudiable}
                    trackColor={{ false: theme.colors.surface5, true: theme.colors.primary }}
                  />
                }
              />
            )}
            {onToggleEditHistory && (
              <ActionRow
                label="Save Edit History"
                sublabel="Keep previous versions of edits"
                trailing={
                  <Switch
                    value={saveEditHistory ?? true}
                    onValueChange={onToggleEditHistory}
                    trackColor={{ false: theme.colors.surface5, true: theme.colors.primary }}
                  />
                }
              />
            )}
          </ActionRowGroup>
        )}

        <ActionRowGroup style={styles.group}>
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
      paddingTop: Skin.space(4),
      paddingBottom: Skin.space(14),
    },
    headerText: {
      ...theme.textStyles.headline,
      color: theme.colors.textStrong,
      textAlign: 'center',
    },
    group: {
      marginBottom: Skin.space(12),
    },
  });

export default DMSettingsSheet;
