/**
 * TipModal - Send an on-chain tip to a cast author
 *
 * The recipient is the author's primary registered (Farcaster-verified)
 * ETH address, so the token picker is limited to EVM chains. After a
 * successful tip, if the author is also a Quorum user, a best-effort DM
 * is sent so they get a push notification.
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { SnapIcon } from '@/components/SocialFeed/content/SnapIcon';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useStorageAdapter } from '@/context/StorageContext';
import { useSendDirectMessage } from '@/hooks/chat/useSendDirectMessage';
import { useQuorumIdentityForFid } from '@/hooks/useQuorumIdentityForFid';
import { useWallet, useWalletKeys, aggregateAssets, AggregatedAsset, useEvmBalancesForAddress } from '@/hooks/useWallet';
import { useWalletSelection } from '@/hooks/useWalletSelection';
import { useWarpcastWallet } from '@/hooks/useWarpcastWallet';
import { getWalletPrivateKey } from '@/hooks/useQNSPayment';
import { fetchPrimaryEthAddress } from '@/services/farcasterClient';
import { getChainName, formatBalance } from '@/services/wallet/balanceService';
import { getChainId } from '@/services/wallet/swapService';
import { sendSwapTransaction, getExplorerUrl, estimateTransferGasCost, waitForTransaction } from '@/services/wallet/transactionService';
import { recordTransaction, updateTransactionStatus } from '@/services/wallet/transactionHistoryService';
import WalletSelector from './WalletSelector';
import { useTheme, type AppTheme } from '@/theme';
import { getErrorMessage } from '@/utils/error';
import { truncateAddress } from '@/utils/formatAddress';
import { logger, type Conversation } from '@quilibrium/quorum-shared';
import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { ActivityIndicator, Keyboard, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

/** Cast info a tipping surface passes when the snap button is tapped. */
export interface TipTarget {
  castHash: string;
  castText: string;
  authorFid: number;
  authorUsername: string;
  authorDisplayName?: string;
}

interface TipModalProps extends TipTarget {
  visible: boolean;
  onClose: () => void;
}

// The recipient is an ETH address, valid on all of these EVM chains.
const TIP_EVM_CHAINS = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'];

