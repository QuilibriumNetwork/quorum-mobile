import { useTheme } from '@/theme';
import { Stack } from 'expo-router';
import React from 'react';
import { Platform } from 'react-native';

export default function FeedLayout() {
  const { theme } = useTheme();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface1 },
        headerTintColor: theme.colors.textMain,
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.surface1 },
        // The iOS branch is intentionally EMPTY, not absent — removing the key
        // would make iOS inherit Android's slide_from_right. It previously held
        // headerTransparent + headerBlurEffect, which no screen in this stack
        // uses (they all hide the native header) and which clash with iOS 26's
        // Liquid Glass buttons. See spaces/_layout.tsx.
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
    />
  );
}
