import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useTheme } from '@/theme';
import { createTheme } from '@/theme/themes';
import * as Skin from '@/theme/skins/geometry';
import { CenterModal } from './CenterModal';

type ThemeType = ReturnType<typeof createTheme>;

export interface TypeToConfirmStat {
  label: string;
  value: string | number;
}

export interface TypeToConfirmModalProps {
  visible: boolean;
  title: string;
  /** Consequence copy — should state that this cannot be undone. */
  body: string;
  /** The word the user must type to enable the action (matched case-insensitively, trimmed). */
  keyword: string;
  /** Label for the destructive action button. */
  confirmLabel: string;
  cancelLabel?: string;
  /** Optional preview stats (e.g. channel/member counts for Delete Space). */
  stats?: TypeToConfirmStat[];
  onConfirm: () => void;
  onCancel: () => void;
  testID?: string;
}

/**
 * TypeToConfirmModal — the highest-friction guard (T3 + Delete Space). The user
 * must type a keyword (e.g. "reset" / "delete") before the destructive button
 * enables. Mirrors desktop's keyword LOGIC (not its rendering); renders through
 * mobile's skin via CenterModal.
 *
 * Backdrop tap and Android back resolve to Cancel (owned by CenterModal) and
 * reset the typed input.
 */
export function TypeToConfirmModal({
  visible,
  title,
  body,
  keyword,
  confirmLabel,
  cancelLabel = 'Cancel',
  stats,
  onConfirm,
  onCancel,
  testID,
}: TypeToConfirmModalProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [input, setInput] = useState('');

  // Clear the typed text whenever the modal closes/opens so a previous attempt
  // never leaves the button pre-armed.
  useEffect(() => {
    if (!visible) setInput('');
  }, [visible]);

  const matches = input.trim().toLowerCase() === keyword.trim().toLowerCase();

  const handleCancel = () => {
    setInput('');
    onCancel();
  };

  return (
    <CenterModal
      visible={visible}
      onCancel={handleCancel}
      accessibilityLabel={title}
      dismissOnBackdrop
      testID={testID}
    >
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{body}</Text>

        {stats && stats.length > 0 ? (
          <View style={styles.statsBlock}>
            {stats.map((s) => (
              <View key={s.label} style={styles.statRow}>
                <Text style={styles.statLabel}>{s.label}</Text>
                <Text style={styles.statValue}>{s.value}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <Text style={styles.prompt}>
          Type <Text style={styles.keyword}>{keyword}</Text> to confirm
        </Text>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={keyword}
          placeholderTextColor={theme.colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          accessibilityLabel={`Type ${keyword} to confirm`}
        />

        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.button, styles.cancelButton]}
            onPress={handleCancel}
            accessibilityRole="button"
            accessibilityLabel={cancelLabel}
          >
            <Text style={styles.cancelLabel}>{cancelLabel}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.button, matches ? styles.confirmEnabled : styles.confirmDisabled]}
            onPress={matches ? onConfirm : undefined}
            disabled={!matches}
            accessibilityRole="button"
            accessibilityLabel={confirmLabel}
            accessibilityState={{ disabled: !matches }}
          >
            <Text style={[styles.confirmLabel, !matches && styles.confirmLabelDisabled]}>
              {confirmLabel}
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
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
    body: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textSubtle,
      lineHeight: Skin.font(20),
      marginBottom: Skin.space(16),
    },
    statsBlock: {
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(10),
      padding: Skin.space(12),
      marginBottom: Skin.space(16),
      gap: Skin.space(6),
    },
    statRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    statLabel: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textSubtle,
    },
    statValue: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    prompt: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textSubtle,
      marginBottom: Skin.space(8),
    },
    keyword: {
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    input: {
      borderWidth: Skin.border(1),
      borderColor: theme.colors.border,
      borderRadius: Skin.radius(12),
      paddingVertical: Skin.space(10),
      paddingHorizontal: Skin.space(12),
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
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
      backgroundColor: theme.colors.surface3,
    },
    cancelLabel: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    confirmEnabled: {
      backgroundColor: theme.colors.danger,
    },
    confirmDisabled: {
      backgroundColor: theme.colors.surface4,
    },
    confirmLabel: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: '#fff',
    },
    confirmLabelDisabled: {
      color: theme.colors.textMuted,
    },
  });

export default TypeToConfirmModal;
