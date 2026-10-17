/**
 * Hook for managing wallet selection between built-in and imported wallets
 *
 * Supports switching between:
 * - 'builtin' - The wallet derived from Quorum mnemonic
 * - 'warpcast' - The imported Warpcast embedded wallet
 */

import { useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createMMKV } from 'react-native-mmkv';
import { useImportedWarpcastWallet } from './useWarpcastWallet';
import { useWalletAddresses } from './useWallet';

// Storage for wallet preferences
const walletPrefsStorage = createMMKV({ id: 'quorum-wallet-prefs' });

const STORAGE_KEYS = {
  ACTIVE_ETH_WALLET: 'activeEthWallet',
} as const;

export type WalletType = 'builtin' | 'warpcast';

export interface WalletInfo {
  type: WalletType;
  address: string;
  label: string;
}

// Query keys
export const walletSelectionKeys = {
  all: ['walletSelection'] as const,
  active: () => [...walletSelectionKeys.all, 'active'] as const,
};

/**
 * Get the currently selected wallet type from storage
 */
function getActiveWalletType(): WalletType {
  const stored = walletPrefsStorage.getString(STORAGE_KEYS.ACTIVE_ETH_WALLET);
  if (stored === 'warpcast') return 'warpcast';
  return 'builtin'; // Default to built-in wallet
}

/**
 * Set the active wallet type in storage
 */
function setActiveWalletType(type: WalletType): void {
  walletPrefsStorage.set(STORAGE_KEYS.ACTIVE_ETH_WALLET, type);
}

/**
 * Hook for wallet selection state and switching
 */
export function useWalletSelection() {
  const queryClient = useQueryClient();

  // Get built-in wallet addresses (cached, fast)
  const { data: builtinAddresses, isLoading: builtinLoading } = useWalletAddresses();

  // Get imported Warpcast wallet. Read from the device only: whether a wallet
  // is available to import is a farcaster.xyz call this hook does not need.
  const { data: importedWallet, isLoading: warpcastLoading } = useImportedWarpcastWallet();
  const hasWarpcastWallet = !!importedWallet;

  // Query for active wallet selection
  const { data: activeType } = useQuery({
    queryKey: walletSelectionKeys.active(),
    queryFn: getActiveWalletType,
    staleTime: Infinity,
  });

  // Mutation to switch wallets
  const switchMutation = useMutation({
    mutationFn: async (type: WalletType) => {
      setActiveWalletType(type);
      return type;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: walletSelectionKeys.active() });
    },
  });

  // Build wallet info objects
  const builtinWallet: WalletInfo | null = useMemo(() => {
    if (!builtinAddresses?.ethereum) return null;
    return {
      type: 'builtin' as WalletType,
      address: builtinAddresses.ethereum,
      label: 'Quorum Wallet',
    };
  }, [builtinAddresses]);

  const warpcastWallet: WalletInfo | null = useMemo(() => {
    if (!importedWallet) return null;
    return {
      type: 'warpcast' as WalletType,
      address: importedWallet.address,
      label: 'Warpcast Wallet',
    };
  }, [importedWallet]);

  // Get the currently active wallet
  const activeWallet: WalletInfo | null = useMemo(() => {
    const type = activeType ?? 'builtin';

    // If warpcast is selected and available, use it
    if (type === 'warpcast' && warpcastWallet) {
      return warpcastWallet;
    }

    // Fall back to builtin (even if warpcast was selected but unavailable)
    return builtinWallet;
  }, [activeType, builtinWallet, warpcastWallet]);

  // Effective active type (accounts for warpcast being selected but unavailable)
  const effectiveActiveType: WalletType = useMemo(() => {
    const type = activeType ?? 'builtin';
    // If warpcast is selected but not available, effective type is builtin
    if (type === 'warpcast' && !warpcastWallet) {
      // Also reset the stored preference to avoid this state persisting
      setActiveWalletType('builtin');
      return 'builtin';
    }
    return type;
  }, [activeType, warpcastWallet]);

  // List of all available wallets
  const availableWallets: WalletInfo[] = useMemo(() => {
    const wallets: WalletInfo[] = [];
    if (builtinWallet) wallets.push(builtinWallet);
    if (warpcastWallet) wallets.push(warpcastWallet);
    return wallets;
  }, [builtinWallet, warpcastWallet]);

  const switchWallet = useCallback((type: WalletType) => {
    switchMutation.mutate(type);
  }, [switchMutation]);

  return {
    /** The currently active wallet */
    activeWallet,
    /** The currently selected wallet type (use effectiveActiveType for UI that depends on actual availability) */
    activeType: effectiveActiveType,
    /** All available wallets */
    availableWallets,
    /** The built-in Quorum wallet */
    builtinWallet,
    /** The imported Warpcast wallet (if available) */
    warpcastWallet,
    /** Whether a Warpcast wallet is available */
    hasWarpcastWallet,
    /** Whether wallet data is loading */
    isLoading: builtinLoading || warpcastLoading,
    /** Switch to a different wallet */
    switchWallet,
    /** Whether switching is in progress */
    isSwitching: switchMutation.isPending,
  };
}

/**
 * Hook to get just the active wallet address for display.
 *
 * Carries no private key for either wallet type. Read keys at the moment of
 * signing: `getWarpcastWalletPrivateKey()` for an imported Warpcast wallet,
 * `useWalletKeys().refetch()` for the built-in one.
 */
export function useActiveWalletKeys() {
  const { activeWallet, isLoading } = useWalletSelection();

  return {
    address: activeWallet?.address ?? null,
    walletType: activeWallet?.type ?? 'builtin',
    isLoading,
  };
}
