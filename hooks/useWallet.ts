/**
 * React Query hooks for multi-chain wallet functionality
 */

import { useQuery, useQueryClient, UseQueryResult } from '@tanstack/react-query';
import { useAuth } from '@/context';
import { getMnemonic, getPrivateKey } from '@/services/onboarding/secureStorage';
import {
  deriveMultiChainAddresses,
  deriveMultiChainAddressesAsync,
  deriveMultiChainKeys,
  deriveMultiChainKeysAsync,
  deriveMultiChainAddressesFromPrivateKey,
  deriveMultiChainAddressesFromPrivateKeyAsync,
  deriveMultiChainKeysFromPrivateKey,
  deriveMultiChainKeysFromPrivateKeyAsync,
  ChainAddresses,
  ChainKeys,
} from '@/services/wallet/multiChainWallet';
import {
  fetchAllBalances,
  fetchEvmBalancesForAddress,
  enrichBalancesWithPrices,
  fetchBitcoinBalance,
  fetchSolanaBalance,
  fetchAllNFTs,
  WalletBalances,
  ChainBalance,
  EVM_CHAINS,
  getChainName,
  NFT,
} from '@/services/wallet/balanceService';
import React from 'react';
import { InteractionManager } from 'react-native';
import { createMMKV } from 'react-native-mmkv';

// MMKV storage for wallet balance cache
const walletCacheStorage = createMMKV({ id: 'quorum-wallet-cache' });
const BALANCES_CACHE_KEY = 'cached_balances';
const EVM_BALANCES_CACHE_KEY = 'cached_evm_balances';
const ADDRESSES_CACHE_KEY = 'cached_addresses';
const CACHE_TIMESTAMP_KEY = 'cache_timestamp';

