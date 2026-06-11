// NOTE: Polyfills (Buffer, react-native-get-random-values) AND the
// background-task `defineTask` registration are installed BEFORE expo-router
// boots, in `index.js` (the custom entry point). Route files are discovered
// via require.context, so _layout.tsx is not guaranteed to evaluate before
// the OS dispatches a background-task wakeup — registering the handler from
// here was a silent no-op when iOS BGTaskScheduler / Android WorkManager
// woke the app, because the JS bridge had finished initializing and looked
// up the handler before the route tree had been imported. Don't add the
// import back here.

// Global error reporter — install before any provider mounts so it can
// surface uncaught errors and unhandled promise rejections that React's
// <ErrorBoundary> doesn't catch (event handlers, async callbacks, etc.).
import { installGlobalErrorReporter } from '@/services/observability/globalErrorReporter';
installGlobalErrorReporter();

// React Query <-> RN bridges. Without these, refetchInterval and
// refetchOnWindowFocus don't fire reliably on RN because the focus
// manager never sees an "active" state.
import { installReactQueryRnBridges } from '@/services/observability/reactQueryRnBridges';
installReactQueryRnBridges();

import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useFonts } from 'expo-font';
import { Slot, router, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import React from 'react';
import { ActivityIndicator, AppState, Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

// Prevent the splash screen from auto-hiding (guarded for Fast Refresh)
let splashScreenPrevented = false;
if (!splashScreenPrevented) {
  splashScreenPrevented = true;
  SplashScreen.preventAutoHideAsync();
}

import {
  ApiClientProvider,
  AuthProvider,
  StorageProvider,
  WebSocketProvider,
  SpaceCallProvider,
  CallProvider,
  useAuth,
} from '@/context';
import { ToastProvider } from '@/context/ToastContext';
import { CallOverlay, SpaceCallOverlay } from '@/components/Call';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { queryConfig } from '@/services/api';
import { queryPersister } from '@/services/offline';
import {
  initializeNotifications,
  registerBackgroundFetch,
  setupNotificationResponseListener,
} from '@/services/notifications';
import {
  registerPushTokenWithQuorum,
  startPushTokenRotationListener,
} from '@/services/notifications/pushRegistration';
import { retryPushPrefsSyncIfDirty } from '@/services/notifications/pushPrefsSync';
import { registerBackgroundNotificationTask } from '@/services/notifications/pushReceivedTask';
import { CustomThemeProvider, useTheme } from '@/theme';
import { AppBackground } from '@/components/ui/AppBackground';
import { getActiveSkin } from '@/services/theme/skinPrefs';
import { ensureSkinFontLoaded } from '@/theme/skins/fontLoader';
import { setSkinGeometry } from '@/theme/skins/geometry';
import { bumpStyleVersion } from '@/theme/skins/skinnableStyleSheet';

// Wrapper to inject auth info into ApiClientProvider
function AuthAwareApiProvider({ children }: { children: React.ReactNode }) {
  const { user, signMessage } = useAuth();
  return (
    <ApiClientProvider
      userAddress={user?.address}
      signMessage={signMessage}
    >
      {children}
    </ApiClientProvider>
  );
}

// Auth-based routing component
function AuthRouter() {
  const { authState } = useAuth();
  const segments = useSegments();
  const { isDark, theme } = useTheme();

  // Track if we're currently navigating to prevent duplicate calls
  const isNavigatingRef = React.useRef(false);
  const splashHiddenRef = React.useRef(false);
  const notificationsInitializedRef = React.useRef(false);

  // Check if we're in the onboarding route group
  const inOnboarding = segments[0] === '(onboarding)';

  // Initialize notifications when user is authenticated
  React.useEffect(() => {
    if (authState !== 'authenticated' || notificationsInitializedRef.current) {
      return;
    }

    notificationsInitializedRef.current = true;

    const initNotifications = async () => {
      try {
        // Request permissions and set up notification channel
        const granted = await initializeNotifications();
        if (granted) {
          // Register background fetch task — fallback only; primary
          // delivery is server-pushed via Expo (see pushRegistration).
          await registerBackgroundFetch();
          // Tell the OS to dispatch silent pushes to our background task
          // handler (defined in pushReceivedTask, registered in index.js).
          await registerBackgroundNotificationTask();
          // Bind this device's Expo token to every inbox the user holds
          // so quorum-api can wake us when a message lands.
          await registerPushTokenWithQuorum();
        }
      } catch {
        // Notification setup is best-effort — app works without notifications
      }
    };

    initNotifications();

    // Set up notification tap handler + Expo token rotation listener.
    const subscription = setupNotificationResponseListener();
    const stopRotation = startPushTokenRotationListener();
    // Retry a failed server-side notification-prefs sync whenever the
    // app comes back to the foreground (no-op when the last sync
    // succeeded — it just checks an MMKV dirty flag).
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') retryPushPrefsSyncIfDirty();
    });
    return () => {
      subscription.remove();
      stopRotation();
      appStateSub.remove();
    };
  }, [authState]);

  // Hide splash screen once auth state is determined
  React.useEffect(() => {
    if (authState !== 'loading' && !splashHiddenRef.current) {
      splashHiddenRef.current = true;
      SplashScreen.hideAsync();
    }
  }, [authState]);

  // Handle navigation based on auth state
  React.useEffect(() => {
    if (authState === 'loading') {
      return;
    }

    // Prevent duplicate navigation
    if (isNavigatingRef.current) {
      return;
    }

    // Navigate to onboarding if unauthenticated and not already there
    if (authState === 'unauthenticated' && !inOnboarding) {
      isNavigatingRef.current = true;
      setTimeout(() => {
        router.replace('/(onboarding)');
        setTimeout(() => {
          isNavigatingRef.current = false;
        }, 500);
      }, 50);
      return;
    }

    // Navigate to home if authenticated and still in onboarding
    if (authState === 'authenticated' && inOnboarding) {
      if (isNavigatingRef.current) return;
      isNavigatingRef.current = true;
      setTimeout(() => {
        // Use dismissAll to clear the onboarding stack, then navigate to messages tab
        router.dismissAll();
        router.replace('/(tabs)/messages');
        // Reset navigation ref after navigation completes
        setTimeout(() => {
          isNavigatingRef.current = false;
        }, 500);
      }, 50);
      return;
    }
  }, [authState, inOnboarding]);

  // Show loading overlay during auth loading or pending redirects
  // This prevents flash of wrong UI before navigation completes
  const shouldShowLoading =
    authState === 'loading' ||
    (authState === 'unauthenticated' && !inOnboarding);

  // Always render Slot (so routes are mounted for navigation), but
  // overlay with loading when needed. The wrapper View's background
  // shows through during iOS native-stack swipe-back animations (the
  // brief gap between the outgoing and incoming screens). Without an
  // explicit color it defaults to white, which is the "left edge
  // white flash" users saw in dark mode when going back from
  // channels → spaces, spaces → list, DM → inbox, etc.
  return (
    <AppBackground>
      <Slot />
      {shouldShowLoading && (
        <View style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: isDark ? '#0a0a0b' : '#ffffff',
        }}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      )}
    </AppBackground>
  );
}

