/**
 * HeaderAvatar — small circular pfp button for the top-left of every
 * main tab header. Tapping it opens the profile/settings view at the
 * top-level `/account` route.
 *
 * The avatar source mirrors the resolution order used by
 * UnifiedProfileHeader (Quorum profile → Farcaster pfp → fallback) so
 * we don't show a different avatar in the header vs the profile pane.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { router } from 'expo-router';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { useAuth } from '@/context';
import { useTheme } from '@/theme';

const SIZE = 32;

export function HeaderAvatar() {
  const { user } = useAuth();
  const { theme } = useTheme();

  // Mirror the resolution order used by UnifiedProfileHeader — Quorum
  // profile image first, then Farcaster pfp as fallback so the header
  // avatar matches the profile screen.
  const uri = user?.profileImage || user?.farcaster?.pfpUrl || undefined;

  return (
    <TouchableOpacity
      onPress={() => router.push('/account')}
      hitSlop={8}
      activeOpacity={0.7}
      accessibilityLabel="Open profile and settings"
    >
      <View
        style={[
          styles.wrap,
          {
            backgroundColor: theme.colors.surface3,
            borderColor: theme.colors.border,
          },
        ]}
      >
        <CachedAvatar source={uri ? { uri } : null} style={styles.avatar} />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  avatar: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
  },
});
