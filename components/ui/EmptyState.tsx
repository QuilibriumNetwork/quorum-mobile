import React from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useTheme, type AppTheme } from '@/theme';
import { IconSymbol, type IconSymbolName } from './IconSymbol';
import * as Skin from '@/theme/skins/geometry';

interface EmptyStateProps {
  /** Icon to display */
  icon?: IconSymbolName;
  /** Title text */
  title: string;
  /** Description text */
  message?: string;
  /** Action button label */
  actionLabel?: string;
  /** Action handler */
  onAction?: () => void;
  /** Custom style */
  style?: ViewStyle;
  /** Test ID */
  testID?: string;
}

/**
 * Empty state component for lists and containers.
 *
 * @example
 * ```tsx
 * <EmptyState
 *   icon="doc.text"
 *   title="No documents"
 *   message="Upload your first document to get started"
 *   actionLabel="Upload"
 *   onAction={handleUpload}
 * />
 * ```
 */
export function EmptyState({
  icon = 'tray',
  title,
  message,
  actionLabel,
  onAction,
  style,
  testID,
}: EmptyStateProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  return (
    <View style={[styles.container, style]} testID={testID}>
      <View style={styles.iconContainer}>
        <IconSymbol
          name={icon}
          size={48}
          color={theme.colors.textMuted}
        />
      </View>
      <Text style={styles.title}>{title}</Text>
      {message && (
        <Text style={styles.message}>{message}</Text>
      )}
      {actionLabel && onAction && (
        <TouchableOpacity
          onPress={onAction}
          style={styles.actionButton}
          activeOpacity={0.7}
        >
          <Text style={styles.actionText}>{actionLabel}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      alignItems: 'center',
      justifyContent: 'center',
      padding: Skin.space(48),
    },
    iconContainer: {
      marginBottom: Skin.space(16),
    },
    title: {
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      textAlign: 'center',
      marginBottom: Skin.space(8),
    },
    message: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
      lineHeight: Skin.font(20),
      marginBottom: Skin.space(20),
    },
    actionButton: {
      paddingVertical: Skin.space(12),
      paddingHorizontal: Skin.space(24),
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(8),
    },
    actionText: {
      fontSize: Skin.font(14),
      color: '#ffffff',
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
  });

export default EmptyState;
