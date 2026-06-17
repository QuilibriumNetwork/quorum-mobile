/**
 * SwapModal - Swap tokens using 0x API (same-chain) and Relay Protocol (cross-chain)
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useToast } from '@/context/ToastContext';
import { truncateAddress } from '@/utils/formatAddress';
import { useWallet, useWalletKeys, aggregateAssets, AggregatedAsset, useEvmBalancesForAddress } from '@/hooks/useWallet';
import { useWalletSelection } from '@/hooks/useWalletSelection';
import { useWarpcastWallet } from '@/hooks/useWarpcastWallet';
import { useBiometricAuth } from '@/hooks/useBiometricAuth';
import { getChainName, formatBalance } from '@/services/wallet/balanceService';
import WalletSelector from './WalletSelector';
import HoldToConfirm from './HoldToConfirm';
import { createPublicClient, http, erc20Abi } from 'viem';
import { base, mainnet, arbitrum, optimism, polygon } from 'viem/chains';
import {
  getChainId,
  getSwapPrice,
  getSwapQuote,
  getGaslessQuote,
  submitGaslessSwap,
  getGaslessSwapStatus,
  isSwapSupported,
  isGaslessSupported,
  NATIVE_TOKEN_ADDRESS,
  COMMON_TOKENS,
  formatTokenAmount,
  parseTokenAmount,
  searchTokens,
  getTokenVerificationStatus,
  SwapPrice,
  GaslessQuote,
  SwapQuote,
  CHAIN_IDS,
  SearchableToken,
  TokenVerificationStatus,
} from '@/services/wallet/swapService';
import {
  sendSwapTransaction,
  getExplorerUrl,
  checkAllowance,
  approveToken,
  waitForTransaction,
} from '@/services/wallet/transactionService';
import { recordTransaction, updateTransactionStatus } from '@/services/wallet/transactionHistoryService';
import {
  getRelayQuote,
  getRelayTokenAddress,
  getRelayTokens,
  RelayQuote,
  RelayToken,
} from '@/services/wallet/relayService';
import {
  getJupiterQuote,
  getJupiterSwapTransaction,
  formatJupiterAmount,
  parseJupiterAmount,
  searchJupiterTokens,
  getJupiterTokenInfo,
  SOL_MINT,
  COMMON_SPL_TOKENS,
  JupiterQuote,
} from '@/services/wallet/jupiterService';
import {
  getLifiQuote,
  getLifiTokens,
  searchLifiTokens,
  formatLifiAmount,
  parseLifiAmount,
  getLifiChainId,
  isLifiSupported,
  LIFI_CHAIN_IDS,
  LIFI_NATIVE_ADDRESS,
  LifiQuote,
} from '@/services/wallet/lifiService';
import { useTheme, type AppTheme } from '@/theme';
import { getErrorMessage } from '@/utils/error';
import { loadPref, savePref } from '@/services/wallet/walletPrefs';
import React from 'react';
import { ActivityIndicator, Alert, InteractionManager, Keyboard, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';
import { SegmentedPills, type SegmentedPillItem } from '@/components/ui/SegmentedPills';

interface SwapModalProps {
  visible: boolean;
  onClose: () => void;
  /** Initial buy token address (contract address for ERC20) */
  initialBuyToken?: string;
}

// Threshold for requiring biometric auth (in USD)
const BIOMETRIC_THRESHOLD = 100;

