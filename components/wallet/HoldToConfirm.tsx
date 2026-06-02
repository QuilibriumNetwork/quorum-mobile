/**
 * HoldToConfirm - A button that requires holding to confirm an action
 */

import { useTheme, type AppTheme } from '@/theme';
import React from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  View,
  ViewStyle,
  PanResponder,
} from 'react-native';
import * as Skin from '@/theme/skins/geometry';

interface HoldToConfirmProps {
  onConfirm: () => void;
  holdDuration?: number; // milliseconds
  disabled?: boolean;
  label?: string;
  holdingLabel?: string;
  style?: ViewStyle;
}

export default function HoldToConfirm({
  onConfirm,
  holdDuration = 1500,
  disabled = false,
  label = 'Hold to Confirm',
  holdingLabel = 'Keep holding...',
  style,
}: HoldToConfirmProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const progress = React.useRef(new Animated.Value(0)).current;
  const [isHolding, setIsHolding] = React.useState(false);
  const holdTimer = React.useRef<NodeJS.Timeout | null>(null);
  const animationRef = React.useRef<Animated.CompositeAnimation | null>(null);

  const startHold = React.useCallback(() => {
    if (disabled) return;

    setIsHolding(true);
    progress.setValue(0);

    // Animate progress bar
    animationRef.current = Animated.timing(progress, {
      toValue: 1,
      duration: holdDuration,
      useNativeDriver: false,
    });

    animationRef.current.start(({ finished }) => {
      if (finished) {
        onConfirm();
        setIsHolding(false);
        progress.setValue(0);
      }
    });
  }, [disabled, holdDuration, onConfirm, progress]);

  const cancelHold = React.useCallback(() => {
    setIsHolding(false);
    if (animationRef.current) {
      animationRef.current.stop();
    }
    Animated.timing(progress, {
      toValue: 0,
      duration: 150,
      useNativeDriver: false,
    }).start();
  }, [progress]);

  const panResponder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: startHold,
        onPanResponderRelease: cancelHold,
        onPanResponderTerminate: cancelHold,
      }),
    [startHold, cancelHold]
  );

  const progressWidth = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  const backgroundColor = progress.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [theme.colors.primary, theme.colors.primary, '#22C55E'],
  });

  return (
    <View
      style={[styles.container, disabled && styles.containerDisabled, style]}
      {...panResponder.panHandlers}
    >
      <Animated.View
        style={[
          styles.progressBar,
          {
            width: progressWidth,
            backgroundColor,
          },
        ]}
      />
      <Text style={styles.label}>
        {isHolding ? holdingLabel : label}
      </Text>
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      height: 56,
      borderRadius: Skin.radius(12),
      backgroundColor: theme.colors.primary,
      justifyContent: 'center',
      alignItems: 'center',
      overflow: 'hidden',
      position: 'relative',
    },
    containerDisabled: {
      opacity: 0.5,
    },
    progressBar: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      borderRadius: Skin.radius(12),
    },
    label: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#fff',
      zIndex: 1,
    },
  });