export default function TipModal({
  visible,
  onClose,
  castHash,
  castText,
  authorFid,
  authorUsername,
  authorDisplayName,
}: TipModalProps) {
  const { theme } = useTheme();
  const { farcasterAuthToken } = useAuth();
  const { showToast } = useToast();
  const storage = useStorageAdapter();
  const sendDirectMessage = useSendDirectMessage();

  const { balances, refetch: refetchBalances } = useWallet();
  const { refetch: fetchKeys } = useWalletKeys();
  const { activeWallet, activeType, warpcastWallet } = useWalletSelection();
  const { importedWallet: warpcastImportedWallet } = useWarpcastWallet();
  const { data: warpcastBalances, refetch: refetchWarpcastBalances } = useEvmBalancesForAddress(
    warpcastWallet?.address,
    { enabled: visible }
  );

  // Resolve the author's primary verified ETH address
  const {
    data: recipientAddress,
    isLoading: isResolvingRecipient,
    isError: recipientError,
  } = useQuery({
    queryKey: ['tip-recipient-eth', authorFid],
    queryFn: () => fetchPrimaryEthAddress(farcasterAuthToken!, authorFid),
    enabled: visible && !!farcasterAuthToken && authorFid > 0,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // Fetched in parallel: linked Quorum identity for the post-tip DM notification
  const { data: quorumIdentity } = useQuorumIdentityForFid(visible ? authorFid : undefined);

  const [selectedAsset, setSelectedAsset] = React.useState<AggregatedAsset | null>(null);
  const [amount, setAmount] = React.useState('');
  const [showAssetPicker, setShowAssetPicker] = React.useState(false);
  const [isSending, setIsSending] = React.useState(false);

  // Memoized — this is a ~190-entry StyleSheet; rebuilding it on every
  // render (each keystroke, each toggle) was the bulk of the visible lag
  // when opening the token picker.
  const styles = React.useMemo(() => createStyles(theme), [theme]);

  // Balances follow the selected wallet (built-in vs imported Warpcast)
  const activeBalances = React.useMemo(() => {
    if (activeType === 'warpcast') {
      return warpcastBalances ?? null;
    }
    return balances;
  }, [activeType, warpcastBalances, balances]);

  // EVM-only assets — the tip recipient is an ETH address. Mirror the
  // wallet's spam policy: drop dust/unknown-price tokens (mainnet wallets
  // accumulate hundreds of spam ERC20s, which made this list enormous and
  // froze the picker), except wQUIL/SNAP which are always tippable. Sorted
  // by USD value so the tokens someone would actually tip are on top.
  const evmAssets = React.useMemo(() => {
    const all = aggregateAssets(activeBalances).filter(
      (asset) => TIP_EVM_CHAINS.includes(asset.chain) && !!getChainId(asset.chain)
    );
    const kept = all.filter(
      (asset) =>
        asset.symbol === 'wQUIL' ||
        asset.symbol === 'SNAP' ||
        (asset.usdValue !== undefined && asset.usdValue >= 0.01)
    );
    kept.sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));
    return kept;
  }, [activeBalances]);

  const handleSelectAsset = React.useCallback((asset: AggregatedAsset) => {
    setSelectedAsset(asset);
    setShowAssetPicker(false);
  }, []);

  // Reset state when modal closes or the wallet changes
  React.useEffect(() => {
    if (!visible) {
      setSelectedAsset(null);
      setAmount('');
      setShowAssetPicker(false);
      setIsSending(false);
    }
  }, [visible]);

  React.useEffect(() => {
    setSelectedAsset(null);
    setAmount('');
  }, [activeType]);

  // Parse balance string to BigInt for precise arithmetic
  const parseBalanceToBigInt = (balance: string, decimals: number): bigint => {
    if (balance.includes('e') || balance.includes('E')) {
      const num = Number(balance);
      if (num === 0 || isNaN(num)) return 0n;
      balance = num.toFixed(decimals);
    }
    balance = balance.trim();
    if (balance.startsWith('-')) return 0n;
    const [whole = '0', fraction = ''] = balance.split('.');
    const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
    try {
      return BigInt(whole + paddedFraction);
    } catch {
      return 0n;
    }
  };

  // Format BigInt back to decimal string
  const formatBigIntBalance = (value: bigint, decimals: number): string => {
    if (value <= 0n) return '0';
    const str = value.toString().padStart(decimals + 1, '0');
    const whole = str.slice(0, -decimals) || '0';
    const fraction = str.slice(-decimals).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
  };

  const handleSetMax = async () => {
    if (!selectedAsset) return;

    const decimals = selectedAsset.decimals || 18;

    if (selectedAsset.isNative) {
      // For native tokens, fetch actual gas cost and reserve it
      const chainId = getChainId(selectedAsset.chain);
      if (!chainId) {
        const formatted = selectedAsset.balance.replace(/\.?0+$/, '');
        setAmount(formatted || '0');
        return;
      }
      try {
        const gasCost = await estimateTransferGasCost(chainId);
        const balanceRaw = parseBalanceToBigInt(selectedAsset.balance, decimals);
        const maxSendable = balanceRaw > gasCost ? balanceRaw - gasCost : 0n;
        setAmount(formatBigIntBalance(maxSendable, decimals));
      } catch (err) {
        // Fallback: use full balance minus small buffer
        const balanceRaw = parseBalanceToBigInt(selectedAsset.balance, decimals);
        const fallbackGas = BigInt('50000000000000'); // 0.00005 ETH fallback
        const maxSendable = balanceRaw > fallbackGas ? balanceRaw - fallbackGas : 0n;
        setAmount(formatBigIntBalance(maxSendable, decimals));
      }
    } else {
      // For ERC20 tokens, use the full balance (gas paid in native token)
      const formatted = selectedAsset.balance.replace(/\.?0+$/, '');
      setAmount(formatted || '0');
    }
  };

  const maxAmount = selectedAsset ? Number(selectedAsset.balance) : 0;
  const noRecipientWallet = !isResolvingRecipient && (recipientError || !recipientAddress);

  const isReadyToSend = React.useMemo(() => {
    if (!recipientAddress || !selectedAsset || !amount) return false;
    const sendAmount = parseFloat(amount);
    if (isNaN(sendAmount) || sendAmount <= 0) return false;
    if (sendAmount > maxAmount) return false;
    return true;
  }, [recipientAddress, selectedAsset, amount, maxAmount]);

  const getButtonLabel = () => {
    if (isResolvingRecipient) return 'Resolving recipient...';
    if (noRecipientWallet) return 'No recipient wallet';
    if (!selectedAsset) return 'Select a token';
    if (!amount) return 'Enter amount';
    const sendAmount = parseFloat(amount);
    if (isNaN(sendAmount) || sendAmount <= 0) return 'Invalid amount';
    if (sendAmount > maxAmount) return 'Insufficient balance';
    return `Tip ${amount} ${selectedAsset.symbol}`;
  };

  /**
   * Best-effort DM so the recipient gets a push notification. Any failure
   * here must NOT affect the tip success UI — log and move on.
   */
  const sendTipNotification = async (params: {
    quorumAddress: string;
    displayName: string;
    tipAmount: string;
    symbol: string;
    txHash: string;
  }) => {
    try {
      const { quorumAddress, displayName, tipAmount, symbol, txHash } = params;

      // Reuse an existing direct conversation when one exists; otherwise
      // create the deterministic one (same pattern as NewConversationModal).
      const { conversations } = await storage.getConversations({ type: 'direct', limit: 1000 });
      const existing = conversations.find(
        (c) =>
          c.address?.toLowerCase() === quorumAddress.toLowerCase() &&
          (c.source === 'quorum' || !c.source)
      );
      let conversationId = existing?.conversationId;
      if (!conversationId) {
        conversationId = `${quorumAddress}/${quorumAddress}`;
        const conversation: Conversation = {
          conversationId,
          address: quorumAddress,
          type: 'direct',
          timestamp: Date.now(),
          displayName,
          icon: '',
        };
        await storage.saveConversation(conversation);
      }

      const snippet = castText.trim().length > 0
        ? ` "${castText.trim().slice(0, 60)}${castText.trim().length > 60 ? '…' : ''}"`
        : '';
      const text = `🫰 Tipped you ${tipAmount} ${symbol} on your cast${snippet}. Tx: ${txHash}`;

      await sendDirectMessage.mutateAsync({
        conversationId,
        recipientAddress: quorumAddress,
        text,
      });
    } catch (error) {
      logger.warn('[TipModal] tip DM notification failed:', error);
    }
  };

  const executeTip = async () => {
    if (!selectedAsset || !recipientAddress || !amount || isSending) return;

    const sendAmount = parseFloat(amount);
    const chainId = getChainId(selectedAsset.chain);
    if (!chainId) return;

    setIsSending(true);
    Keyboard.dismiss();

    try {
      // Get private key for the selected wallet (builtin fetches on demand)
      const privateKey = await getWalletPrivateKey(activeType, warpcastImportedWallet, fetchKeys);

      // Build transaction (native transfer vs ERC20 transfer)
      let txData: string;
      let txTo: string;
      let txValue: string;

      if (selectedAsset.isNative) {
        txTo = recipientAddress;
        txValue = BigInt(Math.floor(sendAmount * Math.pow(10, selectedAsset.decimals))).toString();
        txData = '0x';
      } else {
        txTo = selectedAsset.contractAddress!;
        txValue = '0';
        const amountHex = BigInt(Math.floor(sendAmount * Math.pow(10, selectedAsset.decimals))).toString(16).padStart(64, '0');
        const recipientPadded = recipientAddress.slice(2).toLowerCase().padStart(64, '0');
        txData = `0xa9059cbb${recipientPadded}${amountHex}`;
      }

      const result = await sendSwapTransaction(privateKey, {
        to: txTo,
        data: txData,
        value: txValue,
        chainId,
      });

      const txHash = result.hash;
      const explorerUrl = getExplorerUrl(chainId, result.hash);
      const fromAddress = activeWallet?.address ?? '';

      // Record transaction in history (initially pending)
      recordTransaction({
        hash: txHash,
        chainId,
        from: fromAddress,
        to: recipientAddress,
        amount,
        symbol: selectedAsset.symbol,
        decimals: selectedAsset.decimals,
        isNative: selectedAsset.isNative,
        tokenAddress: selectedAsset.isNative ? undefined : selectedAsset.contractAddress,
        type: 'send',
      });

      // Capture values for background task
      const txAmount = amount;
      const txSymbol = selectedAsset.symbol;
      const isWarpcast = activeType === 'warpcast';
      const recipientQuorumIdentity = quorumIdentity;
      // Broadcast timed out at the HTTP layer — the tx may still have
      // landed (the hash is locally computed and valid either way). The
      // background watcher below settles it; hold the DM until then.
      const broadcastUncertain = !!result.broadcastUncertain;

      const notifyRecipient = () => {
        // Best-effort DM notification if the author is a Quorum user.
        // Failures here never affect the tip success UI.
        if (recipientQuorumIdentity?.address) {
          void sendTipNotification({
            quorumAddress: recipientQuorumIdentity.address,
            displayName: authorDisplayName || recipientQuorumIdentity.displayName || `@${authorUsername}`,
            tipAmount: txAmount,
            symbol: txSymbol,
            txHash,
          });
        }
      };

      setIsSending(false);
      // Close modal first so toast is visible (Modal renders in separate view hierarchy)
      onClose();
      showToast({
        type: 'success',
        title: broadcastUncertain ? 'Tip Submitted' : 'Tip Sent',
        message: broadcastUncertain
          ? `Confirming ${txAmount} ${txSymbol} to @${authorUsername}…`
          : `Tipped ${txAmount} ${txSymbol} to @${authorUsername}`,
        txHash,
        explorerUrl,
      });

      if (!broadcastUncertain) {
        notifyRecipient();
      }

      // Wait for confirmation in background to update history + balances
      (async () => {
        try {
          const receipt = await waitForTransaction(chainId, txHash as `0x${string}`, 1);
          updateTransactionStatus(
            fromAddress,
            txHash,
            chainId,
            receipt.success ? 'success' : 'failed',
            receipt.blockNumber ? Number(receipt.blockNumber) : undefined
          );
          if (receipt.success && broadcastUncertain) {
            // Now we know the timed-out broadcast actually landed —
            // deliver the deferred bits.
            notifyRecipient();
            showToast({
              type: 'success',
              title: 'Tip Sent',
              message: `Tipped ${txAmount} ${txSymbol} to @${authorUsername}`,
              txHash,
              explorerUrl,
            });
          }
          if (!receipt.success) {
            showToast({
              type: 'error',
              title: 'Tip Failed',
              message: 'Transaction failed on chain',
              txHash,
              explorerUrl,
            });
          }
        } catch (err) {
          logger.warn('[TipModal] tip confirmation polling failed:', err);
        }
        // Refresh balances after confirmation attempt
        if (isWarpcast) {
          refetchWarpcastBalances();
        } else {
          refetchBalances();
        }
      })();
    } catch (error: unknown) {
      setIsSending(false);
      // Close modal first so toast is visible (Modal renders in separate view hierarchy)
      onClose();
      const errorMessage = getErrorMessage(error) || 'Failed to send tip. Please try again.';
      showToast({
        type: 'error',
        title: 'Tip Failed',
        message: errorMessage,
        duration: 8000,
      });
    }
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.75} avoidKeyboard>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <SnapIcon color={theme.colors.textMain} size={20} />
          <Text style={styles.title}>Tip</Text>
        </View>
        <TouchableOpacity onPress={onClose}>
          <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* Recipient */}
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Recipient</Text>
          <View style={styles.recipientCard}>
            <View style={styles.recipientInfo}>
              <Text style={styles.recipientName} numberOfLines={1}>
                {authorDisplayName || `@${authorUsername}`}
              </Text>
              {isResolvingRecipient ? (
                <View style={styles.recipientStatusRow}>
                  <ActivityIndicator size="small" color={theme.colors.textMuted} />
                  <Text style={styles.recipientAddress}>Resolving wallet…</Text>
                </View>
              ) : recipientAddress ? (
                <Text style={styles.recipientAddress}>
                  @{authorUsername} • {truncateAddress(recipientAddress)}
                </Text>
              ) : (
                <Text style={styles.recipientError}>This user has no registered wallet</Text>
              )}
            </View>
          </View>
        </View>

        {/* Wallet Selector */}
        <WalletSelector />

        {/* Token Selector */}
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Token</Text>
          <TouchableOpacity
            style={styles.assetSelector}
            onPress={() => setShowAssetPicker(!showAssetPicker)}
          >
            {selectedAsset ? (
              <View style={styles.selectedAsset}>
                <View style={[styles.assetIcon, { backgroundColor: getChainColor(selectedAsset.chain) + '20' }]}>
                  <Text style={[styles.assetIconText, { color: getChainColor(selectedAsset.chain) }]}>
                    {selectedAsset.symbol.charAt(0)}
                  </Text>
                </View>
                <View style={styles.assetInfo}>
                  <Text style={styles.assetName}>{selectedAsset.symbol}</Text>
                  <Text style={styles.assetBalance}>
                    {formatBalance(selectedAsset.balance)} on {getChainName(selectedAsset.chain)}
                  </Text>
                </View>
              </View>
            ) : (
              <Text style={styles.placeholderText}>Select a token</Text>
            )}
            <IconSymbol
              name={showAssetPicker ? 'chevron.up' : 'chevron.down'}
              size={16}
              color={theme.colors.textMuted}
            />
          </TouchableOpacity>

          {/* Token Picker Dropdown — mounted on demand. The asset list is
              spam-filtered to a handful of value-bearing tokens, so a plain
              bounded ScrollView is cheap to mount and avoids nesting a
              VirtualizedList inside the modal's outer ScrollView (which RN
              forbids for same-orientation lists). Rows are memoized; the
              defensive slice keeps a pathological wallet from rendering an
              unbounded list. */}
          {showAssetPicker && (
            <View style={styles.assetPickerDropdown}>
              <ScrollView
                style={styles.assetPickerList}
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
              >
                {evmAssets.length === 0 && (
                  <Text style={styles.emptyAssetsText}>No EVM tokens in this wallet</Text>
                )}
                {evmAssets.slice(0, 50).map((asset, index) => (
                  <TokenPickerRow
                    key={`${asset.chain}-${asset.symbol}-${index}`}
                    asset={asset}
                    styles={styles}
                    onSelect={handleSelectAsset}
                  />
                ))}
              </ScrollView>
            </View>
          )}
        </View>

        {/* Amount */}
        <View style={styles.inputGroup}>
          <View style={styles.amountLabelRow}>
            <Text style={styles.inputLabel}>Amount</Text>
            {selectedAsset && (
              <TouchableOpacity onPress={handleSetMax}>
                <Text style={styles.maxButton}>MAX</Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.amountInputContainer}>
            <TextInput
              style={[styles.textInput, styles.amountInput]}
              placeholder="0.00"
              placeholderTextColor={theme.colors.textMuted}
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
            />
            {selectedAsset && (
              <Text style={styles.amountSymbol}>{selectedAsset.symbol}</Text>
            )}
          </View>
          {selectedAsset && (
            <Text style={styles.balanceHint}>
              Available: {formatBalance(selectedAsset.balance)} {selectedAsset.symbol}
            </Text>
          )}
        </View>

        {/* Send */}
        {isSending ? (
          <View style={styles.sendButton}>
            <ActivityIndicator size="small" color="#fff" />
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.sendButton, !isReadyToSend && styles.sendButtonDisabled]}
            onPress={executeTip}
            disabled={!isReadyToSend}
          >
            <Text style={styles.sendButtonText}>{getButtonLabel()}</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </BaseModal>
  );
}

