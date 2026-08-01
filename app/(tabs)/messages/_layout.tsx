import { useTheme } from '@/theme';
import { Stack } from 'expo-router';
import React from 'react';
import { Platform } from 'react-native';

export default function MessagesLayout() {
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
        // Color the iOS swipe-back gap so it doesn't flash white in dark mode.
        contentStyle: { backgroundColor: theme.colors.surface1 },
        // Re-affirm the edge swipe-back gesture — see spaces/_layout.tsx
        // for the reasoning. contentStyle can silently kill the gesture
        // on native-stack unless explicit.
        gestureEnabled: true,
        fullScreenGestureEnabled: false,
        // The iOS branch is intentionally EMPTY, not absent — see
        // spaces/_layout.tsx for why removing it would change the iOS animation.
        ...Platform.select({
          ios: {},
          // Android: explicit slide_from_right to avoid the
          // overlay-scrim persistence bug on some devices. See
          // spaces/_layout.tsx for the full reasoning.
          default: {
            animation: 'slide_from_right' as const,
          },
        }),
      }}
    >
      {/*
        Both screens hide the native header and draw their own (see
        components/ui/ScreenHeader). Titles are kept for deep links and
        accessibility. Do NOT reintroduce headerTransparent / headerBlurEffect —
        see the note in spaces/_layout.tsx.
      */}
      <Stack.Screen name="index" options={{ title: 'Messages' }} />
      <Stack.Screen name="dm/[id]" options={{ title: 'Chat' }} />
    </Stack>
  );
}
