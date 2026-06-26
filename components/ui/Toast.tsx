/**
 * Toast - Bottom sheet toast notification for transaction feedback
 */

import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconSymbol } from './IconSymbol';
import * as Skin from '@/theme/skins/geometry';

export interface ToastProps {
  visible: boolean;
  onClose: () => void;
  type?: 'success' | 'error' | 'info';
  title: string;
  message?: string;
  txHash?: string;
  explorerUrl?: string;
  duration?: number; // Auto-hide duration in ms, 0 = no auto-hide
}

export function Toast({
  visible,
  onClose,
  type = 'success',
  title,
  message,
  txHash,
  explorerUrl,
  duration = 5000,
}: ToastProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(200)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  const styles = createStyles(theme, insets, type);

  useEffect(() => {
    if (visible) {
      // Reset animation values before animating in
      slideAnim.setValue(200);
      opacityAnim.setValue(0);

      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          useNativeDriver: true,
          tension: 100,
          friction: 10,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();

      // Auto-hide after duration
      if (duration > 0) {
        const timer = setTimeout(() => {
          hideToast();
        }, duration);
        return () => clearTimeout(timer);
      }
    }
  }, [visible, duration]);

  const hideToast = () => {
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: 200,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onClose();
    });
  };

  const copyTxHash = async () => {
    if (txHash) {
      await Clipboard.setStringAsync(txHash);
    }
  };

  const openExplorer = async () => {
    if (explorerUrl) {
      await WebBrowser.openBrowserAsync(explorerUrl);
    }
  };

  const getIcon = () => {
    switch (type) {
      case 'success':
        return 'checkmark.circle.fill';
      case 'error':
        return 'xmark.circle.fill';
      case 'info':
        return 'info.circle.fill';
    }
  };

  const getIconColor = () => {
    switch (type) {
      case 'success':
        return '#22C55E';
      case 'error':
        return '#EF4444';
      case 'info':
        return theme.colors.primary;
    }
  };

  if (!visible) return null;

  return (
    <Animated.View
      style={[
        styles.container,
        {
          transform: [{ translateY: slideAnim }],
          opacity: opacityAnim,
        },
      ]}
    >
      <TouchableOpacity
        style={styles.content}
        onPress={hideToast}
        activeOpacity={0.9}
      >
        <View style={styles.header}>
          <IconSymbol name={getIcon()} size={20} color={getIconColor()} />
          <Text style={styles.title}>{title}</Text>
          <TouchableOpacity onPress={hideToast} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <IconSymbol name="xmark" size={16} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        {message && (
          <Text style={styles.message}>{message}</Text>
        )}

        {txHash && (
          <View style={styles.txContainer}>
            <TouchableOpacity style={styles.txHashRow} onPress={copyTxHash}>
              <Text style={styles.txLabel}>Tx:</Text>
              <Text style={styles.txHash}>
                {txHash.slice(0, 10)}...{txHash.slice(-8)}
              </Text>
              <IconSymbol name="doc.on.doc" size={12} color={theme.colors.textMuted} />
            </TouchableOpacity>

            {explorerUrl && (
              <TouchableOpacity onPress={openExplorer}>
                <Text style={styles.explorerLink}>View in Explorer</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

const createStyles = (theme: AppTheme, insets: EdgeInsets, type: string) =>
  StyleSheet.create({
    container: {
      position: 'absolute',
      bottom: insets.bottom + 90, // Above the blur tab bar
      left: 16,
      right: 16,
      zIndex: 9999,
    },
    content: {
      backgroundColor: theme.colors.surface2 || theme.colors.surface1 || '#1C1C1E',
      borderRadius: Skin.radius(16),
      padding: Skin.space(16),
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.3,
      shadowRadius: 16,
      elevation: 12,
      borderWidth: Skin.border(1),
      borderColor: theme.colors.border || 'rgba(255,255,255,0.1)',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(10),
    },
    title: {
      flex: 1,
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.semiBold?.fontFamily || theme.fonts.bold.fontFamily,
      fontWeight: '600',
      color: theme.colors.textMain,
    },
    message: {
      fontSize: Skin.font(13),
      color: theme.colors.textSubtle,
      marginTop: Skin.space(8),
      lineHeight: Skin.font(18),
    },
    txContainer: {
      marginTop: Skin.space(12),
      paddingTop: Skin.space(12),
      borderTopWidth: Skin.border(1),
      borderTopColor: theme.colors.border,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    txHashRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
    },
    txLabel: {
      fontSize: Skin.font(12),
      color: theme.colors.textSubtle,
    },
    txHash: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
    },
    explorerLink: {
      fontSize: Skin.font(12),
      color: theme.colors.primary,
      fontFamily: theme.fonts.medium?.fontFamily || theme.fonts.regular.fontFamily,
      fontWeight: '500',
    },
  });

export default Toast;