// Lazy-initialize QueryClient to preserve instance across Fast Refresh
let queryClientInstance: QueryClient | null = null;
function getQueryClient() {
  if (!queryClientInstance) {
    queryClientInstance = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: queryConfig.staleTime.feed,
          gcTime: queryConfig.gcTime,
          retry: queryConfig.retry,
        },
      },
    });
  }
  return queryClientInstance;
}

function StatusBarWrapper() {
  const { isDark } = useTheme();

  React.useEffect(() => {
    const bgColor = isDark ? '#0a0a0b' : '#ffffff';
    SystemUI.setBackgroundColorAsync(bgColor);
  }, [isDark]);

  return <StatusBar style={isDark ? 'light' : 'dark'} />;
}

export default function RootLayout() {
  const [loaded] = useFonts({
    AtAero: require('../assets/fonts/AtAeroVARVF.ttf'),
  });

  // Resolve the active skin synchronously (MMKV) and preload its embedded font
  // before revealing the UI, so a skinned launch never flashes the default
  // theme/font. Tokens (colors/radii/borders) apply instantly; only the font
  // is async, so the splash is held until it's ready.
  const bootSkin = React.useMemo(() => {
    const skin = getActiveSkin();
    setSkinGeometry(skin); // before any static StyleSheet evaluates
    // Force skin-reactive static stylesheets that may have evaluated at
    // import time (eagerly-imported modules) to re-resolve with boot geometry
    // on their first render.
    bumpStyleVersion();
    return skin;
  }, []);
  const [skinReady, setSkinReady] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    ensureSkinFontLoaded(bootSkin).finally(() => {
      if (!cancelled) setSkinReady(true);
    });
    return () => { cancelled = true; };
  }, [bootSkin]);

  if (!loaded || !skinReady) {
    return null;
  }

  const queryClient = getQueryClient();

  const content = (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: queryPersister,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
      }}
    >
      <CustomThemeProvider defaultAccentColor="blue" defaultSkin={bootSkin}>
        <StorageProvider>
          <AuthProvider>
            <AuthAwareApiProvider>
              <WebSocketProvider>
                <SpaceCallProvider>
                  <CallProvider>
                    <ToastProvider>
                      <AuthRouter />
                      <CallOverlay />
                      <SpaceCallOverlay />
                    </ToastProvider>
                  </CallProvider>
                </SpaceCallProvider>
              </WebSocketProvider>
            </AuthAwareApiProvider>
          </AuthProvider>
        </StorageProvider>
        <StatusBarWrapper />
      </CustomThemeProvider>
    </PersistQueryClientProvider>
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>{content}</ErrorBoundary>
    </GestureHandlerRootView>
  );
}
