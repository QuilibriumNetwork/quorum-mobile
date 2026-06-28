import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/theme';
import { createTheme } from '@/theme/themes';
import * as Skin from '@/theme/skins/geometry';
import { Button } from '@/components/ui/Button';
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
        <Button variant="secondary" size="lg" onPress={onCancel} style={styles.button}>
          {cancelLabel}
        </Button>
        <Button variant={variant} size="lg" onPress={onConfirm} style={styles.button}>
          {confirmLabel}
        </Button>
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
    },
  });

export default ConfirmDialog;
