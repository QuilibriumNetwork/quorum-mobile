/**
 * EditHistoryModal - Shows the edit history for a message with timestamps
 */

import type { AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  ScrollView,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { formatTime } from './types';
import * as Skin from '@/theme/skins/geometry';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface EditEntry {
  text: string | string[];
  modifiedDate: number;
  lastModifiedHash: string;
}

interface EditHistoryModalProps {
  visible: boolean;
  onClose: () => void;
  originalText: string;
  originalDate: number;
  edits: EditEntry[];
  theme: AppTheme;
}

export const EditHistoryModal = React.memo(function EditHistoryModal({
  visible,
  onClose,
  originalText,
  originalDate,
  edits,
  theme,
}: EditHistoryModalProps) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();

  // Build timeline: original + all edits, newest first
  const timeline = useMemo(() => {
    const entries = [
      ...edits.map((edit, index) => ({
        text: Array.isArray(edit.text) ? edit.text.join('\n') : edit.text,
        date: edit.modifiedDate,
        isOriginal: false,
        index: index + 1,
      })),
      {
        text: originalText,
        date: originalDate,
        isOriginal: true,
        index: 0,
      },
    ];
    // Sort newest first
    entries.sort((a, b) => b.date - a.date);
    return entries;
  }, [originalText, originalDate, edits]);

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        {/* Additive bottom inset so content clears the system nav bar with a
            real gap (max() swallowed the gap when insets.bottom >= it). */}
        <View style={[styles.container, { paddingBottom: insets.bottom + Skin.space(16) }]}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Edit History</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {timeline.map((entry) => (
              <View
                key={`${entry.date}-${entry.index}`}
                style={[styles.editCard, entry.isOriginal && styles.originalCard]}
              >
                <View style={styles.editHeader}>
                  <Text style={styles.editLabel}>
                    {entry.isOriginal ? 'Original' : `Edit #${entry.index}`}
                  </Text>
                  <Text style={styles.editTimestamp}>
                    {formatTime(entry.date)}
                  </Text>
                </View>
                <Text style={styles.editText}>{entry.text}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
});

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      justifyContent: 'flex-end',
    },
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
    },
    container: {
      backgroundColor: theme.colors.surface1 ?? theme.colors.background,
      borderTopLeftRadius: Skin.radius(16),
      borderTopRightRadius: Skin.radius(16),
      maxHeight: '70%',
      width: SCREEN_WIDTH,
      // paddingBottom applied inline from the real safe-area inset.
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Skin.space(20),
      paddingVertical: Skin.space(16),
    },
    headerTitle: {
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textStrong,
    },
    scrollView: {
      // No flex:1 here — the container sizes to its content (capped at
      // maxHeight 70%), so a flex child would collapse to 0 height and the
      // body would render blank. Letting the ScrollView size to content makes
      // it grow with the entries and scroll only once it hits the cap.
      flexGrow: 0,
      flexShrink: 1,
    },
    scrollContent: {
      paddingHorizontal: Skin.space(16),
      paddingTop: Skin.space(4),
      paddingBottom: Skin.space(16),
      gap: Skin.space(10),
    },
    editCard: {
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      padding: Skin.space(12),
    },
    // The Original message is highlighted with a subtle accent-tinted
    // background so it reads as the baseline the edits diverge from.
    originalCard: {
      backgroundColor: theme.colors.accentSoft,
    },
    editHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: Skin.space(6),
    },
    editLabel: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.primary,
    },
    editTimestamp: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textSubtle,
    },
    editText: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
      lineHeight: Skin.font(22),
    },
  });

export default EditHistoryModal;
