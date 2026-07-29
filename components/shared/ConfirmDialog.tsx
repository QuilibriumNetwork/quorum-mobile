import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTheme } from '@/theme';
import { createTheme } from '@/theme/themes';
import * as Skin from '@/theme/skins/geometry';
import { CenterModal } from './CenterModal';
import { ConfirmActions } from './ConfirmActions';

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
 * (T1/T2).
 *
 * Actions render as right-aligned text links, not filled slabs: two filled
 * buttons side by side give equal visual weight to "cancel" and "destroy", and
 * a full-width red block reads as the modal's subject rather than its action.
 * The action link carries the skin danger token (or the accent for a
 * non-destructive confirm) so intent stays legible on BOTH iOS and Android —
 * native Alert.alert can't colour its buttons on Android. Cancel is a subtle
 * text colour, present but not competing.
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
      <ConfirmActions
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        variant={variant}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
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
  });

export default ConfirmDialog;
