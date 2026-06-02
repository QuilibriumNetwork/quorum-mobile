/**
 * MnemonicInputView - Input grid for 24-word mnemonic import
 */

import React, { useState, useRef } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useTheme, type AppTheme } from '@/theme';
import { Button } from '@/components/ui/Button';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { validateMnemonic, suggestWord } from '@/services/onboarding/keyService';
import * as Skin from '@/theme/skins/geometry';

interface MnemonicInputViewProps {
  onSubmit: (words: string[]) => Promise<void>;
  onBack: () => void;
  isLoading?: boolean;
  error?: string | null;
}

export function MnemonicInputView({
  onSubmit,
  onBack,
  isLoading = false,
  error,
}: MnemonicInputViewProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const [words, setWords] = useState<string[]>(Array(24).fill(''));
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const inputRefs = useRef<(TextInput | null)[]>([]);

  const { valid, invalidWords } = validateMnemonic(words);
  const filledCount = words.filter(w => w.trim().length > 0).length;

  const handleWordChange = (index: number, value: string) => {
    const newWords = [...words];
    newWords[index] = value.toLowerCase().trim();
    setWords(newWords);

    // Show suggestions
    if (value.length >= 2) {
      setSuggestions(suggestWord(value));
    } else {
      setSuggestions([]);
    }
  };

  const handleSelectSuggestion = (suggestion: string) => {
    if (focusedIndex !== null) {
      const newWords = [...words];
      newWords[focusedIndex] = suggestion;
      setWords(newWords);
      setSuggestions([]);

      // Move to next input
      if (focusedIndex < 23) {
        inputRefs.current[focusedIndex + 1]?.focus();
      }
    }
  };

  const handleSubmit = async () => {
    if (valid) {
      await onSubmit(words);
    }
  };

  const handlePaste = async (index: number, text: string) => {
    // Check if pasted text looks like a full mnemonic
    const pastedWords = text.trim().split(/\s+/);
    if (pastedWords.length >= 12) {
      // Fill in all words from paste
      const newWords = [...words];
      for (let i = 0; i < Math.min(pastedWords.length, 24); i++) {
        newWords[i] = pastedWords[i].toLowerCase();
      }
      setWords(newWords);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Enter Recovery Phrase</Text>
        <Text style={styles.subtitle}>
          Enter your 24-word recovery phrase to restore your account.
        </Text>
      </View>

      {error && (
        <View style={styles.errorContainer}>
          <IconSymbol name="exclamationmark.circle.fill" size={16} color={theme.colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {suggestions.length > 0 && focusedIndex !== null && (
        <View style={styles.suggestionsContainer}>
          {suggestions.map((suggestion, idx) => (
            <TouchableOpacity
              key={idx}
              style={styles.suggestionItem}
              onPress={() => handleSelectSuggestion(suggestion)}
            >
              <Text style={styles.suggestionText}>{suggestion}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        <View style={styles.wordGrid}>
          {words.map((word, index) => {
            const isInvalid = word.length > 0 && invalidWords.includes(index);
            const isFocused = focusedIndex === index;

            return (
              <View
                key={index}
                style={[
                  styles.wordInputContainer,
                  isFocused && styles.wordInputFocused,
                  isInvalid && styles.wordInputInvalid,
                ]}
              >
                <Text style={styles.wordNumber}>{index + 1}</Text>
                <TextInput
                  ref={ref => { inputRefs.current[index] = ref; }}
                  style={styles.wordInput}
                  value={word}
                  onChangeText={text => {
                    // Check for paste (contains spaces)
                    if (text.includes(' ')) {
                      handlePaste(index, text);
                    } else {
                      handleWordChange(index, text);
                    }
                  }}
                  onFocus={() => setFocusedIndex(index)}
                  onBlur={() => {
                    if (focusedIndex === index) {
                      setFocusedIndex(null);
                      setSuggestions([]);
                    }
                  }}
                  placeholder="word"
                  placeholderTextColor={theme.colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  returnKeyType={index < 23 ? 'next' : 'done'}
                  onSubmitEditing={() => {
                    if (index < 23) {
                      inputRefs.current[index + 1]?.focus();
                    }
                  }}
                />
              </View>
            );
          })}
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <Text style={styles.progressText}>
          {filledCount} of 24 words entered
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
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
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
    suggestionsContainer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: Skin.space(8),
      marginBottom: Skin.space(12),
    },
    suggestionItem: {
      backgroundColor: theme.colors.primary + '20',
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(6),
      borderRadius: Skin.radius(16),
    },
    suggestionText: {
      color: theme.colors.primary,
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
    },
    scrollView: {
      flex: 1,
    },
    wordGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: Skin.space(8),
    },
    wordInputContainer: {
      width: '23%',
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(8),
      borderWidth: Skin.border(1),
      borderColor: 'transparent',
      paddingHorizontal: Skin.space(8),
      paddingVertical: Skin.space(8),
    },
    wordInputFocused: {
      borderColor: theme.colors.primary,
    },
    wordInputInvalid: {
      borderColor: theme.colors.danger,
    },
    wordNumber: {
      fontSize: Skin.font(10),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.regular.fontFamily,
      width: 16,
    },
    wordInput: {
      flex: 1,
      fontSize: Skin.font(12),
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.medium.fontFamily,
      padding: 0,
    },
    footer: {
      paddingTop: Skin.space(16),
    },
    progressText: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
      marginBottom: Skin.space(16),
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
