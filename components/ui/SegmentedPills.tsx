// SegmentedPills — a horizontal row of selectable "pill" chips used inside
// modals for filters / tab selectors. Replaces the per-modal hand-rolled pill
// rows, giving one consistent active state and (optionally) auto-centring the
// tapped pill.
//
// Active-state standard (the fix for the "invisible active pill" problem):
//   - variant 'tinted' (default): active background = theme.colors.accentSoft
//     (12% accent), active text/icon = accent (or per-item accentColor, or
//     danger). Inactive = surface3 / textMuted.
//   - variant 'solid': active background = full accent (or accentColor),
//     active text/icon = surface0. For stronger looks (e.g. round icon chips).
//
// Built options-array driven (like the shared RadioGroup/Select primitives) and
// with a Base/Native-style prop split so it can later be promoted to
// quorum-shared/src/primitives/SegmentedControl with a .web.tsx sibling without
// a rewrite. See .agents/tasks/2026-06-17-horizontal-pill-menu-ux-improvements.md

import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { useTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import { useCenteredPillScroll } from '@/hooks/useCenteredPillScroll';

export type SegmentedPillsVariant = 'tinted' | 'solid';

export interface SegmentedPillItem {
  /** Stable identifier; also the value passed to onChange. */
  key: string;
  /** Text label (omit for icon-only / emoji-only chips). */
  label?: string;
  /** Optional second line under the label (e.g. "KAS only" on a chain pill). */
  subtitle?: string;
  /** Icon glyph rendered left of the label (or alone if no label). */
  icon?: IconSymbolName;
  /** Emoji glyph rendered left of the label/count (for reaction pills). */
  emoji?: string;
  /** Arbitrary leading content (e.g. a custom-emoji <Image>), rendered before
   *  the label/count. Takes precedence over `icon`/`emoji` when provided. */
  leading?: React.ReactNode;
  /** A count shown after the emoji/label (for reaction pills). */
  count?: number;
  /** Arbitrary trailing content (e.g. a styled count badge), rendered after
   *  the label/count. */
  trailing?: React.ReactNode;
  /** Per-item active color override (e.g. chain brand colors). */
  accentColor?: string;
  /** Use the danger color for the active state (e.g. a "Danger" tab). */
  danger?: boolean;
  /** Accessibility label; falls back to `label`. */
  accessibilityLabel?: string;
}

interface BaseSegmentedPillsProps {
  items: SegmentedPillItem[];
  /** Currently selected key, or null when nothing is selected. */
  activeKey: string | null;
  onChange: (key: string) => void;
  variant?: SegmentedPillsVariant;
  /** Horizontal scroll (default) vs a fixed flex row that fits the width. */
  scrollable?: boolean;
  /** Auto-scroll the tapped pill toward centre (scrollable rows only). */
  centerOnSelect?: boolean;
  /** Tapping the active pill calls onChange with the same key (caller may
   *  treat that as a toggle-off). */
  allowReselect?: boolean;
  /** Accessibility role for each pill: 'tab' for tab bars, 'button' for filters. */
  itemRole?: 'tab' | 'button';
  /** Font size for `item.emoji` glyphs (default 16; emoji-tab rows use ~22). */
  emojiSize?: number;
  /** Icon size for `item.icon` glyphs (default 16). */
  iconSize?: number;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

export interface NativeSegmentedPillsProps extends BaseSegmentedPillsProps {
  /** Light selection haptic on tap (default true). */
  hapticFeedback?: boolean;
}

export type SegmentedPillsProps = NativeSegmentedPillsProps;

export function SegmentedPills({
  items,
  activeKey,
  onChange,
  variant = 'tinted',
  scrollable = true,
  centerOnSelect = true,
  allowReselect = false,
  itemRole = 'tab',
  emojiSize = 16,
  iconSize = 16,
  hapticFeedback = true,
  style,
  contentContainerStyle,
  testID,
}: SegmentedPillsProps) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const pills = useCenteredPillScroll();

  const handlePress = (item: SegmentedPillItem) => {
    const isActive = item.key === activeKey;
    if (isActive && !allowReselect) return;
    if (hapticFeedback) Haptics.selectionAsync();
    onChange(item.key);
    if (scrollable && centerOnSelect) pills.center(item.key);
  };

  const renderPill = (item: SegmentedPillItem) => {
    const isActive = item.key === activeKey;
    const itemAccent = item.danger ? theme.colors.danger : item.accentColor ?? theme.colors.primary;

    // Whether this pill carries its own (non-accent) tint color — chains pass a
    // brand accentColor; danger uses the danger color.
    const hasItemColor = Boolean(item.accentColor) || Boolean(item.danger);

    // 'solid' variant: the active pill is a loud solid fill with white text; the
    // rest sit as a dimmed wash of their own color (chain identity at rest). The
    // strong difference in *kind* (solid vs dim) makes the selection unmistakable.
    // 'tinted' variant: the gentler accentSoft look used by tab bars.
    const fg =
      variant === 'solid'
        ? isActive
          ? theme.colors.surface0 // white text on the solid fill
          : hasItemColor
            ? itemAccent
            : theme.colors.textMuted
        : hasItemColor
          ? itemAccent
          : isActive
            ? itemAccent
            : theme.colors.textMuted;

    const bg =
      variant === 'solid'
        ? isActive
          ? itemAccent // full solid color
          : hasItemColor
            ? withAlpha(itemAccent, 0.12) // dimmed own-color wash at rest
            : theme.colors.surface3
        : hasItemColor
          ? isActive
            ? withAlpha(itemAccent, 0.15)
            : 'transparent'
          : isActive
            ? theme.colors.accentSoft
            : theme.colors.surface3;

    const borderColor =
      variant === 'solid'
        ? isActive
          ? itemAccent
          : undefined
        : !hasItemColor
          ? isActive
            ? itemAccent
            : undefined
          : isActive
            ? itemAccent
            : withAlpha(itemAccent, 0.5);

    // Subtitle sits one step quieter than the main label: a translucent white on
    // the active solid fill, otherwise the muted text color.
    const subtitleColor =
      variant === 'solid' && isActive
        ? withAlpha(theme.colors.surface0, 0.8)
        : theme.colors.textMuted;

    const pillStyle = [
      styles.pill,
      // In a fixed (non-scrolling) row, pills share the width equally so the row
      // reads as a segmented control, matching the existing Join/Create tabs.
      !scrollable ? styles.pillFlex : null,
      { backgroundColor: bg },
      borderColor ? { borderColor } : null,
    ];

    return (
      <Pressable
        key={item.key}
        onLayout={pills.onItemLayout(item.key)}
        onPress={() => handlePress(item)}
        style={({ pressed }) => [pillStyle, pressed && styles.pressed]}
        accessibilityRole={itemRole}
        accessibilityState={{ selected: isActive }}
        accessibilityLabel={item.accessibilityLabel ?? item.label}
        hitSlop={6}
      >
        {item.leading != null ? (
          item.leading
        ) : item.icon ? (
          <IconSymbol name={item.icon} size={iconSize} color={fg} />
        ) : item.emoji ? (
          <Text style={[styles.emoji, { fontSize: Skin.font(emojiSize) }]}>{item.emoji}</Text>
        ) : null}
        {item.label && item.subtitle ? (
          <View style={styles.labelColumn}>
            <Text style={[styles.label, { color: fg }]} numberOfLines={1}>
              {item.label}
            </Text>
            <Text style={[styles.subtitle, { color: subtitleColor }]} numberOfLines={1}>
              {item.subtitle}
            </Text>
          </View>
        ) : item.label ? (
          <Text style={[styles.label, { color: fg }]} numberOfLines={1}>
            {item.label}
          </Text>
        ) : null}
        {typeof item.count === 'number' ? (
          <Text style={[styles.count, { color: fg }]}>{item.count}</Text>
        ) : null}
        {item.trailing != null ? item.trailing : null}
      </Pressable>
    );
  };

  if (!scrollable) {
    return (
      <View style={[styles.fixedRow, style, contentContainerStyle]} testID={testID}>
        {items.map(renderPill)}
      </View>
    );
  }

  return (
    <ScrollView
      {...pills.scrollViewProps}
      style={[styles.scroll, style]}
      contentContainerStyle={[styles.scrollContent, contentContainerStyle]}
      testID={testID}
    >
      {items.map(renderPill)}
    </ScrollView>
  );
}

// Append an alpha to a hex color. Mirrors theme.themes.withAlpha for the
// per-item accentColor case (where we don't have a pre-computed soft token).
function withAlpha(hex: string, alpha: number): string {
  // Only handles #RGB / #RRGGBB; passes through rgba()/named colors unchanged
  // (callers pass hex chain colors and theme hex tokens).
  if (!hex.startsWith('#')) return hex;
  let r: number, g: number, b: number;
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  } else {
    r = parseInt(hex.slice(1, 3), 16);
    g = parseInt(hex.slice(3, 5), 16);
    b = parseInt(hex.slice(5, 7), 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const makeStyles = (theme: ReturnType<typeof useTheme>['theme']) =>
  StyleSheet.create({
    scroll: {
      flexGrow: 0,
    },
    scrollContent: {
      gap: Skin.space(8),
      paddingHorizontal: Skin.space(4),
    },
    fixedRow: {
      flexDirection: 'row',
      gap: Skin.space(8),
    },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Skin.space(6),
      paddingVertical: Skin.space(8),
      paddingHorizontal: Skin.space(12),
      borderRadius: Skin.radius(8),
      borderWidth: Skin.border(1),
      borderColor: 'transparent',
    },
    pillFlex: {
      flex: 1,
    },
    pressed: {
      opacity: 0.7,
    },
    labelColumn: {
      alignItems: 'center',
    },
    label: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    subtitle: {
      fontSize: Skin.font(10),
      marginTop: Skin.space(2),
      fontFamily: theme.fonts.regular.fontFamily,
    },
    count: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    emoji: {
      // fontSize is applied inline from the emojiSize prop.
      textAlign: 'center',
    },
  });