// Cache helper functions
function getCachedBalances(): WalletBalances | null {
  try {
    const cached = walletCacheStorage.getString(BALANCES_CACHE_KEY);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch {
    // Storage/parse failure — return fallback
  }
  return null;
}

function setCachedBalances(balances: WalletBalances): void {
  try {
    walletCacheStorage.set(BALANCES_CACHE_KEY, JSON.stringify(balances));
    walletCacheStorage.set(CACHE_TIMESTAMP_KEY, Date.now().toString());
  } catch {
    // Storage/parse failure — return fallback
  }
}

function getCacheTimestamp(): number {
  try {
    const timestamp = walletCacheStorage.getString(CACHE_TIMESTAMP_KEY);
    if (timestamp) {
      return parseInt(timestamp, 10);
    }
  } catch {
    // Storage/parse failure — return fallback
  }
  return 0;
}

function getCachedEvmBalances(address: string): WalletBalances | null {
  try {
    const cached = walletCacheStorage.getString(`${EVM_BALANCES_CACHE_KEY}_${address}`);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch {
    // Storage/parse failure — return fallback
  }
  return null;
}

function setCachedEvmBalances(address: string, balances: WalletBalances): void {
  try {
    walletCacheStorage.set(`${EVM_BALANCES_CACHE_KEY}_${address}`, JSON.stringify(balances));
    walletCacheStorage.set(`${EVM_BALANCES_CACHE_KEY}_${address}_timestamp`, Date.now().toString());
  } catch {
    // Storage/parse failure — return fallback
  }
}

function getEvmCacheTimestamp(address: string): number {
  try {
    const timestamp = walletCacheStorage.getString(`${EVM_BALANCES_CACHE_KEY}_${address}_timestamp`);
    if (timestamp) {
      return parseInt(timestamp, 10);
    }
  } catch {
    // Storage/parse failure — return fallback
  }
  return 0;
}

function getCachedAddresses(version: number): ChainAddresses | null {
  try {
    const cached = walletCacheStorage.getString(`${ADDRESSES_CACHE_KEY}_v${version}`);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch {
    // Storage/parse failure — return fallback
  }
  return null;
}

function setCachedAddresses(version: number, addresses: ChainAddresses): void {
  try {
    walletCacheStorage.set(`${ADDRESSES_CACHE_KEY}_v${version}`, JSON.stringify(addresses));
  } catch {
    // Storage/parse failure — return fallback
  }
}

// Derivation version - increment when adding new chains to force re-derivation
// v1: ethereum, bitcoin, solana
// v2: added kaspa
// v3: added bittensor
// v4: kaspa ECDSA format (rejected by API)
// v5: kaspa back to Schnorr format (version 0x00, X-coordinate only)
// v6: kaspa checksum fix (use Kaspa's fivebit prefix instead of standard bech32 HRP)
// Bumped to 7 when Tezos was added to ChainAddresses/ChainKeys —
// existing cached entries from v6 don't have the `tezos` field and
// would crash UI consumers that read `addresses.tezos.slip10`.
const DERIVATION_VERSION = 7;

// Query keys
export const walletKeys = {
  all: ['wallet'] as const,
  addresses: () => [...walletKeys.all, 'addresses', `v${DERIVATION_VERSION}`] as const,
  keys: () => [...walletKeys.all, 'keys', `v${DERIVATION_VERSION}`] as const,
  // Use ethereum address as stable key instead of whole object to prevent refetch loops
  balances: (ethAddress: string | null) => [...walletKeys.all, 'balances', ethAddress] as const,
  chainBalance: (chain: string, address: string) => [...walletKeys.all, 'balance', chain, address] as const,
  nfts: (address: string | null, tezosAddress?: string) => [...walletKeys.all, 'nfts', address, tezosAddress ?? null] as const,
};

/**
 * Hook to derive multi-chain addresses from the user's mnemonic or private key
 * Uses MMKV cache for instant loading - derivation only happens once
 */
export function useWalletAddresses() {
  // Load cached addresses once on mount - this is synchronous and fast
  const cachedAddresses = React.useMemo(() => {
    const cached = getCachedAddresses(DERIVATION_VERSION);
    if (cached) {
    }
    return cached;
  }, []);

  // If we have cache, no need to derive
  const hasCache = !!cachedAddresses;

  // Delay derivation until after interactions (only if no cache). A hard
  // fallback timer guarantees derivation still happens even when
  // InteractionManager never settles (continuous JS-driven animations —
  // common on the simulator — starve runAfterInteractions indefinitely,
  // which left the query disabled forever and the addresses tab showing
  // "No wallet found" for a perfectly healthy wallet).
  const [canDerive, setCanDerive] = React.useState(false);
  React.useEffect(() => {
    if (!hasCache && !canDerive) {
      const task = InteractionManager.runAfterInteractions(() => {
        setTimeout(() => {
          setCanDerive(true);
        }, 200);
      });
      const hardFallback = setTimeout(() => setCanDerive(true), 1500);
      return () => {
        task.cancel();
        clearTimeout(hardFallback);
      };
    }
  }, [hasCache, canDerive]);

  return useQuery({
    queryKey: walletKeys.addresses(),
    queryFn: async (): Promise<ChainAddresses | null> => {
      // First try mnemonic (preferred). Errors here must NOT abort the
      // whole query — fall through to the private-key path (previously a
      // mnemonic-derivation throw escaped the queryFn and the private-key
      // fallback never ran).
      try {
        const stored = await getMnemonic();
        // Older builds persisted the raw phrase string rather than a
        // word array — normalize so `.map()` in the deriver doesn't
        // throw on a string.
        const mnemonic = typeof stored === 'string'
          ? (stored as string).trim().split(/\s+/)
          : stored;
        if (mnemonic && mnemonic.length >= 12) {
          const addresses = await deriveMultiChainAddressesAsync(mnemonic);
          setCachedAddresses(DERIVATION_VERSION, addresses);
          return addresses;
        }
        if (stored) {
          console.warn('[useWalletAddresses] mnemonic present but malformed (length', mnemonic?.length, ') — trying private key');
        }
      } catch (e) {
        console.warn('[useWalletAddresses] mnemonic derivation failed — trying private key:', e instanceof Error ? e.message : e);
      }

      // Fall back to hex private key derivation
      try {
        const privateKey = await getPrivateKey();
        if (privateKey && privateKey.length > 0) {
          const addresses = await deriveMultiChainAddressesFromPrivateKeyAsync(privateKey);
          setCachedAddresses(DERIVATION_VERSION, addresses);
          return addresses;
        }
      } catch (e) {
        console.warn('[useWalletAddresses] private-key derivation failed:', e instanceof Error ? e.message : e);
        throw e; // surface as query error — both sources failed
      }

      console.warn('[useWalletAddresses] no mnemonic and no private key in secure storage — no addresses to derive');
      return null;
    },
    staleTime: Infinity,
    gcTime: Infinity,
    // Only derive if no cache AND UI is ready
    enabled: !hasCache && canDerive,
    // Return cached addresses immediately
    initialData: cachedAddresses ?? undefined,
  });
}

/**
 * Hook to get full key material (including private keys) - use carefully!
 * This should only be used when signing transactions
 */
export function useWalletKeys() {
  return useQuery({
    queryKey: walletKeys.keys(),
    queryFn: async (): Promise<ChainKeys | null> => {
      // First try mnemonic (preferred)
      const mnemonic = await getMnemonic();
      if (mnemonic && mnemonic.length >= 12) {
        // Use async version that yields to UI thread
        return deriveMultiChainKeysAsync(mnemonic);
      }

      // Fall back to hex private key derivation (for non-mnemonic accounts)
      const privateKey = await getPrivateKey();
      if (privateKey && privateKey.length > 0) {
        // Use async version that yields to UI thread
        return deriveMultiChainKeysFromPrivateKeyAsync(privateKey);
      }

      return null;
    },
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes only (security)
    enabled: false, // Don't auto-fetch - must be manually triggered
  });
}

/**
 * Hook to fetch all wallet balances across chains
 * Uses MMKV cache for instant display on app restart
 */
export function useWalletBalances(options?: { enabled?: boolean; refetchInterval?: number }) {
  const { data: addresses } = useWalletAddresses();

  // Load cached balances - memoize to prevent unnecessary re-reads
  const { cachedBalances, cacheTimestamp } = React.useMemo(() => {
    const balances = getCachedBalances();
    const timestamp = getCacheTimestamp();
    return { cachedBalances: balances, cacheTimestamp: timestamp };
  }, []);

  // Use ethereum address as stable query key to prevent refetch loops
  const ethAddress = addresses?.ethereum ?? null;

  const query = useQuery({
    queryKey: walletKeys.balances(ethAddress),
    queryFn: async (): Promise<WalletBalances | null> => {
      if (!addresses) return null;
      const balances = await fetchAllBalances(addresses);
      // Enrich with USD prices
      const enriched = await enrichBalancesWithPrices(balances);
      // Persist to cache for next app launch
      if (enriched) {
        setCachedBalances(enriched);
      }
      return enriched;
    },
    enabled: !!addresses && options?.enabled !== false,
    staleTime: 30 * 1000, // 30 seconds
    gcTime: 5 * 60 * 1000, // 5 minutes
    refetchInterval: options?.refetchInterval,
    // Use cached data as initial data - this persists while refreshing
    initialData: cachedBalances ?? undefined,
    initialDataUpdatedAt: cacheTimestamp,
  });

  return query;
}

/**
 * Hook to fetch Bitcoin balance only
 */
export function useBitcoinBalance(address: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: walletKeys.chainBalance('bitcoin', address ?? ''),
    queryFn: () => fetchBitcoinBalance(address!),
    enabled: !!address && options?.enabled !== false,
    staleTime: 60 * 1000, // Bitcoin is slower, cache longer
    gcTime: 5 * 60 * 1000,
  });
}

/**
 * Hook to fetch Solana balance only
 */
export function useSolanaBalance(address: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: walletKeys.chainBalance('solana', address ?? ''),
    queryFn: () => fetchSolanaBalance(address!),
    enabled: !!address && options?.enabled !== false,
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
  });
}

