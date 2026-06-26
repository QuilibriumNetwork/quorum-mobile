/**
 * RegisterPaymentModal - In-app payment flow for QNS name registration
 * Replaces the browser redirect with native ERC20 payment
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import HoldToConfirm from '@/components/wallet/HoldToConfirm';
import { useAuth } from '@/context';
import { useCalculatePrice, usePricing } from '@/hooks/useQNS';
import { useRegistrationPayment, type RegistrationStep } from '@/hooks/useQNSPayment';
import { useWallet, aggregateAssets } from '@/hooks/useWallet';
import { useWalletSelection } from '@/hooks/useWalletSelection';
import {
  QNS_TOKEN_ADDRESSES,
  QNS_CHAIN_NAMES,
  TOKEN_DECIMALS,
} from '@/services/wallet/qnsPaymentService';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import React from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { SegmentedPills, type SegmentedPillItem } from '@/components/ui/SegmentedPills';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

interface RegisterPaymentModalProps {
  visible: boolean;
  onClose: () => void;
  name: string;
  nameType: 'username' | 'domain';
  priceQuil: number;
  onSuccess?: () => void;
}

const AVAILABLE_TOKENS: ('wQUIL' | 'USDC')[] = ['USDC', 'wQUIL'];

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

function getStepLabel(step: RegistrationStep): string {
  switch (step) {
    case 'signing_message': return 'Signing authentication message...';
    case 'getting_payment_address': return 'Getting payment address...';
    case 'sending_payment': return 'Sending payment...';
    case 'registering': return 'Registering name...';
    case 'confirming': return 'Confirming on-chain...';
    case 'success': return 'Registration complete!';
    case 'error': return 'Registration failed';
    default: return '';
  }
}

function getStepNumber(step: RegistrationStep): number {
  switch (step) {
    case 'signing_message': return 1;
    case 'getting_payment_address': return 2;
    case 'sending_payment': return 3;
    case 'registering': return 4;
    case 'confirming': return 5;
    case 'success': return 6;
    default: return 0;
  }
}

const TOTAL_STEPS = 5;

export default function RegisterPaymentModal({
  visible,
  onClose,
  name,
  nameType,
  priceQuil,
  onSuccess,
}: RegisterPaymentModalProps) {
  const { theme, isDark } = useTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme, isDark, insets);

  const { balances } = useWallet();
  const { activeType } = useWalletSelection();

  const [selectedToken, setSelectedToken] = React.useState<'wQUIL' | 'USDC'>('USDC');
  const [selectedChain, setSelectedChain] = React.useState<string>('base');

  const { execute, reset, step, isProcessing, error, txHash } = useRegistrationPayment();

  // Calculate price in selected token
  const { data: calculatedPrice, isLoading: isCalculating } = useCalculatePrice(
    name,
    nameType,
    selectedToken,
    { enabled: visible && !!name }
  );

  // Get available chains for selected token
  const availableChains = React.useMemo(() => {
    const chains: { chainId: number; name: string }[] = [];
    for (const [chainIdStr, tokens] of Object.entries(QNS_TOKEN_ADDRESSES)) {
      const chainId = parseInt(chainIdStr);
      if (tokens[selectedToken]) {
        chains.push({ chainId, name: QNS_CHAIN_NAMES[chainId] || `Chain ${chainId}` });
      }
    }
    return chains;
  }, [selectedToken]);

  // Auto-select first available chain when token changes
  React.useEffect(() => {
    if (availableChains.length > 0) {
      const hasCurrentChain = availableChains.some(c => c.name === selectedChain);
      if (!hasCurrentChain) {
        setSelectedChain(availableChains[0].name);
      }
    }
  }, [availableChains, selectedChain]);

  // Get user's balance for selected token on selected chain
  const userBalance = React.useMemo(() => {
    if (!balances) return null;
    const assets = aggregateAssets(balances);
    const match = assets.find(
      a => a.symbol === selectedToken && a.chain === selectedChain
    );
    return match ? match.balance : '0';
  }, [balances, selectedToken, selectedChain]);

  // Check if user has sufficient balance
  const hasSufficientBalance = React.useMemo(() => {
    if (!calculatedPrice || !userBalance) return false;
    const required = parseFloat(calculatedPrice.price_token);
    const available = parseFloat(userBalance);
    return available >= required;
  }, [calculatedPrice, userBalance]);

  // Reset state when modal opens/closes
  React.useEffect(() => {
    if (visible) {
      reset();
      setSelectedToken('USDC');
      setSelectedChain('base');
    }
  }, [visible, reset]);

  const handleConfirm = React.useCallback(async () => {
    if (!calculatedPrice || !user?.quilibriumAddress) return;

    const result = await execute({
      name,
      nameType,
      tokenSymbol: selectedToken,
      chainName: selectedChain,
      tokenAmount: calculatedPrice.price_token,
      quilibriumAddress: user.quilibriumAddress,
    });

    if (result) {
      onSuccess?.();
    }
  }, [calculatedPrice, user, name, nameType, selectedToken, selectedChain, execute, onSuccess]);

  const handleClose = () => {
    if (isProcessing) {
      Alert.alert(
        'Payment in Progress',
        'A payment is currently being processed. Are you sure you want to close?',
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

  return (
    <BaseModal visible={visible} onClose={handleClose} height={0.85}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Register Name</Text>
          <TouchableOpacity onPress={handleClose}>
            <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Name Display */}
        <View style={styles.nameContainer}>
          <Text style={styles.nameLabel}>@{name}</Text>
          <Text style={styles.namePrice}>{priceQuil} QUIL</Text>
        </View>

        {/* Processing State */}
        {(isProcessing || step === 'success' || step === 'error') && (
          <View style={styles.processingContainer}>
            {step === 'success' ? (
              <View style={styles.successContainer}>
                <IconSymbol name="checkmark.circle.fill" size={48} color={theme.colors.success} />
                <Text style={styles.successTitle}>Name Registered!</Text>
                <Text style={styles.successSubtitle}>
                  @{name} has been registered to your Quilibrium identity
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
              <View style={styles.errorContainer}>
                <IconSymbol name="xmark.circle.fill" size={48} color={theme.colors.danger} />
                <Text style={styles.errorTitle}>Registration Failed</Text>
                <Text style={styles.errorText}>{error}</Text>
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
            {/* Token Selector */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Payment Token</Text>
              <SegmentedPills
                style={styles.tokenSelector}
                variant="tinted"
                pillShape="rect"
                scrollable={false}
                itemRole="button"
                items={AVAILABLE_TOKENS.map<SegmentedPillItem>(token => ({ key: token, label: token }))}
                activeKey={selectedToken}
                onChange={(key) => setSelectedToken(key as 'wQUIL' | 'USDC')}
              />
            </View>

            {/* Chain Selector */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Network</Text>
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

            {/* Price Breakdown */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Payment Details</Text>
              <View style={styles.priceBreakdown}>
                <View style={styles.priceRow}>
                  <Text style={styles.priceLabel}>Price</Text>
                  {isCalculating ? (
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                  ) : (
                    <Text style={styles.priceValue}>
                      {calculatedPrice?.price_token ?? '...'} {selectedToken}
                    </Text>
                  )}
                </View>
                {calculatedPrice && calculatedPrice.price_usd != null && (
                  <View style={styles.priceRow}>
                    <Text style={styles.priceLabel}>USD Value</Text>
                    <Text style={styles.priceValueMuted}>
                      ~${Number(calculatedPrice.price_usd).toFixed(2)}
                    </Text>
                  </View>
                )}
                <View style={styles.divider} />
                <View style={styles.priceRow}>
                  <Text style={styles.priceLabel}>Your Balance</Text>
                  <Text
                    style={[
                      styles.priceValue,
                      !hasSufficientBalance && styles.insufficientBalance,
                    ]}
                  >
                    {userBalance ?? '0'} {selectedToken}
                  </Text>
                </View>
              </View>
              {!hasSufficientBalance && calculatedPrice && (
                <View style={styles.warningContainer}>
                  <IconSymbol name="exclamationmark.triangle.fill" size={16} color={theme.colors.warning} />
                  <Text style={styles.warningText}>
                    Insufficient {selectedToken} balance on {selectedChain}
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
                disabled={!hasSufficientBalance || isCalculating || !calculatedPrice}
                label={`Hold to Pay ${calculatedPrice?.price_token ?? '...'} ${selectedToken}`}
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
    namePrice: {
      fontSize: Skin.font(14),
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
    tokenSelector: {
      gap: Skin.space(8),
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
      color: theme.colors.textSubtle,
    },
    priceValue: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    priceValueMuted: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
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
      color: theme.colors.textSubtle,
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
      color: theme.colors.textSubtle,
    },
    successContainer: {
      alignItems: 'center',
      gap: Skin.space(12),
    },
    successTitle: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.success,
    },
    successSubtitle: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      textAlign: 'center',
    },
    txHashText: {
      fontSize: Skin.font(12),
      color: theme.colors.textSubtle,
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
    errorContainer: {
      alignItems: 'center',
      gap: Skin.space(12),
    },
    errorTitle: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.danger,
    },
    errorText: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      textAlign: 'center',
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
