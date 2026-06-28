import React from 'react';
import {
  Modal,
  Platform,
  StyleSheet,
  TouchableWithoutFeedback,
  View,
  ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSafeAreaInsets, EdgeInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme';
import { createTheme } from '@/theme/themes';
import * as Skin from '@/theme/skins/geometry';
import { frameAccentBorder } from '@/theme/skins/frame';

type ThemeType = ReturnType<typeof createTheme>;

export interface CenterModalProps {
  visible: boolean;
  /**
   * Dismiss WITHOUT confirming. Wired to the Android hardware back button and a
   * backdrop tap — both must resolve to CANCEL, never to the destructive action.
   */
  onCancel: () => void;
  children: React.ReactNode;
  /** Announced to screen readers + used as the dialog's accessibility label. */
  accessibilityLabel?: string;
  /** Tap outside the card cancels (default true). The destructive action is never reachable this way. */
  dismissOnBackdrop?: boolean;
  cardStyle?: ViewStyle;
  testID?: string;
}

/**
 * CenterModal — a center-anchored, skin-styled modal shell for destructive
 * confirmations (ConfirmDialog, TypeToConfirmModal). Distinct from BaseModal,
 * which is a bottom sheet for action menus.
 *
 * Owns, in one place, the cross-cutting behaviors that native `Alert.alert`
 * gives for free (so they're written + tested once):
 *  - centered card over a dim backdrop, carrying the skin (fonts/colors/frame)
 *  - `accessibilityViewIsModal` + a dialog role so screen readers trap + announce
 *  - Android hardware-back → onCancel (via `onRequestClose`)
 *  - backdrop tap → onCancel
 *
 * SAFETY INVARIANT: nothing here can trigger a confirm. Back + backdrop only
 * ever call `onCancel`. The destructive action lives on an explicit button
 * inside `children`.
 */
export function CenterModal({
  visible,
  onCancel,
  children,
  accessibilityLabel,
  dismissOnBackdrop = true,
  cardStyle,
  testID,
}: CenterModalProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme, insets);

  // Keyboard avoidance. An RN <Modal> is a separate window, so the Activity's
  // `adjustResize` does NOT shrink it — the soft keyboard draws on top of the
  // centered card, hiding the input + buttons on short screens (Galaxy A40).
  // `KeyboardAvoidingView` inside a Modal is unreliable on Android for the same
  // window reason, so we track the live keyboard height and lift the card.
  // The card is vertically centered, so translating it up by HALF the keyboard
  // height re-centers it in the space remaining above the keyboard.
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const cardAnimatedStyle = useAnimatedStyle(() => ({
    // `keyboardHeight` is negative while the keyboard is open (RN keyboard-
    // controller convention), so `/ 2` already yields an upward (negative) shift.
    transform: [{ translateY: keyboardHeight.value / 2 }],
  }));

  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      statusBarTranslucent
      // Draw edge-to-edge under the bottom nav bar too, so the backdrop dimming
      // extends behind it instead of leaving a default-colored (light) nav bar.
      navigationBarTranslucent
      // Android hardware back → cancel, never confirm.
      onRequestClose={onCancel}
      testID={testID}
    >
      <View style={styles.container}>
        {/* Backdrop tap → cancel. Sits behind the card. */}
        <TouchableWithoutFeedback
          onPress={dismissOnBackdrop ? onCancel : undefined}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <View style={styles.backdrop} />
        </TouchableWithoutFeedback>

        {/* The card. accessibilityViewIsModal traps the screen reader inside it.
            Animated so it lifts above the keyboard (see note above). */}
        <Animated.View
          style={[styles.card, cardStyle, cardAnimatedStyle]}
          accessibilityViewIsModal
          accessibilityRole={Platform.OS === 'ios' ? 'none' : 'alert'}
          accessibilityLabel={accessibilityLabel}
        >
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

const createStyles = (theme: ThemeType, insets: EdgeInsets) =>
  StyleSheet.create({
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: Skin.space(24),
      // Keep the card off the very top/bottom edges on small screens.
      paddingTop: insets.top + Skin.space(24),
      paddingBottom: insets.bottom + Skin.space(24),
    },
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
    },
    card: {
      width: '100%',
      maxWidth: 420,
      backgroundColor: theme.colors.surface1,
      borderRadius: Skin.radius(20),
      padding: Skin.space(20),
      shadowColor: '#000',
      shadowOpacity: 0.3,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 4 },
      elevation: 12,
      ...frameAccentBorder(theme),
    },
  });

export default CenterModal;
