/**
 * OnboardingLayout - Shared layout wrapper for onboarding screens
 */

import React from 'react';
import {
  View,
  StyleSheet,
} from 'react-native';
import { KeyboardAwareScrollView, KeyboardStickyView } from 'react-native-keyboard-controller';
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
  /** Bottom action row (e.g. StepNavigation). Pinned and lifted above the
   *  keyboard so the primary button stays tappable while typing. */
  footer?: React.ReactNode;
}

export function OnboardingLayout({
  children,
  currentStep,
  showStepIndicator = true,
  scrollable = true,
  footer,
}: OnboardingLayoutProps) {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();

  const styles = createStyles(theme, isDark, insets);

  const content = (
    // Without a footer, the children own the bottom of the screen, so they need
    // the safe-area inset themselves; with a footer, the footer carries it.
    <View style={[styles.content, !footer && styles.contentBottomInset]}>
      {showStepIndicator && currentStep !== 'complete' && (
        <StepIndicator currentStep={currentStep} />
      )}
      {children}
    </View>
  );

  // Footer rides above the keyboard so Back/Continue stay reachable while a
  // field is focused.
  const footerNode = footer ? (
    <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
      <View style={styles.footer}>{footer}</View>
    </KeyboardStickyView>
  ) : null;

  if (!scrollable) {
    return (
      <View style={styles.container}>
        {content}
        {footerNode}
      </View>
    );
  }

  // KeyboardAwareScrollView auto-scrolls the focused field above the keyboard on
  // both platforms (and under edge-to-edge), replacing a KeyboardAvoidingView
  // that was a no-op on Android. Footer is pinned outside the scroll.
  return (
    <View style={styles.container}>
      <KeyboardAwareScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        bottomOffset={Skin.space(24)}
      >
        {content}
      </KeyboardAwareScrollView>
      {footerNode}
    </View>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean, insets: EdgeInsets) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: isDark ? theme.colors.surface0 : theme.colors.surface1,
    },
    scroll: {
      flex: 1,
    },
    scrollContent: {
      flexGrow: 1,
    },
    content: {
      flex: 1,
      paddingTop: insets.top + 16,
      paddingHorizontal: Skin.space(24),
    },
    contentBottomInset: {
      paddingBottom: insets.bottom + 16,
    },
    footer: {
      paddingHorizontal: Skin.space(24),
      paddingBottom: insets.bottom + 16,
      backgroundColor: isDark ? theme.colors.surface0 : theme.colors.surface1,
    },
  });

export default OnboardingLayout;
