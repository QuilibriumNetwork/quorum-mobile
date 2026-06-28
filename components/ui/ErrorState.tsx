import React from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme, type AppTheme } from '@/theme';
import { IconSymbol } from './IconSymbol';
import { Button } from './Button';
import * as Skin from '@/theme/skins/geometry';

interface ErrorStateProps {
  /** Error message to display */
  message: string;
  /** Retry handler */
  onRetry?: () => void;
  /** Retry button label */
  retryLabel?: string;
  /** Custom style */
  style?: ViewStyle;
  /** Test ID */
  testID?: string;
}

/**
 * Error state component with optional retry action.
 *
 * @example
 * ```tsx
 * <ErrorState
 *   message="Failed to load data"
 *   onRetry={refetch}
 * />
 * ```
 */
export function ErrorState({
  message,
  onRetry,
  retryLabel = 'Try Again',
  style,
  testID,
}: ErrorStateProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  return (
    <View style={[styles.container, style]} testID={testID}>
      <View style={styles.iconContainer}>
        <IconSymbol
          name="exclamationmark.triangle.fill"
          size={32}
          color={theme.colors.danger}
        />
      </View>
      <Text style={styles.message}>{message}</Text>
      {onRetry && (
        <Button variant="ghost" size="sm" icon="arrow.clockwise" onPress={onRetry}>
          {retryLabel}
        </Button>
      )}
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      alignItems: 'center',
      justifyContent: 'center',
      padding: Skin.space(32),
    },
    iconContainer: {
      marginBottom: Skin.space(16),
    },
    message: {
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
      lineHeight: Skin.font(20),
      marginBottom: Skin.space(16),
    },
  });

export default ErrorState;
