/**
 * OnboardingLayout - Shared layout wrapper for onboarding screens
 */

import React from 'react';
import {
  View,
  StyleSheet,
} from 'react-native';
import { KeyboardStickyView, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
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

  // Keyboard height (the library reports it negative-going: 0 -> -kbHeight).
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();

  // A spacer at the bottom of the scroll content that grows by the keyboard
  // height. This GROWS the scrollable area (rather than relying on
  // KeyboardAwareScrollView's offset math, which doesn't scroll when content
  // only marginally overflows — issue kirillzyusko/react-native-keyboard-controller#1394),
  // so a focused field can always be scrolled into view.
  const keyboardSpacerStyle = useAnimatedStyle(() => ({
    height: Math.max(0, -keyboardHeight.value),
  }));

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

  // Plain scroll + a keyboard-height spacer: the scroll area grows with the
  // keyboard so the focused field reliably scrolls into view on the first
  // focus (unlike KeyboardAwareScrollView's offset approach — see #1394).
  return (
    <View style={styles.container}>
      <Animated.ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {content}
        <Animated.View style={keyboardSpacerStyle} />
      </Animated.ScrollView>
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
      flexGrow: 1,
      paddingTop: insets.top + 16,
      paddingHorizontal: Skin.space(24),
    },
    contentBottomInset: {
      paddingBottom: insets.bottom + 16,
    },
    footer: {
      // Opaque background so the footer masks scroll content when it lifts
      // above the keyboard (otherwise the content shows through under the
      // buttons). paddingTop gives a clear gap above the buttons.
      paddingTop: Skin.space(12),
      paddingHorizontal: Skin.space(24),
      paddingBottom: insets.bottom + 16,
      backgroundColor: isDark ? theme.colors.surface0 : theme.colors.surface1,
    },
  });

export default OnboardingLayout;
