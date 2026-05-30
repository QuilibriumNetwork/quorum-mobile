/**
 * SendModal - Send tokens to another address
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useToast } from '@/context/ToastContext';
import { useWalletKeys, aggregateAssets, AggregatedAsset, useEvmBalancesForAddress } from '@/hooks/useWallet';
import { useWallet } from '@/hooks/useWallet';
import { useWalletSelection } from '@/hooks/useWalletSelection';
import { useWarpcastWallet } from '@/hooks/useWarpcastWallet';
import { useBiometricAuth } from '@/hooks/useBiometricAuth';
import { getChainName, formatBalance } from '@/services/wallet/balanceService';
import WalletSelector from './WalletSelector';
import HoldToConfirm from './HoldToConfirm';
import { getChainId, NATIVE_TOKEN_ADDRESS } from '@/services/wallet/swapService';
import { sendSwapTransaction, getExplorerUrl, estimateTransferGasCost, waitForTransaction } from '@/services/wallet/transactionService';
import { recordTransaction, updateTransactionStatus } from '@/services/wallet/transactionHistoryService';
import {
  sendSolana,
  sendSplToken,
  getSolanaExplorerUrl,
  waitForSolanaTransaction,
  sendKaspa,
  getKaspaExplorerUrl,
  sendBittensor,
  sendTezos,
  getBittensorExplorerUrl,
  sendBitcoin,
  getBitcoinExplorerUrl,
  checkBitcoinAddressBalances,
  estimateBitcoinFee,
} from '@/services/wallet/nonEvmTransactionService';
import { useTheme, type AppTheme } from '@/theme';
import { getErrorMessage } from '@/utils/error';
import { addRecentRecipient, getRecentRecipients, type RecentRecipient } from '@/services/wallet/walletPrefs';
import { haptics } from '@/utils/haptics';
import React from 'react';
import {
  ActivityIndicator,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

interface SendModalProps {
  visible: boolean;
  onClose: () => void;
  preselectedAsset?: AggregatedAsset | null;
  /** Optional prefilled recipient address. Applied on each `visible`
   *  transition false → true, so re-opening the modal with a new value
   *  picks it up. Pass a chain-appropriate format (0x… for EVM, base58
   *  for Solana, etc.). */
  initialRecipient?: string;
  /** Optional prefilled amount string (token-denominated, decimal). */
  initialAmount?: string;
}

// Threshold for requiring biometric auth (in USD)
const BIOMETRIC_THRESHOLD = 100;

// Non-EVM chains that we support
const NON_EVM_CHAINS = ['solana', 'bitcoin', 'kaspa', 'bittensor', 'tezos'];

