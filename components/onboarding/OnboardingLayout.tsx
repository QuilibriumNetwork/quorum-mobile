/**
 * OnboardingLayout - Shared layout wrapper for onboarding screens
 */

import React from 'react';
import {
  View,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
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

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
    >
      {scrollable ? (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {content}
        </ScrollView>
      ) : (
        content
      )}
    </KeyboardAvoidingView>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean, insets: EdgeInsets) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: isDark ? theme.colors.surface0 : theme.colors.surface1,
    },
    scrollView: {
      flex: 1,
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