/**
 * Hook to fetch EVM balances for a single ETH address (e.g., imported Warpcast wallet)
 * Uses MMKV cache for instant display on app restart
 */
export function useEvmBalancesForAddress(address: string | null | undefined, options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();

  // Load cached balances and re-enrich with current prices on mount
  // This ensures consistent prices across wallets using the shared price cache
  React.useEffect(() => {
    if (!address) return;

    const cachedBalances = getCachedEvmBalances(address);
    if (cachedBalances) {
      // Re-enrich with current prices and set as query data immediately
      enrichBalancesWithPrices(cachedBalances).then((enriched) => {
        queryClient.setQueryData(['evmBalances', address], enriched);
      });
    }
  }, [address, queryClient]);

  return useQuery({
    queryKey: ['evmBalances', address ?? ''],
    queryFn: async (): Promise<WalletBalances | null> => {
      if (!address) return null;
      const balances = await fetchEvmBalancesForAddress(address);
      const enriched = await enrichBalancesWithPrices(balances);
      // Persist to cache for next app launch
      if (enriched) {
        setCachedEvmBalances(address, enriched);
      }
      return enriched;
    },
    enabled: !!address && options?.enabled !== false,
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
  });
}

/**
 * Hook to fetch all NFTs across supported chains
 * @param address - Optional address to fetch NFTs for. If not provided, uses builtin wallet.
 */
