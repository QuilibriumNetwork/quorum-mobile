/**
 * MigrationModal — full-screen, non-dismissible overlay shown by
 * StorageProvider while the one-time MMKV→SQLite messages migration is
 * running. The migration uses synchronous SQLite APIs and blocks the
 * JS thread for the duration; the user shouldn't background or kill
 * the app during it, so we tell them that explicitly.
 *
 * Non-dismissible by design: no swipe-to-close, no backdrop tap, no
 * close button. The parent unmounts this when migration completes.
 */

import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme, type AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

interface MigrationModalProps {
  visible: boolean;
}

export function MigrationModal({ visible }: MigrationModalProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      // No onRequestClose handler — Android back button is a no-op
      // while migration is in progress.
      onRequestClose={() => { /* intentional no-op */ }}
      statusBarTranslucent
      // Edge-to-edge under the bottom nav bar so the backdrop covers it instead
      // of leaving a default-colored (light) nav bar.
      navigationBarTranslucent
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <ActivityIndicator size="large" color={theme.colors.accent} />
          <Text style={styles.title}>Optimizing your message history</Text>
          <Text style={styles.body}>
            We're building a new on-device index so your messages load
            faster and stay searchable as your history grows. This is a
            one-time pass.
          </Text>
          <Text style={styles.warn}>
            Please don't close or leave the app until this finishes.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: Skin.space(24),
    },
    card: {
      width: '100%',
      maxWidth: 360,
      backgroundColor: theme.colors.surface1,
      borderRadius: Skin.radius(16),
      padding: Skin.space(24),
      alignItems: 'center',
      gap: Skin.space(16),
    },
    title: {
      fontSize: Skin.font(18),
      fontWeight: '600',
      color: theme.colors.textStrong,
      textAlign: 'center',
    },
    body: {
      fontSize: Skin.font(14),
      lineHeight: Skin.font(20),
      color: theme.colors.textMain,
      textAlign: 'center',
    },
    warn: {
      fontSize: Skin.font(13),
      fontWeight: '600',
      color: theme.colors.accent,
      textAlign: 'center',
    },
  });
}

export default MigrationModal;
