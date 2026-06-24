/**
 * HexInputView - Input for hex-encoded private key import
 */

import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Clipboard from 'expo-clipboard';
import { useTheme, type AppTheme } from '@/theme';
import { Button } from '@/components/ui/Button';
import { IconSymbol } from '@/components/ui/IconSymbol';
import * as Skin from '@/theme/skins/geometry';

interface HexInputViewProps {
  onSubmit: (hex: string) => Promise<void>;
  onBack: () => void;
  isLoading?: boolean;
  error?: string | null;
}

// ed448 private key is 57 bytes = 114 hex characters
const EXPECTED_HEX_LENGTH = 114;

export function HexInputView({
  onSubmit,
  onBack,
  isLoading = false,
  error,
}: HexInputViewProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme, insets);

  const [hexInput, setHexInput] = useState('');

  // Validate hex string
  const cleanHex = hexInput.replace(/^0x/i, '').replace(/\s/g, '').toLowerCase();
  const isValidHex = /^[0-9a-f]*$/.test(cleanHex);
  const isCorrectLength = cleanHex.length === EXPECTED_HEX_LENGTH;
  const isValid = isValidHex && isCorrectLength;

  const handlePaste = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) {
      setHexInput(text.trim());
    }
  };

  const handleSubmit = async () => {
    if (isValid) {
      await onSubmit(cleanHex);
    }
  };

  const getValidationMessage = () => {
    if (hexInput.length === 0) return null;
    if (!isValidHex) return 'Invalid characters. Use only 0-9 and a-f.';
    if (cleanHex.length < EXPECTED_HEX_LENGTH) {
      return `Key too short (${cleanHex.length}/${EXPECTED_HEX_LENGTH} characters)`;
    }
    if (cleanHex.length > EXPECTED_HEX_LENGTH) {
      return `Key too long (${cleanHex.length}/${EXPECTED_HEX_LENGTH} characters)`;
    }
    return null;
  };

  const validationMessage = getValidationMessage();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Import Private Key</Text>
        <Text style={styles.subtitle}>
          Enter your ed448 private key in hexadecimal format (114 characters).
        </Text>
      </View>

      {error && (
        <View style={styles.errorContainer}>
          <IconSymbol name="exclamationmark.circle.fill" size={16} color={theme.colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.inputContainer}>
        <View style={styles.inputHeader}>
          <Text style={styles.inputLabel}>Private Key (Hex)</Text>
          <TouchableOpacity onPress={handlePaste} style={styles.pasteButton}>
            <IconSymbol name="doc.on.clipboard" size={16} color={theme.colors.primary} />
            <Text style={styles.pasteText}>Paste</Text>
          </TouchableOpacity>
        </View>

        <TextInput
          style={[
            styles.textInput,
            validationMessage && styles.textInputInvalid,
            isValid && styles.textInputValid,
          ]}
          value={hexInput}
          onChangeText={setHexInput}
          placeholder="Enter or paste hex key..."
          placeholderTextColor={theme.colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          multiline
          numberOfLines={4}
        />

        {validationMessage && (
          <Text style={styles.validationError}>{validationMessage}</Text>
        )}

        {isValid && (
          <View style={styles.validIndicator}>
            <IconSymbol name="checkmark.circle.fill" size={16} color={theme.colors.success ?? '#22c55e'} />
            <Text style={styles.validText}>Valid private key format</Text>
          </View>
        )}

        <Text style={styles.charCount}>
          {cleanHex.length} / {EXPECTED_HEX_LENGTH} characters
        </Text>
      </View>

      <View style={styles.warning}>
        <IconSymbol name="lock.shield.fill" size={20} color={theme.colors.warning ?? '#f59e0b'} />
        <Text style={styles.warningText}>
          Never share your private key. Anyone with this key has full access to your account.
        </Text>
      </View>

      {/* Buttons ride above the keyboard so Import Account stays tappable
          while the key field is focused. marginTop:auto pins them to the
          bottom with a clear gap above. */}
      <KeyboardStickyView style={styles.stickyFooter} offset={{ closed: 0, opened: insets.bottom }}>
        <View style={styles.footer}>
          <View style={styles.buttons}>
            <Button variant="secondary" onPress={onBack} style={styles.backButton}>
              Back
            </Button>
            <Button
              variant="primary"
              onPress={handleSubmit}
              disabled={!isValid || isLoading}
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
      marginBottom: Skin.space(24),
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
    inputContainer: {
      marginBottom: Skin.space(24),
    },
    inputHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: Skin.space(8),
    },
    inputLabel: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.medium.fontFamily,
    },
    pasteButton: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    pasteText: {
      fontSize: Skin.font(14),
      color: theme.colors.primary,
      fontFamily: theme.fonts.medium.fontFamily,
      marginLeft: Skin.space(4),
    },
    textInput: {
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      borderWidth: Skin.border(1),
      borderColor: 'transparent',
      padding: Skin.space(16),
      fontSize: Skin.font(14),
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.mono?.fontFamily ?? 'monospace',
      minHeight: 120,
      textAlignVertical: 'top',
    },
    textInputInvalid: {
      borderColor: theme.colors.danger,
    },
    textInputValid: {
      borderColor: theme.colors.success ?? '#22c55e',
    },
    validationError: {
      fontSize: Skin.font(12),
      color: theme.colors.danger,
      fontFamily: theme.fonts.regular.fontFamily,
      marginTop: Skin.space(8),
    },
    validIndicator: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: Skin.space(8),
    },
    validText: {
      fontSize: Skin.font(12),
      color: theme.colors.success ?? '#22c55e',
      fontFamily: theme.fonts.regular.fontFamily,
      marginLeft: Skin.space(4),
    },
    charCount: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.regular.fontFamily,
      marginTop: Skin.space(8),
      textAlign: 'right',
    },
    warning: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor: (theme.colors.warning ?? '#f59e0b') + '15',
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      marginBottom: Skin.space(24),
    },
    warningText: {
      flex: 1,
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.regular.fontFamily,
      marginLeft: Skin.space(12),
      lineHeight: Skin.font(20),
    },
    stickyFooter: {
      marginTop: 'auto',
    },
    footer: {
      paddingBottom: insets.bottom + Skin.space(8),
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

export default HexInputView;
