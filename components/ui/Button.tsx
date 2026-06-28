import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  StyleProp,
  Text,
  TouchableOpacity,
  View,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useTheme, type AppTheme } from '@/theme';
import { IconSymbol, type IconSymbolName } from './IconSymbol';
import * as Skin from '@/theme/skins/geometry';
import { useSurface } from '@/theme/skins/surfaces';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost' | 'outline';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps {
  /** Button label */
  children: React.ReactNode;
  /** Visual variant */
  variant?: ButtonVariant;
  /** Size preset */
  size?: ButtonSize;
  /** Disabled state */
  disabled?: boolean;
  /** Loading state - shows spinner */
  loading?: boolean;
  /** Icon to display */
  icon?: IconSymbolName;
  /** Icon position */
  iconPosition?: 'left' | 'right';
  /** Press handler */
  onPress: () => void;
  /** Full width button */
  fullWidth?: boolean;
  /**
   * Override the fill color for a one-off brand button (e.g. biometric purple,
   * Apex gold). Applies to `primary`/`danger`/`success` fills; for `outline`
   * it tints the border + label. Prefer a variant when the color is reusable.
   */
  color?: string;
  /** Custom style */
  style?: StyleProp<ViewStyle>;
  /** Test ID */
  testID?: string;
}

/**
 * Themed button component with multiple variants and sizes.
 *
 * @example
 * ```tsx
 * <Button variant="primary" onPress={handlePress}>
 *   Submit
 * </Button>
 *
 * <Button variant="danger" icon="trash.fill" loading={isDeleting}>
 *   Delete
 * </Button>
 * ```
 */
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  icon,
  iconPosition = 'left',
  onPress,
  fullWidth = false,
  color,
  style,
  testID,
}: ButtonProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme, variant, size, disabled, fullWidth, color);

  // Per-variant skin surface: `button.<variant>` inherits the generic `button`.
  const surface = useSurface(`button.${variant}`);
  const surfaceColor = surface.background && !surface.backgroundIsImage ? surface.background : undefined;
  const surfaceImage = surface.backgroundIsImage ? surface.background : undefined;

  const isDisabled = disabled || loading;

  const iconSize = size === 'sm' ? 14 : size === 'md' ? 16 : 18;
  // `ghost`/`outline` use a tinted label/icon (the override color, or accent);
  // `secondary` uses textMain; filled variants (primary/danger/success) use white.
  const tintedLabel = variant === 'ghost' || variant === 'outline';
  const iconColor = surface.text ?? (
    disabled
      ? theme.colors.textMuted
      : tintedLabel
        ? (color ?? theme.colors.primary)
        : variant === 'secondary'
          ? theme.colors.textMain
          : '#ffffff');

  const content = (
    <>
      {loading ? (
        <ActivityIndicator
          size="small"
          color={iconColor}
          style={styles.loader}
        />
      ) : icon && iconPosition === 'left' ? (
        <IconSymbol
          name={icon}
          size={iconSize}
          color={iconColor}
          style={styles.iconLeft}
        />
      ) : null}

      <Text style={[styles.text, surface.text ? { color: surface.text } : null]}>{children}</Text>

      {!loading && icon && iconPosition === 'right' && (
        <IconSymbol
          name={icon}
          size={iconSize}
          color={iconColor}
          style={styles.iconRight}
        />
      )}
    </>
  );

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={isDisabled}
      activeOpacity={0.7}
      style={[
        styles.button,
        surfaceColor ? { backgroundColor: surfaceColor } : null,
        surfaceImage ? { overflow: 'hidden' } : null,
        style,
      ]}
      testID={testID}
    >
      {surfaceImage && (
        <ExpoImage
          source={{ uri: surfaceImage }}
          style={[StyleSheet.absoluteFill, { opacity: surface.opacity }]}
          contentFit={surface.fit === 'contain' ? 'contain' : 'cover'}
          cachePolicy="memory-disk"
        />
      )}
      {content}
    </TouchableOpacity>
  );
}

const createStyles = (
  theme: AppTheme,
  variant: ButtonVariant,
  size: ButtonSize,
  disabled: boolean,
  fullWidth: boolean,
  color?: string
) => {
  const getBackgroundColor = () => {
    if (disabled) return theme.colors.surface3;
    switch (variant) {
      case 'primary':
        return color ?? theme.colors.primary;
      case 'secondary':
        return theme.colors.surface3;
      case 'danger':
        return color ?? theme.colors.danger;
      case 'success':
        return color ?? theme.colors.success;
      case 'ghost':
      case 'outline':
        return 'transparent';
    }
  };

  const getTextColor = () => {
    if (disabled) return theme.colors.textMuted;
    switch (variant) {
      case 'primary':
      case 'danger':
      case 'success':
        return '#ffffff';
      case 'secondary':
        return theme.colors.textMain;
      case 'ghost':
      case 'outline':
        return color ?? theme.colors.primary;
    }
  };

  const getPadding = () => {
    switch (size) {
      case 'sm':
        return { paddingVertical: Skin.space(6), paddingHorizontal: Skin.space(12) };
      case 'md':
        return { paddingVertical: Skin.space(12), paddingHorizontal: Skin.space(20) };
      case 'lg':
        return { paddingVertical: Skin.space(16), paddingHorizontal: Skin.space(28) };
    }
  };

  const getFontSize = () => {
    switch (size) {
      case 'sm':
        return 12;
      case 'md':
        return 14;
      case 'lg':
        return 16;
    }
  };

  return StyleSheet.create({
    button: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: getBackgroundColor(),
      borderRadius: size === 'sm' ? 6 : size === 'md' ? 8 : 12,
      ...getPadding(),
      ...(variant === 'outline'
        ? {
            borderWidth: Skin.border(1),
            borderColor: disabled ? theme.colors.surface5 : (color ?? theme.colors.primary),
          }
        : {}),
      ...(fullWidth ? { width: '100%' } : {}),
      opacity: disabled ? 0.6 : 1,
    } as ViewStyle,
    text: {
      fontSize: getFontSize(),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: getTextColor(),
    } as TextStyle,
    iconLeft: {
      marginRight: Skin.space(6),
    } as TextStyle,
    iconRight: {
      marginLeft: Skin.space(6),
    } as TextStyle,
    loader: {
      marginRight: Skin.space(8),
    } as ViewStyle,
  });
};

export default Button;
