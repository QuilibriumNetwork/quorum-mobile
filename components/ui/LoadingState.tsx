import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { useTheme, type AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

type LoadingSize = 'sm' | 'md' | 'lg';

interface LoadingStateProps {
  /** Optional message */
  message?: string;
  /** Size preset */
  size?: LoadingSize;
  /** Custom style */
  style?: ViewStyle;
  /** Test ID */
  testID?: string;
}

const SIZE_MAP: Record<LoadingSize, 'small' | 'large'> = {
  sm: 'small',
  md: 'small',
  lg: 'large',
};

/**
 * Consistent loading state component.
 *
 * @example
 * ```tsx
 * <LoadingState message="Loading data..." />
 *
 * {isLoading && <LoadingState size="lg" />}
 * ```
 */
export function LoadingState({
  message,
  size = 'md',
  style,
  testID,
}: LoadingStateProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme, size);

  return (
    <View style={[styles.container, style]} testID={testID}>
      <ActivityIndicator
        size={SIZE_MAP[size]}
        color={theme.colors.primary}
      />
      {message && (
        <Text style={styles.message}>{message}</Text>
      )}
    </View>
  );
}

const createStyles = (theme: AppTheme, size: LoadingSize) =>
  StyleSheet.create({
    container: {
      alignItems: 'center',
      justifyContent: 'center',
      padding: size === 'sm' ? 16 : size === 'md' ? 24 : 48,
    },
    message: {
      marginTop: Skin.space(12),
      fontSize: size === 'sm' ? 12 : 14,
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
    },
  });

export default LoadingState;
