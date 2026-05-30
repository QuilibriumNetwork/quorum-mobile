import MiniAppsModal from '@/components/MiniAppsModal';
import { useMiniappOverlay } from '@/context/MiniappOverlayContext';
import { router } from 'expo-router';
import React from 'react';
import { View, StyleSheet } from 'react-native';

export default function AppsScreen() {
  const { openMiniapp } = useMiniappOverlay();

  return (
    <View style={styles.container}>
      <MiniAppsModal
        visible={true}
        onClose={() => router.back()}
        onOpenMiniApp={(url, isQNative) => openMiniapp({ url, isQNative })}
        isRouteMode={true}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
