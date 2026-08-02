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
  /**
   * Where the actions live, which decides how they render:
   * 'dialog' (default) — a centre-anchored "are you sure?"; right-aligned text
   * links, so the destructive word never outweighs the question above it.
   * 'sheet' — a bottom drawer; two filled buttons splitting the width, matching
   * every other sheet in the app.
   */
  surface?: 'dialog' | 'sheet';
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
 * How it renders depends on where it sits, via `surface`:
 *
 * A centre-anchored dialog (`'dialog'`, the default) gets right-aligned text
 * links. Two filled buttons side by side would give "cancel" and the
 * destructive action equal visual weight, and a full-width coloured block reads
 * as the dialog's subject rather than its action. The action link carries the
 * danger token (or the accent when non-destructive); cancel takes a subtle text
 * colour so it stays available without competing. Tap targets stay ~50pt tall:
 * the links trade horizontal padding for a tighter look but keep the `lg`
 * vertical padding.
 *
 * A bottom drawer (`'sheet'`) gets ordinary filled buttons splitting the width.
 * A sheet is a small screen, not a warning: its actions are what the user came
 * for, and links floating in the corner of a tall drawer read as an
 * afterthought. This also matches the button row every other sheet uses.
 *
 * This exists as one component rather than a copied JSX block because it was
 * previously hand-rolled in eight places, which is how confirmation styling
 * drifts apart one modal at a time.
 */
export function ConfirmActions({
  confirmLabel,
  onConfirm,
  onCancel,
  cancelLabel = 'Cancel',
  variant = 'danger',
  surface = 'dialog',
  confirmDisabled,
  confirmLoading,
  cancelDisabled,
  style,
  confirmTestID,
  cancelTestID,
}: ConfirmActionsProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const isSheet = surface === 'sheet';

  return (
    <View style={[isSheet ? styles.buttonRow : styles.row, style]}>
      <Button
        variant={isSheet ? 'secondary' : 'ghost'}
        size="lg"
        color={isSheet ? undefined : theme.colors.textSubtle}
        disabled={cancelDisabled}
        onPress={onCancel}
        style={isSheet ? styles.button : styles.link}
        testID={cancelTestID}
      >
        {cancelLabel}
      </Button>
      <Button
        variant={isSheet ? variant : 'ghost'}
        size="lg"
        color={isSheet ? undefined : variant === 'danger' ? theme.colors.danger : theme.colors.primary}
        disabled={confirmDisabled}
        loading={confirmLoading}
        onPress={onConfirm}
        style={isSheet ? styles.button : styles.link}
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
      // The links carry padding on all four sides purely to keep a ~50pt tap
      // target. That padding is invisible, so it stacks on the host's own
      // padding and reads as dead space — most obviously below the row, where
      // the link's 16 and the card's 20 left the labels floating well off the
      // bottom edge. Pull the row back out by roughly the overhang so the
      // labels optically align with the surrounding text block, without
      // shrinking the touch area.
      marginRight: -Skin.space(12),
      marginBottom: -Skin.space(10),
    },
    link: {
      // Tighter than the `lg` default (28) — these read as links, not slabs.
      // Vertical padding is untouched, so the tap target stays ~50pt tall.
      paddingHorizontal: Skin.space(12),
    },
    buttonRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
    },
    button: {
      // Split the width evenly. The `lg` horizontal padding is irrelevant once
      // the buttons flex, but it keeps a long label from crowding the edges.
      flex: 1,
    },
  });

export default ConfirmActions;
