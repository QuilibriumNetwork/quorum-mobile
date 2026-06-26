import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { QnsIcon } from '@/components/ui/QnsIcon';
import { useAuth } from '@/context';
import { useUnifiedNotifications } from '@/hooks/useUnifiedNotifications';
import { feedActiveTabBus } from '@/services/ui/feedActiveTab';
import { useTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import * as Haptics from 'expo-haptics';
import { router, usePathname } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { composerBottomBusySV, useComposerPanelVisible } from '@/services/ui/composerPanelVisible';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Height of the icon-only primary row.
const PRIMARY_ROW_HEIGHT = 54;
// Height of the secondary row (icon + label).
const SECONDARY_ROW_HEIGHT = 62;
// Extra vertical breathing room (top + bottom) added ONLY when the bar is
// expanded to show both rows, so the two-row state feels roomier.
const EXPANDED_V_PADDING = 12;
// Horizontal margin from screen edges.
const H_MARGIN = 0;
// Bottom margin above the home indicator / edge.
const BOTTOM_MARGIN = 0;
// Corner radius of the floating pill.
const PILL_RADIUS = 0;

const AVATAR_SIZE = 32;

// ─── Avatar button ────────────────────────────────────────────────────────────

function AvatarButton() {
  const { user } = useAuth();
  const { theme } = useTheme();

  const uri = user?.profileImage || user?.farcaster?.pfpUrl || undefined;
  const fallbackName = user?.displayName || user?.primaryUsername || '';

  const handlePress = useCallback(() => {
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    router.push('/account');
  }, []);

  return (
    <TouchableOpacity
      onPress={handlePress}
      hitSlop={8}
      activeOpacity={0.75}
      accessibilityLabel="Open profile and settings"
      accessibilityRole="button"
      style={styles.tabSlot}
    >
      <View style={[styles.avatarWrap, { backgroundColor: theme.colors.surface3 }]}>
        <CachedAvatar
          source={uri ? { uri } : null}
          style={styles.avatar}
          fallbackName={fallbackName}
        />
      </View>
    </TouchableOpacity>
  );
}

// ─── Bell icon with unread dot ────────────────────────────────────────────────

function BellIcon({ color }: { color: string }) {
  const { unreadCount } = useUnifiedNotifications();
  return (
    <View>
      <IconSymbol size={24} name="bell" color={color} />
      {unreadCount > 0 && (
        <View style={[styles.unreadDot, { borderRadius: Skin.radius(5) }]} />
      )}
    </View>
  );
}

// ─── Primary row tab button ───────────────────────────────────────────────────

function PrimaryTabButton({
  icon,
  onPress,
  accessibilityLabel,
  isFocused,
}: {
  icon: React.ReactNode;
  isFocused: boolean;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const handlePress = useCallback(() => {
    if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  }, [onPress]);

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="tab"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: isFocused }}
      style={styles.tabSlot}
    >
      {icon}
    </Pressable>
  );
}

// ─── Secondary row item ───────────────────────────────────────────────────────

