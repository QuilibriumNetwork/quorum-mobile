/**
 * Farcaster Setup - Step 2 of Onboarding (Optional)
 *
 * Import Farcaster account via recovery phrase (12 or 24 words).
 * This derives the Ethereum custody address and looks up the FID.
 */

import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Clipboard from 'expo-clipboard';
import { useTheme, type AppTheme } from '@/theme';
import { useOnboarding } from '@/context';
import { OnboardingLayout, StepNavigation } from '@/components/onboarding';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { FarcasterLogoIcon } from '@/components/ui/FarcasterLogoIcon';
import { Button } from '@/components/ui/Button';
import {
  deriveFarcasterKeys,
  lookupFarcasterAccount,
  validateFarcasterMnemonic,
} from '@/services/onboarding/farcasterService';
import {
  storeFarcasterCustodyKey,
  storeFarcasterSignerKey,
  storeFarcasterFid,
  storeFarcasterAuthToken,
  storeFarcasterAuthTokenExpiresAt,
} from '@/services/onboarding/secureStorage';
import { fetchImageAsDataUri } from '@/utils/image';
import * as Skin from '@/theme/skins/geometry';

export default function FarcasterSetupScreen() {
  const { theme } = useTheme();
  const { state, skipFarcaster, setFarcasterAccount, goBack } = useOnboarding();
  const styles = createStyles(theme);

  const [wordCount, setWordCount] = useState<12 | 24>(12);
  const [words, setWords] = useState<string[]>(Array(12).fill(''));
  const [pasteMode, setPasteMode] = useState(true);
  const [pasteText, setPasteText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const filledCount = pasteMode
    ? pasteText.trim().split(/\s+/).filter(w => w.length > 0).length
    : words.filter(w => w.trim().length > 0).length;
  const isComplete = pasteMode
    ? (filledCount === 12 || filledCount === 24)
    : filledCount === wordCount;

  const handleWordCountChange = (count: 12 | 24) => {
    setWordCount(count);
    if (count > words.length) {
      setWords([...words, ...Array(count - words.length).fill('')]);
    } else {
      setWords(words.slice(0, count));
    }
  };

  const handleWordChange = (index: number, value: string) => {
    // Handle paste of full mnemonic
    if (value.includes(' ')) {
      const pastedWords = value.trim().split(/\s+/);
      const pastedCount = pastedWords.length;

      // Auto-detect 12 or 24 word mnemonic
      if (pastedCount === 12 || pastedCount === 24) {
        const newWords = Array(pastedCount).fill('');
        for (let i = 0; i < pastedCount; i++) {
          newWords[i] = pastedWords[i]?.toLowerCase() ?? '';
        }
        setWordCount(pastedCount as 12 | 24);
        setWords(newWords);
        setError(null);
        return;
      }
    }

    const newWords = [...words];
    newWords[index] = value.toLowerCase().trim();
    setWords(newWords);
    setError(null);
  };

  const handlePasteFromClipboard = useCallback(async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (!text || !text.trim()) {
        setError('Clipboard is empty');
        return;
      }
      setPasteText(text.trim());
      setError(null);
    } catch {
      setError('Failed to read clipboard');
    }
  }, []);

  const handlePasteTextChange = useCallback((text: string) => {
    setPasteText(text);
    setError(null);
  }, []);

  const handleSubmit = async () => {
    if (!isComplete || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      // Get words from either paste mode or individual inputs
      const cleanWords = pasteMode
        ? pasteText.trim().split(/\s+/).map(w => w.toLowerCase().trim())
        : words.map(w => w.toLowerCase().trim());
      if (!validateFarcasterMnemonic(cleanWords)) {
        setError('Invalid recovery phrase. Please check your words.');
        setIsSubmitting(false);
        return;
      }

      // Derive keys from mnemonic
      const keys = deriveFarcasterKeys(cleanWords);

      // Look up FID from custody address using official Farcaster API
      const account = await lookupFarcasterAccount(keys.custodyAddress, keys.custodyPrivateKey);

      if (!account) {
        setError(`No Farcaster account found for this recovery phrase.`);
        setIsSubmitting(false);
        return;
      }

      // Store Farcaster keys and auth token securely
      const storePromises = [
        storeFarcasterCustodyKey(keys.custodyPrivateKey),
        storeFarcasterSignerKey(keys.signerPrivateKey),
        storeFarcasterFid(account.fid),
      ];
      if (account.authToken) {
        storePromises.push(storeFarcasterAuthToken(account.authToken));
        if (account.authTokenExpiresAt != null) {
          storePromises.push(storeFarcasterAuthTokenExpiresAt(account.authTokenExpiresAt));
        }
      }
      await Promise.all(storePromises);

      // Fetch profile image as data URI if available
      let pfpDataUri: string | undefined;
      if (account.pfpUrl) {
        const dataUri = await fetchImageAsDataUri(account.pfpUrl);
        if (dataUri) {
          pfpDataUri = dataUri;
        }
      }

      // Success - set the account and continue (pre-fill profile from Farcaster data)
      setFarcasterAccount({
        fid: account.fid,
        username: account.username,
        displayName: account.displayName,
        pfpUrl: pfpDataUri,  // Use data URI instead of remote URL
        signerPublicKey: keys.signerPublicKey,
        custodyAddress: keys.custodyAddress,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import account');
      setIsSubmitting(false);
    }
  };

  return (
    <OnboardingLayout
      currentStep="farcaster-setup"
      footer={
        <StepNavigation
          onBack={goBack}
          onNext={handleSubmit}
          onSkip={skipFarcaster}
          showSkip={true}
          skipLabel="Skip for now"
          showBack={true}
          nextLabel="Import"
          nextDisabled={!isComplete || isSubmitting}
          isLoading={isSubmitting}
        />
      }
    >
      <View style={styles.header}>
        <View style={styles.iconContainer}>
          <FarcasterLogoIcon size={32} color={theme.colors.primary} />
        </View>
        <Text style={styles.title}>Import Farcaster</Text>
        <Text style={styles.subtitle}>
          Enter your Farcaster recovery phrase to connect your account. This is optional and can be done later in Settings.
        </Text>
      </View>

      {/* Input mode toggle */}
      <View style={styles.wordCountToggle}>
        <TouchableOpacity
          style={[styles.wordCountOption, pasteMode && styles.wordCountOptionActive]}
          onPress={() => setPasteMode(true)}
        >
          <Text style={[styles.wordCountText, pasteMode && styles.wordCountTextActive]}>
            Paste phrase
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.wordCountOption, !pasteMode && styles.wordCountOptionActive]}
          onPress={() => setPasteMode(false)}
        >
          <Text style={[styles.wordCountText, !pasteMode && styles.wordCountTextActive]}>
            Word by word
          </Text>
        </TouchableOpacity>
      </View>

      {error && (
        <View style={styles.errorContainer}>
          <IconSymbol name="exclamationmark.circle.fill" size={16} color={theme.colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {pasteMode ? (
        <View style={styles.pasteContainer}>
          <TextInput
            style={styles.pasteInput}
            value={pasteText}
            onChangeText={handlePasteTextChange}
            placeholder="Enter or paste your recovery phrase here..."
            placeholderTextColor={theme.colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            textAlignVertical="top"
            editable={!isSubmitting}
          />
          <TouchableOpacity style={styles.pasteButton} onPress={handlePasteFromClipboard}>
            <IconSymbol name="doc.on.clipboard" size={18} color={theme.colors.primary} />
            <Text style={styles.pasteButtonText}>Paste from clipboard</Text>
          </TouchableOpacity>
          <View style={styles.footer}>
            <Text style={styles.progressText}>
              {filledCount} word{filledCount !== 1 ? 's' : ''} detected
              {filledCount === 12 || filledCount === 24 ? ' ✓' : ''}
            </Text>
          </View>
        </View>
      ) : (
        <>
          <View style={styles.wordCountToggleSecondary}>
            <TouchableOpacity
              style={[styles.wordCountOptionSmall, wordCount === 12 && styles.wordCountOptionActive]}
              onPress={() => handleWordCountChange(12)}
            >
              <Text style={[styles.wordCountTextSmall, wordCount === 12 && styles.wordCountTextActive]}>12</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.wordCountOptionSmall, wordCount === 24 && styles.wordCountOptionActive]}
              onPress={() => handleWordCountChange(24)}
            >
              <Text style={[styles.wordCountTextSmall, wordCount === 24 && styles.wordCountTextActive]}>24</Text>
            </TouchableOpacity>
          </View>
          {/* No inner ScrollView — OnboardingLayout's KeyboardAwareScrollView
              owns scrolling, so the grid is a plain View (avoids nested
              vertical scrolls and lets a focused word scroll above the
              keyboard). */}
          <View style={styles.wordGrid}>
            {words.map((word, index) => (
              <View key={index} style={styles.wordInputContainer}>
                <Text style={styles.wordNumber}>{index + 1}</Text>
                <TextInput
                  style={styles.wordInput}
                  value={word}
                  onChangeText={text => handleWordChange(index, text)}
                  placeholder="word"
                  placeholderTextColor={theme.colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isSubmitting}
                />
              </View>
            ))}
          </View>
          <View style={styles.footer}>
            <Text style={styles.progressText}>
              {filledCount} of {wordCount} words entered
            </Text>
          </View>
        </>
      )}
    </OnboardingLayout>
  );
}

// Styles

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    header: {
      alignItems: 'center',
      marginBottom: Skin.space(24),
    },
    iconContainer: {
      width: 64,
      height: 64,
      borderRadius: Skin.radius(32),
      backgroundColor: theme.colors.primary + '20',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: Skin.space(16),
    },
    title: {
      fontSize: Skin.font(24),
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      textAlign: 'center',
      marginBottom: Skin.space(8),
    },
    subtitle: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
      lineHeight: Skin.font(20),
      paddingHorizontal: Skin.space(16),
    },
    wordCountToggle: {
      flexDirection: 'row',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(10),
      padding: Skin.space(4),
      marginBottom: Skin.space(16),
    },
    wordCountOption: {
      flex: 1,
      paddingVertical: Skin.space(8),
      paddingHorizontal: Skin.space(16),
      borderRadius: Skin.radius(8),
      alignItems: 'center',
    },
    wordCountOptionActive: {
      backgroundColor: theme.colors.surface1,
    },
    wordCountText: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.medium.fontFamily,
    },
    wordCountTextActive: {
      color: theme.colors.textStrong,
    },
    wordGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: Skin.space(8),
    },
    wordInputContainer: {
      width: '31%',
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(8),
      paddingHorizontal: Skin.space(8),
      paddingVertical: Skin.space(8),
    },
    wordNumber: {
      fontSize: Skin.font(10),
      color: theme.colors.textSubtle,
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
    pasteContainer: {
      flex: 1,
    },
    pasteInput: {
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      fontSize: Skin.font(16),
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.regular.fontFamily,
      minHeight: 120,
      lineHeight: Skin.font(24),
    },
    pasteButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Skin.space(8),
      marginTop: Skin.space(12),
      paddingVertical: Skin.space(12),
      backgroundColor: theme.colors.primary + '15',
      borderRadius: Skin.radius(10),
    },
    pasteButtonText: {
      fontSize: Skin.font(15),
      color: theme.colors.primary,
      fontFamily: theme.fonts.medium.fontFamily,
    },
    wordCountToggleSecondary: {
      flexDirection: 'row',
      gap: Skin.space(8),
      marginBottom: Skin.space(12),
      justifyContent: 'center',
    },
    wordCountOptionSmall: {
      paddingVertical: Skin.space(6),
      paddingHorizontal: Skin.space(16),
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.surface3,
    },
    wordCountTextSmall: {
      fontSize: Skin.font(13),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.medium.fontFamily,
    },
    footer: {
      marginTop: 'auto',
      paddingTop: Skin.space(16),
    },
    progressText: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
      marginBottom: Skin.space(16),
    },
  });
