/**
 * DMSettingsSheet - Shows settings/actions for a DM conversation
 */

import type { AppTheme } from '@/theme';
import React, { useState } from 'react';
import { View, Text, StyleSheet, Modal, Pressable, Alert, Switch } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol } from '@/components/ui/IconSymbol';
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
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={guardedClose}
    >
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={guardedClose} />
        <View style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.headerText}>Conversation Settings</Text>
          </View>
          {onToggleRepudiable && (
            <>
              <View style={styles.divider} />
              <View style={styles.toggleRow}>
                <View style={styles.actionContent}>
                  <Text style={styles.actionText}>Repudiable Messages</Text>
                  <Text style={styles.actionSubtext}>Messages can't be proven as yours</Text>
                </View>
                <Switch
                  value={isRepudiable ?? false}
                  onValueChange={onToggleRepudiable}
                  trackColor={{ false: theme.colors.surface5, true: theme.colors.primary }}
                />
              </View>
            </>
          )}
          {onToggleEditHistory && (
            <>
              <View style={styles.divider} />
              <View style={styles.toggleRow}>
                <View style={styles.actionContent}>
                  <Text style={styles.actionText}>Save Edit History</Text>
                  <Text style={styles.actionSubtext}>Keep previous versions of edits</Text>
                </View>
                <Switch
                  value={saveEditHistory ?? true}
                  onValueChange={onToggleEditHistory}
                  trackColor={{ false: theme.colors.surface5, true: theme.colors.primary }}
                />
              </View>
            </>
          )}
          <View style={styles.divider} />
          <TouchableOpacity style={styles.actionButton} onPress={handleFixEncryption}>
            <IconSymbol
              name="arrow.triangle.2.circlepath"
              size={20}
              color={theme.colors.warning ?? theme.colors.textMuted}
            />
            <View style={styles.actionContent}>
              <Text style={styles.actionText}>Fix Encryption</Text>
              <Text style={styles.actionSubtext}>Reset if messages fail to send/decrypt</Text>
            </View>
          </TouchableOpacity>
          <View style={styles.divider} />
          <TouchableOpacity style={styles.actionButton} onPress={handleDeleteConversation}>
            <IconSymbol
              name="trash"
              size={20}
              color={theme.colors.danger ?? theme.colors.danger}
            />
            <View style={styles.actionContent}>
              <Text style={[styles.actionText, styles.dangerText]}>Delete Conversation</Text>
              <Text style={styles.actionSubtext}>Only deletes from your device</Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>
      {confirmDialog}
    </Modal>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
    },
    container: {
      backgroundColor: theme.colors.surface1 ?? theme.colors.background,
      borderRadius: Skin.radius(12),
      minWidth: 280,
      maxWidth: 320,
      overflow: 'hidden',
    },
    header: {
      paddingVertical: Skin.space(14),
      paddingHorizontal: Skin.space(20),
    },
    headerText: {
      fontSize: Skin.font(16),
      fontWeight: '600',
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium?.fontFamily ?? theme.fonts.regular.fontFamily,
      textAlign: 'center',
    },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: Skin.space(14),
      paddingHorizontal: Skin.space(20),
      gap: Skin.space(12),
    },
    actionContent: {
      flex: 1,
    },
    actionText: {
      fontSize: Skin.font(16),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    actionSubtext: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.regular.fontFamily,
      marginTop: Skin.space(2),
    },
    dangerText: {
      color: theme.colors.danger ?? theme.colors.danger,
    },
    toggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: Skin.space(14),
      paddingHorizontal: Skin.space(20),
      gap: Skin.space(12),
    },
    divider: {
      height: 1,
      backgroundColor: theme.colors.border ?? theme.colors.surface3,
    },
  });

export default DMSettingsSheet;