export function useNFTs(options?: { enabled?: boolean; address?: string | null }): UseQueryResult<NFT[], Error> {
  const { data: addresses } = useWalletAddresses();

  // Use provided address or fall back to builtin wallet
  const targetAddress = options?.address ?? addresses?.ethereum ?? null;
  // Tezos NFTs are fetched alongside EVM. Always uses the
  // Quorum-mnemonic-derived tz1 (SLIP-10) regardless of which EVM
  // wallet is active — Tezos has no equivalent of the
  // Quorum-vs-Warpcast wallet switch on EVM.
  const tezosAddress = addresses?.tezos?.slip10 ?? undefined;

  return useQuery<NFT[], Error>({
    queryKey: walletKeys.nfts(targetAddress, tezosAddress),
    queryFn: async (): Promise<NFT[]> => {
      if (!targetAddress) return [];
      return fetchAllNFTs(targetAddress, tezosAddress);
    },
    enabled: !!targetAddress && options?.enabled !== false,
    staleTime: 2 * 60 * 1000, // 2 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
    refetchOnMount: true, // Refetch when component mounts if stale
  });
}

// Re-export NFT type for convenience
export type { NFT };

/**
 * Combine all wallet data into a single interface for the wallet modal
 */
export interface WalletData {
  addresses: ChainAddresses | null;
  balances: WalletBalances | null;
  isLoading: boolean;
  /** True until the address-derivation query has actually completed.
   *  Distinct from isLoading: a disabled/not-yet-started query is pending
   *  but NOT loading — consumers must not render "no wallet" empty states
   *  while this is true. */
  addressesPending: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  /** Re-run address derivation. The plain `refetch` only refreshes
   *  balances — retry buttons for missing addresses must call this. */
  refetchAddresses: () => void;
}

/**
 * Main hook for the wallet modal - combines addresses and balances
 */
export function useWallet(): WalletData {
  const {
    data: addresses,
    isLoading: addressesLoading,
    isPending: addressesPending,
    error: addressesError,
    refetch: refetchAddresses,
  } = useWalletAddresses();

  const {
    data: balances,
    isLoading: balancesLoading,
    error: balancesError,
    refetch,
  } = useWalletBalances({ enabled: !!addresses });

  // Only show loading when we have NO data yet (initial load)
  // If we have cached data, show it immediately while refreshing in background
  const isLoading = (addressesLoading && !addresses) || (!!addresses && balancesLoading && !balances);
  const error = addressesError || balancesError;

  // Log errors for debugging
  if (addressesError) {
  }
  if (balancesError) {
  }

  return {
    addresses: addresses ?? null,
    balances: balances ?? null,
    isLoading,
    addressesPending: addressesPending && !addresses,
    isError: !!error,
    error: error as Error | null,
    refetch,
    refetchAddresses,
  };
}

/**
 * Aggregate all token balances across chains into a flat list
 */
