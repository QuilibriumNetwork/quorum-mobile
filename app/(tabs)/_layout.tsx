import { HapticTab } from '@/components/HapticTab';
import { IconSymbol } from '@/components/ui/IconSymbol';
import TabBarBackground from '@/components/ui/TabBarBackground';
import { AudioSpaceProvider } from '@/context/AudioSpaceContext';
import { MiniappOverlayProvider } from '@/context/MiniappOverlayContext';
import { SwapModalProvider } from '@/context/SwapModalContext';
import { useUnifiedNotifications } from '@/hooks/useUnifiedNotifications';
import { feedActiveTabBus } from '@/services/ui/feedActiveTab';
import { useTheme } from '@/theme';
import { Tabs } from 'expo-router';
import React from 'react';
import { Platform, Text, View } from 'react-native';

function ProfileTabIcon({ color, focused }: { color: string; focused: boolean }) {
  // The tab now defaults to the notifications inbox; profile/account is
  // a sub-route reached via the person icon in the header. Tab icon is
  // a bell to match. The OTA bolt that used to live here is now in the
  // notifications screen's headerLeft, so the only badge here is a
  // simple unread dot.
  const { unreadCount } = useUnifiedNotifications();
  const showUnread = unreadCount > 0;
  return (
    <View>
      <IconSymbol size={26} name={focused ? 'bell.fill' : 'bell'} color={color} />
      {showUnread && (
        <View
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: '#FF3B30',
          }}
        />
      )}
    </View>
  );
}

export default function TabsLayout() {
  const { theme } = useTheme();

  return (
    <SwapModalProvider>
    <MiniappOverlayProvider>
    <AudioSpaceProvider>
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarButton: HapticTab,
        tabBarBackground: TabBarBackground,
        // Icon-only: no labels beneath the SF Symbols / Material icons.
        tabBarShowLabel: false,
        tabBarHideOnKeyboard: false,
        tabBarStyle: {
          position: 'absolute' as const,
          borderTopWidth: 0,
          elevation: 0,
        },
      }}
    >
      <Tabs.Screen
        name="spaces"
        options={{
          title: 'Spaces',
          tabBarIcon: ({ color, focused }) => (
            <IconSymbol size={26} name={focused ? 'person.3.fill' : 'person.3'} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          title: 'Messages',
          tabBarIcon: ({ color, focused }) => (
            <IconSymbol size={26} name={focused ? 'message.fill' : 'message'} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="feed"
        options={{
          title: 'Feed',
          tabBarIcon: ({ color }) => (
            <IconSymbol size={26} name="globe" color={color} />
          ),
        }}
        listeners={({ navigation }) => ({
          // When the tab icon is tapped:
          //  - If we're on a DIFFERENT tab, do nothing here — the
          //    default action navigates to /feed and restores its
          //    saved navigator state (including any thread the user
          //    was viewing). This is built-in to expo-router/RN-tabs.
          //  - If we're ALREADY on the feed tab, fire the bus so the
          //    Feed screen can decide what "back-to-here" means
          //    (pop thread → scroll to top → refresh).
          tabPress: (e) => {
            if (navigation.isFocused()) {
              e.preventDefault();
              feedActiveTabBus.fire();
            }
          },
        })}
      />
      <Tabs.Screen
        name="wallet"
        options={{
          title: 'Wallet',
          tabBarIcon: ({ color, focused }) => (
            <IconSymbol size={26} name={focused ? 'creditcard.fill' : 'creditcard'} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, focused }) => (
            <ProfileTabIcon color={color} focused={focused} />
          ),
        }}
      />
      {/*
        Account / settings — reachable via the HeaderAvatar in every
        other tab's header, NOT a sub-route under notifications. Hidden
        from the tab bar via href: null.
      */}
      <Tabs.Screen
        name="account"
        options={{
          href: null,
        }}
      />
    </Tabs>
    </AudioSpaceProvider>
    </MiniappOverlayProvider>
    </SwapModalProvider>
  );
}