export default function SwapModal({ visible, onClose, initialBuyToken }: SwapModalProps) {
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

  const [sellAsset, setSellAsset] = React.useState<AggregatedAsset | null>(null);
  const [buyAsset, setBuyAsset] = React.useState<AggregatedAsset | null>(null);
  const [destinationChain, setDestinationChain] = React.useState<string | null>(null);
  const [sellAmount, setSellAmount] = React.useState('');
  const [buyAmount, setBuyAmount] = React.useState('');
  const [showSellPicker, setShowSellPicker] = React.useState(false);
  const [showBuyPicker, setShowBuyPicker] = React.useState(false);
  const [sellSearch, setSellSearch] = React.useState('');
  const [buySearch, setBuySearch] = React.useState('');
  const [isLoadingQuote, setIsLoadingQuote] = React.useState(false);
  const [isSwapping, setIsSwapping] = React.useState(false);
  const [quote, setQuote] = React.useState<SwapPrice | null>(null);
  const [gaslessQuote, setGaslessQuote] = React.useState<GaslessQuote | null>(null);
  const [relayQuote, setRelayQuote] = React.useState<RelayQuote | null>(null);
  const [jupiterQuote, setJupiterQuote] = React.useState<JupiterQuote | null>(null);
  const [lifiQuote, setLifiQuote] = React.useState<LifiQuote | null>(null);
  const [isGaslessAvailable, setIsGaslessAvailable] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [searchedTokens, setSearchedTokens] = React.useState<RelayToken[]>([]);
  const [showManualEntry, setShowManualEntry] = React.useState(false);
  const [manualContractAddress, setManualContractAddress] = React.useState('');
  const [manualChain, setManualChain] = React.useState<string | null>(null);
  const [manualSymbol, setManualSymbol] = React.useState('');
  const [manualDecimals, setManualDecimals] = React.useState('18');
  const [isSearchingTokens, setIsSearchingTokens] = React.useState(false);
  const [isPickerLoading, setIsPickerLoading] = React.useState(false);

  // Helper to open pickers with deferred rendering to prevent UI freeze
  const openSellPicker = React.useCallback(() => {
    setIsPickerLoading(true);
    setShowBuyPicker(false);
    // Use requestAnimationFrame to let the loading state render first
    requestAnimationFrame(() => {
      InteractionManager.runAfterInteractions(() => {
        setShowSellPicker(true);
        setIsPickerLoading(false);
      });
    });
  }, []);

  const openBuyPicker = React.useCallback(() => {
    setIsPickerLoading(true);
    setShowSellPicker(false);
    requestAnimationFrame(() => {
      InteractionManager.runAfterInteractions(() => {
        setShowBuyPicker(true);
        setIsPickerLoading(false);
      });
    });
  }, []);

  // Helper to refresh balances based on active wallet type
  const refreshBalances = () => {
    if (activeType === 'warpcast') {
      refetchWarpcastBalances();
    } else {
      refetchBalances();
    }
  };

  // Determine if this is a cross-chain swap
  const isCrossChain = React.useMemo(() => {
    if (!sellAsset || !destinationChain) return false;
    return sellAsset.chain !== destinationChain;
  }, [sellAsset, destinationChain]);

  // Check if sell amount exceeds available balance
  const insufficientBalance = React.useMemo(() => {
    if (!sellAsset || !sellAmount) return false;
    const amount = parseFloat(sellAmount);
    const balance = parseFloat(sellAsset.balance);
    return !isNaN(amount) && !isNaN(balance) && amount > balance;
  }, [sellAsset, sellAmount]);

  const styles = createStyles(theme, isDark);

  const allAssets = React.useMemo(() => aggregateAssets(activeBalances), [activeBalances]);

  // Filter to only show swappable assets (EVM chains with 0x/Li.Fi support + Solana via Jupiter)
  const swappableAssets = React.useMemo(() => {
    return allAssets.filter(asset => {
      // 0x supported EVM chains
      if (isSwapSupported(asset.chain)) return true;
      // Solana via Jupiter
      if (asset.chain === 'solana') return true;
      // Hyperliquid and other Li.Fi supported chains
      if (isLifiSupported(asset.chain)) return true;
      return false;
    });
  }, [allAssets]);

  // Extended asset type with verification info
  type VerifiedAsset = AggregatedAsset & {
    verified?: boolean;
    verificationStatus?: TokenVerificationStatus;
  };

  // Helper to check if an asset matches the sell asset
  const isSameSellAsset = React.useCallback((chain: string, contractAddress?: string, isNative?: boolean) => {
    if (!sellAsset) return false;
    if (chain !== sellAsset.chain) return false;

    // Compare by contract address if available
    if (sellAsset.contractAddress && contractAddress) {
      return sellAsset.contractAddress.toLowerCase() === contractAddress.toLowerCase();
    }

    // Both are native tokens on the same chain
    if (sellAsset.isNative && isNative) return true;

    return false;
  }, [sellAsset]);

  // Helper to check if a buy chain is compatible with the sell chain
  const isChainCompatible = React.useCallback((sellChain: string, buyChain: string): boolean => {
    // Solana can only swap to Solana (no cross-chain support yet)
    if (sellChain === 'solana') {
      return buyChain === 'solana';
    }
    // EVM cannot swap to Solana (no cross-chain support yet)
    if (buyChain === 'solana') {
      return false;
    }
    // All other combinations are supported (EVM↔EVM, Hyperliquid↔EVM)
    return true;
  }, []);

  // Get assets for buy options - filtered by compatible chains
  const buyableAssets = React.useMemo((): VerifiedAsset[] => {
    if (!sellAsset) return [];

    const assets: VerifiedAsset[] = [];

    // Add user's assets from compatible chains (user's own tokens are trusted)
    for (const asset of swappableAssets) {
      // Exclude the sell asset (same token on same chain)
      if (isSameSellAsset(asset.chain, asset.contractAddress, asset.isNative)) {
        continue;
      }
      // Only include assets on compatible chains
      if (!isChainCompatible(sellAsset.chain, asset.chain)) {
        continue;
      }
      // User's own tokens are considered verified (they already hold them)
      assets.push({
        ...asset,
        verified: true,
        verificationStatus: 'verified' as TokenVerificationStatus,
      });
    }

    // Add common EVM tokens for compatible chains
    // COMMON_TOKENS are manually curated and verified
    for (const chainName of Object.keys(CHAIN_IDS)) {
      // Skip if this chain isn't compatible with the sell chain
      if (!isChainCompatible(sellAsset.chain, chainName)) continue;

      const chainTokens = COMMON_TOKENS[chainName] || {};

      for (const [, tokenInfo] of Object.entries(chainTokens)) {
        const tokenContractAddress = tokenInfo.address === NATIVE_TOKEN_ADDRESS ? undefined : tokenInfo.address;
        const tokenIsNative = tokenInfo.address === NATIVE_TOKEN_ADDRESS;

        // Skip if it's the same as sell asset
        if (isSameSellAsset(chainName, tokenContractAddress, tokenIsNative)) continue;

        // Skip if user already has this asset on this chain
        const alreadyHas = assets.some(a =>
          a.chain === chainName && (
            a.symbol === tokenInfo.symbol ||
            (tokenInfo.address !== NATIVE_TOKEN_ADDRESS && a.contractAddress?.toLowerCase() === tokenInfo.address.toLowerCase())
          )
        );

        if (!alreadyHas) {
          assets.push({
            symbol: tokenInfo.symbol,
            name: tokenInfo.name || tokenInfo.symbol,
            balance: '0',
            chain: chainName,
            chainName: getChainName(chainName),
            contractAddress: tokenContractAddress,
            isNative: tokenIsNative,
            decimals: tokenInfo.decimals,
            verified: true, // COMMON_TOKENS are curated
            verificationStatus: 'verified' as TokenVerificationStatus,
          });
        }
      }
    }

    // Add common Hyperliquid tokens (addresses from Li.Fi API) - only if compatible
    if (isChainCompatible(sellAsset.chain, 'hyperevm')) {
      const hyperliquidTokens = [
        { symbol: 'HYPE', name: 'Hyperliquid', address: LIFI_NATIVE_ADDRESS, decimals: 18, isNative: true },
        { symbol: 'USDC', name: 'USD Coin', address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', decimals: 6, isNative: false },
        { symbol: 'USDT', name: 'Tether USD', address: '0xbF2D3b1a37D54ce86d0e1455884dA875a97C87a8', decimals: 6, isNative: false },
        { symbol: 'ETH', name: 'Ethereum', address: '0x1fbcCdc677c10671eE50b46C61F0f7d135112450', decimals: 18, isNative: false },
        { symbol: 'WBTC', name: 'Wrapped Bitcoin', address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', decimals: 8, isNative: false },
      ];

      for (const tokenInfo of hyperliquidTokens) {
        const tokenContractAddress = tokenInfo.isNative ? undefined : tokenInfo.address;
        if (isSameSellAsset('hyperevm', tokenContractAddress, tokenInfo.isNative)) continue;

        const alreadyHas = assets.some(a =>
          a.chain === 'hyperevm' && (a.symbol === tokenInfo.symbol || a.contractAddress?.toLowerCase() === tokenInfo.address.toLowerCase())
        );

        if (!alreadyHas) {
          assets.push({
            symbol: tokenInfo.symbol,
            name: tokenInfo.name,
            balance: '0',
            chain: 'hyperevm',
            chainName: 'Hyperliquid',
            contractAddress: tokenContractAddress,
            isNative: tokenInfo.isNative,
            decimals: tokenInfo.decimals,
            verified: true,
            verificationStatus: 'verified' as TokenVerificationStatus,
          });
        }
      }
    }

    // Add common Solana tokens (from Jupiter's curated list) - only if sell is also Solana
    if (isChainCompatible(sellAsset.chain, 'solana')) {
      for (const [symbol, tokenInfo] of Object.entries(COMMON_SPL_TOKENS)) {
        const tokenContractAddress = tokenInfo.mint === SOL_MINT ? undefined : tokenInfo.mint;
        const tokenIsNative = tokenInfo.mint === SOL_MINT;

        if (isSameSellAsset('solana', tokenContractAddress, tokenIsNative)) continue;

        const alreadyHas = assets.some(a =>
          a.chain === 'solana' && (a.symbol === symbol || a.contractAddress === tokenInfo.mint)
        );

        if (!alreadyHas) {
          assets.push({
            symbol: tokenInfo.symbol,
            name: tokenInfo.name,
            balance: '0',
            chain: 'solana',
            chainName: 'Solana',
            contractAddress: tokenContractAddress,
            isNative: tokenIsNative,
            decimals: tokenInfo.decimals,
            verified: true,
            verificationStatus: 'verified' as TokenVerificationStatus,
          });
        }
      }
    }

    return assets;
  }, [swappableAssets, sellAsset, isSameSellAsset, isChainCompatible]);

  // Filter assets by search
  const filteredSellAssets = React.useMemo(() => {
    if (!sellSearch.trim()) return swappableAssets;
    const search = sellSearch.toLowerCase();
    return swappableAssets.filter(asset =>
      asset.symbol.toLowerCase().includes(search) ||
      asset.name.toLowerCase().includes(search) ||
      asset.chain.toLowerCase().includes(search)
    );
  }, [swappableAssets, sellSearch]);

  const filteredBuyAssets = React.useMemo((): VerifiedAsset[] => {
    // If no search, return the pre-defined buyable assets
    if (!buySearch.trim()) return buyableAssets;

    // Start with local filter of buyable assets (search symbol, name, and chain)
    const search = buySearch.toLowerCase();
    const localFiltered = buyableAssets.filter(asset =>
      asset.symbol.toLowerCase().includes(search) ||
      asset.name.toLowerCase().includes(search) ||
      asset.chain.toLowerCase().includes(search) ||
      asset.chainName.toLowerCase().includes(search)
    );

    // Convert API search results to VerifiedAsset format and merge
    const apiAssets: VerifiedAsset[] = searchedTokens
      .filter(token => {
        const chainName = (token as any).chainName || '';
        const tokenAddress = token.address === '0x0000000000000000000000000000000000000000' ? undefined : token.address;
        const tokenIsNative = token.address === '0x0000000000000000000000000000000000000000';

        // Filter out the sell asset
        if (isSameSellAsset(chainName, tokenAddress, tokenIsNative)) {
          return false;
        }

        // Filter out tokens already in local results
        const alreadyHas = localFiltered.some(a =>
          a.chain === chainName &&
          (a.contractAddress?.toLowerCase() === token.address.toLowerCase() ||
           (a.isNative && tokenIsNative))
        );
        return !alreadyHas;
      })
      .map(token => {
        const chainName = (token as any).chainName || '';
        const chainId = getChainId(chainName);
        const verificationStatus = chainId
          ? getTokenVerificationStatus(chainId, token.address, token.symbol)
          : ('unverified' as TokenVerificationStatus);

        return {
          symbol: token.symbol,
          name: token.name,
          balance: '0',
          chain: chainName,
          chainName: getChainName(chainName),
          contractAddress: token.address === '0x0000000000000000000000000000000000000000' ? undefined : token.address,
          isNative: token.address === '0x0000000000000000000000000000000000000000',
          decimals: token.decimals,
          verified: (token as any).verified || verificationStatus === 'verified',
          verificationStatus: (token as any).verificationStatus || verificationStatus,
        };
      });

    return [...localFiltered, ...apiAssets];
  }, [buyableAssets, buySearch, searchedTokens, isSameSellAsset]);

  // Reset state when modal closes
  React.useEffect(() => {
    if (!visible) {
      setSellAsset(null);
      setBuyAsset(null);
      setDestinationChain(null);
      setSellAmount('');
      setBuyAmount('');
      setSellSearch('');
      setBuySearch('');
      setQuote(null);
      setGaslessQuote(null);
      setRelayQuote(null);
      setJupiterQuote(null);
      setLifiQuote(null);
      setIsGaslessAvailable(false);
      setError(null);
      setSearchedTokens([]);
      setShowManualEntry(false);
      setManualContractAddress('');
      setManualChain(null);
      setManualSymbol('');
      setManualDecimals('18');
    }
  }, [visible]);

  // Persist the (sellAsset, buyAsset) pair whenever both change. On next open
  // with no explicit initial token, we restore this pair so repeat swaps
  // don't need a manual re-selection.
  type TokenKey = { chain: string; symbol: string; contractAddress?: string };
  type SwapPair = { from: TokenKey; to: TokenKey };
  const LAST_PAIR_KEY = 'recent:lastSwapPair';

  React.useEffect(() => {
    if (!sellAsset || !buyAsset) return;
    const pair: SwapPair = {
      from: {
        chain: sellAsset.chain,
        symbol: sellAsset.symbol,
        contractAddress: sellAsset.contractAddress,
      },
      to: {
        chain: buyAsset.chain,
        symbol: buyAsset.symbol,
        contractAddress: buyAsset.contractAddress,
      },
    };
    savePref(LAST_PAIR_KEY, pair);
  }, [sellAsset, buyAsset]);

  // Restore last pair on open when no explicit initial tokens are provided.
  React.useEffect(() => {
    if (!visible) return;
    if (sellAsset || buyAsset) return;
    if (initialBuyToken) return;
    const last = loadPref<SwapPair | null>(LAST_PAIR_KEY, null);
    if (!last) return;

    const matchKey = (a: AggregatedAsset, k: TokenKey) =>
      a.chain === k.chain &&
      a.symbol.toUpperCase() === k.symbol.toUpperCase() &&
      (a.contractAddress ?? '').toLowerCase() ===
        (k.contractAddress ?? '').toLowerCase();

    const sell = allAssets.find((a) => matchKey(a, last.from));
    if (sell) setSellAsset(sell);
    const buy = allAssets.find((a) => matchKey(a, last.to));
    if (buy) setBuyAsset(buy);
    // Note: buyAsset may legitimately not be in allAssets (cross-chain token
    // the user doesn't hold). We skip restoring in that case; they'll see
    // the sell side pre-filled and pick a new buy side.
  }, [visible, allAssets, initialBuyToken, sellAsset, buyAsset]);

  // Set initial buy token when provided (e.g., from mini app swapToken call)
  React.useEffect(() => {
    if (visible && initialBuyToken && !buyAsset) {
      const findInitialToken = async () => {
        try {
          // Parse the JSON format: { address, chainId }
          let tokenAddress: string;
          let chainId: number;
          try {
            const parsed = JSON.parse(initialBuyToken);
            tokenAddress = parsed.address;
            chainId = parsed.chainId;
          } catch {
            // Fallback for plain address
            tokenAddress = initialBuyToken;
            chainId = 8453;
          }
          // First try to find in token lists
          const results = await searchTokens({
            search: tokenAddress,
            chainIds: [chainId],
            limit: 5,
          });
          // Map chain ID to chain name
          const chainIdToName: Record<number, string> = {
            1: 'ethereum',
            8453: 'base',
            42161: 'arbitrum',
            10: 'optimism',
            137: 'polygon',
          };
          const chainIdToDisplayName: Record<number, string> = {
            1: 'Ethereum',
            8453: 'Base',
            42161: 'Arbitrum',
            10: 'Optimism',
            137: 'Polygon',
          };
          const chainName = chainIdToName[chainId] || 'base';
          const chainDisplayName = chainIdToDisplayName[chainId] || 'Base';

          if (results.length > 0) {
            const exactMatch = results.find(
              t => t.address?.toLowerCase() === tokenAddress.toLowerCase()
            );
            const token = exactMatch || results[0];
            setBuyAsset({
              symbol: token.symbol,
              name: token.name,
              balance: '0',
              chain: chainName,
              chainName: chainDisplayName,
              contractAddress: token.address,
              isNative: !token.address,
              decimals: token.decimals,
            });
          } else {
            // Not found in token lists - fetch metadata from contract
            const viemChains = {
              1: mainnet,
              8453: base,
              42161: arbitrum,
              10: optimism,
              137: polygon,
            } as const;
            const chain = viemChains[chainId as keyof typeof viemChains] || base;

            const publicClient = createPublicClient({
              chain,
              transport: http(),
            });

            // Fetch symbol, name, and decimals from the contract
            const [symbol, name, decimals] = await Promise.all([
              publicClient.readContract({
                address: tokenAddress as `0x${string}`,
                abi: erc20Abi,
                functionName: 'symbol',
              }),
              publicClient.readContract({
                address: tokenAddress as `0x${string}`,
                abi: erc20Abi,
                functionName: 'name',
              }),
              publicClient.readContract({
                address: tokenAddress as `0x${string}`,
                abi: erc20Abi,
                functionName: 'decimals',
              }),
            ]);
            setBuyAsset({
              symbol: symbol as string,
              name: name as string,
              balance: '0',
              chain: chainName,
              chainName: chainDisplayName,
              contractAddress: tokenAddress,
              isNative: false,
              decimals: decimals as number,
            });
          }
        } catch {
          // Token lookup failed — leave buy asset unset
        }
      };
      findInitialToken();
    }
  }, [visible, initialBuyToken, buyAsset]);

  // Set default destination chain when sell asset is selected
  React.useEffect(() => {
    if (sellAsset && !destinationChain) {
      setDestinationChain(sellAsset.chain);
    }
  }, [sellAsset, destinationChain]);

  // Search for tokens via multiple APIs when buy search changes
  React.useEffect(() => {
    const performSearch = async () => {
      if (!buySearch.trim() || buySearch.length < 2 || !sellAsset) {
        setSearchedTokens([]);
        return;
      }

      setIsSearchingTokens(true);
      try {
        // Determine which chains to search based on sell asset compatibility
        const sellChain = sellAsset.chain;

        // If selling Solana, only search Solana tokens
        if (sellChain === 'solana') {
          let jupiterResults: RelayToken[] = [];
          try {
            const jupTokens = await searchJupiterTokens(buySearch);
            jupiterResults = jupTokens.map(t => ({
              chainId: 0,
              address: t.address,
              symbol: t.symbol,
              name: t.name,
              decimals: t.decimals,
              logoURI: t.logoURI,
              chainName: 'solana',
            } as RelayToken & { chainName: string }));
          } catch {
            // Jupiter search failed — proceed with empty results
          }
          setSearchedTokens(jupiterResults);
          setIsSearchingTokens(false);
          return;
        }

        // For EVM chains, search all compatible chains
        const evmChainsToSearch = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'];
        const chainIds = evmChainsToSearch.map(c => getChainId(c)).filter(Boolean) as number[];

        // 1. Search public token lists (comprehensive)
        const tokenListResults = await searchTokens({
          search: buySearch,
          chainIds,
          limit: 30,
        });

        // 2. Also try Relay API for additional tokens
        const relayPromises = evmChainsToSearch.map(async (chainName) => {
          const chainId = getChainId(chainName);
          if (!chainId) return [];
          try {
            const tokens = await getRelayTokens(chainId, buySearch);
            return tokens.map(t => ({ ...t, chainName }));
          } catch {
            return [];
          }
        });

        const relayResults = (await Promise.all(relayPromises)).flat();

        // 3. Search Li.Fi for Hyperliquid and other chains
        let lifiResults: RelayToken[] = [];
        try {
          const lifiTokens = await searchLifiTokens(buySearch, LIFI_CHAIN_IDS.hyperevm);
          lifiResults = lifiTokens.map(t => ({
            chainId: t.chainId,
            address: t.address,
            symbol: t.symbol,
            name: t.name,
            decimals: t.decimals,
            logoURI: t.logoURI,
            chainName: 'hyperevm',
          } as RelayToken & { chainName: string }));
        } catch {
          // Li.Fi search failed — proceed with other results
        }

        // Note: Jupiter/Solana search is handled separately above when sellAsset is Solana

        // Merge results, preferring token list results (they have better metadata)
        const seen = new Set<string>();
        const allTokens: RelayToken[] = [];

        // Add token list results first (converted to RelayToken format)
        for (const token of tokenListResults) {
          const chainName = Object.entries(CHAIN_IDS).find(([, id]) => id === token.chainId)?.[0] || '';
          const key = `${token.chainId}-${token.address.toLowerCase()}`;
          if (!seen.has(key)) {
            seen.add(key);
            allTokens.push({
              chainId: token.chainId,
              address: token.address,
              symbol: token.symbol,
              name: token.name,
              decimals: token.decimals,
              logoURI: token.logoURI,
              chainName, // Add for display
            } as RelayToken & { chainName: string });
          }
        }

        // Add Relay results that aren't already included
        for (const token of relayResults) {
          const key = `${token.chainId}-${token.address.toLowerCase()}`;
          if (!seen.has(key)) {
            seen.add(key);
            allTokens.push(token);
          }
        }

        // Add Li.Fi results (Hyperliquid)
        for (const token of lifiResults) {
          const key = `hyperevm-${token.address.toLowerCase()}`;
          if (!seen.has(key)) {
            seen.add(key);
            allTokens.push(token);
          }
        }
        setSearchedTokens(allTokens);
      } catch (err) {
        setSearchedTokens([]);
      } finally {
        setIsSearchingTokens(false);
      }
    };

    const timer = setTimeout(performSearch, 300); // Debounce
    return () => clearTimeout(timer);
  }, [buySearch, sellAsset]);

  // Helper to determine swap provider based on chains
  type SwapProvider = 'jupiter' | 'lifi' | '0x' | 'relay' | 'unsupported';
  const getSwapProvider = React.useCallback((sellChain: string, buyChain: string): SwapProvider => {
    // Solana swaps - use Jupiter (only same-chain supported)
    if (sellChain === 'solana') {
      if (buyChain === 'solana') {
        return 'jupiter';
      }
      // Solana → EVM cross-chain not supported yet
      return 'unsupported';
    }

    // EVM → Solana cross-chain not supported yet
    if (buyChain === 'solana') {
      return 'unsupported';
    }

    // Hyperliquid - use Li.Fi (same-chain and cross-chain)
    if (sellChain === 'hyperevm' || buyChain === 'hyperevm') {
      return 'lifi';
    }

    // Cross-chain EVM - use Relay
    if (sellChain !== buyChain) {
      return 'relay';
    }

    // Same-chain EVM - use 0x
    return '0x';
  }, []);

  // Fetch quote when sell amount changes - uses 0x for same-chain, Relay for cross-chain
  React.useEffect(() => {
    const fetchQuote = async () => {
      if (!sellAsset || !buyAsset || !sellAmount || parseFloat(sellAmount) <= 0) {
        setQuote(null);
        setGaslessQuote(null);
        setRelayQuote(null);
        setJupiterQuote(null);
        setLifiQuote(null);
        setIsGaslessAvailable(false);
        setBuyAmount('');
        return;
      }

      setIsLoadingQuote(true);
      setError(null);

      // Clear all quotes
      setQuote(null);
      setGaslessQuote(null);
      setRelayQuote(null);
      setJupiterQuote(null);
      setLifiQuote(null);
      setIsGaslessAvailable(false);

      try {
        // Ensure decimals are valid numbers
        const sellDecimals = typeof sellAsset.decimals === 'number' && !isNaN(sellAsset.decimals)
          ? sellAsset.decimals
          : (sellAsset.chain === 'solana' ? 9 : 18);
        const buyDecimals = typeof buyAsset.decimals === 'number' && !isNaN(buyAsset.decimals)
          ? buyAsset.decimals
          : (buyAsset.chain === 'solana' ? 9 : 18);

        // Determine swap provider
        const provider = getSwapProvider(sellAsset.chain, buyAsset.chain);
        // Unsupported cross-chain combination
        if (provider === 'unsupported') {
          throw new Error(`Cross-chain swaps between ${sellAsset.chain} and ${buyAsset.chain} are not supported yet`);
        }

        // Jupiter for Solana swaps
        if (provider === 'jupiter') {
          const inputMint = sellAsset.isNative ? SOL_MINT : sellAsset.contractAddress!;
          const outputMint = buyAsset.isNative ? SOL_MINT : buyAsset.contractAddress!;
          const jupResult = await getJupiterQuote(
            inputMint,
            outputMint,
            parseJupiterAmount(sellAmount, sellDecimals),
            50 // 0.5% slippage
          );

          setJupiterQuote(jupResult);
          setBuyAmount(formatJupiterAmount(jupResult.outAmount, buyDecimals));
          return;
        }

        // Li.Fi for Hyperliquid and other supported chains
        if (provider === 'lifi') {
          const fromChainId = getLifiChainId(sellAsset.chain);
          const toChainId = getLifiChainId(buyAsset.chain);

          if (!fromChainId || !toChainId) {
            throw new Error(`Unsupported chain for Li.Fi: ${sellAsset.chain} or ${buyAsset.chain}`);
          }

          const fromTokenAddress = sellAsset.isNative ? LIFI_NATIVE_ADDRESS : sellAsset.contractAddress!;
          const toTokenAddress = buyAsset.isNative ? LIFI_NATIVE_ADDRESS : buyAsset.contractAddress!;
          const lifiResult = await getLifiQuote(
            fromChainId,
            toChainId,
            fromTokenAddress,
            toTokenAddress,
            parseLifiAmount(sellAmount, sellDecimals),
            activeAddress || '',
            50 // 0.5% slippage
          );

          setLifiQuote(lifiResult);
          setBuyAmount(formatLifiAmount(lifiResult.estimate.toAmount, buyDecimals));
          return;
        }

        // Get chain IDs for EVM swaps
        const originChainId = getChainId(sellAsset.chain);
        const destChainId = getChainId(buyAsset.chain);
        if (!originChainId || !destChainId) {
          throw new Error(`Unsupported chain: ${sellAsset.chain} or ${buyAsset.chain}`);
        }

        // Cross-chain EVM swap - use Relay Protocol
        if (provider === 'relay') {
          const originCurrency = getRelayTokenAddress(sellAsset.contractAddress, sellAsset.isNative || false);
          const destinationCurrency = getRelayTokenAddress(buyAsset.contractAddress, buyAsset.isNative || false);
          const relayResult = await getRelayQuote({
            originChainId,
            destinationChainId: destChainId,
            originCurrency,
            destinationCurrency,
            amount: parseTokenAmount(sellAmount, sellDecimals),
            userAddress: activeAddress || '',
            slippageTolerance: 100, // 1%
          });

          setRelayQuote(relayResult);

          // Extract buy amount from response
          const outputAmount =
            (relayResult.details as any)?.currencyOut?.amountFormatted ||
            (relayResult.details as any)?.currencyOut?.amount;

          if (outputAmount) {
            if (/^\d+$/.test(outputAmount) && outputAmount.length > 10) {
              setBuyAmount(formatTokenAmount(outputAmount, buyDecimals));
            } else {
              const dotIndex = outputAmount.indexOf('.');
              if (dotIndex !== -1 && outputAmount.length > dotIndex + 9) {
                const truncated = outputAmount.slice(0, dotIndex + 9).replace(/\.?0+$/, '');
                setBuyAmount(truncated);
              } else {
                setBuyAmount(outputAmount.replace(/\.?0+$/, ''));
              }
            }
          }
          return;
        }

        // Same-chain EVM swap - use 0x
        const sellTokenAddress = sellAsset.isNative ? NATIVE_TOKEN_ADDRESS : sellAsset.contractAddress!;
        const buyTokenAddress = buyAsset.isNative ? NATIVE_TOKEN_ADDRESS : buyAsset.contractAddress!;
        // Check if gasless is supported for this swap
        const gaslessSupported = isGaslessSupported(originChainId, sellTokenAddress);
        setIsGaslessAvailable(gaslessSupported);

        // Get regular price quote
        const priceResult = await getSwapPrice({
          chainId: originChainId,
          sellToken: sellTokenAddress,
          buyToken: buyTokenAddress,
          sellAmount: parseTokenAmount(sellAmount, sellDecimals),
          takerAddress: activeAddress,
        });

        // Check if liquidity is available
        if (priceResult.liquidityAvailable === false || !priceResult.buyAmount) {
          throw new Error('No liquidity available for this swap');
        }

        setQuote(priceResult);
        setBuyAmount(formatTokenAmount(priceResult.buyAmount, buyDecimals));

        // If gasless is supported, also fetch gasless quote
        if (gaslessSupported && activeAddress) {
          try {
            const gasless = await getGaslessQuote({
              chainId: originChainId,
              sellToken: sellTokenAddress,
              buyToken: buyTokenAddress,
              sellAmount: parseTokenAmount(sellAmount, sellDecimals),
              takerAddress: activeAddress,
              slippageBps: 100,
            });
            setGaslessQuote(gasless);
          } catch {
            setGaslessQuote(null);
            setIsGaslessAvailable(false);
          }
        } else {
          setGaslessQuote(null);
        }
      } catch (err: unknown) {
        const errorMessage = getErrorMessage(err) || 'Failed to get quote';
        setError(errorMessage);
        setBuyAmount('');
        setQuote(null);
        setGaslessQuote(null);
        setRelayQuote(null);
        setJupiterQuote(null);
        setLifiQuote(null);
        setIsGaslessAvailable(false);
        showToast({
          type: 'error',
          title: 'Quote Error',
          message: errorMessage,
        });
      } finally {
        setIsLoadingQuote(false);
      }
    };

    const timer = setTimeout(fetchQuote, 500); // Debounce
    return () => clearTimeout(timer);
  }, [sellAsset, buyAsset, sellAmount, activeAddress, getSwapProvider]);

  const getChainColor = (chain: string): string => {
    switch (chain) {
      case 'ethereum': return '#627EEA';
      case 'base': return '#0052FF';
      case 'arbitrum': return '#28A0F0';
      case 'optimism': return '#FF0420';
      case 'polygon': return '#8247E5';
      case 'solana': return '#9945FF';
      case 'hyperevm': return '#00E5A0';
      case 'avalanche': return '#E84142';
      case 'bsc': return '#F0B90B';
      default: return theme.colors.primary;
    }
  };

  const handleSwapDirection = () => {
    // For cross-chain, swap chains as well
    if (buyAsset && sellAsset) {
      const tempChain = sellAsset.chain;
      setDestinationChain(tempChain);
    }
    const tempAsset = sellAsset;
    const tempAmount = sellAmount;
    setSellAsset(buyAsset);
    setBuyAsset(tempAsset);
    setSellAmount(buyAmount);
    setBuyAmount(tempAmount);
  };

  const handleSetMax = async () => {
    if (!sellAsset || !sellAsset.balance) return;

    // For native tokens, reserve 1% of balance for gas (minimum 0.001)
    // This is simpler and more reliable than trying to estimate exact gas costs
    if (sellAsset.isNative) {
      const balance = parseFloat(sellAsset.balance);
      // Reserve 1% for gas, with a minimum of 0.001 tokens
      const gasReserve = Math.max(balance * 0.01, 0.001);
      const maxAmount = Math.max(0, balance - gasReserve);
      setSellAmount(maxAmount > 0 ? maxAmount.toString() : '0');
    } else {
      // For tokens, use full balance (gas is paid in native token)
      setSellAmount(sellAsset.balance);
    }
  };

  // Calculate swap value in USD for determining confirmation method
  const swapUsdValue = React.useMemo(() => {
    if (!sellAsset || !sellAmount) return 0;
    const amount = parseFloat(sellAmount);
    if (isNaN(amount)) return 0;
    // Use the asset's USD value per unit if available
    if (sellAsset.usdValue !== undefined && parseFloat(sellAsset.balance) > 0) {
      const pricePerUnit = sellAsset.usdValue / parseFloat(sellAsset.balance);
      return amount * pricePerUnit;
    }
    return 0;
  }, [sellAsset, sellAmount]);

  // Determine if biometric auth is required (>= $100)
  const requiresBiometric = swapUsdValue >= BIOMETRIC_THRESHOLD && biometricAvailable;

  // Execute the swap after confirmation
  const executeSwap = async () => {
    // Validate we have all required data
    const hasValidQuote = jupiterQuote || lifiQuote || relayQuote || quote || gaslessQuote;
    if (!sellAsset || !buyAsset || !sellAmount || !hasValidQuote || !activeAddress) {
      return;
    }

    const provider = getSwapProvider(sellAsset.chain, buyAsset.chain);

    setIsSwapping(true);
    Keyboard.dismiss();

    try {
      const keysResult = await fetchKeys();
      const keys = keysResult.data;

      if (!keys) {
        throw new Error('Failed to access wallet keys');
      }

      // Get the appropriate private key based on chain
      let privateKey: string;
      if (sellAsset.chain === 'solana') {
        privateKey = keys.solana?.privateKey || '';
        if (!privateKey) {
          throw new Error('No Solana private key available');
        }
      } else {
        // For warpcast wallet, use imported wallet private key; for builtin, use keys from derivation
        privateKey = (activeType === 'warpcast' ? warpcastImportedWallet?.privateKey : null) || keys.ethereum?.privateKey || '';
        if (!privateKey) {
          throw new Error('No EVM private key available');
        }
      }

      // Jupiter swap for Solana
      if (provider === 'jupiter' && jupiterQuote) {
        const inputMint = sellAsset.isNative ? SOL_MINT : sellAsset.contractAddress!;
        const outputMint = buyAsset.isNative ? SOL_MINT : buyAsset.contractAddress!;
        const sellDecimals = sellAsset.decimals || 9;

        // Import and execute Jupiter swap
        const { executeJupiterSwap, getJupiterExplorerUrl } = await import('@/services/wallet/jupiterService');

        const result = await executeJupiterSwap(
          inputMint,
          outputMint,
          parseJupiterAmount(sellAmount, sellDecimals),
          privateKey,
          jupiterQuote.slippageBps
        );

        const explorerUrl = getJupiterExplorerUrl(result.signature);

        setIsSwapping(false);
        onClose();
        refreshBalances();

        setTimeout(() => {
          showToast({
            type: 'success',
            title: 'Swap Complete',
            message: `${sellAmount} ${sellAsset.symbol} → ~${buyAmount} ${buyAsset.symbol}`,
            txHash: result.signature,
            explorerUrl,
          });
        }, 300);
        return;
      }

      // Li.Fi swap for Hyperliquid and other chains
      if (provider === 'lifi' && lifiQuote && lifiQuote.transactionRequest) {
        const txRequest = lifiQuote.transactionRequest;
        const { getLifiExplorerUrl } = await import('@/services/wallet/lifiService');
        const fromChainId = lifiQuote.action.fromChainId;

        // Check if we need token approval (for ERC20 tokens, not native)
        if (!sellAsset.isNative && lifiQuote.estimate.approvalAddress) {
          const sellTokenAddress = sellAsset.contractAddress!;
          const sellDecimals = sellAsset.decimals || 18;
          const sellAmountBigInt = BigInt(parseLifiAmount(sellAmount, sellDecimals));

          const currentAllowance = await checkAllowance(
            fromChainId,
            sellTokenAddress,
            activeAddress!,
            lifiQuote.estimate.approvalAddress
          );

          if (currentAllowance < sellAmountBigInt) {
            const approvalHash = await approveToken(
              privateKey,
              fromChainId,
              sellTokenAddress,
              lifiQuote.estimate.approvalAddress
            );

            // Wait for approval to confirm
            await waitForTransaction(fromChainId, approvalHash, 1);
          }
        }

        // Execute the swap transaction
        const result = await sendSwapTransaction(privateKey, {
          to: txRequest.to,
          data: txRequest.data,
          value: txRequest.value,
          gas: txRequest.gasLimit,
          gasPrice: txRequest.gasPrice,
          chainId: txRequest.chainId,
        });

        const explorerUrl = getLifiExplorerUrl(txRequest.chainId, result.hash);

        setIsSwapping(false);
        onClose();
        refreshBalances();

        setTimeout(() => {
          showToast({
            type: 'success',
            title: 'Swap Submitted',
            message: `${sellAmount} ${sellAsset.symbol} → ~${buyAmount} ${buyAsset.symbol}`,
            txHash: result.hash,
            explorerUrl,
          });
        }, 300);
        return;
      }

      // Get EVM chainId for Relay and 0x swaps
      const chainId = getChainId(sellAsset.chain);

      // Cross-chain swap via Relay Protocol
      if (provider === 'relay' && relayQuote && chainId) {
        const timeEstimate = relayQuote.details.timeEstimate
          ? `~${Math.ceil(relayQuote.details.timeEstimate / 60)} min`
          : '~2-5 min';
        // Execute each step in the relay quote
        let lastTxHash: string | null = null;
        let lastChainId = chainId;

        for (const step of relayQuote.steps) {
          for (const item of step.items) {
            if (item.status === 'complete') {
              continue;
            }

            if (!item.data) {
              continue;
            }

            const txData = item.data;
            const result = await sendSwapTransaction(privateKey, {
              to: txData.to,
              data: txData.data,
              value: txData.value || '0',
              gas: txData.gas,
              chainId: txData.chainId,
            });

            lastTxHash = result.hash;
            lastChainId = txData.chainId;
            // Wait for transaction to confirm before next step
            await waitForTransaction(txData.chainId, result.hash, 1);
          }
        }

        const explorerUrl = lastTxHash ? getExplorerUrl(lastChainId, lastTxHash as `0x${string}`) : '';

        // Record cross-chain swap transaction in history (already confirmed since we waited)
        if (lastTxHash) {
          recordTransaction({
            hash: lastTxHash,
            chainId: lastChainId,
            from: activeAddress!,
            to: relayQuote.steps[0]?.items[0]?.data?.to || '',
            amount: sellAmount,
            symbol: `${sellAsset.symbol} → ${buyAsset.symbol}`,
            decimals: sellAsset.decimals,
            isNative: sellAsset.isNative,
            tokenAddress: sellAsset.isNative ? undefined : sellAsset.contractAddress,
            type: 'swap',
          });

          // Mark as success since we already waited for confirmation
          updateTransactionStatus(
            activeAddress!,
            lastTxHash,
            lastChainId,
            'success'
          );
        }

        setIsSwapping(false);
        onClose();
        refreshBalances();

        // Show toast after modal closes
        setTimeout(() => {
          showToast({
            type: 'success',
            title: 'Cross-chain Swap Complete',
            message: `${sellAmount} ${sellAsset.symbol} → ~${buyAmount} ${buyAsset.symbol}`,
            txHash: lastTxHash || undefined,
            explorerUrl: lastTxHash ? explorerUrl : undefined,
          });
        }, 300);
        return;
      }

      // Same-chain EVM swaps via 0x
      if (provider !== '0x' || !chainId) {
        throw new Error('Unable to execute swap - no valid provider');
      }

      const sellDecimals = sellAsset.decimals;
      const sellTokenAddress = sellAsset.isNative ? NATIVE_TOKEN_ADDRESS : sellAsset.contractAddress!;
      const buyTokenAddress = buyAsset.isNative ? NATIVE_TOKEN_ADDRESS : buyAsset.contractAddress!;

      // Gasless swap - execute if we have a gasless quote
      if (gaslessQuote && isGaslessAvailable && gaslessQuote.trade?.eip712) {
        const { createWalletClient, http } = await import('viem');
        const { privateKeyToAccount } = await import('viem/accounts');
        const { base, mainnet, arbitrum, optimism, polygon } = await import('viem/chains');

        const chainMap: Record<number, any> = {
          1: mainnet,
          8453: base,
          42161: arbitrum,
          10: optimism,
          137: polygon,
        };

        const chain = chainMap[chainId];
        if (!chain) {
          throw new Error(`Gasless swaps not supported on chain ${chainId}`);
        }

        const formattedKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
        const account = privateKeyToAccount(formattedKey);

        const walletClient = createWalletClient({
          account,
          chain,
          transport: http(),
        });

        // Sign approval EIP-712 message if needed
        let approvalSignature: string | undefined;
        if (gaslessQuote.approval?.eip712) {
          approvalSignature = await walletClient.signTypedData({
            types: gaslessQuote.approval.eip712.types,
            domain: gaslessQuote.approval.eip712.domain,
            message: gaslessQuote.approval.eip712.message,
            primaryType: gaslessQuote.approval.eip712.primaryType,
          });
        }

        // Sign trade EIP-712 message
        const tradeSignature = await walletClient.signTypedData({
          types: gaslessQuote.trade.eip712.types,
          domain: gaslessQuote.trade.eip712.domain,
          message: gaslessQuote.trade.eip712.message,
          primaryType: gaslessQuote.trade.eip712.primaryType,
        });

        // Submit the signed gasless swap
        const submitResult = await submitGaslessSwap({
          chainId,
          trade: {
            type: gaslessQuote.trade.type,
            eip712: gaslessQuote.trade.eip712,
          },
          tradeSignature,
          approval: gaslessQuote.approval ? {
            type: gaslessQuote.approval.type,
            eip712: gaslessQuote.approval.eip712,
          } : undefined,
          approvalSignature,
        });

        // Show pending toast
        showToast({
          type: 'info',
          title: 'Gasless Swap Submitted',
          message: `${sellAmount} ${sellAsset.symbol} → ~${buyAmount} ${buyAsset.symbol}`,
        });

        setIsSwapping(false);
        onClose();

        // Poll for status in background
        const tradeHash = submitResult.tradeHash;
        const txChainId = chainId;
        const sellSymbol = sellAsset.symbol;
        const buySymbol = buyAsset.symbol;
        const txSellAmount = sellAmount;
        const txBuyAmount = buyAmount;
        const isWarpcast = activeType === 'warpcast';

        (async () => {
          try {
            // Poll status every 3 seconds, max 60 seconds
            let attempts = 0;
            const maxAttempts = 20;

            while (attempts < maxAttempts) {
              await new Promise(resolve => setTimeout(resolve, 3000));
              attempts++;

              const status = await getGaslessSwapStatus({ chainId: txChainId, tradeHash });

              if (status.status === 'confirmed' || status.status === 'succeeded') {
                // Get tx hash from transactions array
                const txHash = status.transactions?.[0]?.hash;

                // Refresh balances
                await new Promise(resolve => setTimeout(resolve, 2000));
                if (isWarpcast) {
                  refetchWarpcastBalances();
                } else {
                  refetchBalances();
                }

                showToast({
                  type: 'success',
                  title: 'Gasless Swap Complete',
                  message: `${txSellAmount} ${sellSymbol} → ${txBuyAmount} ${buySymbol}`,
                  txHash,
                  explorerUrl: txHash ? getExplorerUrl(txChainId, txHash as `0x${string}`) : undefined,
                });
                return;
              } else if (status.status === 'failed') {
                showToast({
                  type: 'error',
                  title: 'Gasless Swap Failed',
                  message: 'Transaction failed. Please try again.',
                });
                return;
              }
              // Still pending, continue polling
            }

            // Timed out waiting for confirmation
            showToast({
              type: 'info',
              title: 'Swap Still Processing',
              message: 'Your gasless swap is still being processed. Check your wallet balance.',
            });
          } catch (err) {
            // Refresh balances anyway
            if (isWarpcast) {
              refetchWarpcastBalances();
            } else {
              refetchBalances();
            }
          }
        })();

        return;
      }

      // Regular swap with gas - get fresh quote with transaction data
      const swapQuote = await getSwapQuote({
        chainId,
        sellToken: sellTokenAddress,
        buyToken: buyTokenAddress,
        sellAmount: parseTokenAmount(sellAmount, sellDecimals),
        takerAddress: activeAddress!,
        slippageBps: 100, // 1%
      });

      if (!swapQuote.transaction) {
        throw new Error('No transaction data in quote');
      }

      // Check if we need token approval (for ERC20 tokens, not native)
      if (!sellAsset.isNative && swapQuote.allowanceTarget) {
        const sellAmountBigInt = BigInt(parseTokenAmount(sellAmount, sellDecimals));
        const currentAllowance = await checkAllowance(
          chainId,
          sellTokenAddress,
          activeAddress!,
          swapQuote.allowanceTarget
        );

        if (currentAllowance < sellAmountBigInt) {
          const approvalHash = await approveToken(
            privateKey,
            chainId,
            sellTokenAddress,
            swapQuote.allowanceTarget
          );

          // Wait for approval to confirm
          await waitForTransaction(chainId, approvalHash, 1);
        }
      }
      const result = await sendSwapTransaction(privateKey, {
        to: swapQuote.transaction.to,
        data: swapQuote.transaction.data,
        value: swapQuote.transaction.value,
        gas: swapQuote.transaction.gas,
        gasPrice: swapQuote.transaction.gasPrice,
        chainId,
      });

      const explorerUrl = getExplorerUrl(chainId, result.hash);
      // Record swap transaction in history (initially pending)
      recordTransaction({
        hash: result.hash,
        chainId,
        from: activeAddress!,
        to: swapQuote.transaction.to,
        amount: sellAmount,
        symbol: `${sellAsset.symbol} → ${buyAsset.symbol}`,
        decimals: sellAsset.decimals,
        isNative: sellAsset.isNative,
        tokenAddress: sellAsset.isNative ? undefined : sellAsset.contractAddress,
        type: 'swap',
      });

      // Show pending toast immediately
      showToast({
        type: 'info',
        title: 'Swap Pending',
        message: `${sellAmount} ${sellAsset.symbol} → ~${buyAmount} ${buyAsset.symbol}`,
        txHash: result.hash,
        explorerUrl,
      });

      // Wait for transaction confirmation in background
      const txHash = result.hash;
      const txChainId = chainId;
      const txAddress = activeAddress!;
      const sellSymbol = sellAsset.symbol;
      const buySymbol = buyAsset.symbol;
      const txSellAmount = sellAmount;
      const txBuyAmount = buyAmount;
      const isWarpcast = activeType === 'warpcast';

      setIsSwapping(false);
      onClose();

      // Background confirmation - don't block UI
      (async () => {
        try {
          const receipt = await waitForTransaction(txChainId, txHash, 1);
          const success = receipt.success;

          updateTransactionStatus(
            txAddress,
            txHash,
            txChainId,
            success ? 'success' : 'failed',
            receipt.blockNumber ? Number(receipt.blockNumber) : undefined
          );

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
            title: success ? 'Swap Complete' : 'Swap Failed',
            message: success
              ? `${txSellAmount} ${sellSymbol} → ${txBuyAmount} ${buySymbol}`
              : 'Transaction failed on chain',
            txHash,
            explorerUrl,
          });
        } catch (err) {
          // Still try to refresh balances
          if (isWarpcast) {
            refetchWarpcastBalances();
          } else {
            refetchBalances();
          }
        }
      })();
    } catch (err: unknown) {
      setIsSwapping(false);
      showToast({
        type: 'error',
        title: 'Swap Failed',
        message: getErrorMessage(err) || 'Failed to execute swap',
      });
    }
  };

  // Handle swap with biometric authentication
  const handleBiometricSwap = async () => {
    const result = await authenticate(
      `Authenticate to swap ${sellAmount} ${sellAsset?.symbol} ($${swapUsdValue.toFixed(2)})`
    );

    if (result.success) {
      executeSwap();
    } else if (result.error !== 'Cancelled') {
      showToast({
        type: 'error',
        title: 'Authentication Failed',
        message: result.error || 'Please try again',
      });
    }
  };

  // Handle swap confirmation (called by HoldToConfirm or biometric)
  const handleSwapConfirm = () => {
    if (requiresBiometric) {
      handleBiometricSwap();
    } else {
      executeSwap();
    }
  };

  const renderAssetPicker = (
    assets: VerifiedAsset[],
    searchValue: string,
    onSearchChange: (text: string) => void,
    onSelect: (asset: VerifiedAsset) => void,
    onClose: () => void,
    placeholder: string = 'Search tokens...',
    isLoading: boolean = false,
    showVerification: boolean = false
  ) => (
    <View style={styles.assetPickerDropdown}>
      <View style={styles.searchContainer}>
        <IconSymbol name="magnifyingglass" size={16} color={theme.colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textMuted}
          value={searchValue}
          onChangeText={onSearchChange}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {isLoading ? (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        ) : searchValue.length > 0 ? (
          <TouchableOpacity onPress={() => onSearchChange('')}>
            <IconSymbol name="xmark.circle.fill" size={16} color={theme.colors.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>
      <ScrollView style={styles.assetPickerList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {assets.length === 0 ? (
          <Text style={styles.noAssetsText}>
            {isLoading ? 'Searching...' : searchValue ? 'No verified tokens found' : 'No swappable assets available'}
          </Text>
        ) : (
          assets.map((asset, index) => {
            const isVerified = asset.verified !== false;
            const hasWarning = asset.verificationStatus === 'warning';

            return (
              <TouchableOpacity
                key={`${asset.chain}-${asset.symbol}-${asset.contractAddress || 'native'}-${index}`}
                style={styles.assetPickerItem}
                onPress={() => {
                  // Warn about unverified tokens
                  if (showVerification && !isVerified) {
                    Alert.alert(
                      'Unverified Token',
                      `This token (${asset.symbol}) is not on verified token lists. Verify the contract address before swapping:\n\n${asset.contractAddress || 'Native token'}`,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Select Anyway',
                          style: 'destructive',
                          onPress: () => {
                            onSelect(asset);
                            onSearchChange('');
                            onClose();
                          },
                        },
                      ]
                    );
                  } else {
                    onSelect(asset);
                    onSearchChange('');
                    onClose();
                  }
                }}
              >
                <View style={[styles.assetIcon, { backgroundColor: getChainColor(asset.chain) + '20' }]}>
                  <Text style={[styles.assetIconText, { color: getChainColor(asset.chain) }]}>
                    {asset.symbol.charAt(0)}
                  </Text>
                </View>
                <View style={styles.assetInfo}>
                  <View style={styles.assetNameRow}>
                    <Text style={styles.assetName}>{asset.symbol}</Text>
                    {showVerification && isVerified && (
                      <View style={styles.verifiedBadge}>
                        <IconSymbol name="checkmark.seal.fill" size={12} color="#22C55E" />
                      </View>
                    )}
                    {showVerification && hasWarning && (
                      <View style={styles.warningBadge}>
                        <IconSymbol name="exclamationmark.triangle.fill" size={12} color="#EF4444" />
                      </View>
                    )}
                  </View>
                  <Text style={styles.assetBalance}>
                    {parseFloat(asset.balance) > 0 ? formatBalance(asset.balance) + ' on ' : ''}{getChainName(asset.chain)}
                  </Text>
                  {showVerification && asset.contractAddress && (
                    <Text style={styles.contractAddress}>
                      {truncateAddress(asset.contractAddress)}
                    </Text>
                  )}
                </View>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
    </View>
  );

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.85} avoidKeyboard>
      <View style={styles.header}>
        <Text style={styles.title}>Swap</Text>
        <TouchableOpacity onPress={onClose}>
          <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* Wallet Selector */}
        <WalletSelector />

        {/* Sell Section */}
        <View style={styles.swapSection}>
          <View style={styles.swapSectionHeader}>
            <Text style={styles.swapLabel}>You pay</Text>
            {sellAsset && (
              <TouchableOpacity onPress={handleSetMax}>
                <Text style={styles.maxButton}>MAX</Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.swapInputRow}>
            <TextInput
              style={styles.swapAmountInput}
              placeholder="0"
              placeholderTextColor={theme.colors.textMuted}
              value={sellAmount}
              onChangeText={setSellAmount}
              keyboardType="decimal-pad"
            />
            <TouchableOpacity
              style={styles.tokenSelector}
              onPress={() => showSellPicker ? setShowSellPicker(false) : openSellPicker()}
            >
              {sellAsset ? (
                <View style={styles.selectedToken}>
                  <View style={[styles.tokenDot, { backgroundColor: getChainColor(sellAsset.chain) }]} />
                  <Text style={styles.tokenSymbol}>{sellAsset.symbol}</Text>
                </View>
              ) : (
                <Text style={styles.selectTokenText}>Select</Text>
              )}
              {isPickerLoading ? (
                <ActivityIndicator size="small" color={theme.colors.primary} />
              ) : (
                <IconSymbol name="chevron.down" size={14} color={theme.colors.textMuted} />
              )}
            </TouchableOpacity>
          </View>

          {sellAsset && (
            <Text style={[styles.balanceText, insufficientBalance && styles.balanceTextError]}>
              Balance: {formatBalance(sellAsset.balance)} {sellAsset.symbol}
              {insufficientBalance && ' (insufficient)'}
            </Text>
          )}

          {showSellPicker && renderAssetPicker(
            filteredSellAssets.map(a => ({ ...a, verified: true, verificationStatus: 'verified' as TokenVerificationStatus })),
            sellSearch,
            setSellSearch,
            (asset) => {
              setSellAsset(asset);
              // Reset buy asset if not on same chain
              if (buyAsset && buyAsset.chain !== asset.chain) {
                setBuyAsset(null);
              }
            },
            () => setShowSellPicker(false),
            'Search by token or chain...',
            false, // isLoading
            false // showVerification - user's own tokens
          )}
        </View>

        {/* Swap Direction Button */}
        <View style={styles.swapDirectionContainer}>
          <TouchableOpacity style={styles.swapDirectionButton} onPress={handleSwapDirection}>
            <IconSymbol name="arrow.up.arrow.down" size={18} color={theme.colors.primary} />
          </TouchableOpacity>
        </View>

        {/* Buy Section */}
        <View style={styles.swapSection}>
          <View style={styles.swapSectionHeader}>
            <Text style={styles.swapLabel}>You receive</Text>
          </View>

          <View style={styles.swapInputRow}>
            <View style={[styles.swapAmountInput, styles.swapAmountOutput]}>
              {isLoadingQuote ? (
                <ActivityIndicator size="small" color={theme.colors.primary} />
              ) : (
                <Text style={[styles.swapAmountText, !buyAmount && styles.swapAmountPlaceholder]}>
                  {buyAmount || '0'}
                </Text>
              )}
            </View>
            <TouchableOpacity
              style={styles.tokenSelector}
              onPress={() => showBuyPicker ? setShowBuyPicker(false) : openBuyPicker()}
            >
              {buyAsset ? (
                <View style={styles.selectedToken}>
                  <View style={[styles.tokenDot, { backgroundColor: getChainColor(buyAsset.chain) }]} />
                  <Text style={styles.tokenSymbol}>{buyAsset.symbol}</Text>
                </View>
              ) : (
                <Text style={styles.selectTokenText}>Select</Text>
              )}
              {isPickerLoading ? (
                <ActivityIndicator size="small" color={theme.colors.primary} />
              ) : (
                <IconSymbol name="chevron.down" size={14} color={theme.colors.textMuted} />
              )}
            </TouchableOpacity>
          </View>

          {showBuyPicker && (
            <>
              {renderAssetPicker(
                filteredBuyAssets,
                buySearch,
                setBuySearch,
                (asset) => {
                  setBuyAsset(asset);
                  setDestinationChain(asset.chain);
                  setShowManualEntry(false);
                },
                () => setShowBuyPicker(false),
                'Search tokens across chains...',
                isSearchingTokens,
                true
              )}

              {/* Manual Token Entry */}
              <TouchableOpacity
                style={styles.manualEntryToggle}
                onPress={() => setShowManualEntry(!showManualEntry)}
              >
                <IconSymbol name={showManualEntry ? "chevron.up" : "plus.circle"} size={16} color={theme.colors.primary} />
                <Text style={styles.manualEntryToggleText}>
                  {showManualEntry ? 'Hide manual entry' : 'Add custom token'}
                </Text>
              </TouchableOpacity>

              {showManualEntry && (
                <View style={styles.manualEntryContainer}>
                  {/* Chain Selector */}
                  <Text style={styles.manualEntryLabel}>Chain</Text>
                  <SegmentedPills
                    style={styles.chainSelector}
                    variant="solid"
                    itemRole="button"
                    items={(sellAsset?.chain === 'solana'
                      ? ['solana']
                      : ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'hyperevm']
                    ).map<SegmentedPillItem>((chain) => ({
                      key: chain,
                      label: getChainName(chain),
                      accentColor: getChainColor(chain),
                    }))}
                    activeKey={manualChain}
                    onChange={setManualChain}
                  />

                  {/* Contract Address */}
                  <Text style={styles.manualEntryLabel}>Contract Address</Text>
                  <TextInput
                    style={styles.manualEntryInput}
                    placeholder={manualChain === 'solana' ? 'Token mint address...' : '0x...'}
                    placeholderTextColor={theme.colors.textMuted}
                    value={manualContractAddress}
                    onChangeText={setManualContractAddress}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />

                  {/* Symbol & Decimals Row */}
                  <View style={styles.manualEntryRow}>
                    <View style={{ flex: 2 }}>
                      <Text style={styles.manualEntryLabel}>Symbol</Text>
                      <TextInput
                        style={styles.manualEntryInput}
                        placeholder="TOKEN"
                        placeholderTextColor={theme.colors.textMuted}
                        value={manualSymbol}
                        onChangeText={setManualSymbol}
                        autoCapitalize="characters"
                        autoCorrect={false}
                      />
                    </View>
                    <View style={{ flex: 1, marginLeft: Skin.space(12) }}>
                      <Text style={styles.manualEntryLabel}>Decimals</Text>
                      <TextInput
                        style={styles.manualEntryInput}
                        placeholder="18"
                        placeholderTextColor={theme.colors.textMuted}
                        value={manualDecimals}
                        onChangeText={setManualDecimals}
                        keyboardType="number-pad"
                      />
                    </View>
                  </View>

                  {/* Add Token Button */}
                  <TouchableOpacity
                    style={[
                      styles.manualEntryButton,
                      (!manualChain || !manualContractAddress || !manualSymbol) && styles.manualEntryButtonDisabled
                    ]}
                    disabled={!manualChain || !manualContractAddress || !manualSymbol}
                    onPress={() => {
                      if (manualChain && manualContractAddress && manualSymbol) {
                        const decimals = parseInt(manualDecimals) || 18;
                        setBuyAsset({
                          symbol: manualSymbol.toUpperCase(),
                          name: manualSymbol.toUpperCase(),
                          balance: '0',
                          chain: manualChain,
                          chainName: getChainName(manualChain),
                          contractAddress: manualContractAddress,
                          isNative: false,
                          decimals,
                        });
                        setDestinationChain(manualChain);
                        setShowBuyPicker(false);
                        setShowManualEntry(false);
                        setManualContractAddress('');
                        setManualSymbol('');
                        setManualDecimals('18');
                        setManualChain(null);
                      }
                    }}
                  >
                    <Text style={styles.manualEntryButtonText}>Use This Token</Text>
                  </TouchableOpacity>
                </View>
              )}
            </>
          )}
        </View>

        {/* Error Display */}
        {error && (
          <View style={styles.errorBox}>
            <IconSymbol name="exclamationmark.triangle.fill" size={16} color="#EF4444" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Quote Info - 0x (Same Chain EVM) */}
        {quote && !jupiterQuote && !lifiQuote && !relayQuote && sellAsset && buyAsset && (
          <View style={styles.quoteInfo}>
            {/* Gasless Badge */}
            {gaslessQuote && isGaslessAvailable && (
              <View style={styles.gaslessBadgeRow}>
                <View style={styles.gaslessBadge}>
                  <IconSymbol name="bolt.fill" size={12} color="#22C55E" />
                  <Text style={styles.gaslessBadgeText}>Gasless Available</Text>
                </View>
              </View>
            )}
            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Rate</Text>
              <Text style={styles.quoteValue}>
                1 {sellAsset.symbol} = {((parseFloat(quote.buyAmount) / Math.pow(10, buyAsset.decimals)) / (parseFloat(quote.sellAmount) / Math.pow(10, sellAsset.decimals))).toFixed(6)} {buyAsset.symbol}
              </Text>
            </View>
            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Network</Text>
              <Text style={styles.quoteValue}>{getChainName(sellAsset.chain)}</Text>
            </View>
            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Gas Fee</Text>
              {gaslessQuote && isGaslessAvailable ? (
                <Text style={[styles.quoteValue, styles.gaslessFree]}>Free (Sponsored)</Text>
              ) : (
                <Text style={styles.quoteValue}>~{parseInt(quote.gas || '0').toLocaleString()} gas</Text>
              )}
            </View>
          </View>
        )}

        {/* Quote Info - Jupiter (Solana) */}
        {jupiterQuote && sellAsset && buyAsset && (
          <View style={styles.quoteInfo}>
            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Rate</Text>
              <Text style={styles.quoteValue}>
                1 {sellAsset.symbol} = {((parseFloat(jupiterQuote.outAmount) / Math.pow(10, buyAsset.decimals || 9)) / (parseFloat(jupiterQuote.inAmount) / Math.pow(10, sellAsset.decimals || 9))).toFixed(6)} {buyAsset.symbol}
              </Text>
            </View>
            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Network</Text>
              <Text style={styles.quoteValue}>Solana</Text>
            </View>
            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Route</Text>
              <Text style={styles.quoteValue}>
                {jupiterQuote.routePlan.map(r => r.swapInfo.label).join(' → ')}
              </Text>
            </View>
            {parseFloat(jupiterQuote.priceImpactPct) > 1 && (
              <View style={styles.quoteRow}>
                <Text style={styles.quoteLabel}>Price Impact</Text>
                <Text style={[styles.quoteValue, { color: theme.colors.danger }]}>
                  {parseFloat(jupiterQuote.priceImpactPct).toFixed(2)}%
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Quote Info - Li.Fi (Hyperliquid/EVM) */}
        {lifiQuote && sellAsset && buyAsset && (
          <View style={styles.quoteInfo}>
            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Rate</Text>
              <Text style={styles.quoteValue}>
                1 {sellAsset.symbol} = {((parseFloat(lifiQuote.estimate.toAmount) / Math.pow(10, buyAsset.decimals || 18)) / (parseFloat(lifiQuote.estimate.fromAmount) / Math.pow(10, sellAsset.decimals || 18))).toFixed(6)} {buyAsset.symbol}
              </Text>
            </View>
            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Route</Text>
              <Text style={styles.quoteValue}>
                {lifiQuote.action.fromChainId === lifiQuote.action.toChainId
                  ? getChainName(sellAsset.chain)
                  : `${getChainName(sellAsset.chain)} → ${getChainName(buyAsset.chain)}`}
              </Text>
            </View>
            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Provider</Text>
              <Text style={styles.quoteValue}>{lifiQuote.toolDetails?.name || lifiQuote.tool}</Text>
            </View>
            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Est. Time</Text>
              <Text style={styles.quoteValue}>
                {lifiQuote.estimate.executionDuration < 60
                  ? `~${lifiQuote.estimate.executionDuration}s`
                  : `~${Math.ceil(lifiQuote.estimate.executionDuration / 60)} min`}
              </Text>
            </View>
            {lifiQuote.estimate.gasCosts?.length > 0 && (
              <View style={styles.quoteRow}>
                <Text style={styles.quoteLabel}>Gas Fee</Text>
                <Text style={styles.quoteValue}>
                  ~${lifiQuote.estimate.gasCosts.reduce((sum, gc) => sum + parseFloat(gc.amountUSD || '0'), 0).toFixed(2)}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Quote Info - Cross Chain (Relay) */}
        {relayQuote && !jupiterQuote && !lifiQuote && sellAsset && buyAsset && (
          <View style={styles.quoteInfo}>
            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Rate</Text>
              <Text style={styles.quoteValue}>
                1 {sellAsset.symbol} = {parseFloat(relayQuote.details.rate).toFixed(8)} {buyAsset.symbol}
              </Text>
            </View>
            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Route</Text>
              <Text style={styles.quoteValue}>
                {getChainName(sellAsset.chain)} → {getChainName(buyAsset.chain)}
              </Text>
            </View>
            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Est. Time</Text>
              <Text style={styles.quoteValue}>
                {relayQuote.details.timeEstimate
                  ? relayQuote.details.timeEstimate < 60
                    ? `~${relayQuote.details.timeEstimate}s`
                    : `~${Math.ceil(relayQuote.details.timeEstimate / 60)} min`
                  : '~2-5 min'}
              </Text>
            </View>
            <View style={styles.quoteRow}>
              <Text style={styles.quoteLabel}>Fee</Text>
              <Text style={styles.quoteValue}>
                ${relayQuote.fees.relayer?.amountUsd || '0'}
              </Text>
            </View>
            {relayQuote.details.totalImpact && Math.abs(parseFloat(relayQuote.details.totalImpact.percent)) > 1 && (
              <View style={styles.quoteRow}>
                <Text style={styles.quoteLabel}>Price Impact</Text>
                <Text style={[styles.quoteValue, { color: theme.colors.danger }]}>
                  {relayQuote.details.totalImpact.percent}%
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Swap Confirmation */}
        {isSwapping ? (
          <View style={styles.swapButton}>
            <ActivityIndicator size="small" color="#fff" />
          </View>
        ) : !sellAsset || !buyAsset ? (
          <View style={[styles.swapButton, styles.swapButtonDisabled]}>
            <Text style={styles.swapButtonText}>Select tokens</Text>
          </View>
        ) : !sellAmount ? (
          <View style={[styles.swapButton, styles.swapButtonDisabled]}>
            <Text style={styles.swapButtonText}>Enter amount</Text>
          </View>
        ) : insufficientBalance ? (
          <View style={[styles.swapButton, styles.swapButtonDisabled]}>
            <Text style={styles.swapButtonText}>Insufficient balance</Text>
          </View>
        ) : !quote && !relayQuote && !jupiterQuote && !lifiQuote ? (
          <View style={[styles.swapButton, styles.swapButtonDisabled]}>
            <Text style={styles.swapButtonText}>Getting quote...</Text>
          </View>
        ) : requiresBiometric ? (
          // High value swap - require biometric
          <TouchableOpacity style={styles.biometricButton} onPress={handleBiometricSwap}>
            <IconSymbol name="faceid" size={20} color="#fff" />
            <Text style={styles.swapButtonText}>
              {getBiometricLabel()} to Swap (${swapUsdValue.toFixed(2)})
            </Text>
          </TouchableOpacity>
        ) : (
          // Low value swap - hold to confirm
          <HoldToConfirm
            onConfirm={executeSwap}
            label={`Hold to Swap${swapUsdValue > 0 ? ` ($${swapUsdValue.toFixed(2)})` : ''}`}
            holdingLabel="Keep holding..."
            holdDuration={1500}
            style={{ marginTop: Skin.space(20) }}
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
      paddingHorizontal: Skin.space(20),
      paddingBottom: Skin.space(16),
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
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface1,
      borderRadius: Skin.radius(10),
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(8),
      marginBottom: Skin.space(8),
      gap: Skin.space(8),
    },
    searchInput: {
      flex: 1,
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      padding: 0,
    },
    swapSection: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(16),
      padding: Skin.space(16),
      marginBottom: Skin.space(8),
    },
    swapSectionHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: Skin.space(12),
    },
    swapLabel: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
    },
    maxButton: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.primary,
    },
    swapInputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
    },
    swapAmountInput: {
      flex: 1,
      fontSize: Skin.font(28),
      lineHeight: Skin.font(36),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      paddingHorizontal: 0,
      paddingTop: Skin.space(8),
      paddingBottom: Skin.space(4),
      minHeight: 44,
    },
    swapAmountOutput: {
      justifyContent: 'center',
      minHeight: 40,
    },
    swapAmountText: {
      fontSize: Skin.font(28),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    swapAmountPlaceholder: {
      color: theme.colors.textMuted,
    },
    tokenSelector: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.background,
      paddingVertical: Skin.space(8),
      paddingHorizontal: Skin.space(12),
      borderRadius: Skin.radius(20),
      gap: Skin.space(6),
    },
    selectedToken: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
    },
    tokenDot: {
      width: 8,
      height: 8,
      borderRadius: Skin.radius(4),
    },
    tokenSymbol: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    selectTokenText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.primary,
    },
    balanceText: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginTop: Skin.space(8),
    },
    balanceTextError: {
      color: theme.colors.danger,
    },
    assetPickerDropdown: {
      marginTop: Skin.space(12),
      backgroundColor: theme.colors.background,
      borderRadius: Skin.radius(12),
      maxHeight: 180,
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
    assetIcon: {
      width: 32,
      height: 32,
      borderRadius: Skin.radius(16),
      alignItems: 'center',
      justifyContent: 'center',
    },
    assetIconText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
    },
    assetInfo: {
      flex: 1,
      gap: Skin.space(2),
    },
    assetNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(4),
    },
    assetName: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    verifiedBadge: {
      marginLeft: Skin.space(2),
    },
    warningBadge: {
      marginLeft: Skin.space(2),
    },
    assetBalance: {
      fontSize: Skin.font(11),
      color: theme.colors.textMuted,
    },
    contractAddress: {
      fontSize: Skin.font(10),
      color: theme.colors.textMuted,
      fontFamily: 'monospace',
      opacity: 0.7,
    },
    noAssetsText: {
      padding: Skin.space(16),
      textAlign: 'center',
      color: theme.colors.textMuted,
      fontSize: Skin.font(13),
    },
    swapDirectionContainer: {
      alignItems: 'center',
      marginVertical: Skin.space(-16),
      zIndex: 1,
    },
    swapDirectionButton: {
      backgroundColor: theme.colors.surface2,
      borderWidth: Skin.border(3),
      borderColor: theme.colors.background,
      width: 36,
      height: 36,
      borderRadius: Skin.radius(18),
      alignItems: 'center',
      justifyContent: 'center',
    },
    errorBox: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#EF444415',
      borderRadius: Skin.radius(12),
      padding: Skin.space(12),
      gap: Skin.space(8),
      marginTop: Skin.space(8),
    },
    errorText: {
      flex: 1,
      fontSize: Skin.font(13),
      color: theme.colors.danger,
    },
    quoteInfo: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(14),
      marginTop: Skin.space(16),
      gap: Skin.space(8),
    },
    quoteRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    quoteLabel: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
    },
    quoteValue: {
      fontSize: Skin.font(13),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    gaslessBadgeRow: {
      marginBottom: Skin.space(4),
    },
    gaslessBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      backgroundColor: '#22C55E15',
      paddingHorizontal: Skin.space(10),
      paddingVertical: Skin.space(4),
      borderRadius: Skin.radius(12),
      gap: Skin.space(4),
    },
    gaslessBadgeText: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.success,
    },
    gaslessFree: {
      color: theme.colors.success,
    },
    swapButton: {
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: Skin.space(20),
      minHeight: 56,
    },
    swapButtonDisabled: {
      opacity: 0.5,
    },
    swapButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#fff',
    },
    biometricButton: {
      flexDirection: 'row',
      backgroundColor: '#8B5CF6', // Purple for biometric
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: Skin.space(20),
      gap: Skin.space(10),
      minHeight: 56,
    },
    // Manual Token Entry Styles
    manualEntryToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: Skin.space(12),
      gap: Skin.space(6),
      marginTop: Skin.space(8),
    },
    manualEntryToggleText: {
      fontSize: Skin.font(13),
      color: theme.colors.primary,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    manualEntryContainer: {
      backgroundColor: theme.colors.background,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      marginTop: Skin.space(8),
      gap: Skin.space(12),
    },
    manualEntryLabel: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginBottom: Skin.space(6),
    },
    manualEntryInput: {
      backgroundColor: theme.colors.surface1,
      borderRadius: Skin.radius(10),
      paddingHorizontal: Skin.space(14),
      paddingVertical: Skin.space(12),
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
    },
    manualEntryRow: {
      flexDirection: 'row',
      gap: Skin.space(12),
    },
    manualEntryButton: {
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(10),
      paddingVertical: Skin.space(14),
      alignItems: 'center',
      marginTop: Skin.space(4),
    },
    manualEntryButtonDisabled: {
      opacity: 0.4,
    },
    manualEntryButtonText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#fff',
    },
    chainSelector: {
      marginBottom: Skin.space(8),
    },
  });
