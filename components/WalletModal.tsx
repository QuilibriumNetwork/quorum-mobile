/**
 * WalletModal - Multi-chain wallet view
 *
 * Displays wallet addresses and balances for Ethereum, Bitcoin, and Solana
 * derived from the user's Quorum seed phrase.
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth } from '@/context';
import { useToast } from '@/context/ToastContext';
import { useWallet, useNFTs, aggregateAssets, getChainUsdValue, AggregatedAsset, useEvmBalancesForAddress } from '@/hooks/useWallet';
import { useWalletSelection } from '@/hooks/useWalletSelection';
import type { NFT } from '@/services/wallet/balanceService';
import { formatBalance, getChainName, formatUsdValue } from '@/services/wallet/balanceService';
import { textStyles, useTheme, type AppTheme } from '@/theme';
import { useSurface } from '@/theme/skins/surfaces';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { useWalletPref, WALLET_PREF_KEYS } from '@/services/wallet/walletPrefs';
import { haptics } from '@/utils/haptics';
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';
import React from 'react';
import { ActivityIndicator, Alert, Dimensions, Image, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { ActionSheet, type ActionSheetAction } from '@/components/shared';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createMMKV } from 'react-native-mmkv';
import { SendModal, ReceiveModal, SwapModal } from '@/components/wallet';
import HistoryTab from '@/components/wallet/HistoryTab';
import AssetDetailModal from '@/components/wallet/AssetDetailModal';
import NFTDetailModal from '@/components/wallet/NFTDetailModal';
import * as Skin from '@/theme/skins/geometry';
import { SegmentedPills, type SegmentedPillItem } from '@/components/ui/SegmentedPills';

// Storage for wallet display preferences
const walletDisplayStorage = createMMKV({ id: 'quorum-wallet-display' });
const SHOW_ZERO_VALUE_KEY = 'showZeroValueAssets';
const HIDE_BALANCES_KEY = 'hideBalances';
const QUIL_ADDRESS_WARNING_SHOWN_KEY = 'quilAddressWarningShown';

interface WalletModalProps {
  visible: boolean;
  onClose: () => void;
  isRouteMode?: boolean;
  /** When true, skip the `paddingTop: insets.top` applied in route mode.
   *  Used when the modal is nested below another header (e.g. the
   *  segmented Wallet/Mini Apps switcher) which already accounts for
   *  the safe area — without this, the inset is doubled and there's a
   *  visible gap above the screen's own header. */
  noTopInset?: boolean;
}

type ChainFilter = 'all' | 'quilibrium' | 'bitcoin' | 'ethereum' | 'solana' | 'monad' | 'polygon' | 'bsc' | 'hyperevm' | 'base' | 'arbitrum' | 'optimism' | string;

