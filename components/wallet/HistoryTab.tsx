/**
 * HistoryTab - Display transaction history for the wallet
 */

import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { useWalletSelection } from '@/hooks/useWalletSelection';
import { useWalletAddresses } from '@/hooks/useWallet';
import {
  getTransactionHistory,
  fetchOnChainHistory,
  fetchNonEvmHistory,
  getSupportedChainIds,
  StoredTransaction,
} from '@/services/wallet/transactionHistoryService';
import { textStyles, useTheme, type AppTheme } from '@/theme';
import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

interface HistoryTabProps {
  selectedChain: string;
}

export default function HistoryTab({ selectedChain }: HistoryTabProps) {
  const { theme, isDark } = useTheme();
  const { activeWallet } = useWalletSelection();
  const { data: builtinAddresses } = useWalletAddresses();
  const [onChainTxs, setOnChainTxs] = useState<StoredTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);

  const styles = createStyles(theme, isDark);

  // Get local transactions for current wallet
  const localTransactions = React.useMemo(() => {
    if (!activeWallet?.address) return [];

    const chainId = selectedChain === 'all' ? undefined : getChainIdFromName(selectedChain);

    return getTransactionHistory(activeWallet.address, {
      chainId,
      limit: 100,
    });
  }, [activeWallet?.address, selectedChain]);

  // Fetch on-chain history (EVM and non-EVM)
  useEffect(() => {
    let cancelled = false;

    const fetchHistory = async () => {
      if (!activeWallet?.address) return;

      setIsLoading(true);

      try {
        const chainId = selectedChain === 'all' ? undefined : getChainIdFromName(selectedChain);
        const supportedChains = getSupportedChainIds();
        const allTxs: StoredTransaction[] = [];

        // Check if we should fetch EVM chains
        const isNonEvmChain = chainId !== undefined && chainId < 0;
        const shouldFetchEvm = chainId === undefined || chainId > 0;

        // Fetch EVM chains
        if (shouldFetchEvm) {
          const chainsToFetch = chainId !== undefined
            ? (supportedChains.includes(chainId) ? [chainId] : [])
            : supportedChains;

          const results = await Promise.all(
            chainsToFetch.map(cid =>
              fetchOnChainHistory(activeWallet.address, cid, { maxCount: 50 })
            )
          );

          if (cancelled) return;
          allTxs.push(...results.flatMap(r => r.transactions));
        }

        // Fetch non-EVM chains
        const shouldFetchNonEvm = chainId === undefined || isNonEvmChain;
        if (shouldFetchNonEvm && builtinAddresses) {
          // Build addresses object for non-EVM chains
          const nonEvmAddresses: {
            bitcoin?: string[];
            solana?: string;
            kaspa?: string;
            bittensor?: string;
          } = {};

          // Only fetch specific chain if selected, otherwise fetch all
          if (chainId === undefined || chainId === -1) {
            nonEvmAddresses.bitcoin = [
              builtinAddresses.bitcoin?.legacy,
              builtinAddresses.bitcoin?.segwit,
              builtinAddresses.bitcoin?.nativeSegwit,
            ].filter(Boolean) as string[];
          }
          if (chainId === undefined || chainId === -2) {
            nonEvmAddresses.solana = builtinAddresses.solana;
          }
          if (chainId === undefined || chainId === -3) {
            nonEvmAddresses.kaspa = builtinAddresses.kaspa;
          }
          if (chainId === undefined || chainId === -4) {
            nonEvmAddresses.bittensor = builtinAddresses.bittensor;
          }

          const nonEvmTxs = await fetchNonEvmHistory(nonEvmAddresses, { limit: 50 });
          if (cancelled) return;
          allTxs.push(...nonEvmTxs);
        }

        // Sort by timestamp descending
        allTxs.sort((a, b) => b.timestamp - a.timestamp);

        setOnChainTxs(allTxs);
        setHasLoaded(true);
      } catch {
        // Transaction history fetch failed — show empty state
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    fetchHistory();

    return () => {
      cancelled = true;
    };
  }, [activeWallet?.address, selectedChain, builtinAddresses]);

  // Merge and deduplicate local and on-chain transactions
  const transactions = React.useMemo(() => {
    const txMap = new Map<string, StoredTransaction>();

    // Add on-chain transactions first
    for (const tx of onChainTxs) {
      txMap.set(tx.id, tx);
    }

    // Add/override with local transactions (may have more recent status)
    for (const tx of localTransactions) {
      txMap.set(tx.id, tx);
    }

    // Sort by timestamp descending
    const merged = Array.from(txMap.values());
    merged.sort((a, b) => b.timestamp - a.timestamp);

    return merged;
  }, [localTransactions, onChainTxs]);

  const handleOpenExplorer = useCallback(async (url: string) => {
    await WebBrowser.openBrowserAsync(url);
  }, []);

  const formatTimestamp = (timestamp: number): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    });
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'success':
        return theme.colors.success || '#22C55E';
      case 'failed':
        return theme.colors.danger || '#EF4444';
      case 'pending':
        return theme.colors.warning || '#F59E0B';
      default:
        return theme.colors.textMuted;
    }
  };

  const getTypeIcon = (type: string): string => {
    switch (type) {
      case 'send':
        return 'arrow.up.right';
      case 'receive':
        return 'arrow.down.left';
      case 'swap':
        return 'arrow.triangle.2.circlepath';
      case 'approve':
        return 'checkmark.shield';
      default:
        return 'doc.text';
    }
  };

  const renderTransaction = ({ item }: { item: StoredTransaction }) => (
    <TouchableOpacity
      style={styles.transactionRow}
      onPress={() => handleOpenExplorer(item.explorerUrl)}
      activeOpacity={0.7}
    >
      <View style={styles.transactionIcon}>
        <IconSymbol
          name={getTypeIcon(item.type) as IconSymbolName}
          size={18}
          color={getStatusColor(item.status)}
        />
      </View>

      <View style={styles.transactionInfo}>
        <View style={styles.transactionHeader}>
          <Text style={styles.transactionType}>
            {item.type.charAt(0).toUpperCase() + item.type.slice(1)}
          </Text>
          <Text style={[styles.transactionStatus, { color: getStatusColor(item.status) }]}>
            {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
          </Text>
        </View>

        <View style={styles.transactionDetails}>
          <Text style={styles.transactionAmount} numberOfLines={1}>
            {item.type === 'swap' ? item.symbol : `${item.amount} ${item.symbol}`}
          </Text>
          <Text style={styles.transactionChain}>
            {getChainNameFromId(item.chainId)}
          </Text>
        </View>

        <View style={styles.transactionFooter}>
          <Text style={styles.transactionTo} numberOfLines={1}>
            To: {item.to.slice(0, 8)}...{item.to.slice(-6)}
          </Text>
          <Text style={styles.transactionTime}>
            {formatTimestamp(item.timestamp)}
          </Text>
        </View>
      </View>

      <IconSymbol name="chevron.right" size={14} color={theme.colors.textMuted} />
    </TouchableOpacity>
  );

  const renderEmpty = () => (
    <View style={styles.emptyState}>
      {isLoading ? (
        <>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.emptyTitle}>Loading history...</Text>
          <Text style={styles.emptySubtitle}>
            Fetching your transaction history
          </Text>
        </>
      ) : (
        <>
          <IconSymbol name="clock.arrow.circlepath" size={48} color={theme.colors.textMuted} />
          <Text style={styles.emptyTitle}>No transactions yet</Text>
          <Text style={styles.emptySubtitle}>
            Your transaction history will appear here
          </Text>
        </>
      )}
    </View>
  );

  return (
    <View style={styles.container}>
      {isLoading && transactions.length > 0 && (
        <View style={styles.loadingBar}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <Text style={styles.loadingText}>Updating...</Text>
        </View>
      )}
      {transactions.length === 0 ? (
        renderEmpty()
      ) : (
        transactions.map((item) => (
          <TouchableOpacity
            key={item.id}
            style={styles.transactionRow}
            onPress={() => handleOpenExplorer(item.explorerUrl)}
            activeOpacity={0.7}
          >
            <View style={styles.transactionIcon}>
              <IconSymbol
                name={getTypeIcon(item.type) as IconSymbolName}
                size={18}
                color={getStatusColor(item.status)}
              />
            </View>

            <View style={styles.transactionInfo}>
              <View style={styles.transactionHeader}>
                <Text style={styles.transactionType}>
                  {item.type.charAt(0).toUpperCase() + item.type.slice(1)}
                </Text>
                <Text style={[styles.transactionStatus, { color: getStatusColor(item.status) }]}>
                  {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                </Text>
              </View>

              <View style={styles.transactionDetails}>
                <Text style={styles.transactionAmount} numberOfLines={1}>
                  {item.type === 'swap' ? item.symbol : `${item.amount} ${item.symbol}`}
                </Text>
                <Text style={styles.transactionChain}>
                  {getChainNameFromId(item.chainId)}
                </Text>
              </View>

              <View style={styles.transactionFooter}>
                <Text style={styles.transactionTo} numberOfLines={1}>
                  To: {item.to.slice(0, 8)}...{item.to.slice(-6)}
                </Text>
                <Text style={styles.transactionTime}>
                  {formatTimestamp(item.timestamp)}
                </Text>
              </View>
            </View>

            <IconSymbol name="chevron.right" size={14} color={theme.colors.textMuted} />
          </TouchableOpacity>
        ))
      )}
    </View>
  );
}

