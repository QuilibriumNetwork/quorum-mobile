/**
 * StepIndicator - Shows progress through onboarding steps
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme, type AppTheme } from '@/theme';
import type { OnboardingStep } from '@/context';
import * as Skin from '@/theme/skins/geometry';

const STEPS: { key: OnboardingStep; label: string }[] = [
  { key: 'account-setup', label: 'Account' },
  { key: 'farcaster-setup', label: 'Social' },
  { key: 'profile-setup', label: 'Profile' },
  // { key: 'privacy-setup', label: 'Privacy' }, // Temporarily hidden
];

interface StepIndicatorProps {
  currentStep: OnboardingStep;
}

export function StepIndicator({ currentStep }: StepIndicatorProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const currentIndex = STEPS.findIndex(s => s.key === currentStep);

  return (
    <View style={styles.container}>
      <View style={styles.dotsContainer}>
        {STEPS.map((step, index) => {
          const isActive = index === currentIndex;
          const isCompleted = index < currentIndex;

          return (
            <View key={step.key} style={styles.stepItem}>
              <View
                style={[
                  styles.dot,
                  isActive && styles.dotActive,
                  isCompleted && styles.dotCompleted,
                ]}
              >
                {isCompleted && (
                  <Text style={styles.checkmark}>✓</Text>
                )}
                {isActive && (
                  <Text style={styles.stepNumber}>{index + 1}</Text>
                )}
              </View>
              {index < STEPS.length - 1 && (
                <View
                  style={[
                    styles.connector,
                    isCompleted && styles.connectorCompleted,
                  ]}
                />
              )}
            </View>
          );
        })}
      </View>
      <Text style={styles.stepLabel}>
        Step {currentIndex + 1} of {STEPS.length}: {STEPS[currentIndex]?.label}
      </Text>
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      alignItems: 'center',
      marginBottom: Skin.space(32),
    },
    dotsContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: Skin.space(12),
    },
    stepItem: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    dot: {
      width: 32,
      height: 32,
      borderRadius: Skin.radius(16),
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dotActive: {
      backgroundColor: theme.colors.primary,
    },
    dotCompleted: {
      backgroundColor: theme.colors.success ?? theme.colors.primary,
    },
    connector: {
      width: 24,
      height: 2,
      backgroundColor: theme.colors.surface3,
      marginHorizontal: Skin.space(4),
    },
    connectorCompleted: {
      backgroundColor: theme.colors.success ?? theme.colors.primary,
    },
    stepNumber: {
      color: '#fff',
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    checkmark: {
      color: '#fff',
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
    },
    stepLabel: {
      color: theme.colors.textSubtle,
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
    },
  });

export default StepIndicator;
