/**
 * Account Setup - Step 1 of Onboarding
 *
 * Options:
 * - Create new account (generate ed448 keys)
 * - Import existing account (mnemonic, hex, or file)
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, Alert, Image, ActivityIndicator } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useTheme, type AppTheme } from '@/theme';
import { useOnboarding, useAuth } from '@/context';
import { OnboardingLayout } from '@/components/onboarding';
import { IconSymbol } from '@/components/ui/IconSymbol';
import * as Skin from '@/theme/skins/geometry';

const QuorumLogo = require('@/assets/images/quorum-symbol-bg-blue.png');
import MnemonicDisplayView from '@/components/onboarding/MnemonicDisplayView';
import MnemonicInputView from '@/components/onboarding/MnemonicInputView';
import HexInputView from '@/components/onboarding/HexInputView';
import QRScannerView from '@/components/onboarding/QRScannerView';

type ViewMode = 'choose' | 'generating' | 'show-mnemonic' | 'import-mnemonic' | 'import-hex' | 'import-qr';

export default function AccountSetupScreen() {
  const { theme } = useTheme();
  const { signOut } = useAuth();
  const {
    state,
    createNewAccount,
    importFromMnemonic,
    importFromHex,
    confirmMnemonicBackup,
    clearError,
  } = useOnboarding();

  const [viewMode, setViewMode] = useState<ViewMode>(
    state.quorumKeys ? 'show-mnemonic' : 'choose'
  );

  const styles = createStyles(theme);

  const handleResetState = () => {
    Alert.alert(
      'Reset All State',
      'This will wipe all data including keys, messages, and settings. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            try {
              await signOut();
              Alert.alert('Reset Complete', 'All data has been cleared.');
            } catch (error) {
              Alert.alert('Error', 'Failed to reset state.');
            }
          },
        },
      ]
    );
  };

  const handleCreateNew = async () => {
    setViewMode('generating');
    await createNewAccount();
    if (!state.error) {
      setViewMode('show-mnemonic');
    } else {
      setViewMode('choose');
    }
  };

  const handleImportMnemonic = async (words: string[]) => {
    await importFromMnemonic(words);
  };

  const handleImportHex = async (hex: string) => {
    await importFromHex(hex);
  };

  const handleConfirmBackup = () => {
    Alert.alert(
      'Confirm Backup',
      'Have you saved your recovery phrase in a safe place? You will need it to recover your account.',
      [
        { text: 'Go Back', style: 'cancel' },
        {
          text: 'Yes, I saved it',
          onPress: confirmMnemonicBackup,
        },
      ]
    );
  };

  // Show mnemonic after generation
  if (viewMode === 'show-mnemonic' && state.generatedMnemonic) {
    return (
      <OnboardingLayout currentStep="account-setup">
        <MnemonicDisplayView
          mnemonic={state.generatedMnemonic}
          address={state.quorumKeys?.address}
          onConfirm={handleConfirmBackup}
          onBack={() => setViewMode('choose')}
        />
      </OnboardingLayout>
    );
  }

  // Import via mnemonic
  if (viewMode === 'import-mnemonic') {
    // The view renders its own OnboardingLayout (scrollable + sticky footer).
    return (
      <MnemonicInputView
        onSubmit={handleImportMnemonic}
        onBack={() => setViewMode('choose')}
        isLoading={state.isLoading}
        error={state.error}
      />
    );
  }

  // Import via hex
  if (viewMode === 'import-hex') {
    return (
      <HexInputView
        onSubmit={handleImportHex}
        onBack={() => setViewMode('choose')}
        isLoading={state.isLoading}
        error={state.error}
      />
    );
  }

  // Import via QR code scan
  if (viewMode === 'import-qr') {
    return (
      <QRScannerView
        onScan={handleImportHex}
        onBack={() => setViewMode('choose')}
        isLoading={state.isLoading}
        error={state.error}
      />
    );
  }

  // Main choice screen
  return (
    <OnboardingLayout currentStep="account-setup">
      <View style={styles.content}>
        <View style={styles.header}>
          <TouchableOpacity onLongPress={handleResetState} delayLongPress={1000}>
            <Image source={QuorumLogo} style={styles.logo} />
          </TouchableOpacity>
          <Text style={styles.title}>Welcome to Quorum</Text>
          <Text style={styles.subtitle}>
            Create a new account or import an existing one to get started.
          </Text>
        </View>

        {state.error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{state.error}</Text>
            <TouchableOpacity onPress={clearError}>
              <Text style={styles.errorDismiss}>Dismiss</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.mainAction}>
          <TouchableOpacity
            style={[styles.createButton, state.isLoading && styles.buttonDisabled]}
            onPress={handleCreateNew}
            disabled={state.isLoading}
            activeOpacity={0.8}
          >
            {state.isLoading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <IconSymbol name="plus.circle.fill" size={22} color="#fff" />
            )}
            <Text style={styles.createButtonText}>
              {state.isLoading ? 'Creating Account...' : 'Create New Account'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or import existing</Text>
          <View style={styles.dividerLine} />
        </View>

        <View style={styles.importOptions}>
          <TouchableOpacity
            style={styles.importButton}
            onPress={() => setViewMode('import-mnemonic')}
            disabled={state.isLoading}
          >
            <IconSymbol name="rectangle.grid.2x2" size={18} color={theme.colors.textSubtle} />
            <Text style={styles.importButtonText}>Recovery Phrase</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.importButton}
            onPress={() => setViewMode('import-hex')}
            disabled={state.isLoading}
          >
            <IconSymbol name="number" size={18} color={theme.colors.textSubtle} />
            <Text style={styles.importButtonText}>Private Key</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.importButton}
            onPress={() => setViewMode('import-qr')}
            disabled={state.isLoading}
          >
            <IconSymbol name="qrcode.viewfinder" size={18} color={theme.colors.textSubtle} />
            <Text style={styles.importButtonText}>Scan QR</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.footer}>
        <Text style={styles.securityNote}>
          Your private key never leaves your device and is stored securely using device encryption.
        </Text>
      </View>
    </OnboardingLayout>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    content: {
      flex: 1,
      justifyContent: 'center',
    },
    header: {
      alignItems: 'center',
      marginBottom: Skin.space(40),
    },
    logo: {
      width: 80,
      height: 80,
      borderRadius: Skin.radius(40),
      marginBottom: Skin.space(20),
    },
    title: {
      fontSize: Skin.font(26),
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      textAlign: 'center',
      marginBottom: Skin.space(8),
    },
    subtitle: {
      fontSize: Skin.font(15),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
      lineHeight: Skin.font(22),
    },
    errorContainer: {
      backgroundColor: theme.colors.danger + '20',
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      marginBottom: Skin.space(16),
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    errorText: {
      color: theme.colors.danger,
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      flex: 1,
    },
    errorDismiss: {
      color: theme.colors.danger,
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      marginLeft: Skin.space(12),
    },
    mainAction: {
      marginBottom: Skin.space(24),
    },
    createButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(14),
      paddingVertical: Skin.space(16),
      paddingHorizontal: Skin.space(24),
      gap: Skin.space(10),
    },
    buttonDisabled: {
      opacity: 0.6,
    },
    createButtonText: {
      fontSize: Skin.font(17),
      color: '#fff',
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    divider: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: Skin.space(20),
    },
    dividerLine: {
      flex: 1,
      height: 1,
      backgroundColor: theme.colors.surface5,
    },
    dividerText: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.regular.fontFamily,
      paddingHorizontal: Skin.space(16),
    },
    importOptions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: Skin.space(12),
    },
    importButton: {
      flexBasis: '47%',
      flexGrow: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      paddingVertical: Skin.space(14),
      paddingHorizontal: Skin.space(12),
      gap: Skin.space(6),
    },
    importButtonText: {
      fontSize: Skin.font(13),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
    },
    footer: {
      paddingTop: Skin.space(24),
      paddingBottom: Skin.space(8),
    },
    securityNote: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
      lineHeight: Skin.font(18),
    },
  });
