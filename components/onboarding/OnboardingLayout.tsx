/**
 * OnboardingLayout - Shared layout wrapper for onboarding screens
 */

import React from 'react';
import {
  View,
  StyleSheet,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import StepIndicator from './StepIndicator';
import type { OnboardingStep } from '@/context';
import * as Skin from '@/theme/skins/geometry';

interface OnboardingLayoutProps {
  children: React.ReactNode;
  currentStep: OnboardingStep;
  showStepIndicator?: boolean;
  scrollable?: boolean;
}

export function OnboardingLayout({
  children,
  currentStep,
  showStepIndicator = true,
  scrollable = true,
}: OnboardingLayoutProps) {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();

  const styles = createStyles(theme, isDark, insets);

  const content = (
    <View style={styles.content}>
      {showStepIndicator && currentStep !== 'complete' && (
        <StepIndicator currentStep={currentStep} />
      )}
      {children}
    </View>
  );

  if (!scrollable) {
    return <View style={styles.container}>{content}</View>;
  }

  // KeyboardAwareScrollView (react-native-keyboard-controller) auto-scrolls the
  // focused input above the keyboard on BOTH platforms and works correctly
  // under edge-to-edge — unlike the previous KeyboardAvoidingView, which was a
  // no-op on Android (behavior=undefined), letting the keyboard cover the
  // Farcaster seed-phrase fields during onboarding (issue #27). Same library
  // the chat composer already uses.
  return (
    <KeyboardAwareScrollView
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      bottomOffset={Skin.space(24)}
    >
      {content}
    </KeyboardAwareScrollView>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean, insets: EdgeInsets) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: isDark ? theme.colors.surface0 : theme.colors.surface1,
    },
    scrollContent: {
      flexGrow: 1,
    },
    content: {
      flex: 1,
      paddingTop: insets.top + 16,
      paddingBottom: insets.bottom + 16,
      paddingHorizontal: Skin.space(24),
    },
  });

export default OnboardingLayout;
