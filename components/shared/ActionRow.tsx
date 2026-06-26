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
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
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
  style?: StyleProp<ViewStyle>;
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

  // Single-line rows center the leading glyph (aligned with the one line);
  // multi-line rows (with a sublabel) TOP-align it so it pairs with the TITLE,
  // not the gap between title and sublabel — the standard iOS/Material pattern.
  // Single-line behavior is unchanged from before.
  const multiline = !!props.sublabel;
  const leadingNudge = multiline ? styles.leadingTopNudge : undefined;

  return (
    <TouchableOpacity
      style={[
        styles.row,
        multiline && styles.rowMultiline,
        props.isLast && styles.rowLast,
        props.style,
      ]}
      onPress={props.onPress}
      activeOpacity={interactive ? 0.6 : 1}
      disabled={!interactive}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!props.disabled }}
    >
      {props.leading ? (
        // Top-nudge a custom leading node too (channel icon, avatar) so it lines
        // up with the title on multi-line rows.
        multiline ? <View style={leadingNudge}>{props.leading}</View> : props.leading
      ) : props.icon ? (
        // icon name is validated by IconSymbol's mapping at runtime; the strict
        // union type is too narrow for a generic wrapper.
        <IconSymbol name={props.icon as IconSymbolName} size={20} color={color} style={leadingNudge} />
      ) : (
        <View style={styles.iconSpacer} />
      )}

      <View style={styles.labelColumn}>
        <Text style={[styles.label, { color }]} numberOfLines={1}>
          {props.label}
        </Text>
        {props.sublabel ? (
          // No numberOfLines — sublabels wrap to as many lines as needed so the
          // full text always shows (never truncated on narrow screens).
          <Text style={styles.sublabel}>
            {props.sublabel}
          </Text>
        ) : null}
      </View>

      {props.trailing === 'chevron' ? (
        <IconSymbol
          name="chevron.right"
          size={16}
          color={theme.colors.textMuted}
          style={multiline ? styles.trailingCenter : undefined}
        />
      ) : props.trailing ? (
        // Keep the trailing control (Switch, chevron…) vertically centered even
        // when the row top-aligns its leading icon + text for a sublabel.
        multiline ? <View style={styles.trailingCenter}>{props.trailing}</View> : props.trailing
      ) : null}
    </TouchableOpacity>
  );
}

export interface ActionRowGroupProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
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
    rowMultiline: {
      // Top-align leading icon + text column for two-line rows (icon pairs with
      // the title). The trailing control is re-centered via `trailingCenter`.
      alignItems: 'flex-start',
    },
    rowLast: {
      borderBottomWidth: 0,
    },
    iconSpacer: {
      width: 20,
    },
    // Optical nudge so a 20px glyph sits on the title's text line (not the very
    // cap top) when the row is top-aligned.
    leadingTopNudge: {
      marginTop: Skin.space(2),
    },
    // Re-center a trailing control against the full row height on multi-line rows.
    trailingCenter: {
      alignSelf: 'center',
    },
    labelColumn: {
      flex: 1,
    },
    label: {
      ...theme.textStyles.callout,
    },
    sublabel: {
      ...theme.textStyles.footnote,
      // Secondary description text → textSubtle (the readable secondary tone),
      // not textMuted (the placeholder/disabled tone, near-invisible in light).
      color: theme.colors.textSubtle,
      marginTop: Skin.space(1),
    },
  });

export default ActionRow;
