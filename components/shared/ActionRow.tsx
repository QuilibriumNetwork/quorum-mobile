/**
 * ActionRow — the canonical "icon-left + label-right" tappable row.
 *
 * Single source of truth for the row visual used across every modal/drawer/
 * sheet and embedded option list. Use it directly inside any container (a
 * ScrollView profile modal, a centered dialog, a bottom sheet) when the shared
 * `ActionSheet` shell doesn't fit — e.g. surfaces that also need Switch rows,
 * a confirm dialog hosted on top, an emoji strip, or a search field.
 *
 * For a standard bottom-sheet menu, prefer `ActionSheet`, which composes these.
 *
 * `ActionRowGroup` wraps rows in the standardized rounded card with 1px
 * dividers between them (and none after the last). Pass plain `<ActionRow>`
 * children; the group handles the card + divider chrome.
 *
 * See .agents/reports/2026-06-15-modal-link-row-audit-and-unified-component.md
 *
 * @example
 *   <ActionRowGroup>
 *     <ActionRow icon="bubble.left" label="Message" onPress={onMessage} />
 *     <ActionRow icon="bell.slash" label="Mute" onPress={onMute} />
 *     <ActionRow icon="trash" label="Delete" destructive onPress={onDelete} />
 *   </ActionRowGroup>
 */

import React from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { useTheme, type AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

export interface ActionRowProps {
  label: string;
  /** IconSymbol name. Omit to leave an aligned spacer, or use `leading`. */
  icon?: string;
  onPress?: () => void;
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
  /** Internal — set by ActionRowGroup to drop the divider on the last row. */
  isLast?: boolean;
  style?: ViewStyle;
}

/** Resolve the label/icon tint from the row's state. */
function rowColor(theme: AppTheme, props: ActionRowProps): string {
  if (props.disabled) return theme.colors.textMuted;
  if (props.destructive) return theme.colors.danger;
  if (props.active) return theme.colors.success;
  return theme.colors.textMain;
}

export function ActionRow(props: ActionRowProps) {
  const { theme } = useTheme();
  const styles = createRowStyles(theme);
  const color = rowColor(theme, props);

  const interactive = !!props.onPress && !props.disabled;

  return (
    <TouchableOpacity
      style={[styles.row, props.isLast && styles.rowLast, props.style]}
      onPress={props.onPress}
      activeOpacity={interactive ? 0.6 : 1}
      disabled={!interactive}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!props.disabled }}
    >
      {props.leading ? (
        props.leading
      ) : props.icon ? (
        // icon name is validated by IconSymbol's mapping at runtime; the strict
        // union type is too narrow for a generic wrapper.
        <IconSymbol name={props.icon as IconSymbolName} size={20} color={color} />
      ) : (
        <View style={styles.iconSpacer} />
      )}

      <View style={styles.labelColumn}>
        <Text style={[styles.label, { color }]}>{props.label}</Text>
        {props.sublabel ? (
          <Text style={styles.sublabel} numberOfLines={1}>
            {props.sublabel}
          </Text>
        ) : null}
      </View>

      {props.trailing === 'chevron' ? (
        <IconSymbol name="chevron.right" size={16} color={theme.colors.textMuted} />
      ) : props.trailing ? (
        props.trailing
      ) : null}
    </TouchableOpacity>
  );
}

export interface ActionRowGroupProps {
  children: React.ReactNode;
  style?: ViewStyle;
}

/**
 * Wraps ActionRow children in the standardized rounded card and stamps the
 * `isLast` flag so the trailing divider is dropped on the final row.
 */
export function ActionRowGroup({ children, style }: ActionRowGroupProps) {
  const { theme } = useTheme();
  const styles = createRowStyles(theme);

  const rows = React.Children.toArray(children);
  return (
    <View style={[styles.group, style]}>
      {rows.map((child, index) =>
        React.isValidElement<ActionRowProps>(child)
          ? React.cloneElement(child, { isLast: index === rows.length - 1 })
          : child,
      )}
    </View>
  );
}

const createRowStyles = (theme: AppTheme) =>
  StyleSheet.create({
    group: {
      // surface2 card after the down-one-step shift (sheet sits at surface0).
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(14),
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(14),
      minHeight: 44,
      // Full 1px (not hairlineWidth ~0.5px, which read as barely visible).
      // surface4 against the surface2 card.
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.surface4,
    },
    rowLast: {
      borderBottomWidth: 0,
    },
    iconSpacer: {
      width: 20,
    },
    labelColumn: {
      flex: 1,
    },
    label: {
      ...theme.textStyles.callout,
    },
    sublabel: {
      ...theme.textStyles.footnote,
      color: theme.colors.textMuted,
      marginTop: Skin.space(1),
    },
  });

export default ActionRow;
