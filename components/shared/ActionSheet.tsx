/**
 * ActionSheet — reusable themed bottom sheet for contextual actions.
 *
 * Drop-in replacement for ActionSheetIOS / Alert.alert that:
 *   - Matches the app's dark/light theme
 *   - Renders consistently on iOS and Android
 *   - Supports an optional icon (or custom leading element) per action
 *   - Marks destructive actions in red
 *   - Supports flat lists (`actions`) OR grouped sections (`sections`)
 *
 * Dismissed by tapping the backdrop or swiping down (inherited from BaseModal);
 * there is no separate Cancel row, matching the rest of the app's sheets.
 *
 * Rows are rendered via the shared `ActionRow` / `ActionRowGroup` primitives —
 * the single source of truth for the "icon-left + label-right" row. Surfaces
 * that can't use this bottom-sheet shell (embedded scroll lists, sheets with
 * Switch rows or a confirm dialog on top) import those primitives directly.
 *
 * See .agents/reports/2026-06-15-modal-link-row-audit-and-unified-component.md
 *
 * @example flat list
 *   <ActionSheet
 *     visible={visible}
 *     onClose={() => setVisible(false)}
 *     title="Asset"
 *     message="0.5 ETH"
 *     actions={[
 *       { label: 'Send', icon: 'arrow.up.right', onPress: handleSend },
 *       { label: 'Delete', icon: 'trash', onPress: handleDelete, destructive: true },
 *     ]}
 *   />
 *
 * @example grouped sections
 *   <ActionSheet
 *     visible={visible}
 *     onClose={onClose}
 *     sections={[
 *       { title: 'Spaces', items: spaceRows },
 *       { title: 'Direct messages', items: dmRows },
 *     ]}
 *   />
 */

import React, { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { BaseModal } from '@/components/shared/BaseModal';
import { ActionRow, ActionRowGroup, type ActionRowProps } from '@/components/shared/ActionRow';
import { useTheme, type AppTheme } from '@/theme';
import { haptics } from '@/utils/haptics';
import * as Skin from '@/theme/skins/geometry';

/** A single action. `onPress` is required (the sheet runs it after closing). */
export interface ActionRowItem extends Omit<ActionRowProps, 'onPress' | 'isLast' | 'style'> {
  onPress: () => void;
}

export interface ActionSheetSection {
  /** Optional uppercase header shown above the group. */
  title?: string;
  items: ActionRowItem[];
}

interface ActionSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Optional title shown at the top in bold. */
  title?: string;
  /** Optional secondary message under the title. */
  message?: string;
  /** Flat list of actions (back-compat). Provide this OR `sections`. */
  actions?: ActionRowItem[];
  /** Grouped sections. Provide this OR `actions`. */
  sections?: ActionSheetSection[];
}

/** Back-compat alias — old call sites typed against `ActionSheetAction`. */
export type ActionSheetAction = ActionRowItem;

export function ActionSheet({
  visible,
  onClose,
  title,
  message,
  actions,
  sections,
}: ActionSheetProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  // Normalize flat `actions` into a single unnamed section.
  const resolvedSections: ActionSheetSection[] =
    sections ?? (actions ? [{ items: actions }] : []);

  const handleActionPress = useCallback(
    (item: ActionRowItem) => {
      if (item.disabled) return;
      haptics.selection();
      // Close first so the user sees the sheet dismiss, then run the action on
      // next tick. Prevents visual awkwardness when the action opens another
      // modal.
      onClose();
      setTimeout(() => item.onPress(), 120);
    },
    [onClose],
  );

  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      showHandle
      backgroundColor={theme.colors.surface0}
    >
      <View style={styles.container}>
        {(title || message) && (
          <View style={styles.header}>
            {title ? <Text style={styles.title}>{title}</Text> : null}
            {message ? <Text style={styles.message}>{message}</Text> : null}
          </View>
        )}

        {resolvedSections.map((section, sIndex) => (
          <View key={`section-${sIndex}`} style={styles.section}>
            {section.title ? (
              <Text style={styles.sectionTitle}>{section.title}</Text>
            ) : null}
            <ActionRowGroup>
              {section.items.map((item, iIndex) => (
                <ActionRow
                  key={`${item.label}-${iIndex}`}
                  {...item}
                  onPress={() => handleActionPress(item)}
                />
              ))}
            </ActionRowGroup>
          </View>
        ))}
      </View>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      paddingHorizontal: Skin.space(12),
      // Breathing room below the handle bar before the first group, so the menu
      // doesn't crowd the top edge of the sheet.
      paddingTop: Skin.space(12),
      paddingBottom: Skin.space(8),
    },
    header: {
      alignItems: 'center',
      paddingHorizontal: Skin.space(8),
      paddingTop: Skin.space(4),
      paddingBottom: Skin.space(14),
    },
    title: {
      ...theme.textStyles.headline,
      color: theme.colors.textStrong,
      textAlign: 'center',
    },
    message: {
      ...theme.textStyles.subheadline,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: Skin.space(2),
    },
    section: {
      marginBottom: Skin.space(12),
    },
    sectionTitle: {
      ...theme.textStyles.footnote,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginTop: Skin.space(4),
      marginBottom: Skin.space(8),
      marginHorizontal: Skin.space(8),
    },
  });
