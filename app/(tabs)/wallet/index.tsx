/**
 * Wallet tab — the wallet UI is the primary surface; mini apps live
 * behind a small four-square icon in the top-right that toggles to the
 * mini-apps launcher. Matches the spaces/messages header pattern
 * (avatar left, title, right-icon) for visual consistency.
 */

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { HeaderAvatar } from '@/components/HeaderAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { SurfaceBackground } from '@/theme/skins/surfaces';
import WalletModal from '@/components/WalletModal';
import MiniAppsModal from '@/components/MiniAppsModal';
import { useMiniappOverlay } from '@/context/MiniappOverlayContext';
import { textStyles, useTheme, type AppTheme } from '@/theme';
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import * as Skin from '@/theme/skins/geometry';

type Section = 'wallet' | 'apps';

export default function WalletTab() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [section, setSection] = useState<Section>('wallet');
  const { openMiniapp } = useMiniappOverlay();

  const styles = useMemo(() => createStyles(theme), [theme]);

  // Mini-app deep-link from notifications. The notifications tab pushes
  // here with `?miniAppUrl=...` when the user taps a mini-app entry.
  // We auto-switch to the Mini Apps section AND open the global
  // BrowserModal overlay, then clear the param so subsequent tab visits
  // don't re-trigger.
  const params = useLocalSearchParams<{ miniAppUrl?: string }>();
  useEffect(() => {
    if (!params.miniAppUrl) return;
    setSection('apps');
    openMiniapp({ url: params.miniAppUrl, isQNative: false });
    router.setParams({ miniAppUrl: undefined });
  }, [params.miniAppUrl, openMiniapp]);

  const headingLabel = section === 'wallet' ? 'Wallet' : 'Mini Apps';
  // Wallet view → four-square (apps) icon. Mini-apps view → the same
  // creditcard.fill glyph the tab bar uses for the Wallet tab itself,
  // so users see "this is the wallet" affordance in the spot they
  // already learned to associate with the wallet.
  const toggleIcon = section === 'wallet' ? 'square.grid.2x2' : 'creditcard.fill';
  const toggleLabel = section === 'wallet' ? 'Open mini apps' : 'Back to wallet';

  return (
    <SurfaceBackground slot="wallet" fallbackColor={theme.colors.surface1} style={styles.container}>
      <View style={[styles.headerBar, { paddingTop: insets.top + 8 }]}>
        <View style={styles.headerSlotLeft}>
          <HeaderAvatar />
        </View>
        <View style={styles.headerSlotCenter}>
          <Text style={styles.heading}>{headingLabel}</Text>
        </View>
        <View style={styles.headerSlotRight}>
          <TouchableOpacity
            onPress={() => setSection((s) => (s === 'wallet' ? 'apps' : 'wallet'))}
            style={styles.headerIconButton}
            hitSlop={8}
            accessibilityLabel={toggleLabel}
          >
            <IconSymbol name={toggleIcon} size={22} color={theme.colors.textMain} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.body}>
        {section === 'wallet' ? (
          <ErrorBoundary>
            <WalletModal
              visible
              onClose={() => { /* tab route, not a modal */ }}
              isRouteMode
              noTopInset
            />
          </ErrorBoundary>
        ) : (
          <MiniAppsModal
            visible
            onClose={() => { /* tab route, not a modal */ }}
            onOpenMiniApp={(url, isQNative) => openMiniapp({ url, isQNative })}
            isRouteMode
            noTopInset
          />
        )}
      </View>
    </SurfaceBackground>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    headerBar: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      paddingHorizontal: Skin.space(16),
      paddingBottom: Skin.space(4),
      backgroundColor: theme.colors.surface1,
    },
    headerSlotLeft: {
      alignItems: 'flex-start' as const,
      flexDirection: 'row' as const,
    },
    headerSlotCenter: {
      flex: 1,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      paddingHorizontal: Skin.space(8),
    },
    headerSlotRight: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'flex-end' as const,
    },
    heading: {
      ...theme.textStyles.title3,
      color: theme.colors.textMain,
      textAlign: 'center' as const,
    },
    headerIconButton: { padding: Skin.space(8) },
    body: {
      flex: 1,
    },
  });
