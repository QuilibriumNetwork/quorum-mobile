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

export type SegmentedPillsVariant = 'tinted' | 'solid' | 'segmented';

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
  /** Wrap pills onto multiple lines instead of equal-width fitting. Implies a
   *  fixed (non-scrolling) row; pills size to content and wrap. */
  wrap?: boolean;
  /** Auto-scroll the tapped pill toward centre (scrollable rows only). */
  centerOnSelect?: boolean;
  /** Tapping the active pill calls onChange with the same key (caller may
   *  treat that as a toggle-off). */
  allowReselect?: boolean;
  /** Accessibility role for each pill: 'tab' for tab bars, 'button' for filters. */
  itemRole?: 'tab' | 'button';
  /** Pill outline: 'rounded' = fully-rounded pill (default), 'rect' = squarer
   *  rounded rectangle for tab-bar-style rows. The 'segmented' variant is always
   *  rect (lifted card). */
  pillShape?: 'rounded' | 'rect';
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
  wrap = false,
  centerOnSelect = true,
  allowReselect = false,
  itemRole = 'tab',
  pillShape = 'rounded',
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

  // `wrap` is a fixed (non-scrolling) layout where pills size to content and
  // wrap onto multiple lines, so it overrides `scrollable`.
  const isScrollable = scrollable && !wrap;

  const handlePress = (item: SegmentedPillItem) => {
    const isActive = item.key === activeKey;
    if (isActive && !allowReselect) return;
    if (hapticFeedback) Haptics.selectionAsync();
    onChange(item.key);
    if (isScrollable && centerOnSelect) pills.center(item.key);
  };

  const renderPill = (item: SegmentedPillItem) => {
    const isActive = item.key === activeKey;
    const itemAccent = item.danger ? theme.colors.danger : item.accentColor ?? theme.colors.primary;

    // Whether this pill carries its own (non-accent) tint color — chains pass a
    // brand accentColor; danger uses the danger color.
    const hasItemColor = Boolean(item.accentColor) || Boolean(item.danger);

    // Per-variant foreground / background / border. Three looks:
    //  - 'solid': active = loud solid fill (item/chain color) + white text; rest
    //    = neutral grey + muted text. The color appears ONLY on the active pill.
    //  - 'tinted': active = accentSoft (or low-alpha own color) + accent text +
    //    border; rest = flat grey (or transparent for colored pills).
    //  - 'segmented': iOS lifted-card on a grey track. Active = raised card
    //    (`background`) + strong text; rest = transparent on the track + muted
    //    text. No accent color; the track lives on the row container.
    let fg: string;
    let bg: string;
    let borderColor: string | undefined;
    let subtitleColor: string = theme.colors.textMuted;

    if (variant === 'solid') {
      fg = isActive ? theme.colors.surface0 : theme.colors.textSubtle; // secondary text → subtle (muted is unreadable in light)
      bg = isActive ? itemAccent : theme.colors.surface3;
      borderColor = isActive ? itemAccent : undefined;
      if (isActive) subtitleColor = withAlpha(theme.colors.surface0, 0.8);
    } else if (variant === 'segmented') {
      fg = isActive ? theme.colors.textStrong : theme.colors.textMuted;
      bg = isActive ? theme.colors.background : 'transparent';
      borderColor = undefined;
    } else {
      // tinted
      fg = hasItemColor ? itemAccent : isActive ? itemAccent : theme.colors.textMuted;
      bg = hasItemColor
        ? isActive
          ? withAlpha(itemAccent, 0.15)
          : 'transparent'
        : isActive
          ? theme.colors.accentSoft
          : theme.colors.surface3;
      borderColor = !hasItemColor
        ? isActive
          ? itemAccent
          : undefined
        : isActive
          ? itemAccent
          : withAlpha(itemAccent, 0.5);
    }

    const pillStyle = [
      styles.pill,
      // Squarer corners for tab-bar-style rows; the segmented variant is always
      // a rounded rectangle (lifted card).
      pillShape === 'rect' || variant === 'segmented' ? styles.roundedRect : null,
      // In a fixed (non-scrolling, non-wrapping) row, pills share the width
      // equally so the row reads as a segmented control (e.g. Join/Create). In a
      // wrapping row they size to content instead.
      !isScrollable && !wrap ? styles.pillFlex : null,
      // Segmented cards sit flush in the track with a slightly tighter radius.
      variant === 'segmented' ? styles.segmentedPill : null,
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
          <Text
            style={[styles.label, variant === 'segmented' && isActive && styles.labelBold, { color: fg }]}
            numberOfLines={1}
          >
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

  if (!isScrollable) {
    return (
      <View
        style={[
          styles.fixedRow,
          wrap && styles.wrapRow,
          variant === 'segmented' && styles.track,
          style,
          contentContainerStyle,
        ]}
        testID={testID}
      >
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
    wrapRow: {
      flexWrap: 'wrap',
    },
    // 'segmented' variant: a grey rounded track that holds the cards flush
    // (no gap), iOS-segmented-control style.
    track: {
      gap: 0,
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      // 1px inset so the card's own padding + this = the standard pill height
      // (8 padding + 1 border per side), keeping segmented rows the same height
      // as pill rows that sit near them.
      padding: Skin.space(1),
    },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Skin.space(6),
      paddingVertical: Skin.space(8),
      paddingHorizontal: Skin.space(12),
      // Fully-rounded pill shape by default (it's a "pill" component). Tab-bar /
      // segmented use cases opt into a squarer radius via the `pillShape` prop.
      borderRadius: theme.radii.pill,
      borderWidth: Skin.border(1),
      borderColor: 'transparent',
    },
    // Squarer rounded-rectangle radius for tab-bar-style rows.
    roundedRect: {
      borderRadius: Skin.radius(8),
    },
    pillFlex: {
      flex: 1,
    },
    // Card inside the segmented track: no border, same vertical padding as a
    // standard pill so (track inset 1 + padding 8) matches the pill's (padding 8
    // + border 1) and the two row types line up in height.
    segmentedPill: {
      borderRadius: Skin.radius(9),
      borderWidth: 0,
      paddingVertical: Skin.space(8),
      paddingHorizontal: Skin.space(10),
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
    labelBold: {
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
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
