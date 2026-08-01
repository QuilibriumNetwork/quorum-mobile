/**
 * ChannelHeader — the top bar for a Space channel, rendered in React Native
 * rather than by the native navigation stack.
 *
 * Why not the native header: on iOS the navigation bar is a real UIKit
 * `UINavigationBar`, so its back button, its button chrome and its title
 * alignment are Apple's to change — iOS 26 wrapped every bar button in a
 * Liquid Glass capsule, and a bug in the pinned react-native-screens could
 * leave the native back button permanently unresponsive. None of that is
 * visible from an Android device, which is the only platform this project
 * can test on. Drawing the bar ourselves removes the whole class of problem
 * and makes Android a faithful preview of iOS.
 *
 * The trade-off is that the native large-title and scroll-edge behaviours are
 * gone here, and the title is left-aligned on both platforms (iOS centres it)
 * — matching SpaceBannerHeader one level up, so the two Space screens finally
 * agree with each other.
 */

import type { AppTheme } from '@/theme';
import { IconSymbol } from '@/components/ui/IconSymbol';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

// Expands the tap target of the header icon buttons without changing layout
// (the glyphs and their spacing stay identical). Horizontal slop is kept at 8
// so adjacent icons' touch zones meet but don't overlap; vertical slop is
// larger since nothing sits above or below in the header row.
const headerIconHitSlop = { top: 12, bottom: 12, left: 8, right: 8 };

// Matches the height of a standard native nav bar so the chat area below keeps
// the vertical rhythm it had when the header was native.
const BAR_HEIGHT = 44;

interface ChannelHeaderProps {
  channelName: string;
  /** Safe-area top inset — the bar paints into the status bar area itself. */
  insetTop: number;
  onBack: () => void;
  onStartVideoCall: () => void;
  onStartAudioCall: () => void;
  /** Invite is owner-only, mirroring the space settings entry point. */
  onInvite?: () => void;
  onOpenSettings: () => void;
  theme: AppTheme;
}

export const ChannelHeader = React.memo(function ChannelHeader({
  channelName,
  insetTop,
  onBack,
  onStartVideoCall,
  onStartAudioCall,
  onInvite,
  onOpenSettings,
  theme,
}: ChannelHeaderProps) {
  const styles = React.useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={[styles.container, { paddingTop: insetTop }]}>
      <View style={styles.bar}>
        <TouchableOpacity
          onPress={onBack}
          style={styles.backButton}
          hitSlop={headerIconHitSlop}
          accessibilityRole="button"
          accessibilityLabel="Back to channel list"
        >
          <IconSymbol name="chevron.left" color={theme.colors.textMain} size={22} />
        </TouchableOpacity>

        <Text style={styles.title} numberOfLines={1}>
          {`# ${channelName}`}
        </Text>

        <View style={styles.right}>
          <TouchableOpacity
            onPress={onStartVideoCall}
            hitSlop={headerIconHitSlop}
            accessibilityRole="button"
            accessibilityLabel="Start a video call"
          >
            <IconSymbol name="video" color={theme.colors.primary} size={20} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onStartAudioCall}
            hitSlop={headerIconHitSlop}
            accessibilityRole="button"
            accessibilityLabel="Start a voice call"
          >
            <IconSymbol name="phone" color={theme.colors.primary} size={20} />
          </TouchableOpacity>
          {onInvite && (
            <TouchableOpacity
              onPress={onInvite}
              hitSlop={headerIconHitSlop}
              accessibilityRole="button"
              accessibilityLabel="Invite people to this space"
            >
              <IconSymbol name="person.badge.plus" color={theme.colors.textMain} size={20} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={onOpenSettings}
            hitSlop={headerIconHitSlop}
            accessibilityRole="button"
            accessibilityLabel="Space settings"
          >
            <IconSymbol name="gearshape" color={theme.colors.textMain} size={20} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
});

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      backgroundColor: theme.colors.surface1,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border ?? theme.colors.surface3,
    },
    bar: {
      height: BAR_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Skin.space(12),
      gap: Skin.space(12),
    },
    backButton: {
      // Nudged left so the chevron optically aligns with the 16px content
      // gutter the channel list and message rows use.
      marginLeft: Skin.space(-4),
    },
    title: {
      flex: 1,
      ...theme.textStyles.headline,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    right: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(16),
    },
  });

export default ChannelHeader;
