import { AppTabBar } from '@/components/ui/AppTabBar';
import { AudioSpaceProvider } from '@/context/AudioSpaceContext';
import { MiniappOverlayProvider } from '@/context/MiniappOverlayContext';
import { SwapModalProvider } from '@/context/SwapModalContext';
import { useComposerPanelVisible } from '@/services/ui/composerPanelVisible';
import { Tabs } from 'expo-router';
import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// The true visual clearance the bar needs below screen content.
// PRIMARY_ROW_HEIGHT (54) with no bottom margin (full-width strip mode).
// useBottomTabBarHeight() consumers (chat composer, channel screens) read
// this so the composer lands flush below the bar.
const TAB_BAR_CONTENT_HEIGHT = 54;

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  // Hide the bottom tab bar while the chat composer's emoji panel is open so
  // the panel gets the full bottom of the screen.
  const composerPanelOpen = useComposerPanelVisible();

  return (
    <SwapModalProvider>
    <MiniappOverlayProvider>
    <AudioSpaceProvider>
    <Tabs
      tabBar={(props) =>
        composerPanelOpen ? null : <AppTabBar {...props} />
      }
      screenOptions={{
        headerShown: false,
        // NOTE: `freezeOnBlur` was tried here to stop off-screen tabs
        // re-rendering during the WS catch-up, but it triggered a native
        // crash (react-native-screens freezing a reanimated-heavy screen)
        // when navigating into a Farcaster DM. Left off — the cache-first
        // query changes already deliver the tab-switch speedup without it.
        // tabBarStyle is not visually rendered (the custom tabBar prop takes
        // over), but React Navigation reads height from it to answer
        // useBottomTabBarHeight() calls in chat/channel/DM screens.
        tabBarStyle: {
          height: TAB_BAR_CONTENT_HEIGHT + insets.bottom,
        },
      }}
    >
      <Tabs.Screen name="spaces" options={{ title: 'Spaces' }} />
      <Tabs.Screen name="messages" options={{ title: 'Messages' }} />
      <Tabs.Screen name="feed" options={{ title: 'Feed' }} />
      <Tabs.Screen name="wallet" options={{ title: 'Wallet' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
      {/*
        Account / settings — reachable via the avatar button in the tab bar.
        Hidden from the tab bar via href: null.
      */}
      <Tabs.Screen name="account" options={{ href: null }} />
    </Tabs>
    </AudioSpaceProvider>
    </MiniappOverlayProvider>
    </SwapModalProvider>
  );
}
