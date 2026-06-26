/**
 * WalletSelector - Inline wallet switcher for use in modals
 */

import { IconSymbol } from '@/components/ui/IconSymbol';
import { useWalletSelection, WalletType } from '@/hooks/useWalletSelection';
import { useTheme, type AppTheme } from '@/theme';
import { truncateAddress } from '@/utils/formatAddress';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

interface WalletSelectorProps {
  /** Only show if multiple wallets are available */
  hideIfSingle?: boolean;
}

export default function WalletSelector({ hideIfSingle = true }: WalletSelectorProps) {
  const { theme } = useTheme();
  const {
    activeWallet,
    activeType,
    availableWallets,
    hasWarpcastWallet,
    switchWallet,
    isSwitching,
  } = useWalletSelection();

  const styles = createStyles(theme);

  // Don't render if only one wallet and hideIfSingle is true
  if (hideIfSingle && availableWallets.length <= 1) {
    return null;
  }

  const handleSwitch = () => {
    // Toggle between wallets
    const newType: WalletType = activeType === 'builtin' ? 'warpcast' : 'builtin';
    if (newType === 'warpcast' && !hasWarpcastWallet) return;
    switchWallet(newType);
  };

  return (
    <TouchableOpacity
      style={styles.container}
      onPress={handleSwitch}
      disabled={isSwitching || availableWallets.length <= 1}
    >
      <View style={styles.walletInfo}>
        <View style={[styles.walletDot, activeType === 'warpcast' && styles.walletDotWarpcast]} />
        <View>
          <Text style={styles.walletLabel}>
            {activeType === 'warpcast' ? 'Warpcast Wallet' : 'Quorum Wallet'}
          </Text>
          <Text style={styles.walletAddress}>
            {truncateAddress(activeWallet?.address || '')}
          </Text>
        </View>
      </View>
      {availableWallets.length > 1 && (
        <View style={styles.switchButton}>
          <IconSymbol name="arrow.triangle.2.circlepath" size={14} color={theme.colors.primary} />
          <Text style={styles.switchText}>Switch</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(12),
      marginBottom: Skin.space(16),
    },
    walletInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(10),
    },
    walletDot: {
      width: 10,
      height: 10,
      borderRadius: Skin.radius(5),
      backgroundColor: theme.colors.primary,
    },
    walletDotWarpcast: {
      backgroundColor: '#8B5CF6', // Purple for Warpcast
    },
    walletLabel: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    walletAddress: {
      fontSize: Skin.font(11),
      color: theme.colors.textSubtle,
      marginTop: Skin.space(1),
    },
    switchButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(4),
      paddingHorizontal: Skin.space(10),
      paddingVertical: Skin.space(6),
      backgroundColor: theme.colors.primary + '15',
      borderRadius: Skin.radius(8),
    },
    switchText: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.primary,
    },
  });