// Chain ID to name mapping
// Non-EVM chains use negative IDs as placeholders
const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  8453: 'Base',
  42161: 'Arbitrum',
  10: 'Optimism',
  137: 'Polygon',
  56: 'BSC',
  43114: 'Avalanche',
  59144: 'Linea',
  534352: 'Scroll',
  81457: 'Blast',
  324: 'zkSync',
  100: 'Gnosis',
  42220: 'Celo',
  7777777: 'Zora',
  [-1]: 'Bitcoin',
  [-2]: 'Solana',
  [-3]: 'Kaspa',
  [-4]: 'Bittensor',
};

function getChainNameFromId(chainId: number): string {
  return CHAIN_NAMES[chainId] || `Chain ${chainId}`;
}

// Helper to convert chain name back to chain ID
function getChainIdFromName(chainName: string): number | undefined {
  const chainMap: Record<string, number> = {
    ethereum: 1,
    base: 8453,
    arbitrum: 42161,
    optimism: 10,
    polygon: 137,
    bsc: 56,
    avalanche: 43114,
    linea: 59144,
    scroll: 534352,
    blast: 81457,
    zksync: 324,
    gnosis: 100,
    celo: 42220,
    zora: 7777777,
    bitcoin: -1,
    solana: -2,
    kaspa: -3,
    bittensor: -4,
  };
  return chainMap[chainName.toLowerCase()];
}

