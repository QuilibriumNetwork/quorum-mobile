import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme';
import { createTheme } from '@/theme/themes';
import * as Skin from '@/theme/skins/geometry';
import { Button } from '@/components/ui/Button';

type ThemeType = ReturnType<typeof createTheme>;

export interface ConfirmActionsProps {
  /** Label for the action (e.g. "Delete", "Kick", "Block"). */
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Dismissive label. Not always literally "Cancel" — e.g. "Reject". */
  cancelLabel?: string;
  /** 'danger' tints the action red (default). 'primary' for a non-destructive confirm. */
  variant?: 'danger' | 'primary';
  confirmDisabled?: boolean;
  confirmLoading?: boolean;
  cancelDisabled?: boolean;
  /** Extra layout the host needs (outer padding, margins). */
  style?: StyleProp<ViewStyle>;
  confirmTestID?: string;
  cancelTestID?: string;
}

/**
 * ConfirmActions — the cancel/confirm pair every confirmation surface uses.
 *
 * Rendered as right-aligned text links rather than filled slabs. Two filled
 * buttons side by side give "cancel" and the destructive action equal visual
 * weight, and a full-width coloured block reads as the modal's subject rather
 * than its action. The action link carries the danger token (or the accent when
 * non-destructive); cancel takes a subtle text colour so it stays available
 * without competing.
 *
 * This exists as one component rather than a copied JSX block because it was
 * previously hand-rolled in eight places, which is how confirmation styling
 * drifts apart one modal at a time.
 *
 * Tap targets stay ~50pt tall: the links trade horizontal padding for a tighter
 * look but keep the `lg` vertical padding.
 */
export function ConfirmActions({
  confirmLabel,
  onConfirm,
  onCancel,
  cancelLabel = 'Cancel',
  variant = 'danger',
  confirmDisabled,
  confirmLoading,
  cancelDisabled,
  style,
  confirmTestID,
  cancelTestID,
}: ConfirmActionsProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  return (
    <View style={[styles.row, style]}>
      <Button
        variant="ghost"
        size="lg"
        color={theme.colors.textSubtle}
        disabled={cancelDisabled}
        onPress={onCancel}
        style={styles.link}
        testID={cancelTestID}
      >
        {cancelLabel}
      </Button>
      <Button
        variant="ghost"
        size="lg"
        color={variant === 'danger' ? theme.colors.danger : theme.colors.primary}
        disabled={confirmDisabled}
        loading={confirmLoading}
        onPress={onConfirm}
        style={styles.link}
        testID={confirmTestID}
      >
        {confirmLabel}
      </Button>
    </View>
  );
}

const createStyles = (_theme: ThemeType) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      alignItems: 'center',
      gap: Skin.space(4),
      // The links keep a generous tap target via their own horizontal padding;
      // pull the row out by that much so the last label optically aligns with
      // the surrounding text edge rather than sitting inset from it.
      marginRight: -Skin.space(12),
    },
    link: {
      // Tighter than the `lg` default (28) — these read as links, not slabs.
      // Vertical padding is untouched, so the tap target stays ~50pt tall.
      paddingHorizontal: Skin.space(12),
    },
  });

export default ConfirmActions;
