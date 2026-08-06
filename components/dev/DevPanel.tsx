/**
 * DevPanel — the one visual language for dev-build-only tooling.
 *
 * Anything that only exists in a dev build looks the same: a dashed
 * warning-coloured border, the `</>` glyph, a "(dev builds only)" title. The
 * point is that it reads as scaffolding at a glance and can never be mistaken
 * for product UI in a screenshot or a bug report — which matters, because these
 * panels sit inside real screens (the profile modal, the notifications tab, the
 * Apex flow) rather than behind a separate dev menu.
 *
 * The Apex subscribe modal's debug box was the original; this is that box
 * extracted so the next panel inherits the language instead of approximating it.
 * Four panels had already drifted into three different treatments before this
 * existed.
 *
 * These components do NOT gate themselves on `__DEV__`. The gate belongs at the
 * call site, ideally at the `require()`, so the panel and everything it imports
 * are provably absent from a release bundle rather than merely unrendered.
 */

import React, { useMemo } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useTheme, type AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

interface DevPanelProps {
  /** Shown next to the `</>` glyph. "(dev builds only)" is appended for you. */
  title: string;
  /** One or two lines saying what the panel is for. */
  hint?: string;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

export function DevPanel({ title, hint, style, children }: DevPanelProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={[styles.box, style]}>
      <View style={styles.titleRow}>
        <IconSymbol
          name="chevron.left.forwardslash.chevron.right"
          size={16}
          color={theme.colors.warning}
        />
        <Text style={styles.title}>{title} (dev builds only)</Text>
      </View>
      {!!hint && <Text style={styles.hint}>{hint}</Text>}
      <View style={styles.body}>{children}</View>
    </View>
  );
}

/**
 * The panel title treatment on its own, for dev surfaces too large to sit in a
 * box — a whole sheet, say. A dashed frame around a full-screen modal is noise,
 * but the glyph and the warning colour still have to say "this is scaffolding"
 * the moment it opens.
 */
export function DevTitle({ title, style }: { title: string; style?: StyleProp<ViewStyle> }) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={[styles.titleRow, style]}>
      <IconSymbol
        name="chevron.left.forwardslash.chevron.right"
        size={16}
        color={theme.colors.warning}
      />
      <Text style={styles.sheetTitle}>{title} (dev builds only)</Text>
    </View>
  );
}

/** A labelled row inside a panel: text on the left, controls on the right. */
export function DevRow({
  label,
  hint,
  disabled,
  children,
}: {
  label?: string;
  hint?: string;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={[styles.row, disabled && styles.rowDisabled]}>
      {(!!label || !!hint) && (
        <View style={styles.rowText}>
          {!!label && <Text style={styles.rowLabel}>{label}</Text>}
          {!!hint && <Text style={styles.hint}>{hint}</Text>}
        </View>
      )}
      {children}
    </View>
  );
}

/** Wraps a set of DevButtons so they flow onto a second line on a narrow screen. */
export function DevButtonRow({ children }: { children?: React.ReactNode }) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return <View style={styles.buttonRow}>{children}</View>;
}

export function DevButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <TouchableOpacity
      style={[styles.button, disabled && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * A readout line — measured state the panel is reporting back, as opposed to a
 * control. Tabular figures so a number changing in place does not shift the
 * text around it.
 */
export function DevReadout({ children }: { children?: React.ReactNode }) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return <Text style={styles.readout}>{children}</Text>;
}

/** A caveat that must be read before trusting the panel, in the warning colour. */
export function DevWarning({ children }: { children?: React.ReactNode }) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return <Text style={styles.warning}>{children}</Text>;
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    box: {
      padding: Skin.space(12),
      borderRadius: Skin.radius(10),
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: theme.colors.warning,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
    },
    title: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.warning,
    },
    // Larger, because it heads a whole sheet rather than a box inside a screen.
    sheetTitle: {
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.warning,
    },
    hint: {
      fontSize: Skin.font(11),
      lineHeight: Skin.font(15),
      color: theme.colors.textSubtle,
      marginTop: Skin.space(4),
    },
    body: {
      gap: Skin.space(10),
      marginTop: Skin.space(10),
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: Skin.space(10),
    },
    rowDisabled: {
      opacity: 0.45,
    },
    rowText: {
      flex: 1,
    },
    rowLabel: {
      fontSize: Skin.font(13),
      color: theme.colors.textMain,
    },
    buttonRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: Skin.space(8),
    },
    button: {
      paddingVertical: Skin.space(6),
      paddingHorizontal: Skin.space(10),
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.surface2,
      borderWidth: 1,
      borderColor: theme.colors.warning,
    },
    buttonDisabled: {
      opacity: 0.45,
    },
    buttonText: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.warning,
    },
    readout: {
      fontSize: Skin.font(12),
      lineHeight: Skin.font(17),
      color: theme.colors.textMain,
      fontVariant: ['tabular-nums'],
    },
    warning: {
      fontSize: Skin.font(11),
      lineHeight: Skin.font(15),
      color: theme.colors.warning,
    },
  });