function SecondaryItem({
  icon,
  renderIcon,
  label,
  disabled,
  color,
  onPress,
}: {
  // Either a legacy IconSymbol name OR a custom-rendered node (renderIcon).
  icon?: string;
  renderIcon?: (color: string) => React.ReactNode;
  label: string;
  disabled?: boolean;
  color: string;
  onPress: () => void;
}) {
  const { theme } = useTheme();

  const handlePress = useCallback(() => {
    if (disabled) return;
    if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  }, [disabled, onPress]);

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={[styles.secondarySlot, disabled && styles.disabledSlot]}
    >
      {renderIcon ? renderIcon(color) : <IconSymbol size={22} name={icon as any} color={color} />}
      <Text
        style={[
          styles.secondaryLabel,
          { color: color === theme.colors.primary ? color : theme.colors.textMuted },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ─── AppTabBar ────────────────────────────────────────────────────────────────

export function AppTabBar({ state, navigation }: BottomTabBarProps) {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  // Panel-open as React state, only to make the bar inert (pointerEvents) while
  // the panel is open so it can't catch taps meant for it. The VISUAL hide is
  // the UI-thread worklet (hideStyle); this is just touch-inertness.
  const panelOpen = useComposerPanelVisible();

  const [extraOpen, setExtraOpen] = useState(false);
  // 0 = closed, 1 = open
  const anim = useRef(new Animated.Value(0)).current;
  // The bar is ALWAYS mounted (never unmounted) so transitions reveal/cover it
  // with no remount lag. Visual visibility is the UI-thread `hideStyle` worklet
  // below; `panelOpen` (above) only drives pointerEvents (touch-inertness while
  // the panel is open, so it can't catch taps meant for the panel).

  const activeColor = theme.colors.primary;
  const inactiveColor = theme.colors.tabBarIconInactive;

  const animate = useCallback(
    (toValue: number, onDone?: () => void) => {
      Animated.spring(anim, {
        toValue,
        useNativeDriver: false,
        bounciness: toValue === 1 ? 4 : 0,
        speed: toValue === 1 ? 12 : 18,
      }).start(onDone);
    },
    [anim],
  );

  const toggleExtra = useCallback(() => {
    const next = !extraOpen;
    setExtraOpen(next);
    animate(next ? 1 : 0);
    if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [extraOpen, animate]);

  const closeExtra = useCallback(() => {
    if (!extraOpen) return;
    setExtraOpen(false);
    animate(0);
  }, [extraOpen, animate]);

  // Full current route path (e.g. "/spaces/discover", "/profile/apps"). We use
  // this rather than walking the navigator's nested state: when a SECONDARY-row
  // item switches to a not-yet-hydrated tab, the nested stack's leaf isn't known
  // on first render, so the walk reports the TAB name (e.g. "spaces") and the
  // parent's primary icon wrongly lights up. usePathname() is deterministic and
  // updates reliably, so the suppression below never misfires.
  const pathname = usePathname();

  // Paths that belong to SECONDARY-row items, not to a primary tab. When one of
  // these is active, no primary icon should be accented even though the path is
  // nested under a primary tab's stack.
  const SECONDARY_ROW_PATHS = useMemo(
    () => ['/spaces/discover', '/profile/apps'],
    [],
  );

  const onSecondaryRowScreen = useMemo(
    () => SECONDARY_ROW_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`)),
    [pathname, SECONDARY_ROW_PATHS],
  );

  // Active color for a secondary-row item: accent it when its own path is the
  // current screen, otherwise leave it inactive.
  const secondaryColor = useCallback(
    (path: string) =>
      pathname === path || pathname.startsWith(`${path}/`) ? activeColor : inactiveColor,
    [pathname, activeColor, inactiveColor],
  );

  const getTabColor = useCallback(
    (routeName: string) => {
      const isTabFocused =
        state.routes.findIndex((r) => r.name === routeName) === state.index;
      // Don't accent the primary icon when the active screen is actually a
      // secondary-row destination nested under this tab.
      if (isTabFocused && onSecondaryRowScreen) {
        return inactiveColor;
      }
      return isTabFocused ? activeColor : inactiveColor;
    },
    [state, activeColor, inactiveColor, onSecondaryRowScreen],
  );

  const handleTabPress = useCallback(
    (routeName: string) => {
      closeExtra();
      const route = state.routes.find((r) => r.name === routeName);
      if (!route) return;
      const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
      if (!event.defaultPrevented) navigation.navigate(route.name, route.params);
    },
    [state, navigation, closeExtra],
  );

  const handleFeedPress = useCallback(() => {
    closeExtra();
    const feedRoute = state.routes.find((r) => r.name === 'feed');
    if (!feedRoute) return;
    const isFocused = state.routes[state.index]?.name === 'feed';
    const event = navigation.emit({ type: 'tabPress', target: feedRoute.key, canPreventDefault: true });
    if (isFocused) {
      event.preventDefault();
      feedActiveTabBus.fire();
    } else if (!event.defaultPrevented) {
      navigation.navigate(feedRoute.name, feedRoute.params);
    }
  }, [state, navigation, closeExtra]);

  // ── Animation model ───────────────────────────────────────────────────────
  //
  // The pill has a fixed inner height of PRIMARY + SECONDARY and uses
  // `overflow: hidden`. The pill's rendered height animates from
  // PRIMARY_ROW_HEIGHT → PRIMARY + SECONDARY, clipping from the top.
  //
  // Both rows sit inside a container that is always PRIMARY + SECONDARY tall.
  // - Primary row  → position: absolute, bottom: 0  (always anchored to bottom)
  // - Secondary row → position: absolute, bottom: 0, height: SECONDARY
  //   but starts hidden under the primary row; as the pill grows downward
  //   the primary row stays bottom-anchored and the secondary appears below it
  //
  // Wait — we want primary to LIFT UP and secondary to appear BELOW. So:
  // - Container height = PRIMARY + SECONDARY (constant)
  // - Primary row: position absolute, BOTTOM anchored
  //   → translateY from 0 (closed, at very bottom) to -SECONDARY (open, lifted)
  //   OR just: container grows upward, primary stays at top, secondary fills bottom
  //
  // Cleanest: pill grows upward (bottom-anchored outerWrapper).
  // Inner layout: primary row on top (flex), secondary row on bottom (flex).
  // Pill height goes from PRIMARY_ROW_HEIGHT → PRIMARY + SECONDARY.
  // overflow:hidden clips secondary row off initially.
  // As height grows the secondary row becomes visible below the primary.
  // Primary row appears to "move up" because the pill expands below it.

  const pillHeight = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [
      PRIMARY_ROW_HEIGHT,
      // Expanded: both rows + top & bottom breathing room.
      PRIMARY_ROW_HEIGHT + SECONDARY_ROW_HEIGHT + EXPANDED_V_PADDING * 2,
    ],
  });

  // Top/bottom padding grows in only when expanded, matching the pill growth.
  const expandedPadding = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, EXPANDED_V_PADDING],
  });

  // Secondary row fades in only in the second half of the animation
  const secondaryOpacity = anim.interpolate({
    inputRange: [0, 0.4, 1],
    outputRange: [0, 0, 1],
  });

  const bottomOffset = BOTTOM_MARGIN + insets.bottom;

  // ── Tab-bar visibility: ONE UI-thread rule for every transition ──────────
  // Hidden iff the composer owns the bottom (composerBottomBusySV) — i.e. the
  // panel is open or mid panel↔keyboard hand-off, when an RN panel (not the OS
  // keyboard) occupies the bottom and wouldn't cover the bar.
  //
  // We deliberately do NOT gate on keyboard height. The bar is always mounted at
  // bottom: 0; for a plain keyboard show/dismiss the OS keyboard is drawn on top
  // and covers/reveals it, so the bar stays opacity 1 and the descending
  // keyboard reveals an already-present bar (no empty-gap-then-appear). Gating on
  // keyboard height instead hid the bar for the whole slide and snapped it in at
  // the end — the close-direction gap. `bottomBusy` is UI-thread, so no React lag.
  const hideStyle = useAnimatedStyle(() => ({
    opacity: composerBottomBusySV.value === 1 ? 0 : 1,
  }));

  return (
    <>
      {/* Safe-area fill: the bar floats `insets.bottom` above the screen edge so
          its rows clear the home indicator / app-switcher. That strip below the
          bar is otherwise transparent, letting scrolled content show through (iOS,
          and any Android with a bottom inset). Paint it the same solid bar color so
          the bottom edge reads as one continuous surface. Shares hideStyle so it
          fades out in lockstep with the bar when a composer panel owns the bottom. */}
      {insets.bottom > 0 && (
        <Reanimated.View
          pointerEvents="none"
          style={[
            styles.safeAreaFill,
            { height: insets.bottom, backgroundColor: isDark ? '#000000' : '#ffffff' },
            hideStyle,
          ]}
        />
      )}
      <Reanimated.View
        style={[styles.outerWrapper, { bottom: bottomOffset }, hideStyle]}
        pointerEvents={panelOpen ? 'none' : 'box-none'}
      >
      <Animated.View
        style={[
          styles.pill,
          {
            height: pillHeight,
            borderRadius: PILL_RADIUS,
            shadowColor: '#000',
          },
        ]}
      >
        {/* Solid background */}
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: PILL_RADIUS,
              backgroundColor: isDark ? '#000000' : '#ffffff',
            },
          ]}
        />

        {/* Inner container — always full expanded height, clipped by pill.
            Vertical padding animates in only when expanded (roomier two-row state). */}
        <Animated.View
          style={[
            styles.innerContainer,
            { paddingTop: expandedPadding, paddingBottom: expandedPadding },
          ]}
        >
          {/* Primary row — always at top of inner container */}
          <View style={[styles.primaryRow, { height: PRIMARY_ROW_HEIGHT }]}>
            <AvatarButton />

            <PrimaryTabButton
              icon={<IconSymbol size={24} name="message" color={getTabColor('messages')} />}
              isFocused={state.routes[state.index]?.name === 'messages'}
              onPress={() => handleTabPress('messages')}
              accessibilityLabel="Messages"
            />
            <PrimaryTabButton
              icon={<IconSymbol size={24} name="person.3" color={getTabColor('spaces')} />}
              isFocused={state.routes[state.index]?.name === 'spaces'}
              onPress={() => handleTabPress('spaces')}
              accessibilityLabel="Spaces"
            />
            <PrimaryTabButton
              icon={<IconSymbol size={24} name="world-map" color={getTabColor('feed')} />}
              isFocused={state.routes[state.index]?.name === 'feed'}
              onPress={handleFeedPress}
              accessibilityLabel="Feed"
            />
            <PrimaryTabButton
              icon={<BellIcon color={getTabColor('profile')} />}
              isFocused={state.routes[state.index]?.name === 'profile'}
              onPress={() => handleTabPress('profile')}
              accessibilityLabel="Notifications"
            />

            <Pressable
              onPress={toggleExtra}
              accessibilityRole="button"
              accessibilityLabel={extraOpen ? 'Close menu' : 'More'}
              accessibilityState={{ expanded: extraOpen }}
              style={styles.tabSlot}
            >
              <IconSymbol
                size={24}
                name="ellipsis.vertical"
                color={extraOpen ? activeColor : inactiveColor}
              />
            </Pressable>
          </View>

          {/* Secondary row — sits below primary, revealed as pill expands */}
          <Animated.View
            style={[styles.secondaryRow, { height: SECONDARY_ROW_HEIGHT, opacity: secondaryOpacity }]}
            pointerEvents={extraOpen ? 'auto' : 'none'}
          >
            <SecondaryItem
              icon="wallet.pass"
              label="Wallet"
              color={secondaryColor('/wallet')}
              onPress={() => { closeExtra(); setTimeout(() => router.push('/wallet'), 0); }}
            />
            <SecondaryItem
              icon="bookmark"
              label="Bookmarks"
              color={inactiveColor}
              disabled
              onPress={() => {}}
            />
            <SecondaryItem
              icon="safari"
              label="Discover"
              color={secondaryColor('/spaces/discover')}
              onPress={() => { closeExtra(); setTimeout(() => router.push('/spaces/discover'), 0); }}
            />
            <SecondaryItem
              icon="square.grid.2x2"
              label="MiniApps"
              color={secondaryColor('/profile/apps')}
              onPress={() => { closeExtra(); setTimeout(() => router.push('/profile/apps'), 0); }}
            />
            <SecondaryItem
              renderIcon={(c) => <QnsIcon size={22} color={c} />}
              label="QNS"
              color={inactiveColor}
              disabled
              onPress={() => {}}
            />
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </Reanimated.View>
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  outerWrapper: {
    position: 'absolute',
    left: H_MARGIN,
    right: H_MARGIN,
  },
  safeAreaFill: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  pill: {
    overflow: 'hidden',
  },
  // Always-expanded inner container; the pill clips it. minHeight (not height)
  // so the animated paddingVertical ADDS to it rather than compressing the rows.
  innerContainer: {
    minHeight: PRIMARY_ROW_HEIGHT + SECONDARY_ROW_HEIGHT,
    flexDirection: 'column',
  },
  primaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  secondaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  tabSlot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  avatarWrap: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    overflow: 'hidden',
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
  },
  unreadDot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 9,
    height: 9,
    backgroundColor: '#FF3B30',
  },
  secondarySlot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
  },
  disabledSlot: {
    opacity: 0.38,
  },
  secondaryLabel: {
    fontSize: 10,
    fontWeight: '500',
    textAlign: 'center',
  },
});