export interface AggregatedAsset {
  symbol: string;
  name: string;
  balance: string;
  chain: string;
  chainName: string;
  contractAddress?: string;
  isNative: boolean;
  decimals: number;
  usdValue?: number;
  priceChange24h?: number;
  iconUrl?: string;
  // Pending balance info (for chains like Bitcoin with unconfirmed transactions)
  pendingBalance?: string; // Net pending amount (positive = incoming, negative = outgoing)
  confirmedBalance?: string; // Confirmed spendable balance
}

/**
 * Get the total USD value for a chain from balances
 */
export function getChainUsdValue(balances: WalletBalances | null, chain: string): number {
  if (!balances) return 0;
  const chainBalance = balances[chain];
  if (chainBalance && typeof chainBalance === 'object' && 'usdValue' in chainBalance) {
    return parseFloat((chainBalance as ChainBalance).usdValue || '0');
  }
  return 0;
}

export function aggregateAssets(balances: WalletBalances | null): AggregatedAsset[] {
  if (!balances) return [];

  const assets: AggregatedAsset[] = [];

  // Native token display names
  const nativeNames: Record<string, string> = {
    ETH: 'Ethereum',
    BTC: 'Bitcoin',
    SOL: 'Solana',
    KAS: 'Kaspa',
    TAO: 'Bittensor',
    POL: 'Polygon',
    BNB: 'BNB',
    MON: 'Monad',
    HYPE: 'Hyperliquid',
    AVAX: 'Avalanche',
    MATIC: 'Polygon',
    GLMR: 'Moonbeam',
    CELO: 'Celo',
    xDAI: 'Gnosis',
    MNT: 'Mantle',
    BERA: 'Berachain',
    APE: 'ApeCoin',
    DEGEN: 'Degen',
  };

  // Native token decimals by chain
  const nativeDecimals: Record<string, number> = {
    bitcoin: 8,
    solana: 9,
    kaspa: 8, // 1 KAS = 100,000,000 sompi
    bittensor: 9, // 1 TAO = 1,000,000,000 RAO
    // All EVM chains use 18 decimals for native token
  };

  // Helper to add chain balances
  const addChainAssets = (chainBalance: ChainBalance | null | undefined) => {
    if (!chainBalance) return;

    // Add native balance if non-zero
    if (parseFloat(chainBalance.nativeBalance) > 0) {
      const decimals = nativeDecimals[chainBalance.chain] || 18;
      assets.push({
        symbol: chainBalance.nativeSymbol,
        name: nativeNames[chainBalance.nativeSymbol] || chainBalance.nativeSymbol,
        balance: chainBalance.nativeBalance,
        chain: chainBalance.chain,
        chainName: getChainName(chainBalance.chain),
        isNative: true,
        decimals,
        usdValue: chainBalance.nativeUsdValue ? parseFloat(chainBalance.nativeUsdValue) : undefined,
        priceChange24h: chainBalance.nativePriceChange24h,
        iconUrl: chainBalance.nativeIconUrl,
        // Include pending balance info if available (mainly for Bitcoin)
        pendingBalance: chainBalance.pendingBalanceRaw
          ? (Number(chainBalance.pendingBalanceRaw) / Math.pow(10, decimals)).toString()
          : undefined,
        confirmedBalance: chainBalance.confirmedBalanceRaw
          ? (Number(chainBalance.confirmedBalanceRaw) / Math.pow(10, decimals)).toString()
          : undefined,
      });
    }

    // Add token balances
    for (const token of chainBalance.tokens) {
      assets.push({
        symbol: token.symbol,
        name: token.name,
        balance: token.balance,
        chain: chainBalance.chain,
        chainName: getChainName(chainBalance.chain),
        contractAddress: token.contractAddress,
        isNative: false,
        decimals: token.decimals || 18,
        usdValue: token.usdValue ? parseFloat(token.usdValue) : undefined,
        priceChange24h: token.priceChange24h,
        iconUrl: token.logoUrl,
      });
    }
  };

  // Iterate over all chains in balances dynamically
  for (const chainId of Object.keys(balances)) {
    const chainBalance = balances[chainId];
    if (chainBalance && typeof chainBalance === 'object' && 'chain' in chainBalance) {
      addChainAssets(chainBalance as ChainBalance);
    }
  }

  return assets;
}
