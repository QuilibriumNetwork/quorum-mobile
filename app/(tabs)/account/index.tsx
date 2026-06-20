import UnifiedProfileScreen from '@/components/UnifiedProfileScreen';
import WarpcastWalletImportModal from '@/components/WarpcastWalletImportModal';
import { useTheme } from '@/theme';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

export default function ProfileAccountScreen() {
  const { theme } = useTheme();
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
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Account',
          // Override layout-level transparent header on iOS — see the
          // comment in profile/index.tsx for the rationale.
          headerTransparent: false,
          headerShadowVisible: false,
          // Match body background so the header reads as a continuous
          // surface (UnifiedProfileScreen renders against
          // theme.colors.background).
          headerStyle: { backgroundColor: theme.colors.background },
          headerBlurEffect: undefined,
        }}
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
