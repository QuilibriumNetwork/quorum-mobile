/**
 * ScreenHeader — the app's top bar, drawn in React Native.
 *
 * This is the single definition of header geometry. Every screen that used to
 * rely on the native navigation header renders this instead, for two reasons:
 *
 *  1. On iOS the native bar is a real UIKit `UINavigationBar`, so its button
 *     chrome, back button and title alignment belong to Apple. iOS 26 wrapped
 *     every bar button in a Liquid Glass capsule, and a defect in the pinned
 *     react-native-screens could leave the native back button permanently
 *     unresponsive. Neither is observable from an Android device, which is the
 *     only platform this project can test on.
 *  2. Drawing it ourselves means the header renders from identical code on both
 *     platforms, so Android is a faithful preview of what iOS will show.
 *
 * Keep this as the ONE place header height, padding and typography are defined.
 * Screens with richer bars (ChannelHeader, DMChatHeader) compose this rather
 * than re-implementing it — a component that merely looks like the live header
 * is how a fix once landed in the wrong file.
 */

import type { AppTheme } from '@/theme';
import { IconSymbol } from '@/components/ui/IconSymbol';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

/**
 * Expands the tap target of header icon buttons without changing layout.
 * Horizontal slop is kept at 8 so adjacent icons' touch zones meet but don't
 * overlap; vertical slop is larger since nothing sits above or below the row.
 */
export const headerIconHitSlop = { top: 12, bottom: 12, left: 8, right: 8 };

/** Matches a standard native nav bar, so converted screens keep their rhythm. */
export const HEADER_BAR_HEIGHT = 44;

export interface ScreenHeaderProps {
  /** A plain string, or a custom node (e.g. an avatar beside a name). */
  title: React.ReactNode;
  /** Safe-area top inset — the bar paints into the status bar area itself. */
  insetTop: number;
  /** Omit to render no back affordance (a tab root, for instance). */
  onBack?: () => void;
  /** Trailing controls. Lay them out yourself; they are placed in a row. */
  right?: React.ReactNode;
  /** Defaults to `surface1`. Screens whose body is a different surface pass theirs. */
  backgroundColor?: string;
  /**
   * Hairline separator below the bar. On by default.
   *
   * The convention in this app:
   * - **Keep it** on conversation screens (a channel, a DM). Content scrolls up
   *   underneath the bar, so the rule is what stops messages appearing to
   *   collide with the title.
   * - **Turn it off** on list and settings screens (Spaces, Messages, Wallet,
   *   Profile, Discover). Those put a search field, a segmented
   *   control or a section header directly beneath the bar, and a rule between
   *   the two reads as a stray line. None of the app's own list headers draw
   *   one, so a separator here is what looks inconsistent, not its absence.
   */
  showBorder?: boolean;
  accessibilityBackLabel?: string;
  theme: AppTheme;
}

export const ScreenHeader = React.memo(function ScreenHeader({
  title,
  insetTop,
  onBack,
  right,
  backgroundColor,
  showBorder = true,
  accessibilityBackLabel = 'Go back',
  theme,
}: ScreenHeaderProps) {
  const styles = React.useMemo(() => createStyles(theme), [theme]);

  return (
    <View
      style={[
        styles.container,
        backgroundColor ? { backgroundColor } : null,
        showBorder ? styles.bordered : null,
        { paddingTop: insetTop },
      ]}
    >
      <View style={styles.bar}>
        {onBack && (
          <TouchableOpacity
            onPress={onBack}
            style={styles.backButton}
            hitSlop={headerIconHitSlop}
            accessibilityRole="button"
            accessibilityLabel={accessibilityBackLabel}
          >
            <IconSymbol name="chevron.left" color={theme.colors.textMain} size={22} />
          </TouchableOpacity>
        )}

        {typeof title === 'string' ? (
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        ) : (
          <View style={styles.titleSlot}>{title}</View>
        )}

        {right ? <View style={styles.right}>{right}</View> : null}
      </View>
    </View>
  );
});

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      backgroundColor: theme.colors.surface1,
    },
    bordered: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border ?? theme.colors.surface3,
    },
    bar: {
      // minHeight, NOT height. Text scales with the OS font-size setting; a
      // declared height does not. At the default scale this is identical (the
      // tallest content — a 28px avatar, a 22px title line — sits well under
      // 44), so no existing screen moves. It only differs once content would
      // otherwise exceed the bar, where the old fixed height let it bleed over
      // the content below rather than clip: nothing here sets `overflow:
      // hidden`. A two-line title (a DM header showing a linked-identity badge
      // under the name) reaches that point at roughly a 1.15x font scale,
      // which is an ordinary Settings value, not an accessibility extreme.
      //
      // Same class of bug, and the same reasoning, as the message-row header
      // that had to start multiplying its height by `PixelRatio.getFontScale()`
      // — but a minimum needs no scale factor at all, so there is no second
      // copy of that arithmetic to drift.
      minHeight: HEADER_BAR_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Skin.space(12),
      gap: Skin.space(12),
    },
    backButton: {
      // Nudged left so the chevron optically aligns with the 16px content
      // gutter that list rows and message rows use.
      marginLeft: Skin.space(-4),
    },
    title: {
      flex: 1,
      ...theme.textStyles.headline,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    titleSlot: {
      flex: 1,
      minWidth: 0,
    },
    right: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(16),
    },
  });

export default ScreenHeader;
