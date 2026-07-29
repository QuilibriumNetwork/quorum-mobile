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
      <View style={styles.actions}>
        <Button
          variant="ghost"
          size="lg"
          color={theme.colors.textSubtle}
          onPress={onCancel}
          style={styles.button}
        >
          {cancelLabel}
        </Button>
        <Button
          variant="ghost"
          size="lg"
          color={variant === 'danger' ? theme.colors.danger : theme.colors.primary}
          onPress={onConfirm}
          style={styles.button}
        >
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
      justifyContent: 'flex-end',
      alignItems: 'center',
      gap: Skin.space(4),
      // The links keep a generous tap target via their own horizontal padding;
      // pull the row out by that much so the last label optically aligns with
      // the card's text edge rather than sitting inset from it.
      marginRight: -Skin.space(12),
    },
    button: {
      // Tighter than the `lg` default (28) — these read as links, not slabs.
      // Vertical padding is untouched, so the tap target stays ~50pt tall.
      paddingHorizontal: Skin.space(12),
    },
  });

export default ConfirmDialog;