export default function SendModal({ visible, onClose, preselectedAsset, initialRecipient, initialAmount }: SendModalProps) {
  const { theme, isDark } = useTheme();
  const { addresses, balances, refetch: refetchBalances } = useWallet();
  const { refetch: fetchKeys } = useWalletKeys();
  const { activeWallet, activeType, warpcastWallet } = useWalletSelection();
  const { importedWallet: warpcastImportedWallet } = useWarpcastWallet();
  const { isAvailable: biometricAvailable, authenticate, getBiometricLabel } = useBiometricAuth();
  const { showToast } = useToast();

  // Fetch balances for Warpcast wallet (EVM only)
  const { data: warpcastBalances, refetch: refetchWarpcastBalances } = useEvmBalancesForAddress(warpcastWallet?.address);

  // Get the active wallet address (for EVM operations)
  const activeAddress = activeWallet?.address ?? addresses?.ethereum;

  // Get balances based on active wallet type
  const activeBalances = React.useMemo(() => {
    if (activeType === 'warpcast') {
      return warpcastBalances ?? null;
    }
    return balances;
  }, [activeType, warpcastBalances, balances]);

  const [selectedAsset, setSelectedAsset] = React.useState<AggregatedAsset | null>(preselectedAsset || null);
  const [recipient, setRecipient] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [showAssetPicker, setShowAssetPicker] = React.useState(false);
  const [isSending, setIsSending] = React.useState(false);
  const [recentRecipients, setRecentRecipients] = React.useState<RecentRecipient[]>([]);

  // Load recents when the selected asset's chain changes
  React.useEffect(() => {
    if (selectedAsset?.chain) {
      setRecentRecipients(getRecentRecipients(selectedAsset.chain));
    } else {
      setRecentRecipients([]);
    }
  }, [selectedAsset?.chain, visible]);

  const handlePickRecent = React.useCallback(
    (addr: string) => {
      haptics.light();
      setRecipient(addr);
    },
    [],
  );

  const styles = createStyles(theme, isDark);

  const allAssets = React.useMemo(() => aggregateAssets(activeBalances), [activeBalances]);

  // Reset state when modal closes
  React.useEffect(() => {
    if (!visible) {
      setRecipient('');
      setAmount('');
      setIsSending(false);
      if (!preselectedAsset) {
        setSelectedAsset(null);
      }
    }
  }, [visible, preselectedAsset]);

  React.useEffect(() => {
    if (preselectedAsset) {
      setSelectedAsset(preselectedAsset);
    }
  }, [preselectedAsset]);

  // Apply the initial recipient / amount on each open. We tie this to
  // `visible` (false → true) instead of the value props so a user
  // editing the field after open doesn't get clobbered if the parent
  // re-renders with the same prefill value.
  const wasVisibleRef = React.useRef(visible);
  React.useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (visible && !wasVisible) {
      if (initialRecipient) setRecipient(initialRecipient);
      if (initialAmount) setAmount(initialAmount);
    }
  }, [visible, initialRecipient, initialAmount]);

  const getChainColor = (chain: string): string => {
    switch (chain) {
      case 'ethereum': return '#627EEA';
      case 'base': return '#0052FF';
      case 'arbitrum': return '#28A0F0';
      case 'optimism': return '#FF0420';
      case 'bitcoin': return '#F7931A';
      case 'solana': return '#9945FF';
      case 'polygon': return '#8247E5';
      default: return theme.colors.primary;
    }
  };

  const isValidAddress = (address: string, chain: string): boolean => {
    if (!address) return false;
    if (chain === 'bitcoin') {
      // Bitcoin addresses start with 1, 3, or bc1
      return /^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,62}$/.test(address);
    }
    if (chain === 'solana') {
      // Solana addresses are base58 encoded, 32-44 chars
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    }
    if (chain === 'kaspa') {
      // Kaspa addresses: kaspa: prefix followed by bech32 (61-63 chars after prefix)
      return /^kaspa:[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{61,63}$/.test(address);
    }
    if (chain === 'bittensor') {
      // Bittensor SS58 addresses start with 5 and are 47-48 chars (base58)
      return /^5[1-9A-HJ-NP-Za-km-z]{46,47}$/.test(address);
    }
    // EVM addresses
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  };

  // Parse balance string to BigInt for precise arithmetic
  const parseBalanceToBigInt = (balance: string, decimals: number): bigint => {
    // Handle scientific notation (e.g., "9e-4")
    if (balance.includes('e') || balance.includes('E')) {
      // Convert to fixed decimal string first
      const num = Number(balance);
      if (num === 0 || isNaN(num)) return 0n;
      balance = num.toFixed(decimals);
    }

    // Remove any leading/trailing whitespace
    balance = balance.trim();

    // Handle negative (shouldn't happen but be safe)
    if (balance.startsWith('-')) return 0n;

    const [whole = '0', fraction = ''] = balance.split('.');
    // Pad or truncate fraction to exact decimals
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

  // Estimated network fees for non-EVM chains (in smallest units)
  const NON_EVM_FEE_RESERVES: Record<string, bigint> = {
    bittensor: 1_000_000n,      // 0.001 TAO (9 decimals)
    solana: 1_000_000n,         // 0.001 SOL (9 decimals) - rent-exempt minimum + fees
    kaspa: 100_000n,            // 0.001 KAS (8 decimals)
    // Note: Bitcoin fee is calculated dynamically based on address type
  };

  const handleSetMax = async () => {
    if (!selectedAsset) return;

    const decimals = selectedAsset.decimals || 18;
    const chain = selectedAsset.chain;
    // Handle Bitcoin specially - calculate fee based on address type
    if (chain === 'bitcoin') {
      try {
        // Check which Bitcoin address types have balance
        const btcBalances = await checkBitcoinAddressBalances({
          nativeSegwit: addresses?.bitcoin?.nativeSegwit,
          segwit: addresses?.bitcoin?.segwit,
          legacy: addresses?.bitcoin?.legacy,
        });

        if (btcBalances.length === 0) {
          setAmount('0');
          return;
        }

        // Use the address type with the highest balance for fee calculation
        // (most likely the one we'll be sending from)
        const primaryBalance = btcBalances.sort((a, b) => b.balanceSats - a.balanceSats)[0];
        const feeReserve = estimateBitcoinFee(primaryBalance.addressType);
        const totalBalanceSats = btcBalances.reduce((sum, b) => sum + b.balanceSats, 0);
        const maxSendable = totalBalanceSats > feeReserve ? totalBalanceSats - feeReserve : 0;
        const formatted = formatBigIntBalance(BigInt(maxSendable), 8);
        setAmount(formatted);
      } catch (e) {
        // Fallback to worst-case (legacy) fee
        const balanceRaw = parseBalanceToBigInt(selectedAsset.balance, 8);
        const fallbackFee = BigInt(estimateBitcoinFee('legacy'));
        const maxSendable = balanceRaw > fallbackFee ? balanceRaw - fallbackFee : 0n;
        setAmount(formatBigIntBalance(maxSendable, 8));
      }
      return;
    }

    // Handle other non-EVM chains
    if (NON_EVM_CHAINS.includes(chain)) {
      // For non-native tokens (like SPL tokens on Solana), use full balance
      // since fees are paid in the native token
      if (!selectedAsset.isNative) {
        const formatted = selectedAsset.balance.replace(/\.?0+$/, '');
        setAmount(formatted || '0');
        return;
      }
      const balanceRaw = parseBalanceToBigInt(selectedAsset.balance, decimals);
      const feeReserve = NON_EVM_FEE_RESERVES[chain] || 0n;
      const maxSendable = balanceRaw > feeReserve ? balanceRaw - feeReserve : 0n;
      const formatted = formatBigIntBalance(maxSendable, decimals);
      setAmount(formatted);
      return;
    }

    if (selectedAsset.isNative) {
      // For native tokens, fetch actual gas cost and reserve it
      const chainId = getChainId(selectedAsset.chain);
      if (!chainId) {
        // Fallback if chain not supported
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

  // Calculate send value in USD for determining confirmation method
  const sendUsdValue = React.useMemo(() => {
    if (!selectedAsset || !amount) return 0;
    const sendAmount = parseFloat(amount);
    if (isNaN(sendAmount)) return 0;
    if (selectedAsset.usdValue !== undefined && parseFloat(selectedAsset.balance) > 0) {
      const pricePerUnit = selectedAsset.usdValue / parseFloat(selectedAsset.balance);
      return sendAmount * pricePerUnit;
    }
    return 0;
  }, [selectedAsset, amount]);

  // Determine if biometric auth is required (>= $100)
  const requiresBiometric = sendUsdValue >= BIOMETRIC_THRESHOLD && biometricAvailable;

  // Check if send is ready
  const isReadyToSend = React.useMemo(() => {
    if (!selectedAsset || !recipient || !amount) return false;
    if (!isValidAddress(recipient, selectedAsset.chain)) return false;
    const sendAmount = parseFloat(amount);
    if (isNaN(sendAmount) || sendAmount <= 0) return false;
    if (sendAmount > maxAmount) return false;
    return true;
  }, [selectedAsset, recipient, amount, maxAmount]);

  // Get button label
  const getButtonLabel = () => {
    if (!selectedAsset) return 'Select asset';
    if (!recipient) return 'Enter recipient';
    if (!amount) return 'Enter amount';
    if (recipient && !isValidAddress(recipient, selectedAsset.chain)) return 'Invalid address';
    const sendAmount = parseFloat(amount);
    if (isNaN(sendAmount) || sendAmount <= 0) return 'Invalid amount';
    if (sendAmount > maxAmount) return 'Insufficient balance';
    return `Hold to Send${sendUsdValue > 0 ? ` ($${sendUsdValue.toFixed(2)})` : ''}`;
  };

  // Execute the send transaction
  const executeSend = async () => {
    if (!selectedAsset || !recipient || !amount) return;

    const sendAmount = parseFloat(amount);
    const chain = selectedAsset.chain;
    const isNonEvm = NON_EVM_CHAINS.includes(chain);
    const chainId = isNonEvm ? null : getChainId(chain);

    // Check if chain is supported
    if (!isNonEvm && !chainId) {
      showToast({
        type: 'error',
        title: 'Unsupported Chain',
        message: `${getChainName(chain)} is not yet supported for sending.`,
      });
      return;
    }

    setIsSending(true);
    Keyboard.dismiss();

    try {
      // Get private keys for signing
      const keysResult = await fetchKeys();
      const keys = keysResult.data;

      if (!keys) {
        throw new Error('Failed to access wallet keys');
      }

      let txHash: string;
      let explorerUrl: string;
      let fromAddress: string;

      // Handle non-EVM chains
      if (chain === 'solana') {
        const privateKey = keys.solana?.privateKey;
        if (!privateKey) throw new Error('No Solana private key available');

        fromAddress = keys.solana.address;

        // Check if this is an SPL token or native SOL
        if (selectedAsset?.contractAddress && !selectedAsset.isNative) {
          // SPL token transfer
          const result = await sendSplToken(
            privateKey,
            recipient,
            selectedAsset.contractAddress,
            sendAmount,
            selectedAsset.decimals || 9
          );
          txHash = result.signature;
          explorerUrl = getSolanaExplorerUrl(result.signature);
        } else {
          // Native SOL transfer
          const result = await sendSolana(privateKey, recipient, sendAmount);
          txHash = result.signature;
          explorerUrl = getSolanaExplorerUrl(result.signature);
        }
      } else if (chain === 'kaspa') {
        const privateKey = keys.kaspa?.privateKey;
        if (!privateKey) throw new Error('No Kaspa private key available');

        fromAddress = keys.kaspa.address;
        const result = await sendKaspa(privateKey, fromAddress, recipient, sendAmount);
        txHash = result.transactionId;
        explorerUrl = getKaspaExplorerUrl(result.transactionId);
      } else if (chain === 'bittensor') {
        const privateKey = keys.bittensor?.privateKey;
        if (!privateKey) throw new Error('No Bittensor private key available');

        fromAddress = keys.bittensor.address;
        const result = await sendBittensor(privateKey, recipient, sendAmount);
        txHash = result.hash;
        explorerUrl = getBittensorExplorerUrl(result.hash);
      } else if (chain === 'tezos') {
        // Tezos send: always uses the SLIP-10 derivation (the
        // standard one) — the BIP32 variant is exposed for address
        // continuity but isn't actively used for transactions.
        const privateKey = keys.tezos?.slip10.privateKey;
        if (!privateKey) throw new Error('No Tezos private key available');

        fromAddress = keys.tezos.slip10.address;
        const result = await sendTezos(privateKey, fromAddress, recipient, sendAmount);
        txHash = result.operationHash;
        explorerUrl = `https://tzkt.io/${result.operationHash}`;
      } else if (chain === 'bitcoin') {
        // Bitcoin - try all address types to find one with UTXOs
        // Priority: nativeSegwit (lowest fees) > segwit > legacy
        const btcAddresses = [
          { type: 'nativeSegwit', ...keys.bitcoin?.nativeSegwit },
          { type: 'segwit', ...keys.bitcoin?.segwit },
          { type: 'legacy', ...keys.bitcoin?.legacy },
        ].filter(addr => addr.address && addr.privateKey);

        let selectedAddress: { type: string; address: string; privateKey: string } | null = null;
        const amountNeededSats = sendAmount * 100_000_000;

        // Find an address with spendable UTXOs
        for (const addr of btcAddresses) {
          try {
            const utxoRes = await fetch(`https://blockstream.info/api/address/${addr.address}/utxo`);
            const utxos = await utxoRes.json();
            const confirmedUtxos = utxos.filter((u: any) => u.status?.confirmed);

            if (confirmedUtxos.length > 0) {
              const totalSats = confirmedUtxos.reduce((sum: number, u: any) => sum + u.value, 0);
              if (totalSats >= amountNeededSats) {
                selectedAddress = addr as any;
                break;
              }
            }
          } catch {
            // UTXO fetch for this address failed — try next address type
          }
        }

        if (!selectedAddress) {
          throw new Error('No Bitcoin address with sufficient confirmed balance found. Your funds may be unconfirmed - please wait for network confirmation.');
        }
        fromAddress = selectedAddress.address;
        const result = await sendBitcoin(selectedAddress.privateKey, fromAddress, recipient, sendAmount);
        txHash = result.txid;
        explorerUrl = getBitcoinExplorerUrl(result.txid);
      } else {
        // EVM chain - use warpcast wallet private key or builtin wallet keys
        const privateKey = (activeType === 'warpcast' ? warpcastImportedWallet?.privateKey : null) || keys.ethereum?.privateKey;
        if (!privateKey) throw new Error('No private key available');

        fromAddress = activeWallet?.address || keys.ethereum.address;

        // Build transaction based on token type
        let txData: string;
        let txTo: string;
        let txValue: string;

        if (selectedAsset.isNative) {
          txTo = recipient;
          txValue = BigInt(Math.floor(sendAmount * Math.pow(10, selectedAsset.decimals))).toString();
          txData = '0x';
        } else {
          txTo = selectedAsset.contractAddress!;
          txValue = '0';
          const amountHex = BigInt(Math.floor(sendAmount * Math.pow(10, selectedAsset.decimals))).toString(16).padStart(64, '0');
          const recipientPadded = recipient.slice(2).toLowerCase().padStart(64, '0');
          txData = `0xa9059cbb${recipientPadded}${amountHex}`;
        }

        const result = await sendSwapTransaction(privateKey, {
          to: txTo,
          data: txData,
          value: txValue,
          chainId: chainId!,
        });

        txHash = result.hash;
        explorerUrl = getExplorerUrl(chainId!, result.hash);
      }

      // Record transaction in history (initially pending)
      recordTransaction({
        hash: txHash,
        chainId: chainId || 0, // Use 0 for non-EVM chains
        from: fromAddress,
        to: recipient,
        amount,
        symbol: selectedAsset.symbol,
        decimals: selectedAsset.decimals,
        isNative: selectedAsset.isNative,
        tokenAddress: selectedAsset.isNative ? undefined : selectedAsset.contractAddress,
        type: 'send',
      });

      // Show pending toast immediately
      showToast({
        type: 'info',
        title: 'Transaction Pending',
        message: `Sending ${amount} ${selectedAsset.symbol} to ${recipient.slice(0, 8)}...${recipient.slice(-6)}`,
        txHash,
        explorerUrl,
      });

      // Capture values for background task
      const txHashCaptured = txHash;
      const txChainId = chainId;
      const txChain = chain;
      const txAddress = fromAddress;
      const txAmount = amount;
      const txSymbol = selectedAsset.symbol;
      const txRecipient = recipient;
      const isWarpcast = activeType === 'warpcast';

      // Remember recipient for the next time user sends on this chain
      addRecentRecipient(txChain, txRecipient);

      setIsSending(false);
      onClose();

      // Wait for confirmation in background
      (async () => {
        try {
          let success = false;

          if (txChain === 'solana') {
            const result = await waitForSolanaTransaction(txHashCaptured);
            success = result.success;
          } else if (txChain === 'bitcoin' || txChain === 'kaspa' || txChain === 'bittensor') {
            // These chains don't have easy confirmation APIs, assume success after a delay
            // Bitcoin: Could check mempool/confirmations but broadcast success is sufficient
            await new Promise(resolve => setTimeout(resolve, 5000));
            success = true;
          } else if (txChainId) {
            // EVM chain
            const receipt = await waitForTransaction(txChainId, txHashCaptured as `0x${string}`, 1);
            success = receipt.success;

            updateTransactionStatus(
              txAddress,
              txHashCaptured,
              txChainId,
              success ? 'success' : 'failed',
              receipt.blockNumber ? Number(receipt.blockNumber) : undefined
            );
          }

          // Wait for indexers to pick up the new balance
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Refresh balances after confirmation
          if (isWarpcast) {
            refetchWarpcastBalances();
          } else {
            refetchBalances();
          }

          showToast({
            type: success ? 'success' : 'error',
            title: success ? 'Send Complete' : 'Send Failed',
            message: success
              ? `Sent ${txAmount} ${txSymbol} to ${txRecipient.slice(0, 8)}...${txRecipient.slice(-6)}`
              : 'Transaction failed on chain',
            txHash: txHashCaptured,
            explorerUrl,
          });
        } catch (err) {
          if (isWarpcast) {
            refetchWarpcastBalances();
          } else {
            refetchBalances();
          }
        }
      })();
    } catch (error: unknown) {
      setIsSending(false);
      // Close modal first so toast is visible (Modal renders in separate view hierarchy)
      onClose();
      // Show error toast after modal closes
      const errorMessage = getErrorMessage(error) || 'Failed to send transaction. Please try again.';
      showToast({
        type: 'error',
        title: 'Send Failed',
        message: errorMessage,
        duration: 8000, // Longer duration for errors so user can read them
      });
    }
  };

  // Handle send with biometric authentication
  const handleBiometricSend = async () => {
    const result = await authenticate(
      `Authenticate to send ${amount} ${selectedAsset?.symbol} ($${sendUsdValue.toFixed(2)})`
    );

    if (result.success) {
      executeSend();
    } else if (result.error !== 'Cancelled') {
      showToast({
        type: 'error',
        title: 'Authentication Failed',
        message: result.error || 'Please try again',
      });
    }
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.75} avoidKeyboard>
      <View style={styles.header}>
        <Text style={styles.title}>Send</Text>
        <TouchableOpacity onPress={onClose}>
          <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* Wallet Selector */}
        <WalletSelector />

        {/* Asset Selector */}
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Asset</Text>
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
              <Text style={styles.placeholderText}>Select an asset</Text>
            )}
            <IconSymbol name="chevron.down" size={16} color={theme.colors.textMuted} />
          </TouchableOpacity>

          {/* Asset Picker Dropdown */}
          {showAssetPicker && (
            <View style={styles.assetPickerDropdown}>
              <ScrollView style={styles.assetPickerList} nestedScrollEnabled>
                {allAssets.map((asset, index) => (
                  <TouchableOpacity
                    key={`${asset.chain}-${asset.symbol}-${index}`}
                    style={styles.assetPickerItem}
                    onPress={() => {
                      setSelectedAsset(asset);
                      setShowAssetPicker(false);
                    }}
                  >
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
                ))}
              </ScrollView>
            </View>
          )}
        </View>

        {/* Recipient Address */}
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Recipient Address</Text>
          <TextInput
            style={styles.textInput}
            placeholder={selectedAsset ? `Enter ${getChainName(selectedAsset.chain)} address` : 'Enter address'}
            placeholderTextColor={theme.colors.textMuted}
            value={recipient}
            onChangeText={setRecipient}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {recipient && selectedAsset && !isValidAddress(recipient, selectedAsset.chain) && (
            <Text style={styles.errorText}>Invalid address format</Text>
          )}
          {/* Recent recipients for this chain — tap to fill */}
          {recentRecipients.length > 0 && !recipient && (
            <View style={styles.recentsContainer}>
              <Text style={styles.recentsLabel}>Recent</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.recentsRow}
              >
                {recentRecipients.map((r) => {
                  const shortAddr =
                    r.label ||
                    (r.address.length > 14
                      ? `${r.address.slice(0, 6)}...${r.address.slice(-4)}`
                      : r.address);
                  return (
                    <TouchableOpacity
                      key={r.address}
                      style={styles.recentChip}
                      onPress={() => handlePickRecent(r.address)}
                    >
                      <IconSymbol name="clock" size={12} color={theme.colors.textMuted} />
                      <Text style={styles.recentChipText}>{shortAddr}</Text>
                    </TouchableOpacity>
                  );
                })}
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

        {/* Send Confirmation */}
        {isSending ? (
          <View style={styles.sendButton}>
            <ActivityIndicator size="small" color="#fff" />
          </View>
        ) : !isReadyToSend ? (
          <View style={[styles.sendButton, styles.sendButtonDisabled]}>
            <Text style={styles.sendButtonText}>{getButtonLabel()}</Text>
          </View>
        ) : requiresBiometric ? (
          <TouchableOpacity style={styles.biometricButton} onPress={handleBiometricSend}>
            <IconSymbol name="faceid" size={20} color="#fff" />
            <Text style={styles.sendButtonText}>
              {getBiometricLabel()} to Send (${sendUsdValue.toFixed(2)})
            </Text>
          </TouchableOpacity>
        ) : (
          <HoldToConfirm
            onConfirm={executeSend}
            label={getButtonLabel()}
            holdingLabel="Keep holding..."
            holdDuration={1500}
            style={{ marginTop: 16 }}
          />
        )}
      </ScrollView>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingBottom: 16,
    },
    title: {
      fontSize: 20,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    content: {
      flex: 1,
      paddingHorizontal: 20,
    },
    inputGroup: {
      marginBottom: 20,
    },
    inputLabel: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginBottom: 8,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    assetSelector: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: theme.colors.surface2,
      borderRadius: 12,
      padding: 14,
    },
    selectedAsset: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    assetIcon: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    assetIconText: {
      fontSize: 16,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
    },
    assetInfo: {
      gap: 2,
    },
    assetName: {
      fontSize: 15,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    assetBalance: {
      fontSize: 12,
      color: theme.colors.textMuted,
    },
    placeholderText: {
      fontSize: 15,
      color: theme.colors.textMuted,
    },
    assetPickerDropdown: {
      marginTop: 8,
      backgroundColor: theme.colors.surface2,
      borderRadius: 12,
      maxHeight: 200,
      overflow: 'hidden',
    },
    assetPickerList: {
      padding: 8,
    },
    assetPickerItem: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 10,
      borderRadius: 8,
      gap: 12,
    },
    textInput: {
      backgroundColor: theme.colors.surface2,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      lineHeight: 20,
      color: theme.colors.textMain,
      textAlignVertical: 'center',
      minHeight: 48,
    },
    errorText: {
      fontSize: 12,
      color: '#EF4444',
      marginTop: 6,
    },
    recentsContainer: {
      marginTop: 10,
    },
    recentsLabel: {
      fontSize: 11,
      letterSpacing: 0.6,
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      marginBottom: 6,
    },
    recentsRow: {
      flexDirection: 'row',
      gap: 8,
      paddingRight: 8,
    },
    recentChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 14,
      backgroundColor: theme.colors.surface2,
    },
    recentChipText: {
      fontSize: 12,
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    amountLabelRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 8,
    },
    maxButton: {
      fontSize: 12,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.primary,
    },
    amountInputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      borderRadius: 12,
    },
    amountInput: {
      flex: 1,
      backgroundColor: 'transparent',
    },
    amountSymbol: {
      paddingRight: 14,
      fontSize: 15,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMuted,
    },
    balanceHint: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginTop: 6,
    },
    sendButton: {
      backgroundColor: theme.colors.primary,
      borderRadius: 12,
      padding: 16,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 16,
      marginBottom: 24,
      minHeight: 56,
    },
    sendButtonDisabled: {
      opacity: 0.5,
    },
    sendButtonText: {
      fontSize: 16,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#fff',
    },
    biometricButton: {
      flexDirection: 'row',
      backgroundColor: '#8B5CF6',
      borderRadius: 12,
      padding: 16,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 16,
      marginBottom: 24,
      gap: 10,
      minHeight: 56,
    },
  });