export default function WalletModal({ visible, onClose, isRouteMode = false, noTopInset = false }: WalletModalProps) {
  const { theme, isDark } = useTheme();
  const walletSurface = useSurface('wallet');
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  // Persistent preferences — survive modal close/reopen and app restarts.
  const [activeTab, setActiveTab] = useWalletPref<
    'assets' | 'collectibles' | 'addresses' | 'history'
  >(WALLET_PREF_KEYS.activeTab, 'assets');
  const [chainFilter, setChainFilter] = useWalletPref<ChainFilter>(
    WALLET_PREF_KEYS.chainFilter,
    'all',
  );
  const [showLowValueAssets, setShowLowValueAssets] = useWalletPref<boolean>(
    WALLET_PREF_KEYS.showLowValueAssets,
    false,
  );
  const [showZeroValueAssets, setShowZeroValueAssets] = useWalletPref<boolean>(
    WALLET_PREF_KEYS.showZeroValueAssets,
    false,
  );
  const [hideBalances, setHideBalances] = useWalletPref<boolean>(
    WALLET_PREF_KEYS.hideBalances,
    false,
  );
  const [btcFormatsExpanded, setBtcFormatsExpanded] = useWalletPref<boolean>(
    WALLET_PREF_KEYS.btcFormatsExpanded,
    false,
  );

  const [refreshing, setRefreshing] = React.useState(false);
  const [showSendModal, setShowSendModal] = React.useState(false);
  const [showReceiveModal, setShowReceiveModal] = React.useState(false);
  const [showSwapModal, setShowSwapModal] = React.useState(false);
  const [selectedAsset, setSelectedAsset] = React.useState<AggregatedAsset | null>(null);
  const [showAssetDetail, setShowAssetDetail] = React.useState(false);
  const [detailAsset, setDetailAsset] = React.useState<AggregatedAsset | null>(null);
  const [selectedNFT, setSelectedNFT] = React.useState<NFT | null>(null);
  const [showLoadingSpinner, setShowLoadingSpinner] = React.useState(true);

  // Hide loading spinner after 5 seconds to prevent infinite loading state
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setShowLoadingSpinner(false);
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  // Reset spinner visibility when refresh starts
  React.useEffect(() => {
    if (refreshing) {
      setShowLoadingSpinner(true);
      const timer = setTimeout(() => {
        setShowLoadingSpinner(false);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [refreshing]);

  const styles = createStyles(theme, isDark, insets);

  const { user } = useAuth();
  const { addresses, balances, isLoading, addressesPending, isError, refetch, refetchAddresses } = useWallet();
  const {
    activeWallet,
    activeType,
    builtinWallet,
    warpcastWallet,
    hasWarpcastWallet,
    switchWallet,
  } = useWalletSelection();

  // The Quilibrium / Ethereum / Warpcast cards don't depend on multi-chain
  // derivation — never show the "No wallet found" empty state while any of
  // them is renderable (derivation being slow, disabled, or failed must
  // not hide wallets that plainly exist).
  const hasLocalWalletCards =
    !!user?.quilibriumAddress || !!builtinWallet || !!warpcastWallet;

  // Fetch balances for Warpcast wallet (EVM only)
  const {
    data: warpcastBalances,
    isLoading: warpcastBalancesLoading,
    refetch: refetchWarpcastBalances,
  } = useEvmBalancesForAddress(warpcastWallet?.address);

  // Fetch NFTs for the active wallet
  const activeEvmAddress = activeWallet?.address ?? addresses?.ethereum;
  const nftQuery = useNFTs({ address: activeEvmAddress });
  const nfts = nftQuery.data as NFT[] | undefined;
  const nftsLoading = nftQuery.isLoading;
  const refetchNFTs = nftQuery.refetch;

  // Aggregate assets based on active wallet type
  // When Warpcast wallet is active, show only EVM balances from Warpcast wallet
  // When Quorum wallet is active, show all chain balances from Quorum wallet
  const allAssets = React.useMemo(() => {
    if (activeType === 'warpcast') {
      // For warpcast wallet, use warpcast balances (may be null if loading)
      return aggregateAssets(warpcastBalances ?? null);
    }
    return aggregateAssets(balances);
  }, [activeType, balances, warpcastBalances]);

  // Filter and categorize assets by chain and value
  const { highValueAssets, lowValueAssets, zeroValueAssets } = React.useMemo(() => {
    // First filter by chain
    const chainFiltered = chainFilter === 'all'
      ? allAssets
      : allAssets.filter(asset => asset.chain === chainFilter);

    // Categorize by USD value
    // - High value: $1+
    // - Low value: Known price between $0.01 and $0.99
    // - Zero value: Unknown price OR less than $0.01 (dust/spam)
    const highValue: AggregatedAsset[] = [];
    const lowValue: AggregatedAsset[] = [];
    const zeroValue: AggregatedAsset[] = [];

    for (const asset of chainFiltered) {
      const usdValue = asset.usdValue;

      if (usdValue === undefined) {
        zeroValue.push(asset);
      } else if (usdValue >= 1) {
        highValue.push(asset);
      } else if (usdValue >= 0.01) {
        lowValue.push(asset);
      } else {
        // Less than $0.01 - treat as dust/zero value
        zeroValue.push(asset);
      }
    }

    // Sort each category by USD value descending (unknown values go to end of high value)
    const sortByValue = (a: AggregatedAsset, b: AggregatedAsset) => {
      const aVal = a.usdValue ?? -1; // Unknown goes after known values
      const bVal = b.usdValue ?? -1;
      return bVal - aVal;
    };

    highValue.sort(sortByValue);
    lowValue.sort(sortByValue);

    return { highValueAssets: highValue, lowValueAssets: lowValue, zeroValueAssets: zeroValue };
  }, [allAssets, chainFilter]);

  // Combined filtered assets based on display settings
  const filteredAssets = React.useMemo(() => {
    let assets = [...highValueAssets];
    if (showLowValueAssets) {
      assets = [...assets, ...lowValueAssets];
    }
    if (showZeroValueAssets) {
      assets = [...assets, ...zeroValueAssets];
    }
    return assets;
  }, [highValueAssets, lowValueAssets, zeroValueAssets, showLowValueAssets, showZeroValueAssets]);

  // Count of hidden assets
  const hiddenLowValueCount = showLowValueAssets ? 0 : lowValueAssets.length;
  const hiddenZeroValueCount = showZeroValueAssets ? 0 : zeroValueAssets.length;

  // Calculate total USD balance across all assets
  const totalUsdBalance = React.useMemo(() => {
    return allAssets.reduce((sum, asset) => sum + (asset.usdValue ?? 0), 0);
  }, [allAssets]);

  // Priority order for tiebreaking when USD values are equal (including zero)
  const PRIORITY_CHAINS = ['quilibrium', 'bitcoin', 'ethereum', 'solana', 'monad', 'base', 'optimism', 'polygon', 'arbitrum'];

  // Get balances for the active wallet type
  const activeBalances = React.useMemo(() => {
    return activeType === 'warpcast' ? (warpcastBalances ?? null) : balances;
  }, [activeType, warpcastBalances, balances]);

  // Build dynamic chain filter list sorted by USD value
  const chainFilters = React.useMemo(() => {
    // Get all chains that have assets
    const assetChains = new Set(allAssets.map(a => a.chain));

    // Combine priority chains (always shown) with chains that have assets
    const allChains = new Set([...PRIORITY_CHAINS, ...assetChains]);

    // Build list with USD values for sorting
    const chainsWithValue = [...allChains].map(chain => ({
      chain,
      usdValue: getChainUsdValue(activeBalances, chain),
    }));

    // Sort by USD value descending, with priority order as tiebreaker
    chainsWithValue.sort((a, b) => {
      // First sort by USD value descending
      if (a.usdValue !== b.usdValue) {
        return b.usdValue - a.usdValue;
      }
      // Tiebreaker: use priority order
      const aPriority = PRIORITY_CHAINS.indexOf(a.chain);
      const bPriority = PRIORITY_CHAINS.indexOf(b.chain);
      // If both are in priority list, sort by priority order
      if (aPriority !== -1 && bPriority !== -1) {
        return aPriority - bPriority;
      }
      // Priority chains come before non-priority chains
      if (aPriority !== -1) return -1;
      if (bPriority !== -1) return 1;
      // Both non-priority: sort alphabetically
      return a.chain.localeCompare(b.chain);
    });

    return ['all', ...chainsWithValue.map(c => c.chain)];
  }, [allAssets, activeBalances]);

  const handleRefresh = React.useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      refetch(),
      refetchNFTs(),
      refetchWarpcastBalances(),
      // Re-attempt address derivation too — without this, the retry
      // affordances on the addresses tab only refreshed balances and a
      // failed/null derivation could never recover.
      ...(addresses ? [] : [Promise.resolve(refetchAddresses())]),
    ]);
    setRefreshing(false);
  }, [refetch, refetchNFTs, refetchWarpcastBalances, refetchAddresses, addresses]);

  const copyAddress = React.useCallback(async (address: string, chain: string) => {
    const doCopy = async () => {
      await Clipboard.setStringAsync(address);
      showToast({
        type: 'success',
        title: 'Copied',
        message: `${getChainName(chain)} address copied`,
      });
    };

    // Show one-time warning for Quilibrium address
    if (chain === 'quilibrium') {
      const warningShown = walletDisplayStorage.getBoolean(QUIL_ADDRESS_WARNING_SHOWN_KEY);
      if (!warningShown) {
        Alert.alert(
          'Important',
          'This address is for Quilibrium native assets (QUIL and other tokens) only. Do not send wQUIL to this address, you will lose your wQUIL. Send wQUIL to the Ethereum address.',
          [
            {
              text: 'I Understand',
              onPress: async () => {
                walletDisplayStorage.set(QUIL_ADDRESS_WARNING_SHOWN_KEY, true);
                await doCopy();
              },
            },
          ]
        );
        return;
      }
    }

    await doCopy();
  }, [showToast]);

  const toggleZeroValueAssets = React.useCallback(() => {
    setShowZeroValueAssets(!showZeroValueAssets);
  }, [showZeroValueAssets, setShowZeroValueAssets]);

  const toggleHideBalances = React.useCallback(() => {
    haptics.selection();
    setHideBalances(!hideBalances);
  }, [hideBalances, setHideBalances]);

  // Long-press on an asset row → themed sheet (Send / Receive / Swap /
  // Details). Skips a tap into the detail modal for the most common flows.
  // State for the in-app ActionSheet (replaces native ActionSheetIOS/Alert).
  const [assetActionAsset, setAssetActionAsset] = React.useState<AggregatedAsset | null>(null);
  const showAssetActions = React.useCallback(
    (asset: AggregatedAsset) => {
      haptics.medium();
      setAssetActionAsset(asset);
    },
    [],
  );

  const assetActionSheetActions: ActionSheetAction[] = React.useMemo(() => {
    const asset = assetActionAsset;
    if (!asset) return [];
    return [
      {
        label: 'Send',
        icon: 'arrow.up.right',
        onPress: () => {
          setSelectedAsset(asset);
          setShowSendModal(true);
        },
      },
      {
        label: 'Receive',
        icon: 'arrow.down.left',
        onPress: () => setShowReceiveModal(true),
      },
      {
        label: 'Swap',
        icon: 'arrow.2.squarepath',
        onPress: () => {
          setSelectedAsset(asset);
          setShowSwapModal(true);
        },
      },
      {
        label: 'View Details',
        icon: 'info.circle',
        onPress: () => {
          setDetailAsset(asset);
          setShowAssetDetail(true);
        },
      },
    ];
  }, [assetActionAsset]);

  // Get chain-specific colors
  const getChainColor = (chain: string): string => {
    switch (chain) {
      case 'quilibrium':
        return '#EC4899';
      case 'ethereum':
        return '#627EEA';
      case 'base':
        return '#0052FF';
      case 'arbitrum':
        return '#28A0F0';
      case 'optimism':
        return '#FF0420';
      case 'bitcoin':
        return '#F7931A';
      case 'solana':
        return '#9945FF';
      case 'monad':
        return '#836EF9';
      case 'polygon':
        return '#8247E5';
      case 'bsc':
        return '#F0B90B';
      case 'hyperevm':
        return '#50E2C4';
      case 'kaspa':
        return '#49EAC2';
      case 'bittensor':
        return '#6366F1'; // Indigo - visible in both light/dark modes
      case 'tezos':
        return '#2C7DF7'; // Tezos brand blue
      default:
        return theme.colors.primary;
    }
  };

  // Get asset icon letter/symbol
  const getAssetIcon = (asset: AggregatedAsset): string => {
    if (asset.symbol === 'ETH') return 'Ξ';
    if (asset.symbol === 'BTC') return '₿';
    if (asset.symbol === 'SOL') return '◎';
    if (asset.symbol === 'XTZ') return 'ꜩ'; // Tezos sign (U+A729)
    return asset.symbol.charAt(0);
  };

  // Content that's shared between modal and route modes
  const walletContent = (
    <>
      {/* Wallet switcher row — only when a Warpcast wallet is also
          available. The page title and refresh button are owned by
          the parent tab header now; the user pulls-to-refresh on the
          ScrollView for explicit reloads. */}
      {hasWarpcastWallet && (
        <View style={styles.header}>
          <SegmentedPills
            variant="segmented"
            scrollable={false}
            items={[
              { key: 'builtin', label: 'Quorum' },
              { key: 'warpcast', label: 'Warpcast' },
            ]}
            activeKey={activeType}
            onChange={(key) => switchWallet(key as 'builtin' | 'warpcast')}
          />
        </View>
      )}

      {/* Tab Switcher */}
      <SegmentedPills
        style={styles.tabSwitcher}
        variant="segmented"
        scrollable={false}
        items={[
          { key: 'assets', label: 'Assets' },
          { key: 'collectibles', label: 'Collectibles' },
          { key: 'addresses', label: 'Addresses' },
          { key: 'history', label: 'History' },
        ]}
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as typeof activeTab)}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        style={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={theme.colors.primary}
          />
        }
      >
        {activeTab === 'assets' ? (
          <>
            {/* Total Balance Display */}
            <View style={styles.totalBalanceContainer}>
              <View style={styles.totalBalanceLabelRow}>
                <Text style={styles.totalBalanceLabel}>Total Balance</Text>
                <TouchableOpacity
                  onPress={toggleHideBalances}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={styles.hideBalanceButton}
                >
                  <IconSymbol
                    name={hideBalances ? 'eye.slash' : 'eye'}
                    size={16}
                    color={theme.colors.textMuted}
                  />
                </TouchableOpacity>
              </View>
              <Text style={styles.totalBalanceAmount}>
                {hideBalances
                  ? '••••••'
                  : totalUsdBalance > 0
                    ? `$${totalUsdBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : '$0.00'}
              </Text>
            </View>

            {/* Action Buttons */}
            <View style={styles.actionButtonsRow}>
              <TouchableOpacity
                style={styles.actionButton}
                onPress={() => setShowSendModal(true)}
              >
                <View style={[styles.actionButtonIcon, { backgroundColor: theme.colors.primary + '20' }]}>
                  <IconSymbol name="arrow.up.right" size={20} color={theme.colors.primary} />
                </View>
                <Text style={styles.actionButtonText}>Send</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.actionButton}
                onPress={() => setShowReceiveModal(true)}
              >
                <View style={[styles.actionButtonIcon, { backgroundColor: '#22C55E20' }]}>
                  <IconSymbol name="arrow.down.left" size={20} color="#22C55E" />
                </View>
                <Text style={styles.actionButtonText}>Receive</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.actionButton}
                onPress={() => setShowSwapModal(true)}
              >
                <View style={[styles.actionButtonIcon, { backgroundColor: '#8B5CF620' }]}>
                  <IconSymbol name="arrow.triangle.2.circlepath" size={20} color="#8B5CF6" />
                </View>
                <Text style={styles.actionButtonText}>Swap</Text>
              </TouchableOpacity>
            </View>

            {/* Note for Warpcast wallet - EVM only */}
            {activeType === 'warpcast' && (
              <View style={styles.evmOnlyNote}>
                <IconSymbol name="info.circle" size={14} color={theme.colors.textMuted} />
                <Text style={styles.evmOnlyNoteText}>
                  Warpcast wallet is EVM-only. Switch to Quorum wallet for Bitcoin, Solana, and other chains.
                </Text>
              </View>
            )}

            {/* Chain Filter Pills */}
            <SegmentedPills
              style={styles.filterContainer}
              contentContainerStyle={styles.filterContent}
              variant="solid"
              itemRole="button"
              items={chainFilters.map<SegmentedPillItem>((chain) => ({
                key: chain,
                label: chain === 'all' ? 'All Networks' : getChainName(chain),
                // Per-chain brand color drives the active tint (the 'all' pill
                // falls back to the theme accent).
                accentColor: chain === 'all' ? undefined : getChainColor(chain),
              }))}
              activeKey={chainFilter}
              onChange={setChainFilter}
            />

            {/* Loading State - hide after 5 seconds */}
            {showLoadingSpinner && ((activeType === 'builtin' && isLoading && !balances) ||
              (activeType === 'warpcast' && warpcastBalancesLoading && !warpcastBalances)) && (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
                <Text style={styles.loadingText}>Loading wallet...</Text>
              </View>
            )}

            {/* Timed-out State - spinner auto-hid after 5s but balances never arrived */}
            {!showLoadingSpinner && !isError &&
              ((activeType === 'builtin' && isLoading && !balances) ||
                (activeType === 'warpcast' && warpcastBalancesLoading && !warpcastBalances)) && (
              <View style={styles.errorContainer}>
                <IconSymbol name="exclamationmark.triangle.fill" size={32} color={theme.colors.warning} />
                <Text style={styles.errorText}>Wallet is taking longer than expected to load</Text>
                <TouchableOpacity style={styles.retryButton} onPress={handleRefresh}>
                  <Text style={styles.retryButtonText}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Error State */}
            {isError && (
              <View style={styles.errorContainer}>
                <IconSymbol name="exclamationmark.triangle.fill" size={32} color={theme.colors.warning} />
                <Text style={styles.errorText}>Failed to load balances</Text>
                <TouchableOpacity style={styles.retryButton} onPress={handleRefresh}>
                  <Text style={styles.retryButtonText}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Empty State - only show when there are no assets at all (including hidden ones) */}
            {!(activeType === 'builtin' ? isLoading : warpcastBalancesLoading) && !isError &&
              filteredAssets.length === 0 && hiddenLowValueCount === 0 && hiddenZeroValueCount === 0 && (
              <View style={styles.emptyContainer}>
                <IconSymbol name="wallet.pass" size={48} color={theme.colors.textMuted} />
                <Text style={styles.emptyText}>No assets found</Text>
                <Text style={styles.emptySubtext}>
                  {chainFilter === 'all'
                    ? 'Your wallet is empty across all networks'
                    : `No assets on ${getChainName(chainFilter)}`}
                </Text>
              </View>
            )}

            {/* Assets List */}
            {filteredAssets.length > 0 && (
              <View style={styles.assetsSection}>
                {filteredAssets.map((asset, index) => (
                  <TouchableOpacity
                    key={`${asset.chain}-${asset.symbol}-${asset.contractAddress || 'native'}-${index}`}
                    style={styles.assetItem}
                    onPress={() => {
                      setDetailAsset(asset);
                      setShowAssetDetail(true);
                    }}
                    onLongPress={() => showAssetActions(asset)}
                    delayLongPress={300}
                  >
                    <View style={styles.assetLeft}>
                      <View style={[styles.assetIcon, { backgroundColor: getChainColor(asset.chain) + '20' }]}>
                        {asset.iconUrl ? (
                          <Image
                            source={{ uri: asset.iconUrl }}
                            style={styles.assetIconImage}
                            resizeMode="cover"
                          />
                        ) : (
                          <Text style={[styles.assetSymbolText, { color: getChainColor(asset.chain) }]}>
                            {getAssetIcon(asset)}
                          </Text>
                        )}
                      </View>
                      <View>
                        <Text style={styles.assetName}>{asset.name}</Text>
                        <View style={styles.assetChainRow}>
                          <View style={[styles.chainDot, { backgroundColor: getChainColor(asset.chain) }]} />
                          <Text style={styles.assetChain}>{asset.chainName}</Text>
                        </View>
                      </View>
                    </View>
                    <View style={styles.assetRight}>
                      <Text style={styles.assetBalance}>
                        {formatBalance(asset.balance, asset.symbol === 'BTC' ? 8 : 4)} {asset.symbol}
                      </Text>
                      {/* Show pending indicator for Bitcoin with unconfirmed transactions */}
                      {asset.pendingBalance && parseFloat(asset.pendingBalance) !== 0 && (
                        <Text style={[
                          styles.pendingBalance,
                          parseFloat(asset.pendingBalance) > 0 ? styles.pendingPositive : styles.pendingNegative
                        ]}>
                          {parseFloat(asset.pendingBalance) > 0 ? '+' : ''}
                          {formatBalance(asset.pendingBalance, asset.symbol === 'BTC' ? 8 : 4)} pending
                        </Text>
                      )}
                      {asset.usdValue !== undefined && asset.usdValue > 0 && (
                        <View style={styles.assetPriceRow}>
                          <Text style={styles.assetUsdValue}>
                            {hideBalances ? '••••' : formatUsdValue(asset.usdValue.toString())}
                          </Text>
                          {!hideBalances && asset.priceChange24h != null && asset.priceChange24h !== 0 && (
                            <Text style={[
                              styles.priceChange,
                              asset.priceChange24h > 0 ? styles.priceChangePositive : styles.priceChangeNegative
                            ]}>
                              {asset.priceChange24h > 0 ? '+' : ''}{asset.priceChange24h.toFixed(2)}%
                            </Text>
                          )}
                        </View>
                      )}
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Show More Button for low-value assets */}
            {lowValueAssets.length > 0 && (
              <TouchableOpacity
                style={styles.showMoreButton}
                onPress={() => setShowLowValueAssets(!showLowValueAssets)}
              >
                <IconSymbol
                  name={showLowValueAssets ? 'chevron.up' : 'chevron.down'}
                  size={16}
                  color={theme.colors.textMuted}
                />
                <Text style={styles.showMoreText}>
                  {showLowValueAssets
                    ? 'Hide low value assets'
                    : `Show ${lowValueAssets.length} more asset${lowValueAssets.length === 1 ? '' : 's'} under $1`}
                </Text>
              </TouchableOpacity>
            )}
          </>
        ) : activeTab === 'collectibles' ? (
          /* Collectibles Tab */
          <View style={styles.collectiblesSection}>
            {nftsLoading && !nfts?.length && (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
                <Text style={styles.loadingText}>Loading collectibles...</Text>
              </View>
            )}

            {!nftsLoading && (!nfts || nfts.length === 0) && (
              <View style={styles.emptyContainer}>
                <IconSymbol name="photo.on.rectangle.angled" size={48} color={theme.colors.textMuted} />
                <Text style={styles.emptyText}>No collectibles found</Text>
                <Text style={styles.emptySubtext}>
                  NFTs you own will appear here
                </Text>
              </View>
            )}

            {nfts && nfts.length > 0 && (
              <View style={styles.nftGrid}>
                {nfts.map((nft, index) => (
                  <TouchableOpacity
                    key={`${nft.chain}-${nft.contractAddress}-${nft.tokenId}-${index}`}
                    style={styles.nftCard}
                    activeOpacity={0.8}
                    onPress={() => setSelectedNFT(nft)}
                  >
                    <View style={styles.nftImageContainer}>
                      {nft.thumbnailUrl || nft.imageUrl ? (
                        <Image
                          source={{ uri: nft.thumbnailUrl || nft.imageUrl }}
                          style={styles.nftImage}
                          resizeMode="cover"
                        />
                      ) : (
                        <View style={[styles.nftImage, styles.nftPlaceholder]}>
                          <IconSymbol name="photo" size={32} color={theme.colors.textMuted} />
                        </View>
                      )}
                      <View style={[styles.nftChainBadge, { backgroundColor: getChainColor(nft.chain) }]}>
                        <Text style={styles.nftChainBadgeText}>{nft.chainName.substring(0, 3)}</Text>
                      </View>
                    </View>
                    <View style={styles.nftInfo}>
                      <Text style={styles.nftName} numberOfLines={1}>{nft.name}</Text>
                      {nft.collectionName && (
                        <Text style={styles.nftCollection} numberOfLines={1}>{nft.collectionName}</Text>
                      )}
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        ) : activeTab === 'addresses' ? (
          /* Addresses Tab */
          <View style={styles.addressesSection}>
            {!addresses && !hasLocalWalletCards && (isLoading || addressesPending) ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
                <Text style={styles.loadingText}>Deriving addresses...</Text>
              </View>
            ) : !addresses && !hasLocalWalletCards && isError ? (
              <View style={styles.errorContainer}>
                <IconSymbol name="exclamationmark.triangle.fill" size={32} color={theme.colors.warning} />
                <Text style={styles.errorText}>Failed to derive addresses</Text>
                <TouchableOpacity style={styles.retryButton} onPress={handleRefresh}>
                  <Text style={styles.retryButtonText}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : !addresses && !hasLocalWalletCards ? (
              <View style={styles.errorContainer}>
                <IconSymbol name="key.fill" size={32} color={theme.colors.textMuted} />
                <Text style={styles.errorText}>No wallet found</Text>
                <Text style={styles.emptySubtext}>Set up your wallet to view addresses</Text>
              </View>
            ) : (
              <>
                {/* Quilibrium Address Card */}
                {user?.quilibriumAddress && (
                  <View style={styles.addressCard}>
                    <LinearGradient
                      colors={['#EC489920', '#EC489910']}
                      style={styles.addressCardGradient}
                    >
                      <View style={styles.addressCardHeader}>
                        <Image source={require('@/assets/images/qlogo.png')} style={styles.chainLogo} />
                        <View>
                          <Text style={styles.addressCardTitle}>Quilibrium</Text>
                          <Text style={styles.addressCardSubtitle}>View + Spend Keys</Text>
                        </View>
                      </View>
                      <TouchableOpacity
                        style={styles.addressRow}
                        onPress={() => copyAddress(user.quilibriumAddress, 'quilibrium')}
                      >
                        <View style={styles.addressValueRow}>
                          <Text style={styles.addressText} numberOfLines={1} ellipsizeMode="middle">{user.quilibriumAddress}</Text>
                          <IconSymbol name="doc.on.doc" size={16} color={theme.colors.textMuted} />
                        </View>
                      </TouchableOpacity>
                    </LinearGradient>
                  </View>
                )}

                {/* Ethereum Address Card */}
                <View style={styles.addressCard}>
                  <LinearGradient
                    colors={['#627EEA20', '#627EEA10']}
                    style={styles.addressCardGradient}
                  >
                    <View style={styles.addressCardHeader}>
                      <View style={[styles.chainIconContainer, { backgroundColor: '#627EEA' }]}>
                        <Text style={styles.chainIconText}>Ξ</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.addressCardTitle}>Ethereum</Text>
                        <Text style={styles.addressCardSubtitle}>EVM-compatible chains</Text>
                      </View>
                    </View>

                    {/* Built-in Quorum Wallet */}
                    {builtinWallet && (
                      <TouchableOpacity
                        style={[
                          styles.addressRow,
                          hasWarpcastWallet && activeType === 'builtin' && styles.addressRowActive,
                        ]}
                        onPress={hasWarpcastWallet
                          ? () => switchWallet('builtin')
                          : () => copyAddress(builtinWallet.address, 'ethereum')
                        }
                        onLongPress={hasWarpcastWallet
                          ? () => copyAddress(builtinWallet.address, 'ethereum')
                          : undefined
                        }
                      >
                        <View style={styles.addressLabelRow}>
                          <Text style={styles.addressLabel}>Quorum Wallet</Text>
                          {hasWarpcastWallet && activeType === 'builtin' && (
                            <View style={styles.activeWalletBadge}>
                              <Text style={styles.activeWalletBadgeText}>Active</Text>
                            </View>
                          )}
                        </View>
                        <View style={styles.addressValueRow}>
                          <Text style={styles.addressText} numberOfLines={1} ellipsizeMode="middle">
                            {builtinWallet.address}
                          </Text>
                          <IconSymbol name="doc.on.doc" size={16} color={theme.colors.textMuted} />
                        </View>
                      </TouchableOpacity>
                    )}

                    {/* Imported Warpcast Wallet */}
                    {warpcastWallet && (
                      <TouchableOpacity
                        style={[
                          styles.addressRow,
                          styles.addressRowMiddle,
                          activeType === 'warpcast' && styles.addressRowActive,
                        ]}
                        onPress={() => switchWallet('warpcast')}
                        onLongPress={() => copyAddress(warpcastWallet.address, 'ethereum')}
                      >
                        <View style={styles.addressLabelRow}>
                          <Text style={styles.addressLabel}>Warpcast Wallet</Text>
                          {activeType === 'warpcast' && (
                            <View style={styles.activeWalletBadge}>
                              <Text style={styles.activeWalletBadgeText}>Active</Text>
                            </View>
                          )}
                        </View>
                        <View style={styles.addressValueRow}>
                          <Text style={styles.addressText} numberOfLines={1} ellipsizeMode="middle">
                            {warpcastWallet.address}
                          </Text>
                          <IconSymbol name="doc.on.doc" size={16} color={theme.colors.textMuted} />
                        </View>
                      </TouchableOpacity>
                    )}

                    {hasWarpcastWallet && (
                      <Text style={styles.walletHint}>
                        Tap to select active wallet. Long press to copy.
                      </Text>
                    )}
                  </LinearGradient>
                </View>

                {/* Multi-chain cards need the derived addresses; while they
                    are pending/unavailable, show an inline status card
                    instead of hiding the wallets above. */}
                {!addresses && (
                  <View style={styles.addressCard}>
                    <LinearGradient
                      colors={['#88888820', '#88888810']}
                      style={styles.addressCardGradient}
                    >
                      <View style={styles.addressCardHeader}>
                        <View style={[styles.chainIconContainer, { backgroundColor: theme.colors.textMuted }]}>
                          <IconSymbol name="key.fill" size={14} color="#fff" />
                        </View>
                        <View>
                          <Text style={styles.addressCardTitle}>Other Chains</Text>
                          <Text style={styles.addressCardSubtitle}>Bitcoin, Solana, Kaspa, Bittensor, Tezos</Text>
                        </View>
                      </View>
                      {isLoading || addressesPending ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 }}>
                          <ActivityIndicator size="small" color={theme.colors.primary} />
                          <Text style={styles.emptySubtext}>Deriving addresses…</Text>
                        </View>
                      ) : (
                        <View style={{ paddingVertical: 12 }}>
                          <Text style={styles.emptySubtext}>
                            {isError
                              ? 'Failed to derive multi-chain addresses.'
                              : 'Multi-chain addresses unavailable.'}
                          </Text>
                          <TouchableOpacity style={[styles.retryButton, { marginTop: 8 }]} onPress={handleRefresh}>
                            <Text style={styles.retryButtonText}>Retry</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                    </LinearGradient>
                  </View>
                )}

                {addresses && (
                <>
                {/* Bitcoin Address Card */}
                <View style={styles.addressCard}>
                  <LinearGradient
                    colors={['#F7931A20', '#F7931A10']}
                    style={styles.addressCardGradient}
                  >
                    <View style={styles.addressCardHeader}>
                      <View style={[styles.chainIconContainer, { backgroundColor: '#F7931A' }]}>
                        <Text style={styles.chainIconText}>₿</Text>
                      </View>
                      <View>
                        <Text style={styles.addressCardTitle}>Bitcoin</Text>
                        <Text style={styles.addressCardSubtitle}>Multiple address formats</Text>
                      </View>
                    </View>
                    {/* Native SegWit (Bech32) - recommended, always shown */}
                    <TouchableOpacity
                      style={btcFormatsExpanded ? styles.addressRow : [styles.addressRow, styles.addressRowLast]}
                      onPress={() => copyAddress(addresses.bitcoin.nativeSegwit, 'bitcoin')}
                    >
                      <View style={styles.addressLabelRow}>
                        <Text style={styles.addressLabel}>Native SegWit</Text>
                        <Text style={styles.addressRecommended}>Recommended</Text>
                      </View>
                      <View style={styles.addressValueRow}>
                        <Text style={styles.addressText} numberOfLines={1} ellipsizeMode="middle">{addresses.bitcoin.nativeSegwit}</Text>
                        <IconSymbol name="doc.on.doc" size={16} color={theme.colors.textMuted} />
                      </View>
                    </TouchableOpacity>
                    {/* SegWit + Legacy collapsed by default */}
                    {btcFormatsExpanded && (
                      <>
                        <TouchableOpacity
                          style={[styles.addressRow, styles.addressRowMiddle]}
                          onPress={() => copyAddress(addresses.bitcoin.segwit, 'bitcoin')}
                        >
                          <View style={styles.addressLabelRow}>
                            <Text style={styles.addressLabel}>SegWit</Text>
                          </View>
                          <View style={styles.addressValueRow}>
                            <Text style={styles.addressText} numberOfLines={1} ellipsizeMode="middle">{addresses.bitcoin.segwit}</Text>
                            <IconSymbol name="doc.on.doc" size={16} color={theme.colors.textMuted} />
                          </View>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.addressRow, styles.addressRowLast]}
                          onPress={() => copyAddress(addresses.bitcoin.legacy, 'bitcoin')}
                        >
                          <View style={styles.addressLabelRow}>
                            <Text style={styles.addressLabel}>Legacy</Text>
                          </View>
                          <View style={styles.addressValueRow}>
                            <Text style={styles.addressText} numberOfLines={1} ellipsizeMode="middle">{addresses.bitcoin.legacy}</Text>
                            <IconSymbol name="doc.on.doc" size={16} color={theme.colors.textMuted} />
                          </View>
                        </TouchableOpacity>
                      </>
                    )}
                    <TouchableOpacity
                      style={styles.btcToggleRow}
                      onPress={() => setBtcFormatsExpanded(!btcFormatsExpanded)}
                    >
                      <Text style={styles.btcToggleText}>
                        {btcFormatsExpanded ? 'Hide other formats' : 'Show other formats (SegWit, Legacy)'}
                      </Text>
                      <IconSymbol
                        name={btcFormatsExpanded ? 'chevron.up' : 'chevron.down'}
                        size={12}
                        color={theme.colors.textMuted}
                      />
                    </TouchableOpacity>
                  </LinearGradient>
                </View>

                {/* Solana Address Card */}
                <View style={styles.addressCard}>
                  <LinearGradient
                    colors={['#9945FF20', '#9945FF10']}
                    style={styles.addressCardGradient}
                  >
                    <View style={styles.addressCardHeader}>
                      <Image
                        source={{ uri: 'https://coin-images.coingecko.com/coins/images/4128/small/solana.png' }}
                        style={styles.chainLogo}
                      />
                      <View>
                        <Text style={styles.addressCardTitle}>Solana</Text>
                        <Text style={styles.addressCardSubtitle}>SOL, SPL Tokens</Text>
                      </View>
                    </View>
                    <TouchableOpacity
                      style={styles.addressRow}
                      onPress={() => copyAddress(addresses.solana, 'solana')}
                    >
                      <View style={styles.addressValueRow}>
                        <Text style={styles.addressText} numberOfLines={1} ellipsizeMode="middle">{addresses.solana}</Text>
                        <IconSymbol name="doc.on.doc" size={16} color={theme.colors.textMuted} />
                      </View>
                    </TouchableOpacity>
                  </LinearGradient>
                </View>

                {/* Kaspa Address Card */}
                <View style={styles.addressCard}>
                  <LinearGradient
                    colors={['#49EAC220', '#49EAC210']}
                    style={styles.addressCardGradient}
                  >
                    <View style={styles.addressCardHeader}>
                      <Image
                        source={{ uri: 'https://coin-images.coingecko.com/coins/images/25751/small/kaspa-icon-exchanges.png' }}
                        style={styles.chainLogo}
                      />
                      <View>
                        <Text style={styles.addressCardTitle}>Kaspa</Text>
                        <Text style={styles.addressCardSubtitle}>KAS, Schnorr Signatures</Text>
                      </View>
                    </View>
                    <TouchableOpacity
                      style={styles.addressRow}
                      onPress={() => copyAddress(addresses.kaspa, 'kaspa')}
                    >
                      <View style={styles.addressValueRow}>
                        <Text style={styles.addressText} numberOfLines={1} ellipsizeMode="middle">{addresses.kaspa}</Text>
                        <IconSymbol name="doc.on.doc" size={16} color={theme.colors.textMuted} />
                      </View>
                    </TouchableOpacity>
                  </LinearGradient>
                </View>

                {/* Bittensor Address Card */}
                <View style={styles.addressCard}>
                  <LinearGradient
                    colors={['#6366F120', '#6366F110']}
                    style={styles.addressCardGradient}
                  >
                    <View style={styles.addressCardHeader}>
                      <Image
                        source={{ uri: 'https://assets.coingecko.com/coins/images/28452/small/ARUsPeNQ_400x400.jpeg' }}
                        style={styles.chainLogo}
                      />
                      <View>
                        <Text style={styles.addressCardTitle}>Bittensor</Text>
                        <Text style={styles.addressCardSubtitle}>TAO, Substrate SS58</Text>
                      </View>
                    </View>
                    <TouchableOpacity
                      style={styles.addressRow}
                      onPress={() => copyAddress(addresses.bittensor, 'bittensor')}
                    >
                      <View style={styles.addressValueRow}>
                        <Text style={styles.addressText} numberOfLines={1} ellipsizeMode="middle">{addresses.bittensor}</Text>
                        <IconSymbol name="doc.on.doc" size={16} color={theme.colors.textMuted} />
                      </View>
                    </TouchableOpacity>
                  </LinearGradient>
                </View>

                {/* Tezos Address Card.
                    Two derivations exposed: SLIP-10 (the standard one
                    used by Temple/Kukai/Ledger) and BIP32 (the
                    interpret-as-Ed25519 variant that matches how
                    Solana/Bittensor derive here). SLIP-10 is the
                    address used for balance fetching + NFTs + send.
                    Guarded by addresses.tezos presence so users with
                    a pre-v7 cached ChainAddresses (without `tezos`)
                    don't crash before the re-derive completes. */}
                {addresses.tezos && (
                  <View style={styles.addressCard}>
                    <LinearGradient
                      colors={['#2C7DF720', '#2C7DF710']}
                      style={styles.addressCardGradient}
                    >
                      <View style={styles.addressCardHeader}>
                        <Image
                          source={{ uri: 'https://assets.coingecko.com/coins/images/976/small/Tezos-logo.png' }}
                          style={styles.chainLogo}
                        />
                        <View>
                          <Text style={styles.addressCardTitle}>Tezos</Text>
                          <Text style={styles.addressCardSubtitle}>XTZ, Ed25519 (SLIP-10)</Text>
                        </View>
                      </View>
                      <TouchableOpacity
                        style={styles.addressRow}
                        onPress={() => copyAddress(addresses.tezos.slip10, 'tezos')}
                      >
                        <View style={styles.addressValueRow}>
                          <Text style={styles.addressText} numberOfLines={1} ellipsizeMode="middle">{addresses.tezos.slip10}</Text>
                          <IconSymbol name="doc.on.doc" size={16} color={theme.colors.textMuted} />
                        </View>
                      </TouchableOpacity>
                      {/* BIP32 variant — secondary, smaller. Tap copies. */}
                      <TouchableOpacity
                        style={styles.addressRow}
                        onPress={() => copyAddress(addresses.tezos.bip32, 'tezos-bip32')}
                      >
                        <View style={styles.addressValueRow}>
                          <Text style={[styles.addressText, { opacity: 0.7 }]} numberOfLines={1} ellipsizeMode="middle">
                            BIP32: {addresses.tezos.bip32}
                          </Text>
                          <IconSymbol name="doc.on.doc" size={14} color={theme.colors.textMuted} />
                        </View>
                      </TouchableOpacity>
                    </LinearGradient>
                  </View>
                )}
                </>
                )}

                {/* Info Note */}
                <View style={styles.infoBox}>
                  <IconSymbol name="info.circle.fill" size={18} color={theme.colors.primary} />
                  <Text style={styles.infoText}>
                    These addresses are derived from your Quorum seed phrase. You can use
                    them to receive tokens on any supported chain.
                  </Text>
                </View>

                {/* Display Settings */}
                <View style={styles.settingsSection}>
                  <Text style={styles.settingsSectionTitle}>Display Settings</Text>
                  <TouchableOpacity
                    style={styles.settingsRow}
                    onPress={toggleZeroValueAssets}
                  >
                    <View style={styles.settingsRowLeft}>
                      <IconSymbol name="eye" size={18} color={theme.colors.textMuted} />
                      <Text style={styles.settingsRowText}>Show unknown/zero-value assets</Text>
                    </View>
                    <View style={[
                      styles.settingsToggle,
                      showZeroValueAssets && styles.settingsToggleActive,
                    ]}>
                      <View style={[
                        styles.settingsToggleKnob,
                        showZeroValueAssets && styles.settingsToggleKnobActive,
                      ]} />
                    </View>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        ) : (
          /* History Tab */
          <HistoryTab selectedChain={chainFilter} />
        )}
      </ScrollView>

      {/* Action Modals */}
      <SendModal
        visible={showSendModal}
        onClose={() => setShowSendModal(false)}
        preselectedAsset={selectedAsset}
      />
      <ReceiveModal
        visible={showReceiveModal}
        onClose={() => setShowReceiveModal(false)}
      />
      <SwapModal
        visible={showSwapModal}
        onClose={() => setShowSwapModal(false)}
      />
      <AssetDetailModal
        visible={showAssetDetail}
        onClose={() => {
          setShowAssetDetail(false);
          setDetailAsset(null);
        }}
        asset={detailAsset}
        onSend={(asset) => {
          setShowAssetDetail(false);
          setDetailAsset(null);
          setSelectedAsset(asset);
          setShowSendModal(true);
        }}
        onReceive={() => {
          setShowAssetDetail(false);
          setDetailAsset(null);
          setShowReceiveModal(true);
        }}
        onSwap={(asset) => {
          setShowAssetDetail(false);
          setDetailAsset(null);
          setSelectedAsset(asset);
          setShowSwapModal(true);
        }}
      />
      <NFTDetailModal
        visible={!!selectedNFT}
        onClose={() => setSelectedNFT(null)}
        nft={selectedNFT}
      />
      <ActionSheet
        visible={!!assetActionAsset}
        onClose={() => setAssetActionAsset(null)}
        title={assetActionAsset?.name}
        message={
          assetActionAsset
            ? `${formatBalance(assetActionAsset.balance, assetActionAsset.symbol === 'BTC' ? 8 : 4)} ${assetActionAsset.symbol}`
            : undefined
        }
        actions={assetActionSheetActions}
      />
    </>
  );

  // In route mode, render directly without modal wrapper. The
  // top inset is skipped when the caller has its own header above
  // (noTopInset=true) so we don't double up the safe area.
  if (isRouteMode) {
    // When a skin gives the wallet view its own background, go transparent so
    // the tab-root SurfaceBackground (color/image) shows behind the content.
    return (
      <View style={[styles.routeContainer, { paddingTop: noTopInset ? 0 : insets.top, backgroundColor: walletSurface.empty ? theme.colors.surface1 : 'transparent' }]}>
        {walletContent}
      </View>
    );
  }

  // In modal mode, wrap with BaseModal
  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      height={0.85}
      minHeight={0.45}
    >
      {walletContent}
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean, insets: EdgeInsets) =>
  StyleSheet.create({
    routeContainer: {
      flex: 1,
      paddingBottom: Skin.space(90), // Clear the blur tab bar
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: Skin.space(20),
      paddingBottom: Skin.space(16),
    },
    headerRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
    },
    title: {
      ...theme.textStyles.title3,
      color: theme.colors.textMain,
    },
    scrollContent: {
      flex: 1,
      paddingHorizontal: Skin.space(20),
    },
    tabSwitcher: {
      marginHorizontal: Skin.space(20),
      marginBottom: Skin.space(12),
    },
    evmOnlyNote: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
      backgroundColor: theme.colors.surface2,
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(8),
      borderRadius: Skin.radius(8),
      marginBottom: Skin.space(12),
    },
    evmOnlyNoteText: {
      flex: 1,
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      lineHeight: Skin.font(16),
    },
    filterContainer: {
      marginBottom: Skin.space(16),
      marginHorizontal: Skin.space(-20),
    },
    filterContent: {
      paddingHorizontal: Skin.space(20),
    },
    loadingContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: Skin.space(60),
    },
    loadingText: {
      marginTop: Skin.space(12),
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
    },
    errorContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: Skin.space(60),
    },
    errorText: {
      marginTop: Skin.space(12),
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    retryButton: {
      marginTop: Skin.space(16),
      paddingHorizontal: Skin.space(20),
      paddingVertical: Skin.space(10),
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(8),
    },
    retryButtonText: {
      fontSize: Skin.font(14),
      color: '#fff',
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    emptyContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: Skin.space(60),
    },
    emptyText: {
      marginTop: Skin.space(16),
      fontSize: Skin.font(16),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    emptySubtext: {
      marginTop: Skin.space(4),
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
    assetsSection: {
      marginBottom: Skin.space(20),
    },
    totalBalanceContainer: {
      alignItems: 'center',
      paddingVertical: Skin.space(12),
      marginBottom: Skin.space(4),
    },
    totalBalanceLabelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
      marginBottom: Skin.space(4),
    },
    totalBalanceLabel: {
      ...theme.textStyles.footnote,
      color: theme.colors.textMuted,
    },
    hideBalanceButton: {
      padding: Skin.space(2),
    },
    totalBalanceAmount: {
      ...theme.textStyles.largeTitle,
      color: theme.colors.textMain,
      letterSpacing: -0.5,
    },
    actionButtonsRow: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      marginBottom: Skin.space(16),
      paddingVertical: Skin.space(4),
    },
    actionButton: {
      alignItems: 'center',
      gap: Skin.space(6),
    },
    actionButtonIcon: {
      width: 44,
      height: 44,
      borderRadius: Skin.radius(22),
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionButtonText: {
      ...theme.textStyles.footnote,
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    assetItem: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: Skin.space(16),
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.border,
    },
    assetLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
    },
    assetIcon: {
      width: 44,
      height: 44,
      borderRadius: Skin.radius(22),
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    assetIconImage: {
      width: 44,
      height: 44,
      borderRadius: Skin.radius(22),
    },
    assetSymbolText: {
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
    },
    assetName: {
      fontSize: Skin.font(15),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    assetChainRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: Skin.space(2),
      gap: Skin.space(6),
    },
    chainDot: {
      width: 6,
      height: 6,
      borderRadius: Skin.radius(3),
    },
    assetChain: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
    },
    assetRight: {
      alignItems: 'flex-end',
    },
    assetBalance: {
      fontSize: Skin.font(15),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    assetPriceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: Skin.space(2),
      gap: Skin.space(6),
    },
    assetUsdValue: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
    },
    priceChange: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    priceChangePositive: {
      color: theme.colors.success, // Green
    },
    priceChangeNegative: {
      color: theme.colors.danger, // Red
    },
    pendingBalance: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      marginTop: Skin.space(2),
    },
    pendingPositive: {
      color: theme.colors.warning, // Amber/Orange for incoming pending
    },
    pendingNegative: {
      color: theme.colors.warning, // Amber/Orange for outgoing pending
    },
    addressesSection: {
      paddingTop: Skin.space(8),
    },
    addressCard: {
      marginBottom: Skin.space(16),
      borderRadius: Skin.radius(16),
      overflow: 'hidden',
    },
    addressCardGradient: {
      padding: Skin.space(16),
    },
    addressCardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
      marginBottom: Skin.space(12),
    },
    chainIconContainer: {
      width: 40,
      height: 40,
      borderRadius: Skin.radius(20),
      alignItems: 'center',
      justifyContent: 'center',
    },
    chainLogo: {
      width: 40,
      height: 40,
      borderRadius: Skin.radius(20),
    },
    chainIconText: {
      fontSize: Skin.font(20),
      color: '#fff',
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
    },
    addressCardTitle: {
      fontSize: Skin.font(16),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
    },
    addressCardSubtitle: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginTop: Skin.space(2),
    },
    addressRow: {
      backgroundColor: theme.colors.bgButtonSubtle,
      paddingHorizontal: Skin.space(14),
      paddingVertical: Skin.space(10),
      borderRadius: Skin.radius(10),
    },
    addressRowMiddle: {
      marginTop: Skin.space(8),
    },
    addressRowLast: {
      marginTop: Skin.space(8),
    },
    btcToggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Skin.space(4),
      marginTop: Skin.space(8),
      paddingVertical: Skin.space(4),
    },
    btcToggleText: {
      ...theme.textStyles.footnote,
      color: theme.colors.textMuted,
    },
    addressRowActive: {
      borderWidth: Skin.border(2),
      borderColor: theme.colors.primary,
    },
    activeWalletBadge: {
      backgroundColor: theme.colors.primary,
      paddingHorizontal: Skin.space(8),
      paddingVertical: Skin.space(2),
      borderRadius: Skin.radius(4),
    },
    activeWalletBadgeText: {
      fontSize: Skin.font(10),
      color: '#fff',
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
    },
    walletHint: {
      fontSize: Skin.font(11),
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: Skin.space(10),
      fontStyle: 'italic',
    },
    addressLabelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
      marginBottom: Skin.space(4),
    },
    addressLabel: {
      fontSize: Skin.font(11),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    addressRecommended: {
      fontSize: Skin.font(10),
      color: theme.colors.success || '#4CAF50',
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      backgroundColor: (theme.colors.success || '#4CAF50') + '20',
      paddingHorizontal: Skin.space(6),
      paddingVertical: Skin.space(2),
      borderRadius: Skin.radius(4),
    },
    addressValueRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: Skin.space(8),
    },
    addressText: {
      flex: 1,
      fontSize: Skin.font(12),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    infoBox: {
      flexDirection: 'row',
      backgroundColor: theme.colors.primary + '15',
      borderRadius: Skin.radius(12),
      padding: Skin.space(14),
      gap: Skin.space(10),
      marginTop: Skin.space(8),
      marginBottom: Skin.space(24),
    },
    infoText: {
      flex: 1,
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      lineHeight: Skin.font(18),
    },
    // Collectibles/NFT styles
    collectiblesSection: {
      paddingTop: Skin.space(8),
      paddingBottom: Skin.space(20),
    },
    nftGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: Skin.space(12),
    },
    nftCard: {
      width: (Dimensions.get('window').width - 52) / 2, // 2 columns with gap
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      overflow: 'hidden',
    },
    nftImageContainer: {
      position: 'relative',
      aspectRatio: 1,
    },
    nftImage: {
      width: '100%',
      height: '100%',
      backgroundColor: theme.colors.surface1,
    },
    nftPlaceholder: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    nftChainBadge: {
      position: 'absolute',
      top: 8,
      right: 8,
      paddingHorizontal: Skin.space(6),
      paddingVertical: Skin.space(3),
      borderRadius: Skin.radius(6),
    },
    nftChainBadgeText: {
      fontSize: Skin.font(10),
      color: '#fff',
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      textTransform: 'uppercase',
    },
    nftInfo: {
      padding: Skin.space(10),
    },
    nftName: {
      fontSize: Skin.font(13),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    nftCollection: {
      fontSize: Skin.font(11),
      color: theme.colors.textMuted,
      marginTop: Skin.space(2),
    },
    // Show More Button styles
    showMoreButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Skin.space(8),
      paddingVertical: Skin.space(14),
      marginTop: Skin.space(8),
      marginBottom: Skin.space(16),
      borderRadius: Skin.radius(12),
      backgroundColor: theme.colors.surface2,
    },
    showMoreText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    // Settings section styles
    settingsSection: {
      marginTop: Skin.space(16),
      marginBottom: Skin.space(24),
    },
    settingsSectionTitle: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      marginBottom: Skin.space(12),
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    settingsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: Skin.space(12),
      paddingHorizontal: Skin.space(14),
      backgroundColor: theme.colors.bgButtonSubtle,
      borderRadius: Skin.radius(12),
    },
    settingsRowLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(10),
    },
    settingsRowText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    settingsToggle: {
      width: 46,
      height: 26,
      borderRadius: Skin.radius(13),
      backgroundColor: theme.colors.surface1,
      padding: Skin.space(2),
      justifyContent: 'center',
    },
    settingsToggleActive: {
      backgroundColor: theme.colors.primary,
    },
    settingsToggleKnob: {
      width: 22,
      height: 22,
      borderRadius: Skin.radius(11),
      backgroundColor: '#fff',
    },
    settingsToggleKnobActive: {
      alignSelf: 'flex-end',
    },
  });
