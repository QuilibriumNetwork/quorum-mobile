/**
 * Hook for managing Warpcast wallet import
 *
 * Provides detection of available Warpcast wallet and import functionality.
 */

import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context';
import {
  getImportedWarpcastWallet,
  storeWarpcastWallet,
  deleteWarpcastWallet,
  WarpcastWalletData,
  ImportedWarpcastWallet,
  hasWarpcastWallet,
} from '@/services/onboarding/secureStorage';
import {
  checkWarpcastWallet,
} from '@/services/farcasterClient';
import { logger } from '@quilibrium/quorum-shared';

// Query keys
export const warpcastWalletKeys = {
  all: ['warpcastWallet'] as const,
  imported: () => [...warpcastWalletKeys.all, 'imported'] as const,
  available: () => [...warpcastWalletKeys.all, 'available'] as const,
};

export interface WarpcastWalletState {
  /** Whether a Warpcast wallet has been imported to Quorum */
  isImported: boolean;
  /**
   * The imported wallet's public record (if imported). Never carries the private
   * key or mnemonic: this is query data, and the query cache is persisted. Sign
   * with `getWarpcastWalletPrivateKey()` instead.
   */
  importedWallet: ImportedWarpcastWallet | null;
  /** Whether a Warpcast wallet is available to import (user has one in Warpcast) */
  isAvailable: boolean;
  /** The address of the available wallet (from Warpcast) */
  availableAddress: string | null;
  /** Loading state */
  isLoading: boolean;
  /** Whether the user should be prompted to import */
  shouldPromptImport: boolean;
}

/**
 * Check if an imported Warpcast wallet exists
 */
export function useImportedWarpcastWallet() {
  return useQuery({
    queryKey: warpcastWalletKeys.imported(),
    queryFn: async () => {
      const wallet = await getImportedWarpcastWallet();
      logger.debug('[useWarpcastWallet] getImportedWarpcastWallet result:', {
        hasWallet: !!wallet,
        address: wallet?.address?.slice(0, 10),
      });
      return wallet;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Check if user has a Warpcast wallet available to import. This asks
 * farcaster.xyz (the wallet label is Warpcast server metadata, with no protocol
 * equivalent), so only the import prompt and the export flow mount it.
 */
export function useAvailableWarpcastWallet() {
  const { farcasterAuthToken, user } = useAuth();
  const fid = user?.farcaster?.fid;

  return useQuery({
    queryKey: warpcastWalletKeys.available(),
    queryFn: async () => {
      if (!farcasterAuthToken || !fid) return { hasWallet: false, address: undefined };
      const fidNum = typeof fid === 'string' ? parseInt(fid, 10) : fid;
      return checkWarpcastWallet(farcasterAuthToken, fidNum);
    },
    enabled: !!farcasterAuthToken && !!fid,
    // A Warpcast wallet comes into existence rarely, so a check per half hour
    // is plenty; the import modal checks again itself when it has no address.
    staleTime: 30 * 60 * 1000,
  });
}

/**
 * Main hook for Warpcast wallet state
 */
export function useWarpcastWallet(): WarpcastWalletState & {
  importWallet: (data: Omit<WarpcastWalletData, 'importedAt'>) => Promise<ImportedWarpcastWallet>;
  removeWallet: () => Promise<void>;
  refetch: () => void;
} {
  const queryClient = useQueryClient();

  const {
    data: importedWallet,
    isLoading: importedLoading,
    refetch: refetchImported,
  } = useImportedWarpcastWallet();

  const {
    data: availableWallet,
    isLoading: availableLoading,
  } = useAvailableWarpcastWallet();

  const importMutation = useMutation({
    // The variables carry the private key and mnemonic, and the persister writes
    // PAUSED mutations to disk. This only touches SecureStore, so never let it
    // pause for the network, and drop its state as soon as it settles.
    networkMode: 'always',
    gcTime: 0,
    meta: { neverPersist: true },
    mutationFn: async (data: Omit<WarpcastWalletData, 'importedAt'>): Promise<ImportedWarpcastWallet> => {
      const fullData: WarpcastWalletData = {
        ...data,
        importedAt: new Date().toISOString(),
      };
      await storeWarpcastWallet(fullData);
      return { address: fullData.address, importedAt: fullData.importedAt };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: warpcastWalletKeys.imported() });
    },
  });

  const removeMutation = useMutation({
    mutationFn: deleteWarpcastWallet,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: warpcastWalletKeys.imported() });
    },
  });

  const isImported = !!importedWallet;
  const isAvailable = availableWallet?.hasWallet ?? false;
  const availableAddress = availableWallet?.address ?? null;

  // Should prompt import if:
  // 1. User has a Warpcast wallet available
  // 2. They haven't already imported it
  const shouldPromptImport = isAvailable && !isImported;

  const refetch = useCallback(() => {
    refetchImported();
  }, [refetchImported]);

  return {
    isImported,
    importedWallet: importedWallet ?? null,
    isAvailable,
    availableAddress,
    isLoading: importedLoading || availableLoading,
    shouldPromptImport,
    importWallet: importMutation.mutateAsync,
    removeWallet: removeMutation.mutateAsync,
    refetch,
  };
}
