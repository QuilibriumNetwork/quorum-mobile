/**
 * BuyNameModal - Purchase a name from the marketplace via permit+splitter
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import HoldToConfirm from '@/components/wallet/HoldToConfirm';
import { useAuth } from '@/context';
import { useMarketplaceBuy, type MarketplaceBuyStep } from '@/hooks/useQNSPayment';
import { useWallet, aggregateAssets } from '@/hooks/useWallet';
import { useWalletSelection } from '@/hooks/useWalletSelection';
import type { ResaleListing } from '@/services/api/qnsClient';
import {
  QNS_TOKEN_ADDRESSES,
  QNS_CHAIN_NAMES,
  QNS_CHAIN_IDS,
} from '@/services/wallet/qnsPaymentService';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import React from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { SegmentedPills, type SegmentedPillItem } from '@/components/ui/SegmentedPills';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

interface BuyNameModalProps {
  visible: boolean;
  onClose: () => void;
  listing: ResaleListing | null;
  onSuccess?: () => void;
}

function getChainColor(chain: string): string {
  switch (chain) {
    case 'ethereum': return '#627EEA';
    case 'base': return '#0052FF';
    case 'arbitrum': return '#28A0F0';
    case 'optimism': return '#FF0420';
    case 'polygon': return '#8247E5';
    default: return '#666';
  }
}

function getStepLabel(step: MarketplaceBuyStep): string {
  switch (step) {
    case 'locking': return 'Locking listing...';
    case 'signing_permit': return 'Signing permit...';
    case 'sending_payment': return 'Sending payment...';
    case 'submitting_purchase': return 'Submitting purchase...';
    case 'confirming': return 'Confirming on-chain...';
    case 'success': return 'Purchase complete!';
    case 'error': return 'Purchase failed';
    default: return '';
  }
}

function getStepNumber(step: MarketplaceBuyStep): number {
  switch (step) {
    case 'locking': return 1;
    case 'signing_permit': return 2;
    case 'sending_payment': return 3;
    case 'submitting_purchase': return 4;
    case 'confirming': return 5;
    case 'success': return 6;
    default: return 0;
  }
}

const TOTAL_STEPS = 5;

export default function BuyNameModal({
  visible,
  onClose,
  listing,
  onSuccess,
}: BuyNameModalProps) {
  const { theme, isDark } = useTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme, isDark, insets);

  const { balances } = useWallet();
  const { activeType } = useWalletSelection();
  const { execute, reset, step, isProcessing, error, txHash } = useMarketplaceBuy();

  const [selectedChain, setSelectedChain] = React.useState<string>('base');

  const tokenSymbol = listing?.price_token || 'USDC';

  // Get available chains for the listing's token
  const availableChains = React.useMemo(() => {
    const chains: { chainId: number; name: string }[] = [];
    for (const [chainIdStr, tokens] of Object.entries(QNS_TOKEN_ADDRESSES)) {
      const chainId = parseInt(chainIdStr);
      if (tokens[tokenSymbol]) {
        chains.push({ chainId, name: QNS_CHAIN_NAMES[chainId] || `Chain ${chainId}` });
      }
    }
    return chains;
  }, [tokenSymbol]);

  // Auto-select first available chain
  React.useEffect(() => {
    if (visible && availableChains.length > 0) {
      const hasCurrentChain = availableChains.some(c => c.name === selectedChain);
      if (!hasCurrentChain) {
        setSelectedChain(availableChains[0].name);
      }
    }
  }, [visible, availableChains, selectedChain]);

  // Get user's balance for the listing token on selected chain
  const userBalance = React.useMemo(() => {
    if (!balances) return '0';
    const assets = aggregateAssets(balances);
    const match = assets.find(
      a => a.symbol === tokenSymbol && a.chain === selectedChain
    );
    return match ? match.balance : '0';
  }, [balances, tokenSymbol, selectedChain]);

  // Check sufficient balance (total = price_amount which includes fee)
  const hasSufficientBalance = React.useMemo(() => {
    if (!listing) return false;
    const required = parseFloat(listing.price_amount);
    const available = parseFloat(userBalance);
    return available >= required;
  }, [listing, userBalance]);

  // Reset state when modal opens
  React.useEffect(() => {
    if (visible) {
      reset();
    }
  }, [visible, reset]);

  const handleConfirm = React.useCallback(async () => {
    if (!listing || !user?.quilibriumAddress) return;

    const listingId = listing.listing_id || listing.id;
    if (!listingId) return;

    const result = await execute({
      listingId,
      chainName: selectedChain,
      quilibriumAddress: user.quilibriumAddress,
    });

    if (result) {
      onSuccess?.();
    }
  }, [listing, user, selectedChain, execute, onSuccess]);

  const handleClose = () => {
    if (isProcessing) {
      Alert.alert(
        'Purchase in Progress',
        'A purchase is currently being processed. Are you sure you want to close?',
        [
          { text: 'Stay', style: 'cancel' },
          { text: 'Close', style: 'destructive', onPress: () => { reset(); onClose(); } },
        ]
      );
      return;
    }
    reset();
    onClose();
  };

  if (!listing) return null;

  const feePercent = listing.fee_amount && listing.price_amount
    ? ((parseFloat(listing.fee_amount) / parseFloat(listing.price_amount)) * 100).toFixed(0)
    : '1';

  return (
    <BaseModal visible={visible} onClose={handleClose} height={0.85}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Buy Name</Text>
          <TouchableOpacity onPress={handleClose}>
            <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Name Display */}
        <View style={styles.nameContainer}>
          <Text style={styles.nameLabel}>@{listing.name}</Text>
          <View style={styles.namePriceRow}>
            <Text style={styles.namePrice}>{listing.price_amount} {listing.price_token}</Text>
          </View>
        </View>

        {/* Processing State */}
        {(isProcessing || step === 'success' || step === 'error') && (
          <View style={styles.processingContainer}>
            {step === 'success' ? (
              <View style={styles.resultContainer}>
                <IconSymbol name="checkmark.circle.fill" size={48} color={theme.colors.success} />
                <Text style={styles.resultTitle}>Name Purchased!</Text>
                <Text style={styles.resultSubtitle}>
                  @{listing.name} has been transferred to your Quilibrium identity
                </Text>
                {txHash && (
                  <Text style={styles.txHashText} numberOfLines={1}>
                    Tx: {txHash.slice(0, 10)}...{txHash.slice(-8)}
                  </Text>
                )}
                <TouchableOpacity style={styles.doneButton} onPress={handleClose}>
                  <Text style={styles.doneButtonText}>Done</Text>
                </TouchableOpacity>
              </View>
            ) : step === 'error' ? (
              <View style={styles.resultContainer}>
                <IconSymbol name="xmark.circle.fill" size={48} color={theme.colors.danger} />
                <Text style={[styles.resultTitle, { color: theme.colors.danger }]}>
                  Purchase Failed
                </Text>
                <Text style={styles.resultSubtitle}>{error}</Text>
                {txHash && (
                  <Text style={styles.txHashText} numberOfLines={1}>
                    Tx: {txHash.slice(0, 10)}...{txHash.slice(-8)}
                  </Text>
                )}
                <TouchableOpacity style={styles.retryButton} onPress={reset}>
                  <Text style={styles.retryButtonText}>Try Again</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.stepsContainer}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
                <Text style={styles.stepLabel}>{getStepLabel(step)}</Text>
                <View style={styles.progressBar}>
                  <View
                    style={[
                      styles.progressFill,
                      { width: `${(getStepNumber(step) / TOTAL_STEPS) * 100}%` },
                    ]}
                  />
                </View>
                <Text style={styles.stepCount}>
                  Step {getStepNumber(step)} of {TOTAL_STEPS}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Configuration (hidden during processing) */}
        {step === 'idle' && (
          <>
            {/* Chain Selector */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Payment Network</Text>
              <SegmentedPills
                style={styles.chainSelector}
                variant="solid"
                wrap
                itemRole="button"
                items={availableChains.map<SegmentedPillItem>(chain => ({
                  key: chain.name,
                  label: chain.name.charAt(0).toUpperCase() + chain.name.slice(1),
                  accentColor: getChainColor(chain.name),
                }))}
                activeKey={selectedChain}
                onChange={setSelectedChain}
              />
            </View>

            {/* Fee Breakdown */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Payment Details</Text>
              <View style={styles.priceBreakdown}>
                <View style={styles.priceRow}>
                  <Text style={styles.priceLabel}>Seller receives</Text>
                  <Text style={styles.priceValue}>
                    {listing.seller_amount} {listing.price_token}
                  </Text>
                </View>
                <View style={styles.priceRow}>
                  <Text style={styles.priceLabel}>Platform fee ({feePercent}%)</Text>
                  <Text style={styles.priceValueMuted}>
                    {listing.fee_amount} {listing.price_token}
                  </Text>
                </View>
                <View style={styles.divider} />
                <View style={styles.priceRow}>
                  <Text style={styles.priceLabelBold}>Total</Text>
                  <Text style={styles.priceValueBold}>
                    {listing.price_amount} {listing.price_token}
                  </Text>
                </View>
                <View style={styles.divider} />
                <View style={styles.priceRow}>
                  <Text style={styles.priceLabel}>Your balance</Text>
                  <Text
                    style={[
                      styles.priceValue,
                      !hasSufficientBalance && styles.insufficientBalance,
                    ]}
                  >
                    {userBalance} {tokenSymbol}
                  </Text>
                </View>
              </View>
              {!hasSufficientBalance && (
                <View style={styles.warningContainer}>
                  <IconSymbol name="exclamationmark.triangle.fill" size={16} color={theme.colors.warning} />
                  <Text style={styles.warningText}>
                    Insufficient {tokenSymbol} balance on {selectedChain}
                  </Text>
                </View>
              )}
            </View>

            {/* Ownership Info */}
            <View style={styles.infoContainer}>
              <IconSymbol name="shield.checkered" size={16} color={theme.colors.textMuted} />
              <Text style={styles.infoText}>
                This name will be registered to your Quilibrium identity with stealth privacy
              </Text>
            </View>

            {/* Confirm Button */}
            <View style={styles.confirmContainer}>
              <HoldToConfirm
                onConfirm={handleConfirm}
                disabled={!hasSufficientBalance || listing.state === 'locked'}
                label={
                  listing.state === 'locked'
                    ? 'Listing is locked'
                    : `Hold to Buy @${listing.name}`
                }
                holdingLabel="Processing..."
              />
            </View>
          </>
        )}
      </ScrollView>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean, insets: EdgeInsets) =>
  StyleSheet.create({
    content: {
      paddingHorizontal: Skin.space(20),
      paddingBottom: insets.bottom + 20,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: Skin.space(20),
    },
    title: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    nameContainer: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      alignItems: 'center',
      marginBottom: Skin.space(20),
    },
    nameLabel: {
      fontSize: Skin.font(24),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.primary,
      marginBottom: Skin.space(4),
    },
    namePriceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(4),
    },
    namePrice: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    section: {
      marginBottom: Skin.space(20),
    },
    sectionTitle: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMuted,
      marginBottom: Skin.space(8),
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    chainSelector: {
      gap: Skin.space(8),
    },
    priceBreakdown: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
    },
    priceRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: Skin.space(6),
    },
    priceLabel: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
    },
    priceLabelBold: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    priceValue: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    priceValueBold: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    priceValueMuted: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
    },
    insufficientBalance: {
      color: theme.colors.danger,
    },
    divider: {
      height: 1,
      backgroundColor: theme.colors.border,
      marginVertical: Skin.space(8),
    },
    warningContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
      marginTop: Skin.space(8),
      paddingHorizontal: Skin.space(4),
    },
    warningText: {
      fontSize: Skin.font(13),
      color: theme.colors.warning,
      flex: 1,
    },
    infoContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
      paddingHorizontal: Skin.space(4),
      marginBottom: Skin.space(20),
    },
    infoText: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      flex: 1,
    },
    confirmContainer: {
      marginBottom: Skin.space(10),
    },
    processingContainer: {
      paddingVertical: Skin.space(40),
      alignItems: 'center',
    },
    stepsContainer: {
      alignItems: 'center',
      gap: Skin.space(16),
    },
    stepLabel: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
      textAlign: 'center',
    },
    progressBar: {
      width: '80%',
      height: 4,
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(2),
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(2),
    },
    stepCount: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
    },
    resultContainer: {
      alignItems: 'center',
      gap: Skin.space(12),
    },
    resultTitle: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.success,
    },
    resultSubtitle: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
    txHashText: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      fontFamily: 'monospace',
      marginTop: Skin.space(4),
    },
    doneButton: {
      backgroundColor: theme.colors.primary,
      paddingVertical: Skin.space(12),
      paddingHorizontal: Skin.space(32),
      borderRadius: Skin.radius(10),
      marginTop: Skin.space(12),
    },
    doneButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#fff',
    },
    retryButton: {
      backgroundColor: theme.colors.surface2,
      paddingVertical: Skin.space(12),
      paddingHorizontal: Skin.space(32),
      borderRadius: Skin.radius(10),
      marginTop: Skin.space(8),
    },
    retryButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
  });
