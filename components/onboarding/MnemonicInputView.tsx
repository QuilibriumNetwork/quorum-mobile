/**
 * MnemonicInputView — single text field for importing a BIP-39 recovery
 * phrase. Accepts any valid length (12 / 15 / 18 / 21 / 24 words); the user
 * just pastes or types the whole phrase.
 */

import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, type AppTheme } from '@/theme';
import { Button } from '@/components/ui/Button';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { validateMnemonic } from '@/services/onboarding/keyService';
import * as Skin from '@/theme/skins/geometry';

interface MnemonicInputViewProps {
  onSubmit: (words: string[]) => Promise<void>;
  onBack: () => void;
  isLoading?: boolean;
  error?: string | null;
}

const VALID_COUNTS = [12, 15, 18, 21, 24];

export function MnemonicInputView({
  onSubmit,
  onBack,
  isLoading = false,
  error,
}: MnemonicInputViewProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme, insets);

  const [phrase, setPhrase] = useState('');

  // Split on any whitespace; ignore stray blanks (e.g. a trailing space).
  const words = phrase.trim().length > 0 ? phrase.trim().split(/\s+/) : [];
  const { valid, invalidWords } = validateMnemonic(words);

  // A short, specific hint so the user knows what's wrong.
  let hint = '';
  if (words.length > 0) {
    if (invalidWords.length > 0) {
      hint = `Word ${invalidWords[0] + 1} ("${words[invalidWords[0]]}") isn’t a recovery word`;
    } else if (!VALID_COUNTS.includes(words.length)) {
      hint = `${words.length} words — a phrase is 12 or 24 words`;
    } else if (!valid) {
      hint = 'This recovery phrase is invalid (checksum failed)';
    } else {
      hint = `${words.length}-word phrase ✓`;
    }
  }

  const handleSubmit = async () => {
    if (valid) {
      await onSubmit(words);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Enter Recovery Phrase</Text>
        <Text style={styles.subtitle}>
          Paste or type your 12- or 24-word recovery phrase to restore your account.
        </Text>
      </View>

      {error && (
        <View style={styles.errorContainer}>
          <IconSymbol name="exclamationmark.circle.fill" size={16} color={theme.colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <TextInput
        style={[
          styles.phraseInput,
          words.length > 0 && !valid && styles.phraseInputInvalid,
          valid && styles.phraseInputValid,
        ]}
        value={phrase}
        onChangeText={(t) => setPhrase(t.toLowerCase())}
        placeholder="word1 word2 word3 …"
        placeholderTextColor={theme.colors.textMuted}
        multiline
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect={false}
        spellCheck={false}
        textAlignVertical="top"
        returnKeyType="done"
      />

      {/* Buttons ride above the keyboard so Import Account stays tappable
          while the phrase field is focused. */}
      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
        <View style={styles.footer}>
          <Text style={[styles.hint, valid && { color: theme.colors.success }, words.length > 0 && !valid && { color: theme.colors.danger }]}>
            {hint || ' '}
          </Text>

          <View style={styles.buttons}>
            <Button variant="secondary" onPress={onBack} style={styles.backButton}>
              Back
            </Button>
            <Button
              variant="primary"
              onPress={handleSubmit}
              disabled={!valid || isLoading}
              loading={isLoading}
              style={styles.submitButton}
            >
              Import Account
            </Button>
          </View>
        </View>
      </KeyboardStickyView>
    </View>
  );
}

const createStyles = (theme: AppTheme, insets: { bottom: number }) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    header: {
      marginBottom: Skin.space(16),
    },
    title: {
      fontSize: Skin.font(24),
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      marginBottom: Skin.space(8),
    },
    subtitle: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      lineHeight: Skin.font(20),
    },
    errorContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.danger + '15',
      borderRadius: Skin.radius(8),
      padding: Skin.space(12),
      marginBottom: Skin.space(16),
    },
    errorText: {
      color: theme.colors.danger,
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      marginLeft: Skin.space(8),
      flex: 1,
    },
    phraseInput: {
      flex: 1,
      minHeight: 140,
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      borderWidth: Skin.border(1),
      borderColor: 'transparent',
      padding: Skin.space(14),
      fontSize: Skin.font(16),
      lineHeight: Skin.font(24),
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.medium.fontFamily,
    },
    phraseInputInvalid: {
      borderColor: theme.colors.danger,
    },
    phraseInputValid: {
      borderColor: theme.colors.success,
    },
    footer: {
      paddingTop: Skin.space(16),
      paddingBottom: insets.bottom + Skin.space(8),
    },
    hint: {
      fontSize: Skin.font(13),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
      marginBottom: Skin.space(16),
      minHeight: Skin.font(18),
    },
    buttons: {
      flexDirection: 'row',
      gap: Skin.space(12),
    },
    backButton: {
      flex: 1,
    },
    submitButton: {
      flex: 2,
    },
  });

export default MnemonicInputView;
