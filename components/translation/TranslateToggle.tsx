import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, ViewStyle } from 'react-native';
import type { AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';
import type { TranslateState } from '@/services/translation/useTranslatable';

interface TranslateToggleProps {
  state: TranslateState;
  label: string;
  errorText?: string;
  onPress: () => void;
  theme: AppTheme;
  style?: ViewStyle;
}

/**
 * Subtle "See translation" / "See original" link rendered beneath translatable
 * text. Text + ActivityIndicator only (no icon, so no Material-icon mapping
 * needed). Stays tappable in the error state to retry.
 */
export function TranslateToggle({
  state,
  label,
  errorText,
  onPress,
  theme,
  style,
}: TranslateToggleProps) {
  const busy = state === 'downloading' || state === 'translating';
  const isError = state === 'error';
  const color = isError ? theme.colors.textMuted : theme.colors.accent;

  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      hitSlop={8}
      style={[styles.row, style]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {busy && (
        <ActivityIndicator size="small" color={theme.colors.accent} style={styles.spinner} />
      )}
      <Text style={[styles.label, { color }]}>
        {isError && errorText ? errorText : label}
      </Text>
    </Pressable>
  );
}

const styles = createSkinnable(() =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      marginTop: Skin.space(4),
      gap: Skin.space(6),
    },
    spinner: {
      transform: [{ scale: 0.8 }],
    },
    label: {
      fontSize: Skin.font(13),
      fontWeight: '500',
    },
  })
);

export default TranslateToggle;
