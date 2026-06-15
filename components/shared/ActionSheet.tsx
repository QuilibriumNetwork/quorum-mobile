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
 * This is the single source of truth for the "icon-left + label-right" row used
 * across every modal/drawer/sheet. See
 * .agents/reports/2026-06-15-modal-link-row-audit-and-unified-component.md
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
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { BaseModal } from '@/components/shared/BaseModal';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { useTheme, type AppTheme } from '@/theme';
import { haptics } from '@/utils/haptics';
import * as Skin from '@/theme/skins/geometry';

export interface ActionRowItem {
  label: string;
  /** IconSymbol name. Omit to leave an aligned spacer, or use `leading`. */
  icon?: string;
  /** Runs after the sheet animates closed. */
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Optional secondary line under the label. */
  sublabel?: string;
  /** Trailing affordance: a chevron, or any custom node (toggle, send icon…). */
  trailing?: 'chevron' | React.ReactNode;
  /** Success-tinted active state (e.g. selected / recasted). */
  active?: boolean;
  /** Custom leading element (avatar, SpaceIcon) rendered instead of `icon`. */
  leading?: React.ReactNode;
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

function ActionRow({
  item,
  isLast,
  onPress,
  theme,
  styles,
}: {
  item: ActionRowItem;
  isLast: boolean;
  onPress: (item: ActionRowItem) => void;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
}) {
  const color = item.disabled
    ? theme.colors.textMuted
    : item.destructive
      ? theme.colors.danger
      : item.active
        ? theme.colors.success
        : theme.colors.textMain;

  return (
    <TouchableOpacity
      style={[styles.actionRow, isLast && styles.actionRowLast]}
      onPress={() => onPress(item)}
      activeOpacity={0.6}
      disabled={item.disabled}
      accessibilityRole="button"
      accessibilityLabel={item.label}
      accessibilityState={{ disabled: !!item.disabled }}
    >
      {item.leading ? (
        item.leading
      ) : item.icon ? (
        // icon name is validated by IconSymbol's mapping at runtime; the strict
        // union type is too narrow for a generic wrapper.
        <IconSymbol name={item.icon as IconSymbolName} size={20} color={color} />
      ) : (
        <View style={styles.iconSpacer} />
      )}

      <View style={styles.labelColumn}>
        <Text style={[styles.actionLabel, { color }]}>{item.label}</Text>
        {item.sublabel ? (
          <Text style={styles.actionSublabel} numberOfLines={1}>
            {item.sublabel}
          </Text>
        ) : null}
      </View>

      {item.trailing === 'chevron' ? (
        <IconSymbol name="chevron.right" size={16} color={theme.colors.textMuted} />
      ) : item.trailing ? (
        item.trailing
      ) : null}
    </TouchableOpacity>
  );
}

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
            <View style={styles.group}>
              {section.items.map((item, iIndex) => (
                <ActionRow
                  key={`${item.label}-${iIndex}`}
                  item={item}
                  isLast={iIndex === section.items.length - 1}
                  onPress={handleActionPress}
                  theme={theme}
                  styles={styles}
                />
              ))}
            </View>
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
    group: {
      // Whole stack shifted down one ramp step: sheet surface0, card surface2,
      // divider surface4 — keeps the relative spacing but darkens the overall
      // menu. (Sheet bg set via BaseModal's backgroundColor prop above.)
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(14),
      overflow: 'hidden',
    },
    actionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(14),
      minHeight: 44,
      // Full 1px (not hairlineWidth ~0.5px, which was barely visible). surface4
      // against the surface2 card after the down-one-step shift.
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.surface4,
    },
    actionRowLast: {
      borderBottomWidth: 0,
    },
    iconSpacer: {
      width: 20,
    },
    labelColumn: {
      flex: 1,
    },
    actionLabel: {
      ...theme.textStyles.callout,
    },
    actionSublabel: {
      ...theme.textStyles.footnote,
      color: theme.colors.textMuted,
      marginTop: Skin.space(1),
    },
  });
