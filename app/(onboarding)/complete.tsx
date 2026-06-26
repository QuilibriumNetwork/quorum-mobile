/**
 * Onboarding Complete - Success screen
 *
 * Shows summary of setup and provides entry to main app.
 */

import { OnboardingLayout } from '@/components/onboarding';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth, useOnboarding } from '@/context';
import { useToast } from '@/context/ToastContext';
import { formatAddress, initializeEncryptionKeys, uploadUserRegistration } from '@/services/onboarding/keyService';
import { logger } from '@quilibrium/quorum-shared';
import { getPrivateKey } from '@/services/onboarding/secureStorage';
import { useTheme, type AppTheme } from '@/theme';
import React, { useCallback, useRef } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import * as Skin from '@/theme/skins/geometry';

export default function CompleteScreen() {
  const { theme } = useTheme();
  const { state, completeOnboarding } = useOnboarding();
  const { signIn, signOut } = useAuth();
  const { showToast } = useToast();
  const [isNavigating, setIsNavigating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const hasNavigatedRef = useRef(false);
  const styles = createStyles(theme);

  const handleStartOver = () => {
    Alert.alert(
      'Start Over',
      'This will erase all data and restart the setup process. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Start Over',
          style: 'destructive',
          onPress: async () => {
            try {
              await signOut();
              setError(null);
            } catch {
              // Sign-out cleanup failed — UI will still reset via navigation
            }
          },
        },
      ]
    );
  };

  const handleComplete = useCallback(async () => {
    // Prevent double-tap and re-entry
    if (isNavigating || hasNavigatedRef.current) return;
    setIsNavigating(true);
    hasNavigatedRef.current = true;

    try {
      setError(null);
      let userInfo = await completeOnboarding();

      if (!userInfo) {
        setError('Failed to complete setup. Please try again or start over.');
        setIsNavigating(false);
        hasNavigatedRef.current = false;
        return;
      }

      // For imported accounts, encryption keys and config were already synced during import
      // Only need to initialize for new accounts
      if (!state.isImportedAccount) {
        // Initialize encryption keys for E2E messaging
        // This generates X448 pre-keys and stores them securely
        try {
          const deviceKeyset = await initializeEncryptionKeys(userInfo.publicKey);

          // Get the private key from secure storage for signing the registration
          const privateKey = await getPrivateKey();
          if (privateKey) {
            // Upload registration to server so others can find us
            await uploadUserRegistration(
              userInfo.address,
              userInfo.publicKey,
              privateKey,
              deviceKeyset
            );
          }
        } catch (encryptionError) {
          // Non-blocking - encryption can be initialized later
          logger.warn(
            '[onboarding] encryption key init failed:',
            encryptionError instanceof Error ? encryptionError.message : encryptionError
          );
          showToast({
            type: 'error',
            title: 'Encryption Setup Failed',
            message: 'Secure messaging setup did not finish. You can retry it later in Settings.',
            duration: 8000,
          });
        }
      } else {
        // Use synced profile data from import
        if (state.syncedConfig) {
          userInfo = {
            ...userInfo,
            displayName: state.syncedConfig.name || userInfo.displayName,
            profileImage: state.syncedConfig.profileImage || userInfo.profileImage,
          };
        }
      }

      await signIn(userInfo);
      // AuthRouter in _layout.tsx will handle the redirect to home
    } catch (err) {
      setError('An error occurred while completing setup. Please try again or start over.');
      setIsNavigating(false);
      hasNavigatedRef.current = false;
    }
  }, [completeOnboarding, signIn, isNavigating, state.isImportedAccount, state.syncedConfig, showToast]);

  const privacyLabels: Record<string, string> = {
    maximum: 'Maximum Privacy',
    enhanced: 'Enhanced Privacy',
    standard: 'Standard',
  };

  return (
    <OnboardingLayout currentStep="complete">
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.successIcon}>
            <IconSymbol name="checkmark.circle.fill" size={48} color={theme.colors.success ?? '#22c55e'} />
          </View>
          <Text style={styles.title}>You're All Set!</Text>
          <Text style={styles.subtitle}>
            Your Quorum account is ready. Here's a summary of your setup.
          </Text>
        </View>

        <View style={styles.summary}>
          {/* Account */}
          <Card variant="bordered" style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <View style={styles.summaryIcon}>
                <IconSymbol name="key.fill" size={20} color={theme.colors.primary} />
              </View>
              <View style={styles.summaryContent}>
                <Text style={styles.summaryLabel}>Quorum Account</Text>
                <Text style={styles.summaryValue}>
                  {state.quorumKeys ? formatAddress(state.quorumKeys.address, 8) : 'Not set'}
                </Text>
              </View>
              <IconSymbol name="checkmark.circle.fill" size={20} color={theme.colors.success ?? '#22c55e'} />
            </View>
          </Card>

          {/* Farcaster */}
          <Card variant="bordered" style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <View style={styles.summaryIcon}>
                <IconSymbol name="person.2.fill" size={20} color={state.farcasterEnabled ? theme.colors.primary : theme.colors.textMuted} />
              </View>
              <View style={styles.summaryContent}>
                <Text style={styles.summaryLabel}>Farcaster</Text>
                <Text style={styles.summaryValue}>
                  {state.farcasterEnabled && state.farcasterAccount
                    ? `@${state.farcasterAccount.username}`
                    : 'Not connected'}
                </Text>
              </View>
              {state.farcasterEnabled ? (
                <IconSymbol name="checkmark.circle.fill" size={20} color={theme.colors.success ?? '#22c55e'} />
              ) : (
                <Text style={styles.skippedText}>Skipped</Text>
              )}
            </View>
          </Card>

          {/* Profile */}
          <Card variant="bordered" style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <View style={styles.summaryIcon}>
                <IconSymbol name="person.fill" size={20} color={state.profile.username ? theme.colors.primary : theme.colors.textMuted} />
              </View>
              <View style={styles.summaryContent}>
                <Text style={styles.summaryLabel}>Profile</Text>
                <Text style={styles.summaryValue}>
                  {state.profile.displayName || state.profile.username
                    ? state.profile.displayName || `@${state.profile.username}`
                    : 'Not set'}
                </Text>
              </View>
              {state.profile.username || state.profile.displayName ? (
                <IconSymbol name="checkmark.circle.fill" size={20} color={theme.colors.success ?? '#22c55e'} />
              ) : (
                <Text style={styles.skippedText}>Skipped</Text>
              )}
            </View>
          </Card>

          {/* Privacy */}
          <Card variant="bordered" style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <View style={styles.summaryIcon}>
                <IconSymbol name="hand.raised.fill" size={20} color={theme.colors.primary} />
              </View>
              <View style={styles.summaryContent}>
                <Text style={styles.summaryLabel}>Privacy Level</Text>
                <Text style={styles.summaryValue}>
                  {state.privacyLevel ? privacyLabels[state.privacyLevel] : 'Not set'}
                </Text>
              </View>
              <IconSymbol name="checkmark.circle.fill" size={20} color={theme.colors.success ?? '#22c55e'} />
            </View>
          </Card>
        </View>

        <View style={styles.footer}>
          {error && (
            <View style={styles.errorContainer}>
              <IconSymbol name="exclamationmark.triangle.fill" size={20} color={theme.colors.danger} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
          <Text style={styles.footerNote}>
            You can change these settings anytime in the app.
          </Text>
          <Button
            variant="primary"
            onPress={handleComplete}
            loading={isNavigating}
            style={styles.enterButton}
          >
            Enter Quorum
          </Button>
          {error && (
            <Button
              variant="ghost"
              onPress={handleStartOver}
              style={styles.startOverButton}
            >
              Start Over
            </Button>
          )}
        </View>
      </View>
    </OnboardingLayout>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    header: {
      alignItems: 'center',
      marginBottom: Skin.space(32),
    },
    successIcon: {
      marginBottom: Skin.space(16),
    },
    title: {
      fontSize: Skin.font(28),
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
    },
    summary: {
      gap: Skin.space(12),
    },
    summaryCard: {
      padding: Skin.space(16),
    },
    summaryRow: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    summaryIcon: {
      width: 40,
      height: 40,
      borderRadius: Skin.radius(10),
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: Skin.space(12),
    },
    summaryContent: {
      flex: 1,
    },
    summaryLabel: {
      fontSize: Skin.font(12),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      marginBottom: Skin.space(2),
    },
    summaryValue: {
      fontSize: Skin.font(16),
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.medium.fontFamily,
    },
    skippedText: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    footer: {
      marginTop: 'auto',
      paddingTop: Skin.space(24),
    },
    footerNote: {
      fontSize: Skin.font(12),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
      marginBottom: Skin.space(16),
    },
    enterButton: {
      width: '100%',
    },
    errorContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.danger + '15',
      borderRadius: Skin.radius(10),
      padding: Skin.space(12),
      marginBottom: Skin.space(16),
      gap: Skin.space(10),
    },
    errorText: {
      flex: 1,
      fontSize: Skin.font(13),
      color: theme.colors.danger,
      fontFamily: theme.fonts.regular.fontFamily,
      lineHeight: Skin.font(18),
    },
    startOverButton: {
      marginTop: Skin.space(12),
    },
  });
