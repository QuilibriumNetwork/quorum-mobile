import MiniAppsModal from '@/components/MiniAppsModal';
import { ListBottomFade } from '@/components/ui/ListBottomFade';
import { useMiniappOverlay } from '@/context/MiniappOverlayContext';
import { useTheme } from '@/theme';
import { router } from 'expo-router';
import React from 'react';
import { View, StyleSheet } from 'react-native';

export default function AppsScreen() {
  const { openMiniapp } = useMiniappOverlay();
  const { theme, isDark } = useTheme();

  return (
    <View style={styles.container}>
      <MiniAppsModal
        visible={true}
        onClose={() => router.back()}
        onOpenMiniApp={(url, isQNative) => openMiniapp({ url, isQNative })}
        isRouteMode={true}
      />
      <ListBottomFade surfaceColor={theme.colors.surface1} isDark={isDark} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