const createStyles = (theme: AppTheme, isDark: boolean) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    loadingBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: Skin.space(8),
      gap: Skin.space(8),
      marginBottom: Skin.space(8),
    },
    loadingText: {
      fontSize: Skin.font(13),
      color: theme.colors.textSubtle,
    },
    emptyContainer: {
      flex: 1,
    },
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: Skin.space(60),
    },
    emptyTitle: {
      fontSize: Skin.font(17),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
      marginTop: Skin.space(16),
    },
    emptySubtitle: {
      ...theme.textStyles.subheadline,
      color: theme.colors.textSubtle,
      marginTop: Skin.space(4),
      textAlign: 'center',
    },
    transactionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(14),
      marginBottom: Skin.space(10),
      gap: Skin.space(12),
    },
    transactionIcon: {
      width: 40,
      height: 40,
      borderRadius: Skin.radius(20),
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
    },
    transactionInfo: {
      flex: 1,
      gap: Skin.space(4),
    },
    transactionHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    transactionType: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    transactionStatus: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    transactionDetails: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    transactionAmount: {
      fontSize: Skin.font(13),
      color: theme.colors.textMain,
      flex: 1,
    },
    transactionChain: {
      fontSize: Skin.font(11),
      color: theme.colors.textSubtle,
      backgroundColor: theme.colors.surface3,
      paddingHorizontal: Skin.space(6),
      paddingVertical: Skin.space(2),
      borderRadius: Skin.radius(4),
      overflow: 'hidden',
    },
    transactionFooter: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    transactionTo: {
      fontSize: Skin.font(11),
      color: theme.colors.textSubtle,
      flex: 1,
    },
    transactionTime: {
      fontSize: Skin.font(11),
      color: theme.colors.textSubtle,
    },
  });
