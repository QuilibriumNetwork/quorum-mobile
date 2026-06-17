import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useTheme } from '@/theme';
import { createTheme } from '@/theme/themes';
import * as Skin from '@/theme/skins/geometry';
import { CenterModal } from './CenterModal';

type ThemeType = ReturnType<typeof createTheme>;

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message: string;
  /** Label for the action button (e.g. "Delete", "Remove from Space"). */
  confirmLabel: string;
  /** Cancel button label (default "Cancel"). */
  cancelLabel?: string;
  /** 'danger' styles the action button red (default). 'primary' for a non-destructive confirm. */
  variant?: 'danger' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
  testID?: string;
}

/**
 * ConfirmDialog — a center-anchored "are you sure?" for destructive actions
 * (T1/T2). The action button uses the skin danger token, so it's visibly red on
 * BOTH iOS and Android (native Alert.alert can't do this on Android).
 *
 * Backdrop tap and Android back resolve to Cancel (owned by CenterModal).
 */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  variant = 'danger',
  onConfirm,
  onCancel,
  testID,
}: ConfirmDialogProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const confirmColor = variant === 'danger' ? theme.colors.danger : theme.colors.primary;

  return (
    <CenterModal
      visible={visible}
      onCancel={onCancel}
      accessibilityLabel={title}
      testID={testID}
    >
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.message}>{message}</Text>
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.button, styles.cancelButton]}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel={cancelLabel}
        >
          <Text style={styles.cancelLabel}>{cancelLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, { backgroundColor: confirmColor }]}
          onPress={onConfirm}
          accessibilityRole="button"
          accessibilityLabel={confirmLabel}
        >
          <Text style={styles.confirmLabel}>{confirmLabel}</Text>
        </TouchableOpacity>
      </View>
    </CenterModal>
  );
}

const createStyles = (theme: ThemeType) =>
  StyleSheet.create({
    title: {
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      marginBottom: Skin.space(8),
    },
    message: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textSubtle,
      lineHeight: Skin.font(20),
      marginBottom: Skin.space(20),
    },
    actions: {
      flexDirection: 'row',
      gap: Skin.space(10),
    },
    button: {
      flex: 1,
      paddingVertical: Skin.space(12),
      borderRadius: Skin.radius(12),
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelButton: {
      backgroundColor: theme.colors.bgButtonSubtle,
    },
    cancelLabel: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    confirmLabel: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: '#fff',
    },
  });

export default ConfirmDialog;
