import UnifiedProfileScreen from '@/components/UnifiedProfileScreen';
import WarpcastWalletImportModal from '@/components/WarpcastWalletImportModal';
import { useTheme } from '@/theme';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function ProfileAccountScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [warpcastImportVisible, setWarpcastImportVisible] = useState(false);

  // Deep-link entry — `?openWarpcastImport=1` (used by the miniapp
  // BrowserModal's "Go to Settings" affordance when a miniapp requires
  // a Farcaster account and the user hasn't imported one yet). Clear
  // the param after consuming so re-visiting the tab doesn't re-fire.
  const params = useLocalSearchParams<{ openWarpcastImport?: string }>();
  useEffect(() => {
    if (params.openWarpcastImport === '1') {
      setWarpcastImportVisible(true);
      router.setParams({ openWarpcastImport: undefined });
    }
  }, [params.openWarpcastImport]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false, title: 'Account' }} />

      {/*
        Drawn in RN rather than by the native stack — see ScreenHeader. This
        screen previously had to override the layout's transparent/blurred iOS
        header back to an opaque one anyway, so it gains a continuous surface
        for free: the bar takes the same background the body renders against
        and drops the separator.
      */}
      <ScreenHeader
        title="Account"
        insetTop={insets.top}
        onBack={() => router.back()}
        backgroundColor={theme.colors.background}
        showBorder={false}
        theme={theme}
      />

      <UnifiedProfileScreen
        onOpenWarpcastImport={() => setWarpcastImportVisible(true)}
      />

      <WarpcastWalletImportModal
        visible={warpcastImportVisible}
        onClose={() => setWarpcastImportVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
