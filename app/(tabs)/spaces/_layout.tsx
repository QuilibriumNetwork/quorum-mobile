import { useTheme } from '@/theme';
import { Stack } from 'expo-router';
import React from 'react';
import { Platform } from 'react-native';

export default function SpacesLayout() {
  const { theme } = useTheme();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface1 },
        headerTintColor: theme.colors.textMain,
        headerTitleStyle: {
          fontFamily: theme.fonts.bold.fontFamily,
          fontWeight: theme.fonts.bold.fontWeight,
        },
        // Color the gap exposed during the iOS swipe-back so it matches
        // the theme — by default that area shows white, which is
        // jarring in dark mode.
        contentStyle: { backgroundColor: theme.colors.surface1 },
        // Keep the edge swipe-to-go-back gesture explicitly enabled.
        // contentStyle can interact with native-stack gesture
        // hit-testing on iOS in a way that silently disables it
        // unless we re-affirm here. `fullScreenGestureEnabled: false`
        // keeps the gesture limited to the screen edge so the rest of
        // the screen stays interactive (the alternative steals tap +
        // pan events from chat input bars and FlashList).
        gestureEnabled: true,
        fullScreenGestureEnabled: false,
        // The iOS branch is intentionally EMPTY, not absent. Removing the key
        // would make iOS fall through to `default` and inherit Android's
        // slide_from_right, replacing the native iOS push animation.
        ...Platform.select({
          ios: {},
          // Android: explicit 'slide_from_right' animation. The
          // platform default uses an overlay-scrim layer for the
          // depth effect, which on some devices (Samsung One UI 5+,
          // certain MediaTek compositors) leaves a faint tint on the
          // destination screen because the scrim view doesn't get
          // released back to fully transparent at end-of-animation.
          // The pure slide variant doesn't render that scrim at all.
          default: {
            animation: 'slide_from_right' as const,
          },
        }),
      }}
    >
      {/*
        Every screen in this stack hides the native header and draws its own
        (see components/ui/ScreenHeader). These titles are kept because the
        route title is still read for deep links and accessibility, but no
        native bar renders them. Do NOT reintroduce headerTransparent /
        headerBlurEffect here: on iOS 26 they paint a legacy iOS 13 blur under
        buttons the system renders in Liquid Glass, which is what the original
        "weird effect around all the buttons" report was.
      */}
      <Stack.Screen name="index" options={{ title: 'Spaces' }} />
      <Stack.Screen name="discover" options={{ title: 'Discover Spaces' }} />
      <Stack.Screen name="[id]/index" options={{ title: 'Space' }} />
      <Stack.Screen name="[id]/[channelId]" options={{ title: 'Channel' }} />
    </Stack>
  );
}