const getChainColor = (chain: string): string => {
  switch (chain) {
    case 'ethereum': return '#627EEA';
    case 'base': return '#0052FF';
    case 'arbitrum': return '#28A0F0';
    case 'optimism': return '#FF0420';
    case 'polygon': return '#8247E5';
    default: return '#627EEA';
  }
};

/** One token row in the picker. Memoized with stable props (styles is
 *  theme-memoized, onSelect is a useCallback) so list re-renders are
 *  cheap even for token-heavy wallets. */
const TokenPickerRow = React.memo(function TokenPickerRow({
  asset,
  styles,
  onSelect,
}: {
  asset: AggregatedAsset;
  styles: ReturnType<typeof createStyles>;
  onSelect: (asset: AggregatedAsset) => void;
}) {
  return (
    <TouchableOpacity style={styles.assetPickerItem} onPress={() => onSelect(asset)}>
      <View style={[styles.assetIcon, { backgroundColor: getChainColor(asset.chain) + '20' }]}>
        <Text style={[styles.assetIconText, { color: getChainColor(asset.chain) }]}>
          {asset.symbol.charAt(0)}
        </Text>
      </View>
      <View style={styles.assetInfo}>
        <Text style={styles.assetName}>{asset.symbol}</Text>
        <Text style={styles.assetBalance}>
          {formatBalance(asset.balance)} on {getChainName(asset.chain)}
        </Text>
      </View>
    </TouchableOpacity>
  );
});

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: Skin.space(20),
      paddingBottom: Skin.space(16),
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
    },
    title: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    content: {
      flex: 1,
      paddingHorizontal: Skin.space(20),
    },
    inputGroup: {
      marginBottom: Skin.space(20),
    },
    inputLabel: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginBottom: Skin.space(8),
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    recipientCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(14),
    },
    recipientInfo: {
      flex: 1,
      gap: Skin.space(2),
    },
    recipientName: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    recipientStatusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
    },
    recipientAddress: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
    },
    recipientError: {
      fontSize: Skin.font(12),
      color: theme.colors.danger,
    },
    assetSelector: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(14),
    },
    selectedAsset: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
    },
    assetIcon: {
      width: 36,
      height: 36,
      borderRadius: Skin.radius(18),
      alignItems: 'center',
      justifyContent: 'center',
    },
    assetIconText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
    },
    assetInfo: {
      gap: Skin.space(2),
    },
    assetName: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    assetBalance: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
    },
    placeholderText: {
      fontSize: Skin.font(15),
      color: theme.colors.textMuted,
    },
    assetPickerDropdown: {
      marginTop: Skin.space(8),
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      maxHeight: 200,
      overflow: 'hidden',
    },
    assetPickerList: {
      padding: Skin.space(8),
    },
    assetPickerItem: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: Skin.space(10),
      borderRadius: Skin.radius(8),
      gap: Skin.space(12),
    },
    emptyAssetsText: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      textAlign: 'center',
      padding: Skin.space(12),
    },
    textInput: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      paddingHorizontal: Skin.space(14),
      paddingVertical: Skin.space(12),
      fontSize: Skin.font(15),
      lineHeight: Skin.font(20),
      color: theme.colors.textMain,
      textAlignVertical: 'center',
      minHeight: 48,
    },
    amountLabelRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: Skin.space(8),
    },
    maxButton: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.primary,
    },
    amountInputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
    },
    amountInput: {
      flex: 1,
      backgroundColor: 'transparent',
    },
    amountSymbol: {
      paddingRight: Skin.space(14),
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMuted,
    },
    balanceHint: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginTop: Skin.space(6),
    },
    sendButton: {
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: Skin.space(8),
      marginBottom: Skin.space(24),
      minHeight: 56,
    },
    sendButtonDisabled: {
      opacity: 0.5,
    },
    sendButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#fff',
    },
  });
