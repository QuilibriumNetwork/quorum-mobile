import UnifiedProfileScreen from '@/components/UnifiedProfileScreen';
import WarpcastWalletImportModal from '@/components/WarpcastWalletImportModal';
import { useTheme } from '@/theme';
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
    /*
      No title bar. Account is entered from the always-visible avatar in the tab
      bar and switching to it is a tab jump, not a push — so it is a top-level
      destination like Spaces or Messages, and those don't carry one either. The
      bar it used to have said "Account" directly above a pill row whose first
      entry says "Profile", and its back chevron went to Spaces regardless of
      where the user came from. Leaving to any tab is one tap on the bar below.

      Owning the top inset here is what the bar used to do implicitly: it painted
      into the status-bar area, which is why the screen below it adds no inset of
      its own.
    */
    <View
      style={[
        styles.container,
        { paddingTop: insets.top, backgroundColor: theme.colors.background },
      ]}
    >
      <Stack.Screen options={{ headerShown: false, title: 'Account' }} />

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
