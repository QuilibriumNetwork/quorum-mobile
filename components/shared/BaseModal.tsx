import React, { useEffect, useState } from 'react';
import { Animated, Dimensions, Keyboard, KeyboardAvoidingView, Modal, Platform, StyleSheet, TouchableWithoutFeedback, View, ViewStyle } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets, EdgeInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme';
import { useModalAnimation, SCREEN_HEIGHT } from '@/hooks/useModalAnimation';
import { usePanResponder } from '@/hooks/usePanResponder';
import { createTheme } from '@/theme/themes';
import * as Skin from '@/theme/skins/geometry';
import { frameAccentBorder } from '@/theme/skins/frame';

type ThemeType = ReturnType<typeof createTheme>;

export interface BaseModalProps {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Fraction of screen height (0-1), default 0.9 */
  height?: number;
  /** Backdrop opacity (0-1), default 0.5 */
  backdropDarkness?: number;
  showHandle?: boolean;
  handleContainerStyle?: ViewStyle;
  testID?: string;
  avoidKeyboard?: boolean;
  fillHeight?: boolean;
  /** Fraction of screen height (0-1) */
  minHeight?: number;
}

/**
 * BaseModal - A reusable bottom sheet modal with swipe-to-dismiss.
 *
 * Provides consistent animation and gesture behavior across all modals.
 *
 * @example
 * ```tsx
 * <BaseModal visible={isOpen} onClose={handleClose}>
 *   <Text>Modal content here</Text>
 * </BaseModal>
 * ```
 */
export function BaseModal({
  visible,
  onClose,
  children,
  height = 0.9,
  backdropDarkness = 0.5,
  showHandle = true,
  handleContainerStyle,
  testID,
  avoidKeyboard = false,
  fillHeight = false,
  minHeight,
}: BaseModalProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const { slideAnim, backdropAnim, closeModal, snapBack } = useModalAnimation({
    visible,
    onCloseComplete: onClose,
  });

  const { panHandlers } = usePanResponder({
    slideAnim,
    onDismiss: closeModal,
    onSnapBack: snapBack,
  });

  // Track keyboard height for keyboard avoiding behavior
  useEffect(() => {
    if (!avoidKeyboard) return;

    const showListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => setKeyboardHeight(e.endCoordinates.height)
    );
    const hideListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardHeight(0)
    );

    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, [avoidKeyboard]);

  const styles = createStyles(theme, insets, height, backdropDarkness, fillHeight, minHeight);

  // Calculate bottom offset and max height when keyboard is visible
  const keyboardVisible = avoidKeyboard && keyboardHeight > 0;
  // Lift the modal fully above the keyboard
  const bottomOffset = keyboardVisible ? keyboardHeight : 0;

  // Reduce max height when keyboard is visible so content fits above keyboard
  const adjustedMaxHeight = keyboardVisible
    ? SCREEN_HEIGHT - keyboardHeight - insets.top - 20 // 20px padding from top
    : SCREEN_HEIGHT * height;

  const modalContent = (
    <Animated.View
      style={[
        styles.modalContent,
        {
          transform: [{ translateY: slideAnim }],
        },
        // Only apply keyboard adjustments when keyboard is actually visible
        keyboardVisible && {
          bottom: bottomOffset,
          maxHeight: adjustedMaxHeight,
        },
      ]}
      {...panHandlers}
    >
      {/* Handle bar */}
      {showHandle && (
        <TouchableOpacity
          style={[styles.handleContainer, handleContainerStyle]}
          onPress={onClose}
          activeOpacity={0.8}
        >
          <View style={styles.handle} />
        </TouchableOpacity>
      )}

      {/* Modal content */}
      {children}
    </Animated.View>
  );

  return (
    <Modal
      transparent
      visible={visible}
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
      testID={testID}
    >
      <View style={styles.container}>
        {/* Animated backdrop */}
        <Animated.View
          style={[
            styles.backdrop,
            { opacity: backdropAnim },
          ]}
        >
          <TouchableWithoutFeedback onPress={onClose}>
            <View style={StyleSheet.absoluteFillObject} />
          </TouchableWithoutFeedback>
        </Animated.View>

        {/* Animated content */}
        {modalContent}
      </View>
    </Modal>
  );
}

const createStyles = (
  theme: ThemeType,
  insets: EdgeInsets,
  height: number,
  backdropDarkness: number,
  fillHeight: boolean,
  minHeight?: number
) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: `rgba(0, 0, 0, ${backdropDarkness})`,
    },
    modalContent: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: theme.colors.background,
      borderTopLeftRadius: Skin.radius(20),
      borderTopRightRadius: Skin.radius(20),
      ...frameAccentBorder(theme),
      ...(fillHeight ? { height: SCREEN_HEIGHT * height } : {}),
      ...(minHeight ? { minHeight: SCREEN_HEIGHT * minHeight } : {}),
      maxHeight: SCREEN_HEIGHT * height,
      paddingBottom: insets.bottom,
    },
    handleContainer: {
      alignItems: 'center',
      paddingVertical: Skin.space(8),
    },
    handle: {
      width: 40,
      height: 4,
      backgroundColor: theme.colors.surface5,
      borderRadius: Skin.radius(2),
    },
  });

export default BaseModal;
