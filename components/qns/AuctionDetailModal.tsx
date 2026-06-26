/**
 * AuctionDetailModal - View auction details, place bids, instant buy
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import HoldToConfirm from '@/components/wallet/HoldToConfirm';
import { useAuth } from '@/context';
import {
  useAuctionBids,
  usePlaceBid,
  useInstantBuy,
} from '@/hooks/useQNSMarketplace';
import {
  useAuctionPayment,
  getWalletPrivateKey,
  signQNSSignatureMessage,
  type MarketplaceBuyStep,
} from '@/hooks/useQNSPayment';
import { useWallet, aggregateAssets, useWalletKeys } from '@/hooks/useWallet';
import { useWalletSelection } from '@/hooks/useWalletSelection';
import { useWarpcastWallet } from '@/hooks/useWarpcastWallet';
import type { Auction } from '@/services/api/qnsClient';
import {
  QNS_TOKEN_ADDRESSES,
  QNS_CHAIN_NAMES,
  QNS_CHAIN_IDS,
} from '@/services/wallet/qnsPaymentService';
import {
  generateStealthOwnership,
  stealthOwnershipToApi,
} from '@/services/onboarding/keyService';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import React from 'react';
import { ActivityIndicator, Alert, FlatList, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { SegmentedPills, type SegmentedPillItem } from '@/components/ui/SegmentedPills';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

interface AuctionDetailModalProps {
  visible: boolean;
  onClose: () => void;
  auction: Auction | null;
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

function useCountdown(endTime: string | undefined) {
  const [remaining, setRemaining] = React.useState('');

  React.useEffect(() => {
    if (!endTime) return;
    const update = () => {
      const diff = new Date(endTime).getTime() - Date.now();
      if (diff <= 0) { setRemaining('Ended'); return; }
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);
      if (hours > 24) {
        setRemaining(`${Math.floor(hours / 24)}d ${hours % 24}h ${minutes}m`);
      } else if (hours > 0) {
        setRemaining(`${hours}h ${minutes}m ${seconds}s`);
      } else {
        setRemaining(`${minutes}m ${seconds}s`);
      }
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [endTime]);

  return remaining;
}

function getStepLabel(step: MarketplaceBuyStep): string {
  switch (step) {
    case 'signing_permit': return 'Signing permit...';
    case 'sending_payment': return 'Sending payment...';
    case 'submitting_purchase': return 'Submitting payment...';
    case 'confirming': return 'Confirming on-chain...';
    case 'success': return 'Payment complete!';
    case 'error': return 'Payment failed';
    default: return '';
  }
}

export default function AuctionDetailModal({
  visible,
  onClose,
  auction,
  onSuccess,
}: AuctionDetailModalProps) {
  const { theme, isDark } = useTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme, isDark, insets);

  const { balances } = useWallet();
  const { refetch: fetchKeys } = useWalletKeys();
  const { activeWallet, activeType } = useWalletSelection();
  const { importedWallet } = useWarpcastWallet();
  const countdown = useCountdown(auction?.ends_at);

  const [bidAmount, setBidAmount] = React.useState('');
  const [selectedChain, setSelectedChain] = React.useState('base');
  const [showPayment, setShowPayment] = React.useState(false);

  const { data: bids, isLoading: isLoadingBids } = useAuctionBids(auction?.id, {
    enabled: visible && !!auction?.id,
  });

  const { mutate: placeBid, isPending: isPlacingBid } = usePlaceBid();
  const { mutate: instantBuy, isPending: isBuyingInstant } = useInstantBuy();
  const { execute: executePayment, reset: resetPayment, step: paymentStep, isProcessing, error: paymentError, txHash } = useAuctionPayment();

  const tokenSymbol = auction?.token || 'USDC';

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

  const userBalance = React.useMemo(() => {
    if (!balances) return '0';
    const assets = aggregateAssets(balances);
    const match = assets.find(a => a.symbol === tokenSymbol && a.chain === selectedChain);
    return match ? match.balance : '0';
  }, [balances, tokenSymbol, selectedChain]);

  React.useEffect(() => {
    if (visible) {
      setBidAmount('');
      setShowPayment(false);
      resetPayment();
    }
  }, [visible, resetPayment]);

  const minBid = React.useMemo(() => {
    if (!auction) return '0';
    if (auction.bid_count === 0) return auction.starting_price;
    // Min increment is typically 5% above current highest bid
    const current = parseFloat(auction.highest_bid || auction.starting_price);
    return (current * 1.05).toFixed(2);
  }, [auction]);

  const handlePlaceBid = async () => {
    if (!auction || !bidAmount || !user?.quilibriumAddress || !activeWallet) return;

    const amount = parseFloat(bidAmount);
    const min = parseFloat(minBid);
    if (amount < min) {
      Alert.alert('Bid Too Low', `Minimum bid is ${minBid} ${tokenSymbol}`);
      return;
    }

    try {
      const stealth = generateStealthOwnership(user.quilibriumAddress);
      const ownership = stealthOwnershipToApi(stealth);

      // Sign the QNS signature message (EIP-191) so the server can verify the bidder address
      const walletPrivateKey = await getWalletPrivateKey(activeType, importedWallet, fetchKeys);
      const { address: bidderAddress, signature } = await signQNSSignatureMessage(walletPrivateKey);

      placeBid({
        auctionId: auction.id,
        amount: bidAmount,
        bidderAddress,
        bidderOwnership: ownership,
        signature,
        chain: selectedChain,
      }, {
        onSuccess: () => {
          Alert.alert('Bid Placed', `Your bid of ${bidAmount} ${tokenSymbol} has been placed.`);
          setBidAmount('');
        },
        onError: (err) => {
          Alert.alert('Error', err instanceof Error ? err.message : 'Failed to place bid');
        },
      });
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to place bid');
    }
  };

  const handleInstantBuy = () => {
    if (!auction?.instant_buy_price || !user?.quilibriumAddress || !activeWallet) return;

    Alert.alert(
      'Instant Buy',
      `Buy @${auction.name} now for ${auction.instant_buy_price} ${tokenSymbol}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Buy Now',
          onPress: async () => {
            try {
              const stealth = generateStealthOwnership(user.quilibriumAddress);
              const ownership = stealthOwnershipToApi(stealth);

              // Sign the QNS signature message (EIP-191) so the server can verify the buyer address
              const walletPrivateKey = await getWalletPrivateKey(activeType, importedWallet, fetchKeys);
              const { address: buyerAddress, signature } = await signQNSSignatureMessage(walletPrivateKey);

              instantBuy({
                auctionId: auction.id,
                buyerAddress,
                buyerOwnership: ownership,
                signature,
                chain: selectedChain,
              }, {
                onSuccess: (result) => {
                  // Show payment flow
                  setShowPayment(true);
                  executePayment({
                    auctionId: auction.id,
                    chainName: selectedChain,
                    tokenSymbol,
                    platformAddress: result.platform_address,
                    sellerAddress: result.seller_address,
                    feeAmount: result.fee_amount,
                    sellerAmount: result.seller_amount,
                    paymentWindowEndsAt: result.payment_window,
                    quilibriumAddress: user.quilibriumAddress,
                  }).then(r => { if (r) onSuccess?.(); });
                },
                onError: (err) => {
                  Alert.alert('Error', err instanceof Error ? err.message : 'Failed to initiate instant buy');
                },
              });
            } catch (err) {
              Alert.alert('Error', err instanceof Error ? err.message : 'Failed to initiate instant buy');
            }
          },
        },
      ]
    );
  };

  if (!auction) return null;

  const isEnded = countdown === 'Ended';

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.9}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Auction</Text>
          <TouchableOpacity onPress={onClose}>
            <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Name and Countdown */}
        <View style={styles.nameContainer}>
          <Text style={styles.nameLabel}>@{auction.name}</Text>
          <View style={styles.countdownRow}>
            <IconSymbol name="clock" size={14} color={isEnded ? theme.colors.danger : theme.colors.textMuted} />
            <Text style={[styles.countdownText, isEnded && { color: theme.colors.danger }]}>
              {countdown}
            </Text>
          </View>
        </View>

        {/* Payment Processing */}
        {showPayment && (isProcessing || paymentStep === 'success' || paymentStep === 'error') && (
          <View style={styles.processingContainer}>
            {paymentStep === 'success' ? (
              <View style={styles.resultContainer}>
                <IconSymbol name="checkmark.circle.fill" size={48} color={theme.colors.success} />
                <Text style={styles.resultTitle}>Purchase Complete!</Text>
                <TouchableOpacity style={styles.doneButton} onPress={onClose}>
                  <Text style={styles.doneButtonText}>Done</Text>
                </TouchableOpacity>
              </View>
            ) : paymentStep === 'error' ? (
              <View style={styles.resultContainer}>
                <IconSymbol name="xmark.circle.fill" size={48} color={theme.colors.danger} />
                <Text style={[styles.resultTitle, { color: theme.colors.danger }]}>Payment Failed</Text>
                <Text style={styles.resultSubtitle}>{paymentError}</Text>
                <TouchableOpacity style={styles.retryButton} onPress={() => { setShowPayment(false); resetPayment(); }}>
                  <Text style={styles.retryButtonText}>Back</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.stepsContainer}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
                <Text style={styles.stepLabel}>{getStepLabel(paymentStep)}</Text>
              </View>
            )}
          </View>
        )}

        {/* Auction Info (hidden during payment) */}
        {!showPayment && (
          <>
            {/* Current Bid Info */}
            <View style={styles.section}>
              <View style={styles.bidInfoCard}>
                <View style={styles.bidInfoRow}>
                  <Text style={styles.bidInfoLabel}>
                    {auction.bid_count > 0 ? 'Current Bid' : 'Starting Price'}
                  </Text>
                  <Text style={styles.bidInfoValue}>
                    {auction.highest_bid || auction.starting_price} {tokenSymbol}
                  </Text>
                </View>
                <View style={styles.bidInfoRow}>
                  <Text style={styles.bidInfoLabel}>Bids</Text>
                  <Text style={styles.bidInfoValue}>{auction.bid_count}</Text>
                </View>
                {auction.instant_buy_price && (
                  <View style={styles.bidInfoRow}>
                    <Text style={styles.bidInfoLabel}>Instant Buy</Text>
                    <Text style={[styles.bidInfoValue, { color: theme.colors.success }]}>
                      {auction.instant_buy_price} {tokenSymbol}
                    </Text>
                  </View>
                )}
              </View>
            </View>

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
              <Text style={styles.balanceText}>
                Balance: {userBalance} {tokenSymbol}
              </Text>
            </View>

            {/* Place Bid */}
            {!isEnded && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Place Bid</Text>
                <View style={styles.bidInputRow}>
                  <TextInput
                    style={styles.bidInput}
                    placeholder={`Min ${minBid}`}
                    placeholderTextColor={theme.colors.textMuted}
                    value={bidAmount}
                    onChangeText={setBidAmount}
                    keyboardType="decimal-pad"
                  />
                  <Text style={styles.bidInputToken}>{tokenSymbol}</Text>
                </View>
                <TouchableOpacity
                  style={[styles.bidButton, (!bidAmount || isPlacingBid) && styles.bidButtonDisabled]}
                  onPress={handlePlaceBid}
                  disabled={!bidAmount || isPlacingBid}
                >
                  {isPlacingBid ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.bidButtonText}>Place Bid</Text>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {/* Instant Buy */}
            {!isEnded && auction.instant_buy_price && (
              <View style={styles.section}>
                <HoldToConfirm
                  onConfirm={handleInstantBuy}
                  disabled={isBuyingInstant || parseFloat(userBalance) < parseFloat(auction.instant_buy_price)}
                  label={`Hold to Buy Now - ${auction.instant_buy_price} ${tokenSymbol}`}
                  holdingLabel="Processing..."
                />
              </View>
            )}

            {/* Bid History */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Bid History</Text>
              {isLoadingBids ? (
                <ActivityIndicator size="small" color={theme.colors.primary} />
              ) : bids && bids.length > 0 ? (
                bids.map((bid, index) => (
                  <View key={bid.id} style={styles.bidHistoryItem}>
                    <View>
                      <Text style={styles.bidHistoryAmount}>{bid.amount} {tokenSymbol}</Text>
                      <Text style={styles.bidHistoryAddress}>
                        {bid.bidder_address.slice(0, 6)}...{bid.bidder_address.slice(-4)}
                      </Text>
                    </View>
                    {index === 0 && (
                      <View style={styles.highestBadge}>
                        <Text style={styles.highestBadgeText}>Highest</Text>
                      </View>
                    )}
                  </View>
                ))
              ) : (
                <Text style={styles.noBidsText}>No bids yet</Text>
              )}
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
      marginBottom: Skin.space(8),
    },
    countdownRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
    },
    countdownText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textSubtle,
    },
    section: {
      marginBottom: Skin.space(20),
    },
    sectionTitle: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textSubtle,
      marginBottom: Skin.space(8),
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    bidInfoCard: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
    },
    bidInfoRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: Skin.space(6),
    },
    bidInfoLabel: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
    },
    bidInfoValue: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    chainSelector: {
      gap: Skin.space(8),
    },
    balanceText: {
      fontSize: Skin.font(13),
      color: theme.colors.textSubtle,
      marginTop: Skin.space(8),
    },
    bidInputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(10),
      marginBottom: Skin.space(10),
    },
    bidInput: {
      flex: 1,
      height: 44,
      paddingHorizontal: Skin.space(14),
      fontSize: Skin.font(16),
      color: theme.colors.textMain,
    },
    bidInputToken: {
      paddingHorizontal: Skin.space(14),
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    bidButton: {
      height: 44,
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(10),
      justifyContent: 'center',
      alignItems: 'center',
    },
    bidButtonDisabled: { opacity: 0.5 },
    bidButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#fff',
    },
    bidHistoryItem: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(8),
      padding: Skin.space(12),
      marginBottom: Skin.space(6),
    },
    bidHistoryAmount: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    bidHistoryAddress: {
      fontSize: Skin.font(12),
      color: theme.colors.textSubtle,
      fontFamily: 'monospace',
      marginTop: Skin.space(2),
    },
    highestBadge: {
      backgroundColor: isDark ? 'rgba(34, 197, 94, 0.15)' : 'rgba(34, 197, 94, 0.1)',
      paddingVertical: Skin.space(3),
      paddingHorizontal: Skin.space(8),
      borderRadius: Skin.radius(8),
    },
    highestBadgeText: {
      fontSize: Skin.font(11),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.success,
    },
    noBidsText: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      textAlign: 'center',
      paddingVertical: Skin.space(20),
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
      color: theme.colors.textSubtle,
      textAlign: 'center',
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
